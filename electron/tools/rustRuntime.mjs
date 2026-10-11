/**
 * Host bridge to the Rust Agent Runtime sidecar — the one import path for all of it.
 *
 * The bridge outgrew one file, so it lives in four, and this facade keeps every caller's import unchanged:
 *
 * - rustRuntime/core.mjs   the sidecar: spawn, protocol, supervision, readiness. Start here; its header is the
 *                         design document for the whole bridge.
 * - rustRuntime/agent.mjs  `agent.run`, and the host.tool / host.round / host.ask / host.consent answers a run needs.
 * - rustRuntime/calls.mjs  single calls: tools, commands, background services, sub-agent delegations.
 * - rustRuntime/policy.mjs the session policy declared at the handshake.
 *
 * The parts depend on the core and never on this file or on each other, so there are no import cycles to
 * trip over. Loading this file loads all four, which is what registers the agent module's request handlers —
 * exactly as it did when they were one file.
 */
export * from "./rustRuntime/core.mjs";
export * from "./rustRuntime/agent.mjs";
export * from "./rustRuntime/calls.mjs";
export { setSessionPolicyProvider } from "./rustRuntime/policy.mjs";
