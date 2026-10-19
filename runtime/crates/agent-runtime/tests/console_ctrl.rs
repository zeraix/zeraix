//! A console Ctrl+C raised by something the agent ran must not end the runtime (Windows only).
//!
//! Reported from the packaged app as `runtime exited (code=3221225786 signal=-)`: 0xC000013A,
//! STATUS_CONTROL_C_EXIT. The runtime runs on a hidden console of its own, and every command used to attach
//! to that same console, so a command that broadcast Ctrl+C to it (`GenerateConsoleCtrlEvent(_, 0)` reaches
//! every attached process) ended the runtime too — mid-turn, with every service it was running.
#![cfg(windows)]

mod common;

use common::*;

/// PowerShell's `-EncodedCommand` takes base64 of UTF-16LE, which sidesteps every layer of cmd.exe quoting.
fn encoded(script: &str) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |acc, (i, b)| acc | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[test]
fn a_command_that_broadcasts_ctrl_c_does_not_end_the_runtime() {
    let mut rt = Runtime::start_like_host();
    rt.init();

    // Ctrl+C to process group 0: every process attached to the caller's console, the caller included.
    let script = r#"
        Add-Type -Namespace W -Name K -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint e, uint g);'
        Write-Output 'sending'
        [W.K]::GenerateConsoleCtrlEvent(0, 0) | Out-Null
        Start-Sleep -Seconds 5
        Write-Output 'not-interrupted'
    "#;
    let r = rt.call(
        "process.run",
        serde_json::json!({
            "command": format!("powershell -NoProfile -NonInteractive -EncodedCommand {}", encoded(script)),
            "timeout_ms": 60_000,
        }),
    );

    // Proof the event was really raised and delivered, so the survival below is not vacuous: the script got
    // as far as the call (Add-Type worked), and the command itself was on the receiving end and never reached
    // its last line. The marker is printed BEFORE the call because PowerShell stops the script on its handler
    // thread, which can win the race against any line after it.
    let stdout = r["result"]["stdout"].as_str().unwrap_or_default();
    assert!(stdout.contains("sending"), "the script never reached the broadcast: {r}");
    assert!(!stdout.contains("not-interrupted"), "the command never received the Ctrl+C: {r}");

    assert!(
        rt.child.try_wait().expect("query the runtime").is_none(),
        "the runtime exited after a command broadcast Ctrl+C on its console"
    );
    assert!(rt.call("runtime.status", serde_json::json!({}))["result"].is_object());
}
