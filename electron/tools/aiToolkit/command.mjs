/**
 * run_command, sandbox_tools and stop_service, with the limits and guardrails only they use. Split out of
 * aiToolkit.mjs, whose handler table spreads `commandHandlers` in; check_project shares CMD_MAX_BUFFER and
 * cancellationResult.
 */

import { looksLongRunning as commandLooksLongRunning } from "../commandShape.mjs";
import {
  getEngine,
  getSandboxEngine,
  listProcesses as engineListProcesses,
  stopProcess as engineStopProcess,
} from "../sandbox/engine.mjs";
import { sandboxInventory } from "../sandbox/inventory.mjs";
import { ensureWorkdir, getWorkingDir } from "./workdir.mjs";

// The "execution environment switched" note in run_command results: the sandbox becoming ready in
// the background (or degrading / switching mode) can happen mid-session, and the system prompt can't
// be updated — so we announce it through the tool result, a channel the model keeps reading, so the
// model immediately switches to commands matching the new environment (Linux vs the host system).
let lastRunEngineId = null;
function engineSwitchNote(engineId) {
  if (lastRunEngineId === engineId) return "";
  const first = lastRunEngineId === null;
  lastRunEngineId = engineId;
  if (first) return ""; // No note on the session's first run (the system prompt already describes the current environment)
  // qemu (HVF/WHPX/KVM VM): an isolated Debian/bash sandbox with the host directory mounted in; the model switches to Linux commands accordingly.
  if (engineId === "qemu") {
    return (
      "[Execution environment switched] From this command on, commands run inside an isolated Linux " +
      "(Debian, bash) sandbox, where the working directory is /workspace — the same folder the file tools use, " +
      "so use /workspace or relative paths, not the host path. Please use Linux commands.\n\n"
    );
  }
  const host =
    process.platform === "win32" ? "Windows (cmd/PowerShell)" : process.platform === "darwin" ? "macOS (zsh/bash)" : "Linux (bash)";
  // Leaving the sandbox takes /workspace with it, so the one instruction that holds in both environments is "relative".
  return `[Execution environment switched] From this command on, commands run directly on the host ${host} again; please use commands matching that system, and relative paths (there is no /workspace outside the sandbox).\n\n`;
}

/** URL → origin (scheme+host+port), for matching background services by address. */
function toOrigin(u) {
  try {
    const x = new URL(String(u));
    const h = x.hostname === "0.0.0.0" ? "localhost" : x.hostname;
    return `${x.protocol}//${h}${x.port ? `:${x.port}` : ""}`;
  } catch {
    return String(u);
  }
}

/** Whether this is a dangerous command that could kill this app / mass-terminate processes (should be rejected). */
function isAppKillingCommand(cmd) {
  const c = cmd.toLowerCase();
  // taskkill /IM node.exe|electron.exe|zeraix.exe (mass-terminate by image name)
  if (/\btaskkill\b/.test(c) && /\/im\s+["']?(node|electron|zeraix)/.test(c)) return true;
  // pkill / killall node|electron
  if (/\b(pkill|killall)\b/.test(c) && /\b(node|electron)\b/.test(c)) return true;
  // wmic ... process ... (node|electron) ... delete
  if (/\bwmic\b/.test(c) && /process/.test(c) && /(node|electron)/.test(c) && /delete/.test(c)) return true;
  // Terminating this app's own process pid
  if (/\b(taskkill|kill)\b/.test(c) && new RegExp(`\\b${process.pid}\\b`).test(c)) return true;
  return false;
}

// ── Limits / defaults ────────────────────────────────────────────────────────
const CMD_TIMEOUT_MS = 60_000; // run_command timeout
/**
 * The ceiling for commands whose job IS to fetch over the network.
 *
 * `npm install` on a cold cache routinely runs for several minutes, so at 60s it was killed every time,
 * half-way through writing node_modules. What the model does next is the visible damage: the kill notice
 * below used to read as "a GUI or service may already have started", which is nonsense for an install, so
 * it would re-run it, or push it to the background and then poll again and again asking whether it had
 * finished. Both cost far more of the user's time than simply waiting would have.
 *
 * A ceiling, not a delay: a warm `npm install` still returns in two seconds. The trade is that a fetch
 * command wedged on an unreachable mirror now takes ten minutes to report instead of one — acceptable,
 * because the alternative failed the common case in order to fail the rare one faster.
 */
const CMD_FETCH_TIMEOUT_MS = 600_000;
/**
 * Commands that download. Matched on the command line because there is nothing else to go on: output is
 * buffered until exit (see the engine contract), so an idle-based timeout — which would need no list at
 * all — is not available until run_command streams. Deliberately narrow: a false positive here only
 * delays reporting a hung command, but a false negative kills a legitimate install mid-write.
 */
const FETCH_COMMAND_PATTERNS = [
  /\b(npm|pnpm|yarn|bun)\s+(install|i|ci|add|update|up|rebuild)\b/i,
  /\b(npx|uvx|bunx|pipx)\b/i, // package runners fetch on first use
  /\b(pip3?|uv)\s+(install|sync|add|pip\s+install)\b/i,
  /\b(apt|apt-get|dnf|yum|apk|brew)\s+(install|update|upgrade|add)\b/i,
  /\bgit\s+(clone|fetch|pull|submodule)\b/i,
  /\b(cargo|go|gem|composer|mvn|gradle|dotnet|bundle)\s+(install|build|get|add|fetch|restore|tidy|download|mod)\b/i,
  /\bdocker\s+(pull|build)\b/i,
  /\bwget\b/i,
  // curl only when it is downloading TO A FILE. Bare `curl` is just as often a one-second poke at a local
  // endpoint, and handing that the ten-minute ceiling would mean a black-holed request hangs the turn.
  /\bcurl\b[^|]*(\s-O\b|\s-o\s|--output\b|--remote-name\b)/i,
];
const isFetchCommand = (cmd) => FETCH_COMMAND_PATTERNS.some((re) => re.test(cmd));

/**
 * What the model is told when the user stopped a running command.
 *
 * It has to be unmistakably different from a timeout, because the reasonable reaction to each is the
 * opposite: a timeout invites one careful retry, whereas re-running something the user just stopped is
 * the single worst thing to do here. The partial output is included — a stopped `npm install` or `pytest`
 * has usually said something worth reading, and it is also the only evidence of how far the work got.
 */
export function cancellationResult(r) {
  const parts = [];
  if (r.stdout) parts.push(String(r.stdout).trim());
  if (r.stderr) parts.push(`[stderr]\n${String(r.stderr).trim()}`);
  parts.push(
    "[stopped by the user] The user interrupted this command, so it was terminated and did NOT finish. " +
      "Any output above is partial, and whatever it was doing may be half-done (a partial install, a " +
      "partially written file). Do NOT re-run it and do not start anything else: the user stopped you on " +
      "purpose. Wait for their next instruction; if they ask what happened, say plainly that the command " +
      "was stopped part-way and describe what had already been done.",
  );
  return parts.filter(Boolean).join("\n\n");
}

/**
 * Did this command fail only because the program it names is not installed? Returns the program, or "".
 *
 * Every shell says so differently, and the exit code alone is not enough — 127 is conventional on POSIX but
 * a script is free to return it, and cmd.exe uses 9009. So the code is corroborated by the message, and the
 * name is read out of the message when the shell gives it, since the first token of the command line can be
 * `env`, `sudo` or a variable assignment rather than the thing that was missing.
 */
function missingExecutable(r, cmd) {
  const text = `${r?.stderr ?? ""}\n${r?.stdout ?? ""}`;
  const patterns = [
    // zsh MUST come before the bash pattern. zsh says `zsh: command not found: python` — the shell's own name
    // sits where bash puts the missing program, so the bash rule matches it first and reports "zsh" as missing.
    /command not found: (\S+)/im, // zsh
    /(?:^|[:\s])([^\s:]+): (?:command not found|not found)/im, // bash / sh / dash
    /'([^']+)' is not recognized as an internal or external command/im, // cmd.exe
    /The term '([^']+)' is not recognized as (?:the name of )?a cmdlet/im, // PowerShell
    /(\S+): No such file or directory/im, // exec of an absolute path that is not there
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1].trim();
  }
  // Message unrecognised: trust the code only, and fall back to the first bare word of the command.
  if (r?.code === 127 || r?.code === 9009) return cmd.trim().split(/\s+/)[0] ?? "";
  return "";
}

/**
 * Is it safe to re-run this whole command somewhere else after a missing-program failure?
 *
 * Only when nothing in it can already have taken effect. A bare `python x.py` failed before doing anything,
 * so running it again in the sandbox costs nothing. `rm -rf build && python x.py` did NOT — the removal
 * happened, and a blind re-run would repeat it. Redirections are excluded for the same reason: `> out.txt`
 * truncates the file whether or not the program exists.
 */
const SAFE_TO_RERUN = /^[^&|;\n<>`$()]+$/;
export const CMD_MAX_BUFFER = 10 * 1024 * 1024; // run_command output cap: 10MB

// ── Tool implementations ──────────────────────────────────────────────────────
export const commandHandlers = {
  async run_command({ command, background, sandbox, notify }, { signal } = {}) {
    await ensureWorkdir();
    const cmd = String(command ?? "").trim();
    if (!cmd) throw new Error("command must not be empty");
    // Safety guardrail: reject commands that could kill this app (Electron / Node) or mass-terminate
    // processes by image name. To stop a background service you started yourself, use stop_service
    // instead (it only ends that service's process tree and never affects this app).
    if (isAppKillingCommand(cmd)) {
      return (
        "Refused to execute: this command could terminate this app or many unrelated processes (e.g. " +
        "taskkill/pkill node/electron by image name, or terminating this app's process). To stop a " +
        "background service you started earlier, use the stop_service tool instead (pass a pid or url)."
      );
    }
    // Long-lived processes such as dev servers / watchers: start non-blocking in the background so they
    // aren't killed by the 60s timeout. When not explicitly specified, judged by command shape — see
    // commandShape.mjs for what counts, and for the curl-to-a-/dev/-path that used to.
    const looksLongRunning = commandLooksLongRunning(cmd);
    // Through the current execution engine (native = run directly on the host; qemu = isolated
    // execution inside a VM). When the engine differs from last time (sandbox became ready mid-run
    // / degraded / switched mode), prepend the environment-switch note before the result.
    //
    // `sandbox: true` overrides that choice for THIS command only. It exists for dev mode, where the
    // default engine is the host but the document/media toolchain the model needs (imagemagick, ffmpeg,
    // pandoc, OCR) is installed only in the guest image. The working directory is the same either way —
    // it is mounted into the VM — so the artifacts land where the file tools can read them.
    const guest = sandbox === true ? getSandboxEngine() : null;
    if (sandbox === true && !guest) {
      return (
        "The Linux sandbox is not running, so this command cannot be run inside it. Its toolchain " +
        "(imagemagick, ffmpeg, pandoc, OCR, …) is not installed on this machine either — do not fall back " +
        "to running those tools on the host. Tell the user the sandbox needs to be started from the " +
        "sandbox status indicator, or re-run the command without sandbox:true if the host can do the job."
      );
    }
    const engine = guest ?? getEngine();
    // Only the DEFAULT engine's identity is tracked: a one-off `sandbox: true` call is not an environment
    // switch, and letting it move lastRunEngineId would make the NEXT ordinary command announce a switch
    // back to a host it never left.
    const note = guest ? "" : engineSwitchNote(engine.id);
    if (background ?? looksLongRunning) {
      const wantsNotify = notify === true;
      const msg = await engine.startBackground(cmd, { cwd: getWorkingDir(), notify: wantsNotify });
      // The whole point of notify is that the model STOPS here. Said explicitly, because the default reflex
      // after starting something in the background is to poll it, and polling is exactly what this replaces.
      const wait = wantsNotify
        ? "\n\nYou asked to be notified, so this command will announce its own completion with its output. " +
          "Do NOT poll it, re-run it, sleep, or check whether it has finished — you will be told. End your turn now: " +
          "tell the user it is running and that you will continue when it lands, then answer anything else they ask " +
          "in the meantime."
        : "";
      return `${note}${msg}${wait}`;
    }
    const fetches = isFetchCommand(cmd);
    const timeoutMs = fetches ? CMD_FETCH_TIMEOUT_MS : CMD_TIMEOUT_MS;
    let r = await engine.run(cmd, {
      cwd: getWorkingDir(),
      timeoutMs,
      maxBuffer: CMD_MAX_BUFFER,
      signal,
    });
    // The user pressed Stop. Reported before every other branch below and without any of the retry
    // machinery: the fallback-to-sandbox path treats a non-zero exit as "the host cannot do this" and would
    // helpfully re-run, in the sandbox, the very command the user just interrupted.
    if (r.canceled) return cancellationResult(r);
    /**
     * The host does not have that program, but the sandbox does — so use it, rather than reporting defeat.
     *
     * This is the "python is not installed" case: on the host the model runs `python x.py`, gets
     * "command not found", and tells the user the language is missing, when a full Python / Node / JDK is
     * sitting in the sandbox one flag away. It has no way to know that without asking, so it does not ask.
     *
     * Deliberately one-directional. It fires only when the HOST was already the engine — never in daily mode,
     * where commands run in the sandbox precisely so that everyday work cannot touch the user's real machine.
     * Falling back the other way would spend that isolation to fix a convenience problem.
     *
     * `command -v` first rather than just re-running: if the sandbox has not got it either, the honest answer
     * is the host's own error, and a second identical failure would only muddy it.
     */
    let fellBackTo = "";
    if (!guest && engine.id === "native" && !r.killed && r.code !== 0) {
      const missing = missingExecutable(r, cmd);
      const vm = missing && SAFE_TO_RERUN.test(cmd) ? getSandboxEngine() : null;
      if (vm) {
        const probe = await vm.run(`command -v ${JSON.stringify(missing)}`, { cwd: getWorkingDir(), timeoutMs: 15_000 });
        if (probe.code === 0 && String(probe.stdout).trim()) {
          const retry = await vm.run(cmd, { cwd: getWorkingDir(), timeoutMs, maxBuffer: CMD_MAX_BUFFER });
          r = retry;
          fellBackTo = missing;
        }
      }
    }
    // Stated on success as well as failure: the model has to know WHERE this ran, or it will describe host
    // state it never touched, and follow-up commands will go back to the host and fail the same way.
    const fellBack = fellBackTo
      ? `[Ran in the Linux sandbox] \`${fellBackTo}\` is not installed on this machine, but the sandbox has it, so the ` +
        `command was re-run there — same working directory, mounted in. Tell the user this ran in the sandbox rather ` +
        `than saying ${fellBackTo} is missing, and pass sandbox:true yourself for follow-up commands that need it.\n\n`
      : "";
    if (r.code === 0 && !r.killed) {
      const out = `${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`.trim();
      return `${note}${fellBack}${out || "(no output, exit code 0)"}`;
    }
    const parts = [];
    if (note) parts.push(note.trim());
    if (fellBack) parts.push(fellBack.trim());
    if (r.stdout) parts.push(r.stdout.trim());
    if (r.stderr) parts.push(`[stderr]\n${r.stderr.trim()}`);
    parts.push(`[exit code ${r.code ?? "?"}${r.killed ? ", killed (timeout)" : ""}]`);
    // What to say about a timeout depends entirely on what timed out, and saying the wrong thing is
    // expensive. The generic advice below — "a GUI or service may already have started" — is actively
    // misleading for an install that was simply still downloading: it invites a re-run or a poll loop,
    // when the truth is that the network is slow and the work is half-done on disk.
    if (r.killed && fetches) {
      parts.push(
        `Note: this download did not finish within ${Math.round(timeoutMs / 60_000)} minutes and was terminated, ` +
          "so whatever it was fetching is incomplete. It was NOT left running in the background — there is " +
          "nothing to poll or wait for, and re-checking will not help. Re-running it is safe and resumes from " +
          "whatever was already cached, but do that at most once: a second timeout means the network or the " +
          "registry mirror is the problem, and the user has to be told rather than waited on.",
      );
    } else if (r.killed) {
      parts.push(
        `Note: the command did not finish within ${Math.round(timeoutMs / 1000)} seconds and was terminated. If this is a program ` +
          "that opens a window or keeps running (e.g. a GUI app or a service), it may already have " +
          "started. Do not keep retrying similar commands; to run in the background use a non-blocking " +
          "launch, or just tell the user to run it manually.",
      );
    }
    return parts.filter(Boolean).join("\n");
  },

  async sandbox_tools({ query } = {}) {
    const guest = getSandboxEngine();
    // Deliberately not "no tools available": the toolchain is a property of the image, not of whether the VM
    // happens to be up, and the actionable part is that it can be started.
    if (!guest) {
      return (
        "The Linux sandbox is not running, so its toolchain cannot be reached or listed. Those tools " +
        "(imagemagick, ffmpeg, pandoc, LibreOffice, OCR, …) are not installed on the user's machine either, so " +
        "do not try to run them here. Tell the user that image / media / document work needs the sandbox, and " +
        "that it can be started or restarted from the sandbox status indicator."
      );
    }
    return sandboxInventory(guest, { query });
  },

  async stop_service({ pid, url } = {}) {
    const procs = engineListProcesses();
    const has = (t) => procs.some((s) => s.pid === t);
    let target = pid != null && pid !== "" ? Number(pid) : NaN;
    if ((Number.isNaN(target) || !has(target)) && url) {
      const want = toOrigin(url);
      const hit = procs.find((s) => s.url && toOrigin(s.url) === want);
      if (hit) target = hit.pid;
    }
    // When unspecified and there's exactly one background service, stop it by default.
    if ((Number.isNaN(target) || !has(target)) && procs.length === 1) {
      target = procs[0].pid;
    }
    if (Number.isNaN(target) || !has(target)) {
      const running = procs
        .map((s) => `pid ${s.pid}${s.url ? ` (${s.url})` : ""}`)
        .join("; ");
      return `No matching background service found (it may have already stopped). Currently running: ${running || "none"}.`;
    }
    engineStopProcess(target);
    return `Stopped background service pid ${target}.`;
  },
};
