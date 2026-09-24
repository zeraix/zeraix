//! `process.*`: foreground commands and long-lived services. Split out of server.rs; the `Server` it extends is
//! defined there.

use super::*;

impl Server {
    /// `process.*`: run a command, and start, peek at, list and stop services.
    pub(super) async fn handle_process(&self, method: &str, params: Value) -> Result<Value, ErrorBody> {
        match method {
            "process.run" => {
                let p: ProcessRunParams = parse(params)?;
                Ok(json!(self.run_process(p).await))
            }

            "process.start_background" => {
                let p: StartBackgroundParams = parse(params)?;
                // The sender outlives the call that started the service: the callback runs long
                // after this request has been answered.
                let events = Arc::clone(&self.events);
                let command = p.command.clone();
                // Confined exactly as a foreground command is. A service is the longer-lived of the two —
                // it is still running when the conversation that started it has moved on — so leaving it
                // unconfined while `run_command` was confined protected the wrong half.
                let confinement = agent_sandbox::confinement_hook(
                    &self.sandbox_policy(p.cwd.as_deref()).unwrap_or_default(),
                );
                let pid = self
                    .background
                    .start_confined(&p.command, p.cwd.map(Into::into), confinement, move |exited| {
                        // Retirement happens inside the registry before this fires, so a `process.list`
                        // racing the event cannot report a service that has already ended.
                        if let Some(tx) = events.get().cloned() {
                            let event = ProcessExitedEvent {
                                pid: exited.pid,
                                code: exited.code,
                                signal: exited.signal,
                                output: exited.output,
                                command: exited.command,
                            };
                            // Spawned because the reaper's callback is synchronous and writing to the
                            // host is not. Losing the event would leave a dead service showing as
                            // running in the UI, so it is worth a task.
                            tokio::spawn(async move {
                                match serde_json::to_string(&Notification {
                                    method: EVENT_PROCESS_EXITED,
                                    params: json!(event),
                                }) {
                                    Ok(line) => {
                                        if let Err(e) = tx.send(line).await {
                                            tracing::warn!(error = %e, "failed to push process.exited");
                                        }
                                    }
                                    Err(e) => tracing::error!(error = %e, "failed to encode process.exited"),
                                }
                            });
                        }
                    })
                    .map_err(|e| {
                        // A service that could not start is a real error rather than a result: unlike a
                        // command that ran and failed, there is no output to report and no pid to track.
                        RuntimeError::new("process.spawn_failed", ErrorClass::Internal, e)
                    })?;
                tracing::info!(pid, command = %command, "background service started");
                Ok(json!(StartBackgroundResult { pid }))
            }

            "process.peek" => {
                let p: PidParams = parse(params)?;
                // A finished service still answers, with `alive: false` and the output it left
                // behind — see RECENTLY_EXITED_KEPT. An unknown pid answers empty.
                Ok(match self.background.peek(p.pid) {
                    Some((alive, output)) => json!(PeekResult { alive, output }),
                    None => json!(PeekResult { alive: false, output: String::new() }),
                })
            }

            "process.stop" => {
                let p: PidParams = parse(params)?;
                Ok(json!(StoppedResult { stopped: self.background.stop(p.pid) }))
            }

            "process.list" => Ok(json!(ServiceListResult {
                services: self
                    .background
                    .list()
                    .into_iter()
                    .map(|(pid, command)| ServiceDescriptor { pid, command })
                    .collect(),
            })),

            "process.stop_all" => Ok(json!({ "stopped": self.background.stop_all() })),

            other => Err(RuntimeError::invalid(
                "protocol.unknown_method",
                format!("unknown method: {other}"),
            )
            .into()),
        }
    }

    /// Run one foreground command, tracked so it can be cancelled by id.
    ///
    /// The host calls this from `native.mjs`'s `run()`, which means everything above that function
    /// keeps its behaviour: the `run_command` guardrails, the engine choice, the sandbox fallback and
    /// the result wording all stay in JS. What moves is the execution — and with it the two properties
    /// the JS path cannot have: a Stop that actually reaches the process tree, and output that stops
    /// being read at the cap instead of being buffered whole and trimmed afterwards.
    ///
    /// No workspace containment check, deliberately. `run()` accepts any `cwd` today and the caller
    /// chooses it; adding a restriction here would be a security control invented mid-migration, in the
    /// one place where a difference from the JS path shows up as a command that inexplicably refuses to
    /// run. Confinement belongs to `agent-sandbox` and the permission runtime, gated by their own stage.
    async fn run_process(&self, p: ProcessRunParams) -> ProcessRunResult {
        use agent_process::{ExitCode, ProcessRequest};

        let call_id = p.call_id.clone().unwrap_or_else(|| CallId::new().to_string());

        let mut req = ProcessRequest::new(p.command.clone());
        if let Some(dir) = &p.cwd {
            req = req.in_dir(dir);
        }
        // Confinement (TODO §4.2, §11 Sandbox Decision, §15 "Sandbox is enforced by Runtime").
        //
        // `agent-sandbox` has been complete and orphaned since it was built: nothing depended on it, so
        // "Sandbox is enforced by Runtime" was a diagram. It is applied here because this is the only place a
        // command is spawned, and Landlock has to be applied IN THE CHILD between fork and exec — applying it
        // in the parent would confine this runtime irrevocably for the rest of its life.
        //
        // Gated on the host having declared a policy, for the same reason the MCP check is: a host that
        // declared nothing gets an empty allowlist, and confining every command to nothing would break every
        // build, test and git command that works today. See §0.2 F7.
        let sandbox_policy = self.sandbox_policy(p.cwd.as_deref()).unwrap_or_default();
        if let Some(ms) = p.timeout_ms {
            req = req.with_timeout(std::time::Duration::from_millis(ms));
        }
        if let Some(cap) = p.max_buffer {
            // Saturating rather than `as`: a host sending a cap larger than this platform's usize
            // means "do not cap", and wrapping it into a small number would silently truncate output.
            req = req.with_max_buffer(usize::try_from(cap).unwrap_or(usize::MAX));
        }

        // Through the scheduler, which bounds how many host commands can run at once — the JS path
        // has no such cap, so a model that fans out into twenty builds gets twenty.
        let joined = self
            .scheduled(
                format!("process:{}", p.command.chars().take(40).collect::<String>()),
                ResourceClass::Process,
                Some(&call_id),
                // No task timeout: the command carries its own, and `agent-process` reports a killed
                // command as a RESULT with its partial output. A scheduler timeout would discard that.
                None,
                move |cancel| {
                    let req = req.clone();
                    let policy = sandbox_policy.clone();
                    // Spawned for the same reason `call_tool` spawns: a panic becomes this call's
                    // failure rather than a request the host waits out to its 180s timeout.
                    //
                    // Always through the backend, even when the policy is empty. With nothing to enforce it
                    // runs `agent_process::run` exactly as before and reports `NotRequested` — so there is one
                    // spawn path rather than two, and the sandbox cannot be forgotten on one of them.
                    Box::pin(async move {
                        tokio::spawn(async move {
                            let sandbox_req = agent_sandbox::SandboxRequest {
                                command: req.command.clone(),
                                cwd: req.cwd.clone(),
                                env: req.env.clone(),
                                policy,
                                limits: req.limits,
                                timeout: req.timeout,
                                max_buffer: req.max_buffer,
                            };
                            // The trait has to be in scope for its method to be callable.
                            use agent_sandbox::ExecutionBackend as _;
                            let out = agent_sandbox::NativeBackend::new().execute(sandbox_req, &cancel).await;
                            (out.process, out.report)
                        })
                        .await
                    })
                },
            )
            .await;

        let Some(joined) = joined else {
            // Refused or cancelled before it produced anything. Reported as a user stop, which is the
            // only way a caller can reach this today.
            return ProcessRunResult {
                stdout: String::new(),
                stderr: String::new(),
                code: json!("?"),
                killed: false,
                canceled: true,
                truncated: false,
            };
        };

        match joined {
            Ok((r, report)) => {
                // What actually confined this command, published so the audit trail records a decision rather
                // than an intention (TODO §11 Sandbox Decision). Reported even when nothing was enforced: "not
                // requested" and "requested and unavailable" are different facts, and only one of them is a
                // problem.
                tracing::debug!(
                    filesystem = %report.filesystem.describe(),
                    network = %report.network.describe(),
                    "command finished"
                );
                self.bus.publish(agent_events::EventKind::SandboxDecided {
                    call: CallId::from_host(call_id.clone()),
                    filesystem: report.filesystem.describe(),
                    network: report.network.describe(),
                });
                ProcessRunResult {
                    stdout: r.stdout,
                    stderr: r.stderr,
                    code: match r.code {
                        ExitCode::Code(c) => json!(c),
                        ExitCode::Unknown => json!("?"),
                    },
                    killed: r.killed,
                    canceled: r.canceled,
                    truncated: r.truncated,
                }
            }
            Err(join_err) => {
                tracing::error!(error = %join_err, "process task failed");
                // Shaped like a spawn failure, which is what the JS path reports when the child could
                // not start: the reason on stderr, an unknown code, and no exception for a caller that
                // has no way to handle one.
                ProcessRunResult {
                    stdout: String::new(),
                    stderr: format!("the runtime failed to run this command: {join_err}"),
                    code: json!("?"),
                    killed: false,
                    canceled: false,
                    truncated: false,
                }
            }
        }
    }
}
