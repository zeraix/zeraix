/**
 * Host bridge to the Rust Agent Runtime sidecar — the one import path for all of it.
 *
 * The bridge outgrew one file, so it lives in four, and this facade keeps every caller's import unchanged:
 *
 * - rustRuntimeCore.mjs   the sidecar: spawn, protocol, supervision, readiness. Start here; its header is the
 *                         design document for the whole bridge.
 * - rustRuntimeAgent.mjs  `agent.run`, and the host.tool / host.round / host.ask / host.consent answers a run needs.
 * - rustRuntimeCalls.mjs  single calls: tools, commands, background services, sub-agent delegations.
 * - rustRuntimePolicy.mjs the session policy declared at the handshake.
 *
 * The parts depend on the core and never on this file or on each other, so there are no import cycles to
 * trip over. Loading this file loads all four, which is what registers the agent module's request handlers —
 * exactly as it did when they were one file.
 */
export * from "./rustRuntimeCore.mjs";
export * from "./rustRuntimeAgent.mjs";
export * from "./rustRuntimeCalls.mjs";
export { setSessionPolicyProvider } from "./rustRuntimePolicy.mjs";
