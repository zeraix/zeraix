//! `agent.run`: one whole agent turn inside the runtime, and the host bridges it asks through — tools, consent,
//! questions and the between-rounds gate. Split out of server.rs; the `Server` it extends is defined there.

use super::*;

impl Server {
    /// Ask the host whether one action may proceed.
    ///
    /// This is what turns the capability check from a wall into a decision. `agent-dispatch` consults the
    /// permission runtime, the permission runtime consults its `Approver`, and this is the approver that can
    /// reach a person — through `HostChannel`, the same runtime→host request path the sub-agent body uses.
    ///
    /// Holds a `HostChannel` rather than the `Server`: asking a question needs the channel and nothing else,
    /// and a long-lived `Arc<Server>` inside a permission object is a cycle waiting to be written.
    ///
    /// Denies on any failure — a timeout, a host that does not implement the method, a malformed reply. The
    /// default approver denies for the same reason, and it is the only safe direction: a runtime that cannot
    /// ask must not proceed as though it had asked and been told yes.
    fn host_approver(&self) -> Arc<dyn agent_permission::Approver> {
        struct HostApprover {
            channel: HostChannel,
        }
        #[async_trait::async_trait]
        impl agent_permission::Approver for HostApprover {
            async fn approve(
                &self,
                principal: &agent_permission::Principal,
                request: &agent_permission::Request,
            ) -> bool {
                let params = json!({
                    "capability": request.kind.as_str(),
                    "resource": format!("{:?}", request.resource),
                    "call": request.call.to_string(),
                    "agent": principal.agent.to_string(),
                    "depth": principal.depth,
                });
                match self.channel.ask(HOST_REQUEST_CONSENT, params, CONSENT_TIMEOUT).await {
                    Ok(v) => v.get("approved").and_then(Value::as_bool).unwrap_or(false),
                    Err(e) => {
                        tracing::warn!(error = %e, "consent request failed; denying");
                        false
                    }
                }
            }
        }
        Arc::new(HostApprover { channel: self.host_channel() })
    }

    /// The tools whose implementation is a person.
    ///
    /// Only `ask_user` today. Forwarded rather than answered because the runtime cannot render a dialog and
    /// must not guess — a question the model asks and answers itself is not a question.
    ///
    /// A failure is reported to the MODEL rather than raised: a host that cannot ask, or a user who closed the
    /// dialog, leaves the model needing to proceed without an answer, and telling it so is more useful than
    /// ending the turn.
    fn host_tools(&self, run_id: &str, everything: bool) -> Arc<dyn agent_dispatch::HostTools> {
        /// Everything a run may call that this runtime does not implement itself.
        ///
        /// ## Why it is "everything else" rather than a list
        ///
        /// The catalog a run is offered is not fixed and is not the runtime's to know: an MCP server connects
        /// mid-session and brings its tools with it, a plugin adds more, and the app's own tools (the browser
        /// panel, image generation, the todo list) were never going to live here. A list compiled into this
        /// binary would go stale the first time a user approved a server, and the symptom would be the model
        /// being told a tool it can see does not exist.
        ///
        /// So the rule is the complement of something the runtime *does* know exactly: its own registry. A name
        /// the registry serves is served here; anything else is the host's, including a name nobody implements —
        /// the host already words that refusal, and having two spellings of "unknown tool" is how a typo gets
        /// diagnosed differently depending on which side of the bridge it landed on.
        ///
        /// `ask_user` keeps its own path rather than joining the general one: it is answered by a person, so it
        /// carries a person's timeout rather than a tool's.
        ///
        /// ## Unless the host asked for everything
        ///
        /// A chat window runs every tool through one path of its own — consent prompts under the user's approval
        /// mode, the tool's row on screen, its usage-log entry, output capping — and that path already ends in
        /// this runtime's registry through `tool.call`. Serving `write_file` here, inside a chat turn, would skip
        /// the prompt the user set up to see before a file changes. So a run can hand EVERY call to the host,
        /// `ask_user` included (the window answers it as one of its own tools); the loop still runs here.
        struct HostBridge {
            channel: HostChannel,
            /// Which run this call belongs to. The host serves several at once and each carries its own tool
            /// policy — an automation refuses the tools that need a person, a chat window does not.
            run_id: String,
            /// Consulted, never called: this is only how the bridge knows which names are NOT its business.
            registry: Arc<ToolRegistry>,
            /// Every call goes to the host. See "Unless the host asked for everything" above.
            everything: bool,
        }
        #[async_trait::async_trait]
        impl agent_dispatch::HostTools for HostBridge {
            fn serves(&self, name: &str) -> bool {
                // Host tools are checked BEFORE the registry (see DispatchingExecutor::execute), so claiming a
                // name the runtime implements would route `read_file` back into Electron — undoing the
                // migration this bridge exists to complete.
                self.everything || name == "ask_user" || !self.registry.contains(name)
            }
            async fn call(&self, name: &str, args: &Value) -> agent_loop::ToolOutcome {
                if name == "ask_user" && !self.everything {
                    // Tagged with the run for the same reason `host.tool` is: the host serves several at once
                    // and a question means different things in each. An unattended automation refuses it; a
                    // chat window puts it to the person. A host that ignores the field is unaffected — it is
                    // additive, and the arguments it already reads are untouched beside it.
                    let mut tagged = args.clone();
                    if let Some(obj) = tagged.as_object_mut() {
                        obj.insert("run_id".to_owned(), json!(self.run_id));
                    }
                    return match self.channel.ask(HOST_REQUEST_ASK, tagged, ASK_TIMEOUT).await {
                        Ok(v) => {
                            // The host returns whatever shape its dialog produced; it goes to the model verbatim.
                            let text = v
                                .get("answers")
                                .map(|a| a.to_string())
                                .unwrap_or_else(|| v.to_string());
                            agent_loop::ToolOutcome::ok(text)
                        }
                        Err(e) => agent_loop::ToolOutcome::failed(format!(
                            "The question could not be put to the user: {e}. Proceed without an answer, or say \
                             what you need and stop."
                        )),
                    };
                }
                let params = json!({ "run_id": self.run_id, "name": name, "args": args });
                match self.channel.ask(HOST_REQUEST_TOOL, params, host_tool_timeout(self.everything)).await {
                    Ok(v) => {
                        let content = v
                            .get("content")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned();
                        // Absent `ok` means success: a host that answers with content and nothing else has
                        // produced a result, and reading that as a failure would make every terse reply an error.
                        if v.get("ok").and_then(Value::as_bool).unwrap_or(true) {
                            agent_loop::ToolOutcome::ok(content)
                        } else {
                            agent_loop::ToolOutcome::failed(content)
                        }
                    }
                    // The tool may well have run — the failure is in hearing back, not necessarily in doing.
                    // Said plainly, because the model's next move differs: retrying a write that already
                    // happened is how one edit becomes two.
                    Err(e) => agent_loop::ToolOutcome::failed(format!(
                        "{name} could not be completed by the app: {e}. It may or may not have taken effect — \
                         check the current state before retrying it."
                    )),
                }
            }
        }
        Arc::new(HostBridge {
            channel: self.host_channel(),
            registry: Arc::clone(&self.registry),
            run_id: run_id.to_owned(),
            everything,
        })
    }

    /// The host's between-rounds veto, for a run that asked for one.
    ///
    /// Fails CLOSED. A gate is a permission, and a permission that cannot be checked is not granted — the same
    /// rule `SessionPermissions::current` follows. The cost of the other choice is the one the gate exists to
    /// prevent: a spending limit that stops applying the moment the channel hiccups. Stopping still returns
    /// every round that completed, so the caller keeps the work rather than losing the run.
    fn round_gate(&self, run_id: &str) -> Arc<dyn agent_loop::RoundGate> {
        struct HostGate {
            channel: HostChannel,
            run_id: String,
        }
        #[async_trait::async_trait]
        impl agent_loop::RoundGate for HostGate {
            async fn before_round(&self, ctx: &agent_loop::RoundContext) -> agent_loop::RoundDecision {
                // The last round in the terms a host acts on: whether it said anything, what it ran, and what
                // the detector noticed. The calls' results are left out — the host has each one already, from
                // `agent.tool`, which the loop flushes before it asks.
                let last = ctx.last.as_ref().map(|l| {
                    json!({
                        "content_empty": l.content_empty,
                        "has_reasoning": l.has_reasoning,
                        "calls": l.calls.iter().map(|c| json!({
                            "id": c.id, "name": c.name, "args": c.args, "ok": c.ok,
                        })).collect::<Vec<_>>(),
                        "signals": l.signals.iter().map(|g| json!({
                            "call_id": g.call_id,
                            "name": g.name,
                            "signal": signal_label(g.signal),
                            "repeat": g.repeat,
                            "fail_streak": g.fail_streak,
                            "resource_hits": g.resource_hits,
                        })).collect::<Vec<_>>(),
                    })
                });
                let params = json!({
                    "run_id": self.run_id,
                    "round": ctx.round,
                    "prompt_tokens": ctx.usage.prompt_tokens,
                    "completion_tokens": ctx.usage.completion_tokens,
                    "final": ctx.after_final,
                    "last": last,
                });
                match self.channel.ask(HOST_REQUEST_ROUND, params, ROUND_GATE_TIMEOUT).await {
                    Ok(v) => {
                        if v.get("proceed").and_then(Value::as_bool).unwrap_or(true) {
                            let mut decision = agent_loop::RoundDecision::proceed();
                            decision.withdraw_tools =
                                v.get("withdraw_tools").and_then(Value::as_bool).unwrap_or(false);
                            // A message the host could not parse is dropped rather than failing the round: the
                            // run is mid-turn, and losing a nudge is recoverable where losing the turn is not.
                            decision.inject = v
                                .get("inject")
                                .and_then(Value::as_array)
                                .map(|xs| {
                                    xs.iter().filter_map(|m| serde_json::from_value(m.clone()).ok()).collect()
                                })
                                .unwrap_or_default();
                            decision.nudge = v
                                .get("nudge")
                                .and_then(Value::as_str)
                                .filter(|t| !t.is_empty())
                                .map(str::to_owned);
                            decision.resume = v.get("resume").and_then(Value::as_bool).unwrap_or(false);
                            decision
                        } else {
                            agent_loop::RoundDecision::stop(
                                v.get("detail")
                                    .and_then(Value::as_str)
                                    .unwrap_or("the app stopped this run")
                                    .to_owned(),
                            )
                        }
                    }
                    Err(e) => agent_loop::RoundDecision::stop(format!(
                        "the app could not be asked whether this run may continue: {e}"
                    )),
                }
            }
        }
        Arc::new(HostGate { channel: self.host_channel(), run_id: run_id.to_owned() })
    }

    /// Run one agent turn to completion.
    ///
    /// Called by the app for both of its loops. An automation agent node runs its whole turn here since
    /// 2026-09-21 (`electron/agent/turn.mjs` → `runWithModelInRuntime`). A chat turn runs here since 2026-09-23,
    /// behind `ZERAIX_RUST_CHAT_LOOP` (`src/app/agent/chat/runtimeRound.ts`), with `host_tools_only` so every tool
    /// keeps the chat's own consent and display path. Each caller keeps its own loop as the fallback. See
    /// docs/rust-runtime-migration-request.md.
    pub(super) async fn run_agent(&self, p: AgentRunParams) -> Result<AgentRunResult, ErrorBody> {
        use agent_loop::{AgentLoop, LoopConfig, Message, StopPolicyConfig};
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
        let sent = std::sync::Mutex::new((0usize, 0usize));
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

        struct RunObserver {
            run_id: String,
            events: tokio::sync::mpsc::UnboundedSender<RunEvent>,
        }
        impl RunObserver {
            fn emit(&self, method: &'static str, params: Value) {
                let _ = self.events.send(RunEvent::Emit(method, params));
            }
        }
        impl agent_loop::LoopObserver for RunObserver {
            fn round_started(&self, round: u32, decision: &agent_loop::ReasoningDecision) {
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
            Arc::new(RunObserver { run_id: p.run_id.clone(), events: event_tx });

        // Scoped so the loop — and with it the model, the delta callback, and the channel sender it owns — is
        // dropped before the forwarder is awaited below.
        let outcome = {
            let agent = AgentLoop::new(
                Arc::clone(&model) as Arc<dyn agent_loop::ModelClient>,
                Arc::new(executor),
                LoopConfig {
                    model: p.provider.model.clone(),
                    tools: p.tools,
                    stop_policy: StopPolicyConfig::default(),
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
                    let manager = agent_context::ContextManager::new(
                        agent_context::Budget::with_window(window),
                    );
                    // A summariser is only useful if it can be reached; a provider this one cannot build is a
                    // reason to compact WITHOUT it rather than to fail the run.
                    let manager = match HttpModel::new(provider_config(false, true)) {
                        Ok(summary_model) => manager.with_summarizer(agent_context::Summarizer::new(
                            Arc::new(summary_model.with_known(known)),
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

/// How long a consent request waits for a person.
///
/// Generous, because the thing at the other end is a human reading a dialog — a timeout that fires while they
/// are still deciding would deny an action they were about to allow, which reads as the app ignoring them.
const CONSENT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// How long a question to the user waits. Same reasoning as the consent timeout: a person is reading it.
const ASK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

/// How long a host-implemented tool may take.
///
/// Matches the host's own `CALL_TIMEOUT_MS` for a tool call in the other direction, because it bounds the same
/// thing from the other end: one tool doing one piece of work. Deliberately NOT a person's timeout — nothing on
/// this path waits for a human, and borrowing the ask timeout would leave a run stuck for ten minutes on an MCP
/// server that died.
const HOST_TOOL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

/// How long a tool may take when the host serves EVERY call — a chat window.
///
/// `HOST_TOOL_TIMEOUT`'s premise, that nothing on this path waits for a person, stops holding the moment the host
/// serves everything: a consent prompt is waiting for the user to read it, `ask_user` for an answer, and
/// `run_subagent` for a whole delegation. Three minutes would fail a tool the user was still deciding about, and
/// the chat's own loop has no such limit. Longer than the chat bridge's own thirty minutes, so the window's
/// timeout — which can say what it was waiting for — is the one that fires; cancellation reaches the call either
/// way, so a stopped run never waits this out.
const HOST_OWNED_TOOL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// The host-tool timeout for a run: see `HOST_TOOL_TIMEOUT` and `HOST_OWNED_TOOL_TIMEOUT`.
fn host_tool_timeout(host_serves_everything: bool) -> std::time::Duration {
    if host_serves_everything { HOST_OWNED_TOOL_TIMEOUT } else { HOST_TOOL_TIMEOUT }
}

/// How long the between-rounds question waits.
///
/// Short, and short on purpose: nothing at the other end is thinking, it is applying a rule it already knows.
/// A long timeout here would let a wedged host hold a run open between every round.
const ROUND_GATE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// A detector signal as the host names it — the spellings `onDoomSignal` in the chat page switches on.
fn signal_label(signal: agent_loop::DoomSignal) -> &'static str {
    match signal {
        agent_loop::DoomSignal::Identical => "identical",
        agent_loop::DoomSignal::Equivalent => "equivalent",
        agent_loop::DoomSignal::Resource => "resource",
        agent_loop::DoomSignal::Failing => "failing",
    }
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
mod tests {
    use super::*;

    #[test]
    fn a_host_that_serves_everything_gets_a_persons_timeout() {
        // A chat window's tools include a consent prompt and a whole delegation. Its bridge gives up at thirty
        // minutes (runtimeTurnBridge.mjs TOOL_TIMEOUT); the runtime must not give up first.
        assert!(host_tool_timeout(true) > std::time::Duration::from_secs(30 * 60));
        // Everyone else keeps the tool-sized bound: an MCP server that died must not hold a run for an hour.
        assert_eq!(host_tool_timeout(false), std::time::Duration::from_secs(180));
    }
}
