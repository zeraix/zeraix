//! `mcp.*`: connecting to, calling and supervising MCP servers. Split out of server.rs; the `Server` it extends
//! is defined there.

use super::*;

impl Server {
    /// `mcp.*`: connect, call, disconnect, approve and report MCP servers.
    pub(super) async fn handle_mcp(&self, method: &str, params: Value) -> Result<Value, ErrorBody> {
        match method {
            "mcp.connect" => {
                let p: McpConnectParams = parse(params)?;
                let max_response_bytes = ServerConfig::default().max_response_bytes;
                // A local program or a remote endpoint. The supervisor above is identical either way,
                // which is the point of the transport trait: reconnection, heartbeat, backpressure and
                // degradation are written once.
                let factory: Arc<dyn agent_mcp::TransportFactory> = match (&p.command, &p.url) {
                    (Some(command), None) => Arc::new(StdioFactory::new(StdioServer {
                        command: command.clone(),
                        args: p.args.clone(),
                        cwd: p.cwd.clone().map(Into::into),
                        env: p.env.clone(),
                        max_response_bytes,
                    })),
                    (None, Some(url)) => Arc::new(
                        HttpFactory::new(HttpServer {
                            url: url.clone(),
                            headers: p.headers.clone(),
                            max_response_bytes,
                        })
                        .map_err(|e| {
                            RuntimeError::invalid("mcp.bad_endpoint", e.describe())
                        })?,
                    ),
                    _ => {
                        return Err(RuntimeError::invalid(
                            "mcp.bad_config",
                            "an MCP server needs exactly one of `command` (local) or `url` (remote).",
                        )
                        .into())
                    }
                };
                let sup = self.mcp.add(p.id.clone(), factory, ServerConfig::default());

                // Watch this connection and push every transition. Started here rather than inside the
                // supervisor because who is told is the host's business, not the connection's.
                let mut rx = sup.watch_state();
                let events = Arc::clone(&self.events);
                let watched = Arc::clone(&sup);
                let id = p.id.clone();
                tokio::spawn(async move {
                    // `changed()` ends when the supervisor is dropped, which is the disconnect path.
                    while rx.changed().await.is_ok() {
                        let state = rx.borrow().clone();
                        let closed = matches!(state, ConnState::Closed);
                        if let Some(tx) = events.get().cloned() {
                            let status = describe_server(&id, &watched);
                            if let Ok(line) = serde_json::to_string(&Notification {
                                method: EVENT_MCP_STATE,
                                params: json!(status),
                            }) {
                                let _ = tx.send(line).await;
                            }
                        }
                        if closed {
                            break;
                        }
                    }
                });

                // Returns now, not when the server is ready: a connecting server must never delay a
                // turn. Readiness arrives as an mcp.state event.
                Ok(json!({ "id": p.id, "state": state_label(&sup.state()) }))
            }

            "mcp.call" => {
                let p: McpCallParams = parse(params)?;
                // Minted before the server lookup so that EVERY outcome below can be audited, including the
                // one where there is no server: "the agent tried to call something that is not connected" is
                // exactly the kind of thing an audit trail exists to show, and the first version of this
                // returned before any event was published.
                let call_id = p.call_id.clone().unwrap_or_else(|| CallId::new().to_string());

                // `ToolCallOutcome` has no error variant by construction: an external server must not
                // be able to abort a turn, which is the same invariant `callMcpTool` carries in JS.
                let Some(sup) = self.mcp.get(&p.server) else {
                    let detail = format!("no MCP server named '{}' is connected", p.server);
                    self.bus.publish(agent_events::EventKind::McpCalled {
                        call: CallId::from_host(call_id),
                        server: p.server.clone(),
                        tool: p.tool.clone(),
                        delivered: false,
                        detail: Some(detail.clone()),
                    });
                    return Ok(json!(McpCallResult { delivered: false, raw: None, error: Some(detail) }));
                };
                // Permission, before the call goes out (TODO §4.1 MCP Capability, §12 MCP Permission Bypass).
                //
                // Unconditional as of 2026-09-01 (§0.2 F7 resolved). It was gated on the host having declared
                // a policy, because a host that declared nothing got a ceiling granting nothing and would have
                // lost MCP entirely. That gate is gone: §12's "MCP must not bypass Runtime Permission" is not
                // a property that can hold for some hosts and not others.
                //
                // The consequence is deliberate and worth stating plainly: a server the host has not approved —
                // at the handshake or through `mcp.set_approved` — has no MCP tools. That is the same shape as
                // the filesystem ceiling, and the same shape as fail-open's removal — the runtime no longer has
                // a permissive mode to fall into.
                let permissions = self.permissions.current();
                let decision = permissions
                    .decide(
                        &Principal {
                            task: agent_core::TaskId::from_host(call_id.clone()),
                            agent: agent_core::AgentId::from_host("main"),
                            depth: 0,
                            grant: permissions.policy().ceiling.clone(),
                        },
                        &agent_permission::Request {
                            kind: agent_permission::CapabilityKind::McpInvoke,
                            resource: agent_permission::Resource::Name(p.server.clone()),
                            call: CallId::from_host(call_id.clone()),
                            // No justification, for the reason `agent-dispatch` gives: text the model supplies
                            // must have nothing to influence.
                            justification: None,
                        },
                    )
                    .await;
                if !decision.is_allowed() {
                    // A refusal is a RESULT, not an error: `McpCallResult` has no error variant that aborts a
                    // turn, and a denied MCP call is something the model should read and work around.
                    let reason = match &decision {
                        agent_permission::Decision::Deny { reason } => reason.clone(),
                        agent_permission::Decision::NeedsApproval { reason } => {
                            format!("this needs the user's approval and none was given: {reason}")
                        }
                        agent_permission::Decision::Allow => unreachable!("checked above"),
                    };
                    self.bus.publish(agent_events::EventKind::McpCalled {
                        call: CallId::from_host(call_id.clone()),
                        server: p.server.clone(),
                        tool: p.tool.clone(),
                        delivered: false,
                        detail: Some(format!("denied: {reason}")),
                    });
                    return Ok(json!(McpCallResult {
                        delivered: false,
                        raw: None,
                        error: Some(format!(
                            "Permission denied for MCP server '{}' (mcp.invoke): {reason}. Nothing was sent.",
                            p.server
                        )),
                    }));
                }

                // Scheduled like tools and commands, so `call.cancel` reaches an MCP call the same way
                // it reaches anything else -- without which a stopped turn would leave the call holding
                // its backpressure permit until the server answered. The per-server in-flight cap in
                // `agent-mcp` still applies underneath; this one bounds MCP work across all servers.
                let tool = p.tool.clone();
                let args = p.args.clone();
                let out = self
                    .scheduled(
                        format!("mcp:{}/{}", p.server, p.tool),
                        ResourceClass::Mcp,
                        Some(&call_id),
                        // The supervisor owns the per-call timeout, and it words the failure for the
                        // model; a second ceiling here would just race it.
                        None,
                        move |cancel| {
                            let sup = Arc::clone(&sup);
                            let tool = tool.clone();
                            let args = args.clone();
                            Box::pin(async move { sup.call_cancellable(&tool, args, &cancel).await })
                        },
                    )
                    .await;
                let Some(out) = out else {
                    return Ok(json!(McpCallResult {
                        delivered: false,
                        raw: None,
                        error: Some("the call was cancelled".to_owned()),
                    }));
                };
                self.bus.publish(agent_events::EventKind::McpCalled {
                    call: CallId::from_host(call_id.clone()),
                    server: p.server.clone(),
                    tool: p.tool.clone(),
                    delivered: out.raw.is_some(),
                    detail: out.raw.is_none().then(|| out.content.clone()),
                });
                // `raw` present means a server answered, whatever it said. The host reads `isError`
                // off it and does its own flattening — see `McpToolDescriptor`.
                Ok(json!(match out.raw {
                    Some(raw) => McpCallResult { delivered: true, raw: Some(raw), error: None },
                    None => McpCallResult { delivered: false, raw: None, error: Some(out.content) },
                }))
            }

            "mcp.disconnect" => {
                let p: McpServerParams = parse(params)?;
                match self.mcp.get(&p.id) {
                    Some(sup) => {
                        sup.shutdown().await;
                        Ok(json!({ "disconnected": true }))
                    }
                    None => Ok(json!({ "disconnected": false })),
                }
            }

            // The user approved or withdrew a server after the handshake. See `session_policy`.
            "mcp.set_approved" => {
                let p: McpSetApprovedParams = parse(params)?;
                Ok(json!({ "applied": self.permissions.set_approved_mcp_servers(p.servers) }))
            }

            "mcp.status" => Ok(json!(McpStatusResult {
                servers: self
                    .mcp
                    .ids()
                    .into_iter()
                    .filter_map(|id: String| self.mcp.get(&id).map(|sup| describe_server(&id, &sup)))
                    .collect(),
            })),

            other => Err(RuntimeError::invalid(
                "protocol.unknown_method",
                format!("unknown method: {other}"),
            )
            .into()),
        }
    }
}

/// The wire label for a connection state.
fn state_label(state: &ConnState) -> String {
    match state {
        ConnState::Idle => "idle",
        ConnState::Connecting => "connecting",
        ConnState::Ready => "ready",
        ConnState::Degraded { .. } => "degraded",
        ConnState::Failed { .. } => "failed",
        ConnState::Closed => "closed",
    }
    .to_owned()
}

/// One server's state and current declarations, in the shape the host consumes.
fn describe_server(id: &str, sup: &agent_mcp::ConnectionSupervisor) -> McpServerStatus {
    let state = sup.state();
    let reason = match &state {
        ConnState::Degraded { reason } | ConnState::Failed { reason } => Some(reason.clone()),
        _ => None,
    };
    McpServerStatus {
        id: id.to_owned(),
        state: state_label(&state),
        reason,
        stderr: sup.diagnostics(),
        // Empty unless ready — the supervisor's rule, not this function's: a server that cannot serve
        // a call must not be declaring tools to the model.
        tools: sup
            .tools_snapshot()
            .into_iter()
            .map(|t| McpToolDescriptor {
                // The server's own name, not the namespaced one: the host owns that scheme.
                name: t.remote_name,
                description: t.description,
                input_schema: t.parameters,
            })
            .collect(),
    }
}
