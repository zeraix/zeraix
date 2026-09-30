//! Running work: one tool call, anything that goes through the scheduler, and the registry `call.cancel` reads.

use super::*;

impl Server {
    /// Run one tool call, tracked so it can be cancelled by id.
    pub(super) async fn call_tool(&self, p: ToolCallParams) -> ToolCallResult {
        let started = std::time::Instant::now();
        let call_id = p.call_id.clone().unwrap_or_else(|| CallId::new().to_string());

        let registry = Arc::clone(&self.registry);
        let file_cache = Arc::clone(&self.file_cache);
        let workdir = p.workdir.clone();
        let asset_dir = p.asset_dir.clone().unwrap_or_default();
        let name = p.name.clone();
        let args = p.args.clone();
        let handle = CallId::from_host(call_id.clone());
        // Through the scheduler, which is what bounds concurrent tool calls across every conversation.
        // The token comes from the task rather than from the runtime root, so the cancellation tree is
        // the scheduler's — one place that knows how to stop work, whether it has started or not.
        let joined = self
            .scheduled(
                format!("tool:{}", p.name),
                ResourceClass::Tool,
                Some(&call_id),
                self.registry.get(&p.name).and_then(|t| t.metadata().timeout_ms).map(std::time::Duration::from_millis),
                move |cancel| {
                    let registry = Arc::clone(&registry);
                    let ctx = ToolContext::new(
                        Workspace::new(&workdir).with_assets(&asset_dir),
                        cancel,
                        handle.clone(),
                        Arc::clone(&file_cache),
                    );
                    let name = name.clone();
                    let args = args.clone();
                    // Spawned so a panic in a tool is contained: `JoinError` below turns it into a
                    // failed call rather than an aborted process.
                    Box::pin(async move { tokio::spawn(async move { registry.execute(&name, &ctx, &args).await }).await })
                },
            )
            .await;

        let Some(joined) = joined else {
            // `runtime.cancelled`, not a code of its own: `to_legacy_content` matches on exactly that
            // code to produce the cancellation sentence the UI already renders, so a second spelling
            // would give the model "Error in <tool>: The user stopped this operation." for a call
            // cancelled while queued and the bare sentence for one cancelled while running. One user
            // action, one string.
            let err = RuntimeError::new("runtime.cancelled", ErrorClass::Cancelled, "The user stopped this operation.");
            return ToolCallResult {
                ok: false,
                content: to_legacy_content(&p.name, &err),
                error: Some((&err).into()),
                duration_ms: started.elapsed().as_millis() as u64,
            };
        };

        match joined {
            Ok(Ok(inv)) => ToolCallResult {
                ok: true,
                content: inv.content,
                error: None,
                duration_ms: inv.duration_ms,
            },
            Ok(Err(err)) => ToolCallResult {
                ok: false,
                content: to_legacy_content(&p.name, &err),
                error: Some((&err).into()),
                duration_ms: started.elapsed().as_millis() as u64,
            },
            Err(join_err) => {
                tracing::error!(tool = %p.name, error = %join_err, "tool task failed");
                let err = RuntimeError::new(
                    "tool.panicked",
                    ErrorClass::Internal,
                    format!("The {} tool crashed.", p.name),
                )
                .with_cause(join_err);
                ToolCallResult {
                    ok: false,
                    content: to_legacy_content(&p.name, &err),
                    error: Some((&err).into()),
                    duration_ms: started.elapsed().as_millis() as u64,
                }
            }
        }
    }

    /// Run one unit of work through the scheduler and hand back what it produced.
    ///
    /// The scheduler reports how a task ENDED, not what it returned, so the value comes back through a
    /// slot the body fills. `TaskBody` is `FnMut` because a retry policy may call it again; nothing here
    /// retries yet, and a body that did would simply overwrite the slot.
    ///
    /// `None` means the work never produced a value — cancelled, or refused before it started. Callers
    /// turn that into whatever their own contract says a stopped call looks like, because "cancelled"
    /// reads very differently to a model depending on what was cancelled.
    pub(super) async fn scheduled<T, F>(
        &self,
        label: impl Into<String>,
        resource: ResourceClass,
        call_id: Option<&str>,
        timeout: Option<std::time::Duration>,
        make: F,
    ) -> Option<T>
    where
        T: Send + 'static,
        F: Fn(CancellationToken) -> std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send>>
            + Send
            + Sync
            + 'static,
    {
        let task_id = agent_core::TaskId::new();
        let call_token = CancellationToken::new();
        // Registered before submission, so a cancel arriving while the task is still queued finds it.
        // The same ordering rule as everywhere else in this migration (D12).
        if let Some(id) = call_id {
            // A cancel that arrived first is answered by NOT STARTING, rather than by cancelling: the task
            // has not been submitted yet, so `scheduler.cancel` on this id would be a no-op against a task
            // the scheduler has never heard of. That was the first version of this fix, and it did nothing
            // at all.
            let claimed =
                self.register_call(id, CallHandle { task: task_id.clone(), token: call_token.clone() });
            if claimed {
                self.inflight.remove(id);
                return None;
            }
        }

        let slot: Arc<std::sync::Mutex<Option<T>>> = Arc::new(std::sync::Mutex::new(None));
        let writer = Arc::clone(&slot);
        let spec = TaskSpec {
            id: task_id.clone(),
            priority: Priority::Normal,
            parent: None,
            depends_on: Vec::new(),
            resource,
            timeout,
            retry: Default::default(),
            label: label.into(),
        };
        let body = Box::new(move |ctx: agent_scheduler::TaskContext| {
            // Link this server's call token to the task's own, so a cancel that arrived before the
            // scheduler had ever heard of this task still reaches the work. Fires immediately if the
            // token is already cancelled, which is exactly the window this exists for.
            let linked = ctx.cancel.clone();
            let call_token = call_token.clone();
            tokio::spawn(async move {
                call_token.cancelled().await;
                linked.cancel();
            });
            let fut = make(ctx.cancel.clone());
            let writer = Arc::clone(&writer);
            Box::pin(async move {
                let value = fut.await;
                *writer.lock().unwrap_or_else(|e| e.into_inner()) = Some(value);
                Ok(())
            }) as agent_scheduler::TaskFuture
        });

        let outcome = self.scheduler.run_to_completion(spec, body).await;
        if let Some(id) = call_id {
            self.inflight.remove(id);
        }
        match outcome {
            Ok(Outcome::Completed) => slot.lock().unwrap_or_else(|e| e.into_inner()).take(),
            // Cancelled, failed or refused: the body may still have written a value before it was
            // stopped, and if it did that is the more useful answer than a synthesised one.
            _ => slot.lock().unwrap_or_else(|e| e.into_inner()).take(),
        }
    }

    /// Register `id` as cancellable and claim any cancel that arrived before it. Returns whether one had.
    ///
    /// Both steps under `early_cancels`' lock, which the `call.cancel` handler also holds across its own
    /// look-up-then-record. That shared lock is the whole fix: each side's check-then-act is two operations,
    /// and unless the pairs exclude each other they interleave — the cancel misses the registration, the
    /// registration misses the cancel, and Stop is silently dropped. Registering first and claiming second
    /// (the previous arrangement) orders the steps within one side; it cannot order them against the other.
    ///
    /// Lock order is `early_cancels` then an `inflight` shard, on both sides, so the two cannot deadlock.
    pub(super) fn register_call(&self, id: &str, handle: CallHandle) -> bool {
        let mut early = self.early_cancels.lock().unwrap_or_else(|e| e.into_inner());
        self.inflight.insert(id.to_owned(), handle);
        early.iter().position(|c| c == id).map(|pos| early.remove(pos)).is_some()
    }
}
