//! `agent.run`: one whole agent turn inside the runtime. Split out of server.rs; the `Server` it extends is
//! defined there. The host bridges a run asks through — tools, consent, questions and the between-rounds gate —
//! are in `host_bridges`.

mod host_bridges;

use super::*;

impl Server {

    /// Run one agent turn to completion.
    ///
    /// Called by the app for both of its loops. An automation agent node runs its whole turn here since
    /// 2026-09-21 (`electron/agent/turn.mjs` → `runWithModelInRuntime`). A chat turn runs here since 2026-09-23,
    /// behind `ZERAIX_RUST_CHAT_LOOP` (`src/app/agent/chat/runtimeRound.ts`), with `host_tools_only` so every tool
    /// keeps the chat's own consent and display path. Each caller keeps its own loop as the fallback. See
    /// docs/rust-runtime-migration-request.md.
    pub(super) async fn run_agent(&self, p: AgentRunParams) -> Result<AgentRunResult, ErrorBody> {
        use agent_loop::{AgentLoop, LoopConfig, Message};
        use agent_provider::{HttpModel, ProviderConfig};

        let messages: Vec<Message> = p
            .messages
            .into_iter()
            .map(serde_json::from_value)
            .collect::<std::result::Result<_, _>>()
            .map_err(|e| {
                RuntimeError::invalid("agent.bad_messages", format!("could not read the conversation: {e}"))
            })?;

        // Every event of the run — tokens, retries, tool activity, round boundaries — goes through ONE channel
        // and ONE forwarder, so the host receives them in the order they happened.
        //
        // They used to have four, one per kind, and nothing ordered them against each other. A host keeping its
        // own copy of the conversation cannot live with that: an assistant turn has to be stored before the tool
        // results that answer it, and a late token must not repaint a reply the round already finalised. The
        // `Flush` marker is how the loop waits for delivery before it asks the host anything — host requests go
        // out through the same transport, so everything flushed is read before the question.
        //
        // Unbounded, for two reasons: the callbacks feeding it are synchronous and the transport is not, and a
        // bounded queue would push backpressure from the host's stdout into the model read, so a slow reader
        // would stall the generation it is reading.
        enum RunEvent {
            Emit(&'static str, Value),
            Flush(tokio::sync::oneshot::Sender<()>),
        }
        let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel::<RunEvent>();
        let forwarder = {
            let events = Arc::clone(&self.events);
            tokio::spawn(async move {
                while let Some(event) = event_rx.recv().await {
                    match event {
                        RunEvent::Emit(method, params) => {
                            let Some(tx) = events.get().cloned() else { continue };
                            if let Ok(line) = serde_json::to_string(&Notification { method, params }) {
                                if tx.send(line).await.is_err() {
                                    break;
                                }
                            }
                        }
                        RunEvent::Flush(delivered) => {
                            let _ = delivered.send(());
                        }
                    }
                }
            })
        };

        // Token streaming (TODO §10.1). The provider hands back the ACCUMULATED text on every chunk, so the
        // increment is computed here and only that is sent: forwarding the accumulation would be quadratic in
        // the answer's length, and a long reply would get slower to display the longer it grew.
        //
        // The offsets are per ROUND, not per run: each round is a new request whose text starts again from
        // nothing. Carried over, round 2's opening was sliced at round 1's final length — its first words were
        // dropped, and when that offset fell inside a character nothing streamed for the whole round. The
        // observer zeroes them as each round starts (`round_started`, before the request goes out).
        let sent = Arc::new(std::sync::Mutex::new((0usize, 0usize)));
        let stream_offsets = Arc::clone(&sent);
        let delta_tx = event_tx.clone();
        let delta_run_id = p.run_id.clone();
        let on_delta: agent_provider::OnDelta = Box::new(move |content, reasoning| {
            let mut sent = sent.lock().unwrap_or_else(|e| e.into_inner());
            let emit = |content: &str, reasoning: &str, reset: bool| {
                let _ = delta_tx.send(RunEvent::Emit(
                    EVENT_AGENT_DELTA,
                    json!({ "run_id": delta_run_id, "content": content, "reasoning": reasoning, "reset": reset }),
                ));
            };
            // Byte offsets into text that only ever grows by appending, so slicing at the previous length is
            // always on a character boundary.
            let (c_at, r_at) = *sent;
            // Text that went BACKWARDS is a retry: the provider is starting the reply again and everything
            // streamed so far is void. Said as a reset, so a reader clears the half-written reply instead of
            // appending the new attempt to the old one — and the offsets restart, or slicing at the old length
            // would silently drop the new attempt's opening words.
            if content.len() < c_at || reasoning.len() < r_at {
                *sent = (content.len(), reasoning.len());
                emit(content, reasoning, true);
                return;
            }
            let c_new = content.get(c_at..).unwrap_or("");
            let r_new = reasoning.get(r_at..).unwrap_or("");
            if c_new.is_empty() && r_new.is_empty() {
                return;
            }
            *sent = (content.len(), reasoning.len());
            emit(c_new, r_new, false);
        });

        // Retries, told rather than silent.
        let retry_tx = event_tx.clone();
        let retry_run_id = p.run_id.clone();
        let on_retry: agent_provider::OnRetry = Box::new(move |n| {
            let _ = retry_tx.send(RunEvent::Emit(
                EVENT_AGENT_RETRY,
                json!({
                    "run_id": retry_run_id, "attempt": n.attempt, "attempts": n.attempts,
                    "kind": n.kind, "delay_ms": n.delay_ms, "message": n.message,
                }),
            ));
        });
        let known = agent_provider::Quirks {
            thinking_unsupported: p.provider.known.thinking_unsupported,
            reasoning_context_unsupported: p.provider.known.reasoning_context_unsupported,
            vision_unsupported: p.provider.known.vision_unsupported,
        };

        // One builder for both clients, so the two cannot drift. The summariser differs in exactly two ways, and
        // both are about it being housekeeping: it is never streamed (streaming it would put a summary of the
        // conversation on screen as though the model had answered with one), and it never carries
        // `X-Conversation-Id` — a llama-server keeps one conversation per slot, and the parent's id on a side
        // request would evict that conversation's KV cache, the rule `chatRequest.ts` states for sub-agents.
        let provider_config = |stream: bool, summariser: bool| ProviderConfig {
            endpoint: p.provider.endpoint.clone(),
            api_key: p.provider.api_key.clone(),
            model: p.provider.model.clone(),
            capabilities: agent_loop::ModelCapabilities {
                supports_per_turn_reasoning_effort: p.provider.supports_per_turn_reasoning_effort,
                ..Default::default()
            },
            thinking_params: if p.provider.thinking_params.is_null() {
                json!({})
            } else {
                p.provider.thinking_params.clone()
            },
            thinking_by_effort: p.provider.thinking_by_effort.clone(),
            stream,
            headers: p
                .provider
                .headers
                .iter()
                .filter(|(name, _)| !(summariser && name.eq_ignore_ascii_case("x-conversation-id")))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            temperature: p.provider.temperature,
            proxy: p.provider.proxy.clone(),
            ..Default::default()
        };
        // Held as an Arc so what it learned about the model can be read back after the loop is done with it.
        let model = Arc::new(
            HttpModel::new(provider_config(p.provider.stream, false))?
                .with_on_delta(on_delta)
                .with_on_retry(on_retry)
                .with_known(known),
        );

        // One token for the whole run, registered under the host's id so `call.cancel` reaches it. Registered
        // BEFORE the first request goes out, so a cancel arriving during the opening round is not missed.
        let token = self.root_cancel.child_token();
        let task = agent_core::TaskId::from_host(p.run_id.clone());
        // A cancel that arrived before this id was registered. The same race the scheduled path handles:
        // the host can send `call.cancel` for a run whose request is still crossing the wire, and a cancel
        // that found nothing to cancel must not be silently dropped.
        let cancelled_early =
            self.register_call(&p.run_id, CallHandle { task: task.clone(), token: token.clone() });
        if cancelled_early {
            token.cancel();
        }

        let workspace = agent_tools::workspace::Workspace::new(&p.workdir)
            .with_assets(p.asset_dir.clone().unwrap_or_default());
        // Read once: the policy can be replaced mid-session, and the executor and its principal must agree.
        let session = self.permissions.current().policy().clone();
        // Only for a host that declared a policy — the same gate `sandbox_policy` uses before it adds a
        // command's cwd. A host that declared nothing gets the fail-closed runtime it always got: an agent
        // that can use no file tool at all (see `a_tool_call_outside_the_approved_roots_is_denied_inside_the_run`).
        let policy = if self.permissions.declared_roots().is_some() {
            policy_for_run(
                session,
                workspace.root(),
                p.asset_dir.as_deref().filter(|d| !d.is_empty()).map(std::path::Path::new),
            )
        } else {
            session
        };
        let executor = agent_dispatch::DispatchingExecutor::new(
            Arc::clone(&self.registry),
            Arc::new(PermissionRuntime::new(policy.clone()).with_approver(self.host_approver())),
            agent_dispatch::root_principal(task, agent_core::AgentId::from_host("main"), policy.ceiling),
            agent_tools::tool::ToolContext::new(
                workspace,
                token.clone(),
                agent_core::CallId::from_host(p.run_id.clone()),
                Arc::clone(&self.file_cache),
            ),
        )
        .with_host_tools(self.host_tools(&p.run_id, p.host_tools_only));
        let executor = match p.allowed_tools.clone() {
            Some(names) => executor.with_allowed_tools(names),
            None => executor,
        };

        struct RunObserver {
            run_id: String,
            events: tokio::sync::mpsc::UnboundedSender<RunEvent>,
            /// The delta forwarder's offsets, zeroed as each round starts (see `sent`).
            stream_offsets: Arc<std::sync::Mutex<(usize, usize)>>,
        }
        impl RunObserver {
            fn emit(&self, method: &'static str, params: Value) {
                let _ = self.events.send(RunEvent::Emit(method, params));
            }
        }
        impl agent_loop::LoopObserver for RunObserver {
            fn round_started(&self, round: u32, decision: &agent_loop::ReasoningDecision) {
                *self.stream_offsets.lock().unwrap_or_else(|e| e.into_inner()) = (0, 0);
                self.emit(EVENT_AGENT_TURN, json!({
                    "run_id": self.run_id,
                    "phase": "start",
                    "round": round,
                    "effort": decision.effort_param(),
                }));
            }
            // The reply itself, before its tools run: what a host that keeps the conversation stores first.
            fn response_received(&self, record: &agent_loop::AgentTurnRecord) {
                self.emit(EVENT_AGENT_TURN, json!({
                    "run_id": self.run_id,
                    "phase": "response",
                    "round": record.round,
                    "content": record.content,
                    "reasoning": record.reasoning,
                    "tool_calls": record.tool_calls,
                    "prompt_tokens": record.usage.prompt_tokens,
                    "completion_tokens": record.usage.completion_tokens,
                    "cached_tokens": record.usage.cached_tokens,
                    "estimated": record.usage.estimated,
                    "model_ms": record.model_ms,
                }));
            }
            fn round_finished(&self, record: &agent_loop::AgentTurnRecord) {
                self.emit(EVENT_AGENT_TURN, json!({
                    "run_id": self.run_id,
                    "phase": "end",
                    "round": record.round,
                    "tool_calls": record.tool_calls.len(),
                    "prompt_tokens": record.usage.prompt_tokens,
                    "completion_tokens": record.usage.completion_tokens,
                    "cached_tokens": record.usage.cached_tokens,
                    "estimated": record.usage.estimated,
                    "ms": record.ms,
                    "model_ms": record.model_ms,
                }));
            }
            // Arguments on start and the result on end, not just the name and a verdict.
            //
            // A timeline needs only "web_search, 1.2s, ok" — which is all automation ever read, and all these
            // carried. A chat window renders the call itself: the diff an edit made, the lines a read
            // returned, the command and its output. The tools the runtime executes on its own never pass
            // through the host, so these events are the ONLY place a UI can learn what they did. The result
            // is sent in full, as `tool.call` has always returned it.
            fn tool_started(&self, call: &agent_loop::ToolCall) {
                self.emit(EVENT_AGENT_TOOL, json!({
                    "run_id": self.run_id,
                    "phase": "start",
                    "id": call.id,
                    "name": call.name,
                    "arguments": call.arguments
                }));
            }
            fn tool_finished(&self, record: &agent_loop::ToolRecord) {
                self.emit(EVENT_AGENT_TOOL, json!({
                    "run_id": self.run_id,
                    "phase": "end",
                    "id": record.tool_call_id,
                    "name": record.name,
                    "args": record.args,
                    "content": record.content,
                    "ok": record.ok,
                    "ms": record.ms
                }));
            }
            fn flush(&self) -> Option<tokio::sync::oneshot::Receiver<()>> {
                let (delivered, done) = tokio::sync::oneshot::channel();
                self.events.send(RunEvent::Flush(delivered)).ok().map(|_| done)
            }
        }
        // The last sender moves into the observer, so the forwarder ends once the loop and the model are gone.
        let observer: Arc<dyn agent_loop::LoopObserver> =
            Arc::new(RunObserver { run_id: p.run_id.clone(), events: event_tx, stream_offsets });

        // Scoped so the loop — and with it the model, the delta callback, and the channel sender it owns — is
        // dropped before the forwarder is awaited below.
        let outcome = {
            let agent = AgentLoop::new(
                Arc::clone(&model) as Arc<dyn agent_loop::ModelClient>,
                Arc::new(executor),
                LoopConfig {
                    model: p.provider.model.clone(),
                    tools: p.tools,
                    stop_policy: run_stop_policy(),
                    // The stop policy measures `context_limit_fraction` against this. Without it the run has
                    // no idea how close to the window it is.
                    context_window: p.context_window,
                    parallel_safe: p.parallel_tools.iter().cloned().collect(),
                    // The ceiling each round's effort is resolved under. Without it the loop assumed "on, at
                    // medium", whatever the user had chosen.
                    thinking: p.thinking.as_ref().map(thinking_config).unwrap_or_default(),
                    replay_reasoning: p.replay_reasoning,
                },
            )
            .with_observer(observer);
            // Context management, when the host said how big the window is. Absent, the loop keeps
            // `PassThroughContext` and the conversation is sent exactly as it stands — which is what every run
            // did before this existed.
            let agent = match p.context_window {
                Some(window) => {
                    let summarizer_id =
                        p.summarizer_model.clone().unwrap_or_else(|| p.provider.model.clone());
                    // The host's working-set budget when it has one. Without it a turn was held only to its window
                    // — 85% of a 1M model is 850K — so a long turn on a large-window model grew for as long as it
                    // ran, whatever the user's budget said, and nothing was ever summarised.
                    let budget = match p.context_budget {
                        Some(b) => agent_context::Budget::with_thresholds(window, b.trigger_tokens, b.target_tokens),
                        None => agent_context::Budget::with_window(window),
                    };
                    let manager = agent_context::ContextManager::new(budget);
                    // A summariser is only useful if it can be reached; a provider this one cannot build is a
                    // reason to compact WITHOUT it rather than to fail the run.
                    let manager = match HttpModel::new(provider_config(false, true)) {
                        // The run's token, so a Stop reaches a summary request and its retry backoff directly,
                        // not only through the loop dropping the future that awaits it.
                        Ok(summary_model) => manager.with_summarizer(agent_context::Summarizer::new(
                            Arc::new(summary_model.with_known(known).with_cancellation(token.clone())),
                            summarizer_id,
                        )),
                        Err(e) => {
                            tracing::warn!(error = %e, "no summariser for this run; compaction will truncate");
                            manager
                        }
                    };
                    agent.with_context(Box::new(manager))
                }
                None => agent,
            };
            // Only for a run that asked. A gate the host did not request would put a round trip between every
            // round of every run, to ask a question nobody is answering.
            let agent = if p.round_gate { agent.with_gate(self.round_gate(&p.run_id)) } else { agent };
            agent.run(messages, token).await
        };

        // Every event is written before this method returns, and therefore before the reply.
        //
        // Without this the events race the answer: they are forwarded by a spawned task while the reply is
        // written by this one, so a client could receive the finished text and then its tokens. A test caught
        // exactly that — the run assembled "Hello world" correctly and not one delta had arrived.
        //
        // Read what the run learned about the model, and then RELEASE the model — before the forwarder below is
        // awaited. It ends only when every sender is dropped, and the delta and retry senders live in this
        // model's callbacks. The scoped block above exists to drop the others (see its comment); holding this Arc
        // past it kept the model's alive, and every run then waited forever for a reply that could not be
        // written. It deadlocked every `agent.run` on 2026-09-23 until the protocol suite hung.
        let q = model.quirks();
        drop(model);

        let _ = forwarder.await;

        self.inflight.remove(&p.run_id);
        let outcome = outcome?;

        let (prompt_tokens, completion_tokens, cached_tokens, estimated) =
            outcome.turns.iter().fold((0, 0, 0, false), |(p, c, k, e), t| {
                (
                    p + t.usage.prompt_tokens,
                    c + t.usage.completion_tokens,
                    k + t.usage.cached_tokens,
                    e || t.usage.estimated,
                )
            });
        let learned = agent_ipc::protocol::ProviderQuirks {
            thinking_unsupported: q.thinking_unsupported,
            reasoning_context_unsupported: q.reasoning_context_unsupported,
            vision_unsupported: q.vision_unsupported,
        };

        Ok(AgentRunResult {
            stop_reason: outcome
                .stop
                .reason
                .as_ref()
                .and_then(|r| serde_json::to_value(r).ok().and_then(|v| v.as_str().map(str::to_owned)))
                .unwrap_or_else(|| "unknown".to_owned()),
            detail: outcome.stop.detail.clone(),
            content: outcome.final_text().to_owned(),
            rounds: outcome.state.round(),
            tool_calls: outcome.state.tool_calls(),
            messages: outcome
                .messages
                .iter()
                .map(|m| serde_json::to_value(m).unwrap_or(Value::Null))
                .collect(),
            injected: outcome.injected.clone(),
            prompt_tokens,
            completion_tokens,
            cached_tokens,
            estimated,
            learned,
        })
    }
}

/// The session's policy, plus this run's own workspace.
///
/// ## Why a run grants its workspace
///
/// The filesystem ceiling is fixed at the handshake, from the workspace open AT BOOT. A run executes its file
/// tools against the workspace open NOW. The two differ the moment a user opens a project after launch — the
/// ordinary case — and every `read_file` the runtime ran inside `agent.run` was then refused as "outside the
/// configured ceiling", on a project the user had just opened. That shipped on 2026-09-21 with the automation
/// path, and went unnoticed because no automation test used a file tool the runtime executes itself.
///
/// The fix is the one the sandbox already made for the same problem: `sandbox_policy` adds each command's own
/// working directory, because a command confined away from the directory it was started in cannot do its job.
/// A run's workspace is the same kind of fact. It is chosen by the host — the chat bridge overwrites whatever
/// the renderer sends, the automation path reads the app's own setting — and never by the model, and the
/// runtime's file tools are already confined to it by `Workspace::resolve`. Granting it grants exactly what
/// the tools can reach and nothing more.
///
/// What this does NOT do is let the host widen the SESSION ceiling after the handshake, which session_policy
/// still refuses: the grant is scoped to this run's principal and ends with it. Nor does it apply to a host
/// that declared no policy at all — the caller only asks for it after checking `declared_roots()`, so the
/// fail-closed runtime stays fail-closed. The media root is added read-only, matching `readonly_roots`:
/// naming it must never make it writable.
///
/// ## Merged, never appended
///
/// A `Grant` holds ONE capability per kind: `allows` consults the first capability of a kind and ignores any
/// after it. The first version of this appended a second `FilesystemRead` beside the session's, compiled,
/// read naturally — and was ignored, so the run stayed denied. The run's roots are therefore folded into the
/// session's existing scope for each kind.
fn policy_for_run(session: Policy, workspace: &std::path::Path, assets: Option<&std::path::Path>) -> Policy {
    use agent_permission::Scope;

    let mut readable = vec![workspace.to_path_buf()];
    if let Some(a) = assets {
        readable.push(a.to_path_buf());
    }
    let adds = [
        (CapabilityKind::FilesystemRead, readable),
        (CapabilityKind::FilesystemWrite, vec![workspace.to_path_buf()]),
    ];

    let mut caps: Vec<Capability> = session.ceiling.capabilities().to_vec();
    for (kind, roots) in adds {
        match caps.iter_mut().find(|c| c.kind == kind) {
            Some(existing) => {
                existing.scope = match std::mem::replace(&mut existing.scope, Scope::Nothing) {
                    // Already everything: a person typed that into a config file, and it stays everything.
                    Scope::Unrestricted => Scope::Unrestricted,
                    Scope::Paths(mut paths) => {
                        for r in roots {
                            if !paths.contains(&r) {
                                paths.push(r);
                            }
                        }
                        Scope::Paths(paths)
                    }
                    // Nothing, or a scope of the wrong shape for a filesystem kind: the run's roots are the
                    // whole of what it may touch.
                    _ => Scope::Paths(roots),
                };
            }
            None => caps.push(Capability::paths(kind, roots)),
        }
    }

    Policy { ceiling: Grant::of(caps), approval_required: session.approval_required, max_depth: session.max_depth }
}

/// The stop policy every `agent.run` runs under: the defaults, without the per-round limit.
///
/// That limit was checked only AFTER a round had finished, so it never interrupted a round that was stuck — it
/// discarded one that had succeeded slowly. A `join_subagents` (ten minutes by default), a long build, a consent
/// prompt answered late: the tool returned, and the run then stopped with `round-timeout` before the model could
/// read what it had waited for. The TypeScript loop has no such limit. What bounds a stuck round is what it is
/// stuck in: the provider's idle timeout, each tool's own timeout, and Stop.
fn run_stop_policy() -> agent_loop::StopPolicyConfig {
    agent_loop::StopPolicyConfig { round_timeout: None, ..agent_loop::StopPolicyConfig::default() }
}

/// The user's thinking setting, as the loop reads it.
fn thinking_config(t: &agent_ipc::protocol::ThinkingSetting) -> agent_loop::ThinkingConfig {
    let effort = match t.effort.as_str() {
        "low" => agent_loop::Effort::Low,
        "high" => agent_loop::Effort::High,
        _ => agent_loop::Effort::Medium,
    };
    agent_loop::ThinkingConfig { enabled: t.enabled, effort }
}

#[cfg(test)]
#[path = "agent_run_tests.rs"]
mod tests;
