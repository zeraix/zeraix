/**
 * Which commands the run_command tool starts in the background when the model has not said.
 *
 * A dev server or a watcher must not be killed by the foreground timeout, so a command that LOOKS like one
 * is started non-blocking and reported as a running service the user can stop. The old test was a bare
 * keyword match — `dev`, `serve`, `start`, `watch`, `preview` anywhere in the text — which is how
 * `curl http://localhost:3000/dev/api`, `git checkout dev` and `cat dev.log` came to be started as services:
 * a curl that ran long enough to be seen alive showed up in the running-services panel, and a one-shot
 * that exited at once still cost the model a "process has ended" round trip.
 *
 * Pure text, in its own module so the rules can be tested: the tool that consults it lives in a file that
 * imports Electron.
 */

/** The verbs that mean "keep running" when they stand on their own, or name the script itself. */
const SERVICE_WORDS = /(?<![\w./\\-])(?:dev|serve|start|watch|preview)(?![\w./\\-])/i;
/** Tools that are long-lived by identity, wherever they appear in the segment. */
const SERVICE_TOOLS = /\bvite\b|\bwebpack(?:-dev-server)?\b|\bnodemon\b|\bnext\s+dev\b/i;

/**
 * Programs that are one-shot by nature, whatever their arguments say. A fetch, a file read, a git
 * command: none of them is a service, and the words in their arguments (a URL path, a branch, a file
 * name) describe something else.
 */
const ONE_SHOT = new Set(
  [
    "curl", "wget", "http", "https", "xh", "aria2c", "invoke-webrequest", "invoke-restmethod", "iwr", "irm",
    "git", "cat", "type", "ls", "dir", "echo", "grep", "rg", "find", "head", "tail", "cp", "mv", "rm", "mkdir",
    "rmdir", "touch", "pwd", "which", "where", "stat", "du", "df", "tar", "zip", "unzip", "diff", "sed", "awk",
    "sort", "wc", "tee", "printf", "test", "true", "false", "cd", "set", "export",
  ],
);
/** PowerShell's read/query/file verbs — `Get-Content dev.log`, `Test-Path`, `Select-String start`. */
const ONE_SHOT_PS = /^(?:get|select|test|new|remove|copy|move|set|add|out|write|read|invoke|measure|sort|where|format)-\w+$/i;

/** Prefixes that carry a command rather than being one: `sudo npm start`, `FOO=1 vite`, `time make`. */
const WRAPPERS = new Set(["sudo", "env", "nohup", "time", "exec", "command", "builtin"]);

/** The command's own program name — the first token that is not an env assignment or a wrapper, sans path and `.exe`. */
export function firstProgram(segment) {
  // Quote-aware: `"C:\Program Files\nodejs\npm.cmd" run dev` names npm.cmd, not "Program".
  for (const m of String(segment).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    const tok = m[1] ?? m[2] ?? m[3] ?? "";
    if (!tok || /^[A-Za-z_][\w]*=/.test(tok) || WRAPPERS.has(tok.toLowerCase())) continue;
    return tok.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
  }
  return "";
}

const isOneShot = (program) => {
  const p = program.toLowerCase();
  return ONE_SHOT.has(p) || ONE_SHOT_PS.test(p);
};

/**
 * Whether a command should be started in the background: any of its chained segments looks like a
 * service. Judged per segment so `cd app && npm run dev` is a service and `cd app && curl …/dev` is not.
 * URLs are blanked before the word test — a path is not a verb — and a one-shot program is never a
 * service, whatever it was given.
 */
export function looksLongRunning(cmd) {
  const text = String(cmd ?? "");
  for (const segment of text.split(/&&|\|\||;/)) {
    const program = firstProgram(segment);
    if (!program) continue;
    if (isOneShot(program)) continue;
    // The program IS the verb (`dev`, `./serve.sh`, `watch.cmd`): the script's own name is its intent.
    if (/^(?:dev|serve|start|watch|preview)(?:\.\w+)?$/i.test(program)) return true;
    // URLs and single-quoted literals are blanked: a path is not a verb, and `print('start')` is data.
    // Double-quoted text stays — that is how a command is wrapped (`powershell -Command "npm run dev"`).
    const scrubbed = segment.replace(/https?:\/\/\S+/gi, " ").replace(/'[^']*'/g, " ");
    if (SERVICE_TOOLS.test(scrubbed) || SERVICE_WORDS.test(scrubbed)) return true;
  }
  return false;
}
