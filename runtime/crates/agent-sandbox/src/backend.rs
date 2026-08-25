//! The `ExecutionBackend` trait and the host backend (spec §21).
//!
//! Spec §21's requirement is that a tool need not know whether it is running on the host or in the
//! guest. That is what the trait is for, and `engine.mjs` already establishes the contract on the JS
//! side — same shape, same fallback-to-native rule.

use crate::policy::{Enforcement, SandboxPolicy, SandboxReport};
use agent_core::CancellationToken;
use agent_process::{ProcessRequest, ProcessResult, ResourceLimits};
use std::path::PathBuf;

/// One command to run under a policy.
#[derive(Debug, Clone)]
pub struct SandboxRequest {
    pub command: String,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, String)>,
    pub timeout: Option<std::time::Duration>,
    pub policy: SandboxPolicy,
    pub limits: ResourceLimits,
}

impl SandboxRequest {
    pub fn new(command: impl Into<String>) -> Self {
        Self {
            command: command.into(),
            cwd: None,
            env: Vec::new(),
            timeout: None,
            policy: SandboxPolicy::default(),
            limits: ResourceLimits::default(),
        }
    }

    pub fn in_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.cwd = Some(dir.into());
        self
    }
    pub fn with_policy(mut self, p: SandboxPolicy) -> Self {
        self.policy = p;
        self
    }
    pub fn with_limits(mut self, l: ResourceLimits) -> Self {
        self.limits = l;
        self
    }
    pub fn with_timeout(mut self, d: std::time::Duration) -> Self {
        self.timeout = Some(d);
        self
    }
}

/// What a command produced, plus what confined it.
#[derive(Debug, Clone)]
pub struct SandboxOutcome {
    pub process: ProcessResult,
    pub report: SandboxReport,
}

/// Where a command executes. `native` and `qemu` are the two implementations spec §21 names.
#[async_trait::async_trait]
pub trait ExecutionBackend: Send + Sync {
    fn id(&self) -> &'static str;

    /// What this backend would enforce for `policy`, without running anything.
    ///
    /// Callers use this to decide whether a command is safe to run *before* running it — and to tell the
    /// user the truth about what confined it.
    fn enforcement(&self, policy: &SandboxPolicy) -> SandboxReport;

    async fn execute(&self, req: SandboxRequest, cancel: &CancellationToken) -> SandboxOutcome;
}

/// Runs on the host, confined by whatever the kernel offers.
///
/// Always available, and always the fallback — same rule as `engine.mjs`, where native is the default
/// and the guest is switched in only once it is ready.
#[derive(Debug, Default, Clone)]
pub struct NativeBackend;

impl NativeBackend {
    pub fn new() -> Self {
        Self
    }

    fn fs_enforcement(policy: &SandboxPolicy) -> Enforcement {
        #[cfg(target_os = "linux")]
        {
            crate::landlock_backend::enforcement_for(&policy.filesystem)
        }
        #[cfg(not(target_os = "linux"))]
        {
            if policy.filesystem.is_empty() {
                Enforcement::NotRequested
            } else {
                Enforcement::LexicalOnly {
                    reason: "no unprivileged path-confinement mechanism on this platform".to_owned(),
                }
            }
        }
    }

    /// Network confinement on the host path.
    ///
    /// Always unenforced, and it says so. Landlock gained TCP restrictions in ABI v4 (Linux 6.7); below
    /// that there is no unprivileged, process-scoped way to constrain where a spawned `curl` connects.
    /// Proxy environment variables are advisory — a child can ignore them — so offering them as
    /// "enforcement" would be worse than admitting there is none. A real network boundary is what the
    /// QEMU backend already has.
    fn net_enforcement(policy: &SandboxPolicy) -> Enforcement {
        if policy.network.allow_hosts.is_empty() && !policy.network.enabled {
            return Enforcement::NotRequested;
        }
        Enforcement::None {
            reason: "constraining a child process's network requires Landlock ABI v4 (Linux 6.7+) \
                     or the guest backend"
                .to_owned(),
        }
    }
}

#[async_trait::async_trait]
impl ExecutionBackend for NativeBackend {
    fn id(&self) -> &'static str {
        "native"
    }

    fn enforcement(&self, policy: &SandboxPolicy) -> SandboxReport {
        SandboxReport {
            filesystem: Self::fs_enforcement(policy),
            network: Self::net_enforcement(policy),
            limits: "reported per execution".to_owned(),
        }
    }

    async fn execute(&self, req: SandboxRequest, cancel: &CancellationToken) -> SandboxOutcome {
        let report = self.enforcement(&req.policy);

        let mut process = ProcessRequest::new(req.command).with_limits(req.limits);
        if let Some(dir) = req.cwd {
            process.cwd = Some(dir);
        }
        process.env = req.env;
        process.timeout = req.timeout;

        #[cfg(target_os = "linux")]
        {
            // Applied in the child, between fork and exec. It must be there: Landlock restrictions are
            // inherited and irrevocable, so restricting the parent would confine the runtime itself for
            // the rest of its life.
            if !req.policy.filesystem.is_empty() && report.filesystem.is_kernel_enforced() {
                let policy = req.policy.filesystem.clone();
                process.pre_exec_hook = Some(std::sync::Arc::new(move || {
                    crate::landlock_backend::apply(&policy)
                }));
            }
        }

        let result = agent_process::run(process, cancel).await;
        SandboxOutcome { process: result, report }
    }
}
