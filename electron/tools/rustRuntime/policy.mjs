/**
 * The session policy the host declares at the runtime's handshake.
 *
 * Split out of rustRuntime.mjs, which re-exports `setSessionPolicyProvider` — import it from there. Depends on
 * nothing in the runtime bridge, which is what lets the core import it without a cycle.
 */
import path from "node:path";

/**
 * What the host declares about this session at the handshake: the roots work is confined to, the MCP servers
 * the user approved, and whether changes inside those roots need asking about.
 *
 * ## Why a provider rather than a value
 *
 * The answer is not known when this module loads and it is not this module's to know. The workspace root lives
 * in `aiToolkit.mjs`, which already imports from here — reading it back directly would close an import cycle
 * around the two files that most need to stay separable. So the host registers a function and this module calls
 * it at the one moment the answer is needed, which is also the one moment it is guaranteed to be current: the
 * handshake, including the handshake of a sidecar respawned hours later in a different project.
 *
 * ## What declaring this turns ON
 *
 * Landlock. `session_policy.rs` treats a non-empty `workspace_roots` OR `approved_mcp_servers` as "the host
 * declared a policy", and `sandbox_policy` confines every command from that point on. Before this the app
 * declared neither, so the sandbox crate was built, tested, wired — and inert, reporting `NotRequested` on
 * every command it ever saw. That is the gap this closes, and it is why the policy in
 * `FilesystemPolicy::workspace` had to be widened first: an armed sandbox that cannot exec the user's `node`
 * is not a safer app, it is a broken one.
 *
 * Unset — under plain node, in the tests — nothing is declared and the runtime behaves exactly as it did.
 */
let sessionPolicyProvider = null;

/**
 * Declare what this session may touch. Called once at startup, before the sidecar is warmed up.
 *
 * The provider returns `{ workspaceRoots, readonlyRoots, approvedMcpServers, requireApprovalForMutations }`;
 * every field is optional. `readonlyRoots` is for a directory the agent may look at but must never overwrite —
 * the media library — and is kept apart from `workspaceRoots` because a single list cannot express the
 * difference, so naming the library at all used to make it writable. It is called afresh for each handshake rather than captured, so a respawn picks up a workspace the
 * user changed to in the meantime.
 */
export function setSessionPolicyProvider(provider) {
  sessionPolicyProvider = typeof provider === "function" ? provider : null;
}

/** This session's declared policy, in the shape `runtime.initialize` wants. Empty when none was registered. */
export function sessionPolicyParams() {
  if (!sessionPolicyProvider) return {};
  let declared;
  try {
    declared = sessionPolicyProvider() ?? {};
  } catch (e) {
    // Failing closed would confine every command to nothing, which breaks the app far more thoroughly than
    // running unconfined does. Loud, because a session that silently lost its sandbox must not look normal.
    console.error(
      "[rust-runtime] the session policy provider threw; this session runs UNCONFINED:",
      e?.message ?? e,
    );
    return {};
  }
  // Absolute, de-duplicated, and free of the empty strings an unconfigured asset root produces — a `""` root
  // would make `declared` true while naming nothing, which is the one combination that confines a command to
  // its own cwd and nothing else.
  const clean = (list) =>
    [...new Set((list ?? []).filter((r) => typeof r === "string" && r.trim()))].map((r) => path.resolve(r));
  const roots = clean(declared.workspaceRoots);
  // A directory named as both is writable: the stronger declaration wins, and silently dropping one of two
  // explicit statements would be the worse surprise.
  const readonly = clean(declared.readonlyRoots).filter((r) => !roots.includes(r));
  const servers = [...new Set((declared.approvedMcpServers ?? []).filter((s) => typeof s === "string" && s))];
  return {
    workspace_roots: roots,
    readonly_roots: readonly,
    approved_mcp_servers: servers,
    require_approval_for_mutations: Boolean(declared.requireApprovalForMutations),
  };
}
