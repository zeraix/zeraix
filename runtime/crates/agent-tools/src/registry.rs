//! The tool registry: the single chokepoint every tool call passes through (spec §7).
//!
//! Registration is explicit and the map is immutable once built, so "which tools exist" is a property
//! of the binary rather than of whatever happened to register itself first. That matters more here than
//! it looks: the host declares this list to the model, and `toolRouter.ts` documents why the declared
//! set must not change within a conversation — tool schemas sit ahead of `messages` in the cached
//! prefix, so adding one mid-conversation re-prefills from token 0 and throws away the KV cache.

use agent_core::{CancellationToken, ErrorClass, Result, RuntimeError};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Instant;

use crate::schema::{validate, ValidationMode};
use crate::tool::{Tool, ToolContext, ToolMetadata, ToolOutput};

/// A finished call, with the timing the audit log wants.
#[derive(Debug, Clone)]
pub struct ToolInvocation {
    pub content: String,
    pub duration_ms: u64,
}

#[derive(Default)]
pub struct ToolRegistry {
    /// What to do when arguments do not match a tool's declared schema.
    ///
    /// `Warn` by default, and that is not timidity — see `schema.rs`. The JS handlers are lenient in
    /// ways their schemas do not describe, so enforcing would reject calls that work today. Warning
    /// gathers the evidence needed to decide, per tool, whether enforcing is safe.
    validation: ValidationMode,
    /// `BTreeMap` so `list()` is ordered deterministically. The host sends this list to the model in
    /// the prompt prefix; a map with a nondeterministic iteration order would reshuffle the prefix
    /// between runs and defeat prompt caching for no reason at all.
    tools: BTreeMap<&'static str, Arc<dyn Tool>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Set what happens when arguments do not match a tool's schema.
    pub fn with_validation(mut self, mode: ValidationMode) -> Self {
        self.validation = mode;
        self
    }

    pub fn validation_mode(&self) -> ValidationMode {
        self.validation
    }

    /// Register a tool. Panics on a duplicate name — a startup-time programming error, not a runtime
    /// condition, and silently keeping one of two tools with the same name is strictly worse.
    pub fn register(&mut self, tool: Arc<dyn Tool>) {
        let name = tool.metadata().name;
        if self.tools.insert(name, tool).is_some() {
            panic!("duplicate tool registration: {name}");
        }
    }

    /// Every registered tool's metadata, in a stable order.
    pub fn list(&self) -> Vec<ToolMetadata> {
        self.tools.values().map(|t| t.metadata()).collect()
    }

    pub fn get(&self, name: &str) -> Option<&Arc<dyn Tool>> {
        self.tools.get(name)
    }

    pub fn contains(&self, name: &str) -> bool {
        self.tools.contains_key(name)
    }

    pub fn len(&self) -> usize {
        self.tools.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }

    /// Execute a tool with the uniform wrapper: timeout, cancellation, and cache invalidation.
    ///
    /// The `select!` is the part that matters. A tool that never polls its token — or one blocked in a
    /// syscall — cannot be *made* to return, but the caller stops waiting on it and gets a cancellation
    /// result in bounded time. That is the difference between "Stop works" and "Stop appears to do
    /// nothing for a minute", which is exactly the symptom the JS `run_command` path documents.
    pub async fn execute(&self, name: &str, ctx: &ToolContext, args: &Value) -> Result<ToolInvocation> {
        let tool = self.tools.get(name).ok_or_else(|| {
            RuntimeError::invalid("tool.not_found", format!("Unknown tool: {name}"))
        })?;
        let meta = tool.metadata();
        let started = Instant::now();

        // Cheap pre-check: if the caller already gave up, do not start work at all.
        ctx.check_cancelled()?;

        // Schema check. In `Warn` mode this only records; the tool still runs with exactly the
        // arguments it was given, which is what keeps parity with the JS handlers intact.
        if self.validation != ValidationMode::Off {
            let violations = validate(&meta.input_schema, args);
            if !violations.is_empty() {
                let detail = violations.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("; ");
                if self.validation == ValidationMode::Enforce {
                    return Err(RuntimeError::invalid(
                        "tool.invalid_arguments",
                        format!("invalid arguments for {name}: {detail}"),
                    ));
                }
                tracing::warn!(tool = name, violations = %detail, "tool arguments do not match the declared schema");
            }
        }

        let result = match meta.timeout_ms {
            Some(ms) => {
                let deadline = std::time::Duration::from_millis(ms);
                match tokio::time::timeout(deadline, run_cancellable(tool.as_ref(), ctx, args)).await {
                    Ok(r) => r,
                    Err(_) => {
                        // Spec §15: a timeout must *cause* cancellation, not merely report one.
                        ctx.cancel.cancel();
                        Err(RuntimeError::timeout(meta.name, ms))
                    }
                }
            }
            None => run_cancellable(tool.as_ref(), ctx, args).await,
        };

        match result {
            Ok(ToolOutput { content, invalidates_file_list }) => {
                if invalidates_file_list {
                    ctx.file_cache.invalidate(ctx.root());
                }
                Ok(ToolInvocation { content, duration_ms: started.elapsed().as_millis() as u64 })
            }
            Err(e) => Err(e),
        }
    }
}

/// Race a tool against its cancellation token.
async fn run_cancellable(tool: &dyn Tool, ctx: &ToolContext, args: &Value) -> Result<ToolOutput> {
    let cancel = ctx.cancel.clone();
    tokio::select! {
        // Biased so a token cancelled before the first poll wins deterministically, rather than
        // depending on which branch the scheduler happens to try first.
        biased;
        _ = cancel.cancelled() => Err(RuntimeError::cancelled()),
        r = tool.execute(ctx, args) => r,
    }
}

/// Map a runtime error onto the `{ ok, content }` shape the JS seam has always returned.
///
/// This is the compatibility layer in one function. `runTool` in `aiToolkit.mjs` never throws — every
/// failure is `{ ok: false, content: "<sentence>" }` — and a great deal of the app depends on that
/// without saying so: an MCP server or plugin that threw would otherwise abort a turn. The structured
/// error still travels beside this on the wire for callers that want it; this is what a model reads.
pub fn to_legacy_content(name: &str, err: &RuntimeError) -> String {
    match err.class {
        // Worded to match the JS runtime's cancellation strings, which the UI already renders.
        ErrorClass::Cancelled if err.code == "runtime.cancelled" => {
            "The user stopped this operation.".to_owned()
        }
        _ => format!("Error in {name}: {}", err.message),
    }
}

/// Build a cancellation token that is a child of `parent`, so cancelling the parent cancels this call.
pub fn child_token(parent: &CancellationToken) -> CancellationToken {
    parent.child_token()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::{ExecutionMode, RiskLevel};
    use crate::walk::FileListCache;
    use crate::workspace::Workspace;
    use agent_core::CallId;

    struct Sleeper;

    #[async_trait::async_trait]
    impl Tool for Sleeper {
        fn metadata(&self) -> ToolMetadata {
            ToolMetadata {
                name: "sleeper",
                description: "sleeps forever",
                input_schema: serde_json::json!({ "type": "object", "properties": {} }),
                capabilities: &[],
                risk_level: RiskLevel::ReadOnly,
                execution_mode: ExecutionMode::InProcess,
                timeout_ms: None,
            }
        }

        async fn execute(&self, _ctx: &ToolContext, _args: &Value) -> Result<ToolOutput> {
            // Deliberately never checks the token: the wrapper must still cut it loose.
            std::future::pending::<()>().await;
            unreachable!()
        }
    }

    fn ctx(cancel: CancellationToken) -> ToolContext {
        ToolContext::new(
            Workspace::new("/tmp"),
            cancel,
            CallId::from_host("t1"),
            Arc::new(FileListCache::new()),
        )
    }

    #[tokio::test]
    async fn cancellation_frees_a_tool_that_ignores_the_token() {
        let mut reg = ToolRegistry::new();
        reg.register(Arc::new(Sleeper));
        let token = CancellationToken::new();
        let c = ctx(token.clone());

        let handle = tokio::spawn(async move {
            let reg = reg;
            reg.execute("sleeper", &c, &serde_json::json!({})).await
        });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        token.cancel();

        let err = handle.await.unwrap().unwrap_err();
        assert!(err.is_cancelled(), "expected cancellation, got {err:?}");
    }

    #[tokio::test]
    async fn unknown_tool_is_invalid_not_internal() {
        let reg = ToolRegistry::new();
        let err = reg
            .execute("nope", &ctx(CancellationToken::new()), &serde_json::json!({}))
            .await
            .unwrap_err();
        assert_eq!(err.code, "tool.not_found");
        assert_eq!(err.class, ErrorClass::Invalid);
        // The legacy shape the JS seam guarantees.
        assert_eq!(to_legacy_content("nope", &err), "Error in nope: Unknown tool: nope");
    }

    #[tokio::test]
    async fn already_cancelled_never_starts_the_tool() {
        let mut reg = ToolRegistry::new();
        reg.register(Arc::new(Sleeper));
        let token = CancellationToken::new();
        token.cancel();
        let err = reg
            .execute("sleeper", &ctx(token), &serde_json::json!({}))
            .await
            .unwrap_err();
        assert!(err.is_cancelled());
    }
}
