//! Tying every spawned command to the runtime's own lifetime.
//!
//! ## The hole this fills
//!
//! `kill_tree` handles the paths where the runtime is still alive to run code: the deadline fired, the
//! user pressed Stop, the host asked for a shutdown. It cannot handle the path where the runtime is
//! simply *gone* — Task Manager's End Task, a panic that aborts, a SIGKILL, the OS closing the session.
//!
//! On Windows nothing about that reaches the children. A process whose parent dies is re-parented and
//! keeps running; there is no orphan signal and no equivalent of a process group to sweep. So a
//! `pnpm run check` started by the agent survived being "stopped" by killing the app, and went on
//! consuming a core and a gigabyte with nobody able to see or stop it. That is the bug this file exists
//! for, and it is not theoretical — it is what prompted it.
//!
//! ## Why a job object rather than more careful cleanup
//!
//! Every cleanup path is code that has to *run*, and the failure mode here is precisely that no code
//! runs. A job object moves the guarantee into the kernel: processes are members of the job, the job
//! sets `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, and when the last handle to it closes — which the OS does
//! for us as it tears the runtime down, however the runtime died — every member is terminated. There is
//! no path that skips it, because there is no path where a process keeps its handles open after it ends.
//!
//! Membership is inherited, so assigning the shell covers everything the shell goes on to start: the
//! `pnpm`, the `node` workers under it, the `tsc` under those. That is the property `taskkill /T` lacks,
//! since /T walks the parent chain *at kill time* and a grandchild whose parent already exited is no
//! longer on it.
//!
//! ## Unix has nothing equivalent, deliberately
//!
//! The obvious candidate is `PR_SET_PDEATHSIG`, and it is a trap. It fires when the parent **thread**
//! exits, not the parent process, and the child is spawned from whichever tokio thread happened to run
//! the task — a blocking-pool thread is reaped after an idle timeout while the runtime is perfectly
//! healthy. The failure mode is a SIGKILL through the middle of a build the user is waiting on, which is
//! worse than the orphan it would prevent. It also only reaches the shell, not the tree, so it does not
//! even buy the property that matters.
//!
//! Unix keeps the process group (`kill_tree` sweeps it) and relies on the host's startup reaper for the
//! abrupt-death case. Fixing that properly means a cgroup, which is a much larger change than this one.

/// Put `child` — and everything it goes on to spawn — under the runtime's lifetime.
///
/// Best effort by construction. A failure means the child is not adopted, which is exactly the
/// behaviour that existed before this function, so there is nothing to escalate: every caller still
/// has `kill_tree` for the ordinary paths.
#[cfg(windows)]
pub(crate) fn adopt(child: &tokio::process::Child) {
    let Some(job) = job() else { return };
    // The handle, not the pid. `AssignProcessToJobObject` by pid would mean re-opening the process, and
    // a pid can be reused between the spawn and the lookup; the handle cannot name anything but this
    // child. `raw_handle` is `None` only once the child has been reaped, which cannot have happened yet.
    let Some(handle) = child.raw_handle() else { return };
    // SAFETY: `job` is a live job object handle owned for the life of the process (never closed by us),
    // and `handle` is this child's process handle, owned by `child` and outliving this call.
    let ok = unsafe { windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(job, handle) };
    if ok == 0 {
        // The usual cause is a child that exited between spawn and here, which needs no adoption. Worth
        // a line either way: a systematic failure here silently returns the orphan bug, and the symptom
        // (a process nobody can account for) gives no hint that this is where to look.
        tracing::debug!(
            error = %std::io::Error::last_os_error(),
            "could not adopt child into the runtime job object; it may outlive an abrupt exit",
        );
    }
}

#[cfg(not(windows))]
pub(crate) fn adopt(_child: &tokio::process::Child) {}

/// The process-wide job, created once.
///
/// One job for the whole runtime rather than one per command: the point is a container tied to *this
/// process*, and a per-command job would be closed as soon as the command finished, killing exactly the
/// background services that are supposed to keep running.
///
/// The handle is intentionally never closed. Closing it is what kills the members, so the only correct
/// time is process exit — which is when the OS closes it for us, and the one moment we are trying not to
/// depend on running code.
#[cfg(windows)]
fn job() -> Option<windows_sys::Win32::Foundation::HANDLE> {
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        JobObjectExtendedLimitInformation, SetInformationJobObject, CreateJobObjectW,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// `HANDLE` is a raw pointer, so it is neither `Send` nor `Sync` by default. A Win32 handle is
    /// process-wide and every use of this one is a kernel call that takes it by value, so sharing it
    /// across threads is sound; the wrapper is how that is stated to the compiler.
    struct Job(HANDLE);
    // SAFETY: see above — the handle is an opaque kernel object, not a pointer into this address space,
    // and it is never mutated after creation.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    static JOB: OnceLock<Option<Job>> = OnceLock::new();
    JOB.get_or_init(|| {
        // SAFETY: an unnamed job with default security. Both null arguments are documented as valid.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            tracing::warn!(
                error = %std::io::Error::last_os_error(),
                "could not create the runtime job object; commands may outlive an abrupt exit",
            );
            return None;
        }

        // SAFETY: a zeroed `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` is the documented starting point — every
        // limit is off until its bit is set in `LimitFlags`, and the struct is plain data.
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `handle` is the job just created; the pointer and length describe `info`, which lives
        // across the call; the information class matches the struct type, which is the one invariant
        // `SetInformationJobObject` cannot check for us.
        let ok = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(info).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            // A job without the kill-on-close limit is worse than no job: it would take ownership of
            // every child and terminate none of them, and `taskkill /T` still would not reach the tree.
            // Close it and leave the children unadopted rather than pretend.
            tracing::warn!(
                error = %std::io::Error::last_os_error(),
                "could not set kill-on-close on the runtime job object; commands may outlive an abrupt exit",
            );
            // SAFETY: `handle` is ours, still open, and not shared with anything — nothing was assigned
            // to the job, since assignment only happens after this initialiser returns.
            unsafe { CloseHandle(handle) };
            return None;
        }

        tracing::debug!("runtime job object created; spawned commands will not outlive this process");
        Some(Job(handle))
    })
    .as_ref()
    .map(|j| j.0)
}
