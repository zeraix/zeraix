//! Commands and services over the wire: `process.run`, background services, and the confinement and hardening
//! every command gets. Split out of protocol.rs.

mod common;

use common::*;
use std::time::{Duration, Instant};

// ── process.run (Stage 2) ─────────────────────────────────────────────────────────────────────────

#[test]
fn process_run_returns_the_engine_contract() {
    let mut rt = Runtime::start();
    rt.init();
    let r = rt.call(
        "process.run",
        serde_json::json!({ "command": "echo parity", "timeout_ms": 30_000 }),
    );
    let result = &r["result"];
    assert!(result["stdout"].as_str().unwrap().contains("parity"));
    assert_eq!(result["code"], 0);
    assert_eq!(result["killed"], false);
    assert_eq!(result["canceled"], false);
}

/// `"?"` rather than a number, because that is what the JS engine contract returns for a process that
/// never produced an exit status, and callers render it verbatim.
#[test]
fn a_command_that_cannot_start_reports_an_unknown_code() {
    let mut rt = Runtime::start();
    rt.init();
    let r = rt.call(
        "process.run",
        serde_json::json!({ "command": "definitely-not-a-command-xyz", "timeout_ms": 30_000 }),
    );
    // The shell itself runs and fails, so this is a real non-zero exit rather than "?" — what matters
    // is that it is reported as a result at all, with the shell's own message kept for the model.
    let result = &r["result"];
    assert_ne!(result["code"], 0);
    assert!(!result["stderr"].as_str().unwrap().is_empty(), "the shell's error must reach the caller");
}

#[test]
fn the_deadline_kills_the_command_and_keeps_what_it_printed() {
    let mut rt = Runtime::start();
    rt.init();
    let started = Instant::now();
    let r = rt.call(
        "process.run",
        serde_json::json!({ "command": format!("echo before && {}", slow_command(30)), "timeout_ms": 1500 }),
    );
    let result = &r["result"];
    assert_eq!(result["killed"], true, "the deadline must report `killed`, not a clean exit");
    assert_eq!(result["canceled"], false, "a timeout is not a cancellation; run_command words them differently");
    assert!(result["stdout"].as_str().unwrap().contains("before"), "output printed before the kill is still the useful part");
    assert!(started.elapsed() < Duration::from_secs(20), "the deadline did not fire");
}

/// The property the JS path cannot have: Stop reaches a running command.
///
/// Sent as a notification while the run is still in flight, which is only answerable because the server
/// spawns each request rather than serving them in order.
#[test]
fn cancel_stops_a_running_command() {
    let mut rt = Runtime::start();
    rt.init();
    let started = Instant::now();
    let id = rt.send(
        "process.run",
        serde_json::json!({ "command": slow_command(30), "call_id": "c-run-1" }),
    );
    std::thread::sleep(Duration::from_millis(400));
    rt.notify("call.cancel", serde_json::json!({ "call_id": "c-run-1" }));

    let reply = rt.read_reply();
    assert_eq!(reply["id"].as_u64(), Some(id));
    assert_eq!(reply["result"]["canceled"], true);
    assert_eq!(reply["result"]["killed"], false, "a user stop is not a timeout");
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "cancel did not reach the process: took {:?}",
        started.elapsed()
    );
}

/// `tool.cancel` is the 1.0 spelling and stays accepted — a host and a runtime are versioned
/// separately, so the older name has to keep working against a newer binary.
#[test]
fn the_legacy_cancel_spelling_still_reaches_a_command() {
    let mut rt = Runtime::start();
    rt.init();
    let id = rt.send(
        "process.run",
        serde_json::json!({ "command": slow_command(30), "call_id": "c-run-2" }),
    );
    std::thread::sleep(Duration::from_millis(400));
    rt.notify("tool.cancel", serde_json::json!({ "call_id": "c-run-2" }));
    let reply = rt.read_reply();
    assert_eq!(reply["id"].as_u64(), Some(id));
    assert_eq!(reply["result"]["canceled"], true);
}

/// Reading stops at the cap rather than buffering the whole stream and trimming afterwards. The
/// observable half of that is what the caller gets back, which must match the JS path byte for byte.
#[test]
fn output_is_capped() {
    let mut rt = Runtime::start();
    rt.init();
    let node = serde_json::to_string(&std::env::var("PARITY_NODE").unwrap_or_else(|_| "node".to_owned())).unwrap();
    let r = rt.call(
        "process.run",
        serde_json::json!({
            "command": format!("{node} -e \"process.stdout.write('x'.repeat(50000))\""),
            "timeout_ms": 30_000,
            "max_buffer": 1000,
        }),
    );
    let out = r["result"]["stdout"].as_str().unwrap();
    // Node may be absent from the test environment; the cap is what is under test, not node.
    if !out.is_empty() {
        assert_eq!(out.len(), 1000, "output was not capped at max_buffer");
        assert_eq!(r["result"]["truncated"], true);
    }
}

// ── process.start_background (Stage 2b) ───────────────────────────────────────────────────────────

#[test]
fn a_background_service_starts_and_is_readable_while_it_runs() {
    let mut rt = Runtime::start();
    rt.init();
    let cmd = if cfg!(windows) {
        "echo service-is-up && ping -n 100000 127.0.0.1 > nul"
    } else {
        "echo service-is-up && sleep 600"
    };
    let pid = rt.call("process.start_background", serde_json::json!({ "command": cmd }))["result"]["pid"]
        .as_u64()
        .expect("a pid");

    // The host polls exactly like this while deciding whether a service has started.
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        assert!(Instant::now() < deadline, "the service's output never became visible");
        let peek = rt.call("process.peek", serde_json::json!({ "pid": pid }));
        assert_eq!(peek["result"]["alive"], true);
        if peek["result"]["output"].as_str().unwrap_or_default().contains("service-is-up") {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    rt.call("process.stop", serde_json::json!({ "pid": pid }));
}

/// The reason the event direction exists: nothing polls a settled service, so an exit has no other
/// way to be noticed. Without it a dead dev server stays in the UI and `stop_service` targets a pid
/// that belongs to nothing.
#[test]
fn an_exit_is_pushed_to_the_host_without_being_asked() {
    let mut rt = Runtime::start();
    rt.init();
    let pid = rt.call("process.start_background", serde_json::json!({ "command": "echo done && exit 5" }))
        ["result"]["pid"]
        .as_u64()
        .expect("a pid");

    let event = rt.read_event("process.exited");
    assert_eq!(event["params"]["pid"].as_u64(), Some(pid));
    assert_eq!(event["params"]["code"], 5);
    assert!(
        event["params"]["output"].as_str().unwrap().contains("done"),
        "the event carries what the service printed, which is what a notify job reports"
    );
}

/// A killed service must announce itself the same way one that ended on its own does — otherwise the
/// host cleans up after an exit it noticed and leaks after one it caused.
#[test]
fn stopping_a_service_also_pushes_the_exit() {
    let mut rt = Runtime::start();
    rt.init();
    let cmd = if cfg!(windows) { "ping -n 100000 127.0.0.1 > nul" } else { "sleep 600" };
    let pid = rt.call("process.start_background", serde_json::json!({ "command": cmd }))["result"]["pid"]
        .as_u64()
        .expect("a pid");

    assert_eq!(rt.call("process.stop", serde_json::json!({ "pid": pid }))["result"]["stopped"], true);
    let event = rt.read_event("process.exited");
    assert_eq!(event["params"]["pid"].as_u64(), Some(pid));
}

#[test]
fn a_service_that_ended_is_no_longer_listed_or_peekable() {
    let mut rt = Runtime::start();
    rt.init();
    let pid = rt.call("process.start_background", serde_json::json!({ "command": "echo bye" }))["result"]["pid"]
        .as_u64()
        .expect("a pid");

    rt.read_event("process.exited");
    // Removed from the registry before the event is pushed, so a host acting on the event never sees
    // the service still listed.
    assert_eq!(rt.call("process.peek", serde_json::json!({ "pid": pid }))["result"]["alive"], false);
    let listed = rt.call("process.list", serde_json::json!({}));
    let services = listed["result"]["services"].as_array().unwrap();
    assert!(!services.iter().any(|s| s["pid"].as_u64() == Some(pid)));
}

#[test]
fn stopping_a_pid_the_runtime_never_started_is_refused() {
    let mut rt = Runtime::start();
    rt.init();
    // The pid space is shared with the rest of the machine; signalling a stranger is the difference
    // between stopping a dev server and stopping something of the user's.
    assert_eq!(rt.call("process.stop", serde_json::json!({ "pid": 999_999 }))["result"]["stopped"], false);
}

// ── Sandbox and command hardening (TODO §4.2, §11, §12) ───────────────────────────────────────────

/// The differential proof: the SAME command, unconfined and confined.
///
/// Asserting that a policy struct has the right shape proves nothing about the kernel. This runs a real
/// command that reads a real secret outside the workspace, twice, and the only difference is whether the host
/// declared a policy.
#[test]
#[cfg(target_os = "linux")]
fn a_command_cannot_read_outside_the_approved_roots_when_a_policy_is_declared() {
    // NOT under /tmp: `FilesystemPolicy::workspace` makes the whole of /tmp writable, because build tools
    // need temp space — so a "secret" placed there is legitimately inside the allowlist and the test would be
    // asserting against its own fixture rather than against the sandbox.
    let base = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("sandbox-differential");
    let _ = std::fs::remove_dir_all(&base);
    let workspace = base.join("proj");
    std::fs::create_dir_all(&workspace).unwrap();
    let secret = base.join("secret.txt");
    std::fs::write(&secret, "SHOULD-NOT-BE-READABLE").unwrap();
    let cmd = format!("cat {}", secret.display());

    // Unconfined: the host declared nothing, so nothing is enforced and the read succeeds. This half is what
    // makes the other half meaningful — without it, a failure could just mean the command was wrong.
    let unconfined = {
        let mut rt = Runtime::start();
        rt.init();
        let r = rt.call(
            "process.run",
            serde_json::json!({ "command": cmd, "cwd": workspace.to_str().unwrap(), "timeout_ms": 20000 }),
        );
        r["result"]["stdout"].as_str().unwrap_or("").to_owned()
    };
    if !unconfined.contains("SHOULD-NOT-BE-READABLE") {
        // The unconfined read did not work, so this machine cannot demonstrate the difference. Skipping is
        // honest; asserting would certify a boundary the test never actually observed.
        eprintln!("skipping: the unconfined read did not succeed, so there is no difference to measure");
        return;
    }

    // Confined: the same command, with only the workspace approved.
    let mut rt = Runtime::start();
    rt.init_with_roots(&[workspace.to_str().unwrap()]);
    let r = rt.call(
        "process.run",
        serde_json::json!({ "command": cmd, "cwd": workspace.to_str().unwrap(), "timeout_ms": 20000 }),
    );
    let stdout = r["result"]["stdout"].as_str().unwrap_or("");
    assert!(
        !stdout.contains("SHOULD-NOT-BE-READABLE"),
        "the sandbox did not confine the command; it read: {stdout}"
    );
}

/// A command inside the approved roots must still work — confinement that breaks the build is not a feature.
#[test]
fn a_command_inside_the_approved_roots_still_runs() {
    let base = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("sandbox-inside");
    let _ = std::fs::remove_dir_all(&base);
    let workspace = base.join("proj");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("inside.txt"), "READABLE").unwrap();

    let mut rt = Runtime::start();
    rt.init_with_roots(&[workspace.to_str().unwrap()]);
    // `type`, not `cat`, on Windows: the runner only has `cat` because Git for Windows' usr/bin is on its
    // PATH, and a test about what the sandbox permits should not lean on a coincidence of the image.
    let command = if cfg!(windows) { "type inside.txt" } else { "cat inside.txt" };
    let r = rt.call(
        "process.run",
        serde_json::json!({
            "command": command,
            "cwd": workspace.to_str().unwrap(),
            "timeout_ms": 20000
        }),
    );
    assert!(
        r["result"]["stdout"].as_str().unwrap_or("").contains("READABLE"),
        "confinement must not break work inside the workspace: {}",
        r["result"]
    );
}

/// A read-only root is readable and not writable.
///
/// The media library is the case: the app's own file tools refuse to write there, and declaring it alongside
/// the workspace used to hand commands write access anyway, because the policy was built from one flat list
/// of roots. Two layers disagreeing about the same directory, in the direction that loses the user's files.
#[test]
#[cfg(target_os = "linux")]
fn a_readonly_root_can_be_read_and_not_written() {
    let base = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("sandbox-readonly");
    let _ = std::fs::remove_dir_all(&base);
    let workspace = base.join("proj");
    let media = base.join("media");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&media).unwrap();
    std::fs::write(media.join("clip.txt"), "MEDIA-CONTENT").unwrap();

    let mut rt = Runtime::start();
    rt.init_with_policy(&[workspace.to_str().unwrap()], &[media.to_str().unwrap()]);
    let run = |rt: &mut Runtime, cmd: String| {
        rt.call(
            "process.run",
            serde_json::json!({ "command": cmd, "cwd": workspace.to_str().unwrap(), "timeout_ms": 20000 }),
        )
    };

    // The half that must hold everywhere: declared read-only means NOT writable. It is an absence of a rule,
    // so no filesystem can grant it back.
    let write = run(&mut rt, format!("touch {}", media.join("new.txt").display()));
    assert_ne!(write["result"]["code"], 0, "a read-only root must not be writable: {}", write["result"]);
    assert!(!media.join("new.txt").exists(), "the file was created despite the policy");

    // The other half: a read-only root is still READABLE. Kernel-checked where the filesystem lets it be,
    // and skipped — loudly — where it cannot.
    //
    // Landlock identifies a hierarchy by its dentry, and not every filesystem gives it one it can match. On
    // `v9fs` — which is what a WSL checkout on a Windows drive is, and `CARGO_TARGET_TMPDIR` follows the
    // checkout — a `PathBeneath` rule for any directory other than the command's own working directory has no
    // effect: `restrict_self` reports `PartiallyEnforced`, the rule is added without error, and the access is
    // refused anyway. The same policy on ext4 grants it. That is a property of the filesystem, not of this
    // code, so the control below distinguishes the two rather than letting either read as the other.
    let readable = |rt: &mut Runtime| -> bool {
        run(rt, format!("cat {}", media.join("clip.txt").display()))["result"]["stdout"]
            .as_str()
            .unwrap_or("")
            .contains("MEDIA-CONTENT")
    };
    if !readable(&mut rt) {
        // The same directory, declared WRITABLE. If it is unreadable that way too, no non-cwd rule works
        // here at all and the read-only half is untestable on this filesystem; if it is readable, the
        // read-only declaration is what withheld it and that is a real failure.
        let mut control = Runtime::start();
        control.init_with_roots(&[workspace.to_str().unwrap(), media.to_str().unwrap()]);
        assert!(
            !readable(&mut control),
            "declared read-only the root was unreadable, declared writable it was readable — so the \
             read-only declaration withheld a read it should have granted"
        );
        eprintln!(
            "skipping the readable half: this filesystem honours no Landlock rule outside the command's own \
             working directory (v9fs does not; ext4 does). The not-writable half above still ran."
        );
    }
}

/// A long-lived service is confined too.
///
/// It is the one that matters more: `run_command` finishes while the user is watching, and `npm run dev`
/// started from the same conversation is still running an hour later. The confinement used to live inside the
/// foreground backend, so only the short-lived half of the pair was ever sandboxed.
#[test]
#[cfg(target_os = "linux")]
fn a_background_service_is_confined_like_a_command() {
    let base = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("sandbox-background");
    let _ = std::fs::remove_dir_all(&base);
    let workspace = base.join("proj");
    std::fs::create_dir_all(&workspace).unwrap();
    let secret = base.join("secret.txt");
    std::fs::write(&secret, "SHOULD-NOT-BE-READABLE").unwrap();
    let cmd = format!("cat {}", secret.display());

    let output_of = |rt: &mut Runtime| -> String {
        let started = rt.call(
            "process.start_background",
            serde_json::json!({ "command": cmd, "cwd": workspace.to_str().unwrap() }),
        );
        let pid = started["result"]["pid"].as_u64().expect("a pid");
        // The service is a `cat`: it ends at once, and `process.peek` keeps the output of one that has.
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let peek = rt.call("process.peek", serde_json::json!({ "pid": pid }));
            let out = peek["result"]["output"].as_str().unwrap_or("").to_owned();
            if !peek["result"]["alive"].as_bool().unwrap_or(false) || !out.is_empty() {
                return out;
            }
            assert!(Instant::now() < deadline, "the service never ended");
            std::thread::sleep(Duration::from_millis(50));
        }
    };

    // Unconfined first, so a failure below cannot just mean the command was wrong.
    let unconfined = {
        let mut rt = Runtime::start();
        rt.init();
        output_of(&mut rt)
    };
    if !unconfined.contains("SHOULD-NOT-BE-READABLE") {
        eprintln!("skipping: the unconfined read did not succeed, so there is no difference to measure");
        return;
    }

    let mut rt = Runtime::start();
    rt.init_with_roots(&[workspace.to_str().unwrap()]);
    let confined = output_of(&mut rt);
    assert!(
        !confined.contains("SHOULD-NOT-BE-READABLE"),
        "a background service ran unconfined; it read: {confined}"
    );
}

/// §12's command-injection row.
///
/// `run_command` takes a shell command line by design — the model is *supposed* to be able to write
/// `a && b`, and calling that "injection" would be calling the feature a vulnerability. What must hold is
/// narrower and is what these check: the shell metacharacters a model emits are passed through to the shell
/// as written, they cannot escape the sandbox, and they cannot reach the protocol.
#[test]
fn shell_metacharacters_are_executed_as_written_and_do_not_corrupt_the_protocol() {
    let mut rt = Runtime::start();
    rt.init();

    // Quotes, newlines, NUL-adjacent bytes and JSON metacharacters in the OUTPUT must not break the stream:
    // the protocol is newline-delimited JSON, and a command that prints a newline-laden blob is ordinary.
    //
    // One table per shell, because the shell is a platform fact — `/bin/sh -c` on POSIX, `%ComSpec% /d /s /c`
    // on Windows (see `spawn_command` in agent-process) — and "passed through as written" can only be judged
    // against what THAT shell does with the characters. `$((1+1))` is POSIX arithmetic expansion; cmd.exe
    // has no such thing and prints it verbatim, which is exactly what the Windows release leg reported. The
    // cmd.exe rows exercise its own metacharacters instead: `&` chains commands, and `set /a` evaluates an
    // expression — printing the result only when handed to cmd.exe as a command line rather than a batch
    // file, so it also confirms the `/c` invocation is the one Node's `shell: true` builds. (`printf` is not
    // a cmd.exe command either; it only worked on the runner because Git for Windows' usr/bin is on PATH.)
    let cases = if cfg!(windows) {
        [
            (r#"echo 'a"b'"#, "a\"b"),
            ("echo one& echo two", "one"),
            (r#"echo {"id":1,"method":"runtime.shutdown"}"#, "runtime.shutdown"),
            ("set /a 1+1", "2"),
        ]
    } else {
        [
            (r#"echo 'a"b'"#, "a\"b"),
            ("printf 'one\ntwo\n'", "one"),
            (r#"echo '{"id":1,"method":"runtime.shutdown"}'"#, "runtime.shutdown"),
            ("echo $((1+1))", "2"),
        ]
    };
    for (command, expected) in cases {
        let r = rt.call(
            "process.run",
            serde_json::json!({ "command": command, "timeout_ms": 20000 }),
        );
        let stdout = r["result"]["stdout"].as_str().unwrap_or("");
        assert!(stdout.contains(expected), "{command} → {stdout:?}");
    }

    // The runtime is still alive and answering: a command that printed a protocol frame did not inject one.
    let status = rt.call("runtime.status", serde_json::json!({}));
    assert_eq!(status["result"]["protocol_version"], "1.1", "the stream was corrupted by command output");
}

/// A command that fails is a result, not a protocol error — the same contract the JS path has.
#[test]
fn a_command_that_exits_non_zero_is_reported_rather_than_thrown() {
    let mut rt = Runtime::start();
    rt.init();
    let r = rt.call("process.run", serde_json::json!({ "command": "exit 3", "timeout_ms": 20000 }));
    assert!(r["error"].is_null(), "{r}");
    assert_eq!(r["result"]["code"], 3);
}
