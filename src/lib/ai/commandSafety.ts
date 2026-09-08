/**
 * What kind of shell command this is: safe to read, ordinary, or aimed at something you cannot undo.
 *
 * The tool-approval policy (approvalMode.ts) routes `run_command` on this classification rather than
 * treating every command as one thing — the way Claude Code does it:
 *
 *   read-only  `git log`, `ls`, `rg TODO` — run without asking, in every mode but manual.
 *   other      `npm install`, `git commit`, a script — routed to the user's approval.
 *   critical   `rm -rf /`, deleting a home or system directory — routed to approval ALWAYS, even
 *              where an earlier "don't ask again" or full trust would otherwise let it through.
 *
 * Two rules make this safe to rely on:
 *
 *  1. **It fails closed.** Anything this parser cannot account for — a substitution, a redirect, an
 *     unknown program, a flag not on the screen list — is "other", never "read-only". Being wrong
 *     therefore costs a confirmation click, not a deleted repository. Every new rule must preserve
 *     that direction: widen `critical`, never widen `read-only` on a guess.
 *  2. **It is not a sandbox.** It decides who is asked, never what a command may do once approved.
 *     A cleverly disguised destructive command that reads as "other" still stops at the panel with
 *     its text on screen, which is the actual boundary.
 *
 * The shell is bash on macOS/Linux and PowerShell on Windows, so both vocabularies appear below; the
 * splitting characters (`;`, `&&`, `||`, `|`, newlines) mean the same in both.
 */

/** How a command is routed. */
export type CommandClass = "read-only" | "critical" | "other";

/**
 * Constructs whose effect cannot be read off the text: a substitution runs a command we have not
 * classified, a redirect writes, and a heredoc carries a payload. Their presence alone disqualifies
 * a command from `read-only` — it may still be perfectly ordinary, and ordinary means "ask".
 */
const OPAQUE = /\$\(|`|\$\{|<\(|>\(|>>|>|<<|\bnohup\b|\bsudo\b|\bdoas\b|\bsu\b/i;

/** Programs that only read. `find` and `git` are here but screened further below — both have teeth. */
const READ_ONLY_PROGRAMS = new Set([
  // POSIX-ish
  "ls", "pwd", "cat", "head", "tail", "wc", "file", "stat", "du", "df", "tree", "basename", "dirname",
  "realpath", "readlink", "whoami", "hostname", "uname", "date", "echo", "printf", "sort", "uniq",
  "diff", "cmp", "cksum", "md5sum", "sha1sum", "sha256sum", "which", "type", "command", "env", "locale",
  "grep", "egrep", "fgrep", "rg", "ripgrep", "ag", "ack", "jq", "yq", "column", "nl", "od", "strings",
  "find", "git", "fd",
  // Windows / PowerShell
  "dir", "where", "get-content", "get-childitem", "get-location", "get-item", "get-itemproperty",
  "select-string", "test-path", "resolve-path", "measure-object", "select-object", "sort-object",
  "format-list", "format-table", "out-string", "compare-object", "get-date", "get-command",
]);

/**
 * git subcommands that only read.
 *
 * Deliberately short. `branch`, `tag`, `remote`, `config`, `stash` and `checkout` all have a
 * destructive flag form (`branch -D`, `config --unset`, `checkout -f` discards working-tree changes),
 * and none of them is needed to review code and write a plan — so they route to approval like
 * anything else rather than being screened flag by flag.
 */
/**
 * git flags that turn a read-only subcommand into arbitrary execution.
 *
 * `git -c core.pager=<cmd> log` runs `<cmd>`; so do `-c alias.x=!<cmd>`, `-c
 * uploadpack.packObjectsHook=<cmd>`, `--config-env`, and `--exec-path`, which points git at helper
 * binaries of the caller's choosing. The subcommand after them is still `log`, so screening the
 * subcommand alone is not enough — this was a real hole in the first version of this file, found by
 * asking whether ALL git commands are safe rather than which subcommands are.
 *
 * `-C <dir>` and `--no-pager` are deliberately absent: they choose a repository and suppress a pager,
 * and neither can name a program to run.
 */
// Case-SENSITIVE, and that is the whole trick: git's `-c` injects config and its `-C` chooses a
// repository. An /i here quietly rejects `git -C packages/web log`, which is how a monorepo gets
// reviewed — safe, but it would have made the allowlist useless in exactly the repos it matters in.
const GIT_EXECUTES = /^(?:-c(?:=|$)|--config-env(?:=|$)|--exec-path(?:=|$)|--upload-pack(?:=|$)|--receive-pack(?:=|$)|--ext-diff$)/;

const READ_ONLY_GIT = new Set([
  "log", "status", "diff", "show", "blame", "ls-files", "ls-tree", "ls-remote", "rev-parse", "rev-list",
  "describe", "shortlog", "cat-file", "reflog", "grep", "whatchanged", "annotate", "count-objects",
]);

/** `find` actions that run or delete something. Their presence makes a find anything but read-only. */
const FIND_TEETH = /(^|\s)-(delete|exec|execdir|ok|okdir|fls|fprint|fprintf|fprint0)(\s|$)/i;

/** Programs whose whole job is to destroy something. Paired with a target below to spot the critical case. */
const DESTRUCTIVE = new Set([
  "rm", "rmdir", "unlink", "shred", "srm", "dd", "mkfs", "fdisk", "format", "truncate",
  "del", "erase", "rd", "remove-item", "clear-content", "chmod", "chown", "takeown", "icacls",
]);

/**
 * Paths that must never be handed to a destructive command without a human looking at it: filesystem
 * roots, the user's home, and the system directories. Matched against the argument as written — a
 * relative path that happens to reach one of these still routes to approval, because it will not be
 * classified `read-only` either way.
 */
const CRITICAL_TARGET =
  /^(?:[\\/]+\*?|~[\\/]*\*?|\$HOME[\\/]*|\$\{HOME\}[\\/]*|%USERPROFILE%[\\/]*|%HOMEPATH%[\\/]*|%SYSTEMROOT%[\\/]*|[A-Za-z]:[\\/]*\*?|\/(?:usr|etc|var|bin|sbin|lib|opt|boot|dev|sys|proc|System|Library|Applications|Users|home|root)(?:[\\/].*)?|[A-Za-z]:[\\/]+(?:Windows|Program Files(?: \(x86\))?|Users)(?:[\\/].*)?)$/i;

/** Split on the operators that chain commands. Each part is classified on its own; the worst wins. */
function segments(command: string): string[] {
  return command.split(/&&|\|\||[;|\n\r]/g).map((s) => s.trim()).filter(Boolean);
}

/**
 * Prefixes that carry a command rather than being one.
 *
 * `sudo` earns its place twice over: it is also in OPAQUE, so a sudo command can never be read-only,
 * but it must ALSO be seen through here — otherwise `sudo rm -rf /` names the program "sudo", reads
 * as nothing in particular, and a root deletion is classified as an ordinary command that an earlier
 * "don't ask again" would wave straight through. The test suite pins that case.
 */
const WRAPPERS = new Set([
  "sudo", "doas", "su", "env", "time", "exec", "command", "builtin", "nice", "ionice", "nohup", "xargs",
]);

/** A segment split into the program it actually runs and that program's arguments. */
function parse(segment: string): { program: string; args: string[] } {
  const tokens: string[] = [];
  for (const m of segment.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    const tok = m[1] ?? m[2] ?? m[3] ?? "";
    if (tok) tokens.push(tok);
  }
  let i = 0;
  let sawWrapper = false;
  while (i < tokens.length) {
    const tok = tokens[i];
    const bare = tok.replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
    if (/^[A-Za-z_]\w*=/.test(tok) || WRAPPERS.has(bare)) {
      sawWrapper = true;
      i++;
      continue;
    }
    // Only once a wrapper has been seen: its own flags stand between it and the real program
    // (`sudo -u root rm …`). Skipping a flag's value can only over-report, which is the safe way to
    // be wrong — it costs a confirmation, never a missed deletion.
    if (sawWrapper && tok.startsWith("-")) {
      i++;
      continue;
    }
    return { program: bare, args: tokens.slice(i + 1) };
  }
  return { program: "", args: [] };
}

/** The program a segment runs, without its path or extension. Exported for the background-command rules. */
export function firstProgram(segment: string): string {
  return parse(segment).program;
}

/** Whether this one segment is a destructive command pointed at something irreplaceable. */
function isCritical(segment: string): boolean {
  const { program, args } = parse(segment);
  const targetsCritical = args.some((a) => !a.startsWith("-") && CRITICAL_TARGET.test(a));
  if (DESTRUCTIVE.has(program)) return targetsCritical;
  // `find / -delete` and `find / -exec rm {} ;` destroy exactly as thoroughly, under another name.
  if ((program === "find" || program === "fd") && FIND_TEETH.test(segment)) return targetsCritical;
  return false;
}

/** Whether this one segment only reads. Anything unrecognised is false — see the fail-closed rule. */
function isReadOnly(segment: string): boolean {
  const { program, args: rest } = parse(segment);
  if (!READ_ONLY_PROGRAMS.has(program)) return false;
  if (program === "git") {
    // Any config or exec-path injection disqualifies the whole segment, whatever the subcommand is.
    if (rest.some((a) => GIT_EXECUTES.test(a))) return false;
    // `git -C dir log` and `git --no-pager log`: the subcommand is the first non-flag token, and a
    // flag that takes a value (-C, --git-dir, --work-tree) swallows the next one.
    let i = 0;
    while (i < rest.length && rest[i].startsWith("-")) {
      i += /^(-C|--git-dir|--work-tree)$/.test(rest[i]) ? 2 : 1;
    }
    return i < rest.length && READ_ONLY_GIT.has(rest[i].toLowerCase());
  }
  if (program === "find" || program === "fd") return !FIND_TEETH.test(segment);
  // `env` on its own prints the environment; `env FOO=1 cmd` runs something we have not classified.
  if (program === "env") return rest.length === 0;
  return true;
}

/**
 * Classify a whole command line. The worst segment decides: `git log && rm -rf ~` is critical, and
 * `ls && npm install` is ordinary rather than read-only.
 */
export function classifyCommand(command: string | null | undefined): CommandClass {
  const text = String(command ?? "").trim();
  if (!text) return "other";
  const parts = segments(text);
  if (parts.some(isCritical)) return "critical";
  // Checked after `critical` so a destructive command hidden behind a substitution is still reported
  // as ordinary rather than read-only, and a plainly critical one is never softened by it.
  if (OPAQUE.test(text)) return "other";
  return parts.length > 0 && parts.every(isReadOnly) ? "read-only" : "other";
}
