//! What a run reaches back to its host for: consent, the tools the runtime does not serve, and the round gate.
//!
//! Each bridge is a thin adapter from a trait the loop or the dispatcher calls onto one `host.*` request, and each
//! carries the timeout that request deserves.

use super::*;

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
/// the chat's own loop has no such limit. Longer than the chat bridge's own 45 minutes, so the window's
/// timeout — which can say what it was waiting for — is the one that fires; cancellation reaches the call either
/// way, so a stopped run never waits this out.
const HOST_OWNED_TOOL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// The host-tool timeout for a run: see `HOST_TOOL_TIMEOUT` and `HOST_OWNED_TOOL_TIMEOUT`.
pub(super) fn host_tool_timeout(host_serves_everything: bool) -> std::time::Duration {
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
    pub(super) fn host_approver(&self) -> Arc<dyn agent_permission::Approver> {
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
    pub(super) fn host_tools(&self, run_id: &str, everything: bool) -> Arc<dyn agent_dispatch::HostTools> {
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
            async fn call(&self, call_id: &str, name: &str, args: &Value) -> agent_loop::ToolOutcome {
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
                let params = json!({ "run_id": self.run_id, "call_id": call_id, "name": name, "args": args });
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
    pub(super) fn round_gate(&self, run_id: &str) -> Arc<dyn agent_loop::RoundGate> {
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
}
