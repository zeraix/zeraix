/**
 * Minimal git access for module-level staleness.
 *
 * Git is used here — and only here — because it already computes, incrementally and for free, the
 * thing Tier B needs: which paths have moved since a known point. Hashing every source file to
 * discover the same thing would cost far more. Tier A deliberately does NOT use git: direct
 * fingerprints are cheaper still, and work in directories that are not repositories.
 *
 * Everything degrades to "not a repo": a missing git binary, a detached/empty repository, a
 * rewritten history — none of them may fail a session. Callers fall back to shape + TTL.
 */
import { execFile } from "node:child_process";

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

/** Run git, resolving to stdout, or null on any failure (missing binary, non-zero exit, timeout). */
function git(workdir, args) {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd: workdir, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
      (err, stdout) => resolve(err ? null : String(stdout)),
    );
  });
}

/**
 * Parse `git status --porcelain=v1 -z` output into a flat path list.
 * NUL-delimited so paths with spaces / quotes / non-ASCII need no unescaping. Rename and copy
 * records carry a second token (the source path), which is consumed here too.
 */
function parseStatusZ(out) {
  const paths = [];
  const tokens = String(out).split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t || t.length < 4) continue;
    const xy = t.slice(0, 2);
    paths.push(t.slice(3));
    if (xy[0] === "R" || xy[0] === "C") {
      const src = tokens[++i];
      if (src) paths.push(src);
    }
  }
  return paths;
}

/**
 * Repository state in two subprocess calls, regardless of how many modules there are.
 * @returns {Promise<{isRepo:boolean, head:string|null, dirty:string[]}>}
 */
export async function gitInfo(workdir) {
  const head = await git(workdir, ["rev-parse", "HEAD"]);
  if (head == null) return { isRepo: false, head: null, dirty: [] };

  const status = await git(workdir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return {
    isRepo: true,
    head: head.trim() || null,
    dirty: status == null ? [] : parseStatusZ(status),
  };
}

/**
 * Every tracked path, in one call.
 *
 * In a repository this replaces walking the tree: `ls-files` is a single index read, whereas the
 * equivalent walk is thousands of stat calls — which on a Windows drive mounted into WSL (drvfs)
 * dominates the cost of a pass that usually changes nothing. It also gets .gitignore handling for
 * free. Returns null outside a repository, where the caller falls back to walking.
 */
export async function listTrackedFiles(workdir) {
  const out = await git(workdir, ["ls-files", "-z"]);
  if (out == null) return null;
  return out.split("\0").filter(Boolean);
}

/**
 * Paths changed between a previously recorded commit and HEAD.
 * Returns null when the answer is unknowable — no stored baseline, or a history rewrite made the
 * old sha unreachable. Callers must treat null as "assume everything moved", never as "nothing
 * moved": silently skipping a rebuild is the one failure mode that makes the map lie.
 */
export async function changedSince(workdir, fromSha) {
  if (!fromSha) return null;
  const out = await git(workdir, ["diff", "--name-only", `${fromSha}..HEAD`]);
  if (out == null) return null;
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}
