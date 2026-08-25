//! Sandboxed execution (spec §21, TODO §8).
//!
//! ## This does not replace the QEMU sandbox
//!
//! Spec §21 is explicit: *preserve* the existing QEMU capability and put an `ExecutionBackend`
//! abstraction in front of it. `electron/tools/sandbox/engine.mjs` is already that abstraction in JS
//! form — a pluggable engine with `native` and `qemu` implementations, a documented contract, and a
//! background state machine — and the QEMU path behind it (one long-lived VM, bubblewrap confinement, a
//! custom 9p server, dynamic QMP port forwarding, per-platform hypervisor selection) is the most mature
//! subsystem in the runtime being replaced.
//!
//! So this crate is the trait plus the *host* backend, with the allowlist enforcement §8 asks for. The
//! QEMU backend keeps delegating to the existing implementation until there is a reason to move it, and
//! none of the four problems the refactor exists to solve is located in it.
//!
//! ## What is actually enforceable, measured rather than assumed
//!
//! §8 asks for an evaluation of "namespaces + seccomp-bpf / landlock vs WASM". The short version, with
//! the reasoning in `docs/agent-runtime-sandbox-evaluation.md`:
//!
//! - **Landlock** is the right mechanism for filesystem allowlisting on Linux: it needs no privilege, no
//!   namespace, and no helper process, and it is enforced by the kernel rather than by a check the child
//!   can be tricked past. Probed at runtime; this development kernel (WSL2 6.6) reports **ABI v3**.
//! - **Network allowlisting is not available through Landlock at ABI v3.** TCP `bind`/`connect`
//!   restrictions arrived in ABI v4 (Linux 6.7). Below that there is no unprivileged, process-scoped
//!   mechanism — proxy environment variables are advisory and a child can simply ignore them. So on this
//!   path a network allowlist is reported as **unenforced**, and the honest place for one is the QEMU
//!   backend, which has a real network boundary already.
//! - **seccomp-bpf** filters syscalls, not paths. It can forbid `connect` outright but cannot express
//!   "connect only to these hosts", so it is a blunt complement to Landlock, not a substitute.
//! - **WASM (wasmtime)** is a genuinely strong boundary and the wrong shape for this problem: the tools
//!   being sandboxed are `git`, `npm`, `cargo`, `python` — native binaries the user already has. Running
//!   them under WASI would mean shipping WASI builds of a toolchain that does not have them.
//!
//! ## Never silently unenforced
//!
//! The rule this crate follows, inherited from `agent-process::limits`: a restriction that could not be
//! applied is **reported**, never dropped. `Enforcement` says which mechanism ran and why the others did
//! not, so a caller can tell the difference between "confined" and "we asked nicely".

pub mod backend;
pub mod policy;

#[cfg(target_os = "linux")]
pub mod landlock_backend;

pub use backend::{ExecutionBackend, NativeBackend, SandboxRequest};
pub use policy::{Enforcement, FilesystemPolicy, NetworkPolicy, SandboxPolicy};
