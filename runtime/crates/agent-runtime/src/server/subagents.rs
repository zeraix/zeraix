//! `subagent.*`: delegations scheduled by the runtime and run by the host. Split out of server.rs; the `Server`
//! it extends is defined there.

use super::*;

impl Server {
    /// `subagent.*`: spawn, join, cancel and report delegations.
    pub(super) async fn handle_subagent(&self, method: &str, params: Value) -> Result<Value, ErrorBody> {
        match method {
            "subagent.spawn" => {
                let p: SubagentSpawnParams = parse(params)?;
                let sup = self.supervisor_for(&p.turn);
                let mut spawned = Vec::with_capacity(p.jobs.len());
                for spec in p.jobs {
                    let meta = spec.meta.clone();
                    let turn = p.turn.clone();
                    let this = self.host_channel();
                    // The body is a call back into the host. Everything the runtime is good at --
                    // ordering, coalescing, quotas, the cancellation tree -- happens around it; what
                    // it wraps is a model conversation, which belongs where the models are.
                    let body: agent_subagents::DelegationBody = Box::new(move |ctx| {
                        Box::pin(async move {
                            let params = json!({
                                "turn": turn,
                                "job": ctx.agent.to_string(),
                                "meta": meta,
                                "depth": ctx.depth,
                            });
                            // Deliberately NOT racing `ctx.cancel` here. The supervisor already does:
                            // it gives a cancelled body a grace window to return its own partial
                            // conclusion and then aborts it, which is what produces a `cancelled`
                            // outcome. A body that noticed the token itself and returned `Err` would
                            // report the delegation as FAILED instead — the same conclusion the model
                            // draws when a sub-agent genuinely broke. Dropping this future is the
                            // cancellation, and `ask` cleans up after itself when that happens.
                            this.ask(HOST_RUN_SUBAGENT, params, SUBAGENT_BODY_TIMEOUT)
                                .await
                                .map(|v| {
                                    v.get("result")
                                        .and_then(Value::as_str)
                                        .unwrap_or_default()
                                        .to_owned()
                                })
                        })
                    });
                    let r = sup.spawn(spec.meta, spec.key, self.child_grant(&p.turn), body);
                    spawned.push(SubagentSpawned {
                        id: r.id,
                        coalesced: r.coalesced,
                        refused: r.refused,
                    });
                }
                Ok(json!(SubagentSpawnResult { jobs: spawned }))
            }

            "subagent.join" => {
                let p: SubagentJoinParams = parse(params)?;
                let Some(sup) = self.subagents.get(&p.turn).map(|e| Arc::clone(&e)) else {
                    // Nothing was ever spawned for this turn. Every id asked for is unknown, which is
                    // what the model gets told rather than an error it cannot act on.
                    return Ok(json!(SubagentJoinResult {
                        ready: vec![],
                        pending: vec![],
                        unknown: p.ids,
                        timed_out: false,
                    }));
                };
                let mode = if p.mode.as_deref() == Some("any") { JoinMode::Any } else { JoinMode::All };
                let timeout = p
                    .timeout_ms
                    .map(std::time::Duration::from_millis)
                    .map(|d| d.min(JOIN_MAX_TIMEOUT));
                let r = sup.join(&p.ids, mode, timeout, p.block).await;
                Ok(json!(SubagentJoinResult {
                    ready: r
                        .ready
                        .into_iter()
                        .map(|(view, outcome)| SubagentOutcome {
                            id: outcome.id,
                            meta: view.meta,
                            state: format!("{:?}", outcome.state).to_lowercase(),
                            result: outcome.result,
                            ms: outcome.ms,
                            coalesced: view.coalesced,
                        })
                        .collect(),
                    pending: r.pending,
                    unknown: r.unknown,
                    timed_out: r.timed_out,
                }))
            }

            "subagent.cancel" => {
                let p: SubagentTurnParams = parse(params)?;
                if let Some(sup) = self.subagents.get(&p.turn) {
                    sup.cancel_all(p.reason.as_deref().unwrap_or("the turn was interrupted"));
                }
                Ok(json!({ "ok": true }))
            }

            "subagent.status" => {
                let p: SubagentTurnParams = parse(params)?;
                let Some(sup) = self.subagents.get(&p.turn).map(|e| Arc::clone(&e)) else {
                    return Ok(json!(SubagentStatus {
                        turn: p.turn,
                        queued: 0,
                        running: 0,
                        settled: 0,
                        total: 0,
                        outstanding: vec![],
                    }));
                };
                let (queued, running, settled, total) = sup.counts();
                Ok(json!(SubagentStatus {
                    turn: p.turn,
                    queued,
                    running,
                    settled,
                    total,
                    outstanding: sup.outstanding(),
                }))
            }

            other => Err(RuntimeError::invalid(
                "protocol.unknown_method",
                format!("unknown method: {other}"),
            )
            .into()),
        }
    }

    /// The grant a delegation of `turn` should start with.
    ///
    /// Derived through `issue_child` rather than written here, so the rule lives in one place: sub-agents do
    /// not inherit elevated capabilities, and beyond the depth limit they starve out to nothing rather than
    /// erroring. Before this, the spawn site passed `Grant::empty()` literally — correct at the time, and the
    /// kind of correct that stops being correct the moment a policy is configured and nobody remembers this
    /// line exists.
    ///
    /// With no ceiling configured the result is still empty, so behaviour is unchanged for a host that sends
    /// no `workspace_roots`.
    fn child_grant(&self, turn: &str) -> Grant {
        let Some(permissions) = self.permissions.get() else { return Grant::empty() };
        // The turn's own principal. Depth 0: this is the main agent, and the delegation about to be spawned is
        // its first level of children.
        //
        // The parent holds exactly what the user approved — the ceiling itself — rather than an unrestricted
        // grant. `Scope::Unrestricted` is deliberately something no code path constructs: it is the one scope
        // that has to be typed by a person into a config file, and manufacturing one here to then clamp it
        // would be the runtime widening its own ceiling in a way review could not see.
        let parent = Principal {
            task: agent_core::TaskId::from_host(turn),
            agent: agent_core::AgentId::from_host("main"),
            depth: 0,
            grant: permissions.policy().ceiling.clone(),
        };
        permissions.issue_child(&parent)
    }

    /// The supervisor for one turn, created on first use.
    ///
    /// Its cancellation token derives from the runtime root, so shutting the runtime down cancels every
    /// delegation beneath every turn without anyone keeping a list.
    fn supervisor_for(&self, turn: &str) -> Arc<SubAgentSupervisor<Value>> {
        if let Some(existing) = self.subagents.get(turn) {
            return Arc::clone(&existing);
        }
        let sup = Arc::new(SubAgentSupervisor::new(
            agent_core::TaskId::new(),
            &self.root_cancel,
            self.bus.clone(),
        ));
        // `entry` rather than `insert`: two spawns for one turn can race here, and the loser must get
        // the supervisor that won rather than a second one holding half the jobs.
        Arc::clone(self.subagents.entry(turn.to_owned()).or_insert(sup).value())
    }
}

/// How long a delegation may wait for the host to run it.
///
/// Generous because the work behind it is a whole sub-agent conversation — rounds of model calls and
/// tool execution. It is a backstop against a host that has stopped answering, not a task deadline:
/// the real bound is the caller's own cancellation, which reaches the delegation immediately.
const SUBAGENT_BODY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30 * 60);
