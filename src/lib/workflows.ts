/**
 * Renderer bridge for automation workflows (see electron/automation/*).
 *
 * Named `workflows`, not `automation`: `window.automation` is the <webview> CDP browser panel
 * (src/lib/automation.ts) and the two must not share a namespace.
 *
 * Desktop-only. Every call degrades to a safe empty value in the Web build so the page can render a
 * clear "desktop only" state instead of throwing.
 */

export type RunState =
  | "QUEUED"
  | "RUNNING"
  | "AWAITING_APPROVAL"
  | "AWAITING_EVENT"
  | "AWAITING_RETRY"
  | "INTERRUPTED"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT";

/** States with no outgoing transition — a run in one of these will never change again. */
export const TERMINAL_STATES: RunState[] = ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"];
export const isTerminal = (s: RunState) => TERMINAL_STATES.includes(s);

export interface WorkflowSummary {
  id: string;
  name: string;
  version: number;
  updatedAt: number | null;
  triggerTypes: string[];
  nodeCount: number;
}

export interface WorkflowNode {
  id: string;
  runtime: "agent" | "shell" | "python" | "browser" | "mcp" | "webhook";
  config: Record<string, unknown>;
  inputs?: { as: string; ref: string }[];
  retry?: { attempts: number; backoff?: "fixed" | "exponential"; delayMs?: number };
  timeoutMs?: number;
}

export interface WorkflowVariable {
  key: string;
  /** `file` holds a path chosen at run time; `secret` is resolved from secure storage, never asked. */
  type: "string" | "number" | "boolean" | "json" | "secret" | "file";
  default?: unknown;
  /** Must be supplied before the run starts. Mutually exclusive with `default`. */
  required?: boolean;
  label?: string;
}

export interface WorkflowDefinition {
  id: string;
  version: number;
  name: string;
  triggers: { id: string; type: string; config?: Record<string, unknown>; missedRunPolicy?: string }[];
  variables?: WorkflowVariable[];
  limits: { concurrency: "single" | "queue" | "parallel"; maxTokens?: number; maxCostUsd?: number; maxDurationMs?: number };
  nodes: WorkflowNode[];
  edges: { from: string; to: string }[];
}

export interface RunRow {
  id: string;
  workflow_id: string;
  definition_version: number;
  state: RunState;
  trigger_type: string;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  tokens_total: number;
  cost_usd_total: number;
  error: string | null;
}

export interface RunEvent {
  seq: number;
  runId?: string;
  run_id?: string;
  nodeId?: string | null;
  node_id?: string | null;
  type: string;
  payload: Record<string, unknown>;
  at: number;
}

export interface AttemptRow {
  id: string;
  run_id: string;
  node_id: string;
  attempt: number;
  state: RunState;
  model_used: string | null;
  tokens: number | null;
  started_at: number | null;
  ended_at: number | null;
  error: string | null;
}

export interface RunDetail {
  run: RunRow | null;
  attempts: AttemptRow[];
  events: RunEvent[];
  outputs: Record<string, Record<string, unknown>>;
}

export interface PendingWait {
  id: string;
  run_id: string;
  node_id: string;
  match_key: string;
  created_at: number;
  deadline_at: number | null;
  on_timeout: "fail" | "continue";
}

export interface PendingApproval {
  id: string;
  run_id: string;
  workflow_id: string;
  node_id: string;
  state: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";
  title: string | null;
  /** The concrete action being authorised, with secret-looking config fields already redacted. */
  preview: { runtime?: string; config?: Record<string, unknown>; inputs?: Record<string, unknown> };
  requested_at: number;
  deadline_at: number | null;
  on_timeout: "reject" | "approve";
}

interface WorkflowsBridge {
  list(): Promise<WorkflowSummary[]>;
  get(id: string, version?: number): Promise<WorkflowDefinition | null>;
  versions(id: string): Promise<number[]>;
  templates(): Promise<string[]>;
  workdir(): Promise<{ path: string | null }>;
  createFromTemplate(
    templateId: string,
    name: string,
  ): Promise<{ ok: true; version: number; id: string } | { ok: false; errors: string[] }>;
  save(def: unknown): Promise<{ ok: true; version: number } | { ok: false; errors: string[] }>;
  remove(id: string): Promise<{ ok: boolean; error?: string }>;
  run(id: string, variables?: Record<string, unknown>): Promise<{ ok: boolean; runId?: string; error?: string }>;
  cancel(runId: string): Promise<{ ok: boolean }>;
  runs(query?: { workflowId?: string; state?: RunState; limit?: number }): Promise<RunRow[]>;
  runDetail(runId: string, sinceSeq?: number): Promise<RunDetail | null>;
  waits(): Promise<PendingWait[]>;
  deliverEvent(key: string, payload?: unknown): Promise<{ ok: boolean; error?: string }>;
  pickFile(): Promise<string | null>;
  approvals(): Promise<PendingApproval[]>;
  decide(approvalId: string, approved: boolean, note?: string | null): Promise<{ ok: boolean; error?: string }>;
  setApprovalStrings(strings: { title: string; expires: string }): void;
  onEvent(cb: (e: RunEvent) => void): () => void;
  onState(cb: (s: { runId: string; state: RunState; error: string | null }) => void): () => void;
}

declare global {
  interface Window {
    workflows?: WorkflowsBridge;
  }
}

function bridge(): WorkflowsBridge | null {
  return typeof window !== "undefined" && window.workflows ? window.workflows : null;
}

/**
 * Every call below uses `bridge()?.method?.()` — the method is optional-chained as well as the
 * bridge. Preload changes only take effect on a full Electron restart, so a hot-reloaded renderer
 * can be talking to an older `window.workflows` that lacks the newer methods. Without the second
 * `?.` that is a TypeError inside an effect, surfacing as a silently broken page rather than a
 * feature that is merely unavailable.
 */

/** Whether automation is available (Electron desktop only). */
export function isWorkflowsAvailable(): boolean {
  return bridge() !== null;
}

export async function listWorkflows(): Promise<WorkflowSummary[]> {
  return (await bridge()?.list?.()) ?? [];
}

export async function getWorkflow(id: string, version?: number): Promise<WorkflowDefinition | null> {
  return (await bridge()?.get?.(id, version)) ?? null;
}

/** Starter template ids; names and descriptions are translated in the renderer. */
export async function listTemplates(): Promise<string[]> {
  return (await bridge()?.templates?.()) ?? [];
}

/**
 * The folder a step's file tools write into.
 *
 * Read from the main process every time rather than cached: it is the agent toolkit's working
 * directory, which a chat session can move, so a value remembered at mount would send the user to
 * the wrong folder without ever looking wrong.
 */
export async function workflowFolder(): Promise<string | null> {
  return (await bridge()?.workdir?.())?.path ?? null;
}

/** Create a workflow from a template. The main process mints the id and returns it. */
export async function createFromTemplate(templateId: string, name: string) {
  return (
    (await bridge()?.createFromTemplate?.(templateId, name)) ?? {
      ok: false as const,
      errors: ["unavailable"],
    }
  );
}

export async function saveWorkflow(def: unknown) {
  return (await bridge()?.save?.(def)) ?? { ok: false as const, errors: ["unavailable"] };
}

export async function deleteWorkflow(id: string) {
  return (await bridge()?.remove?.(id)) ?? { ok: false, error: "unavailable" };
}

/** Start a run. Resolves once queued — follow progress through subscribeToRuns. */
export async function runWorkflow(id: string, variables?: Record<string, unknown>) {
  return (await bridge()?.run?.(id, variables)) ?? { ok: false, error: "unavailable" };
}

export async function cancelRun(runId: string) {
  return (await bridge()?.cancel?.(runId)) ?? { ok: false };
}

export async function listRuns(query?: { workflowId?: string; state?: RunState; limit?: number }): Promise<RunRow[]> {
  return (await bridge()?.runs?.(query)) ?? [];
}

export async function getRunDetail(runId: string, sinceSeq = 0): Promise<RunDetail | null> {
  return (await bridge()?.runDetail?.(runId, sinceSeq)) ?? null;
}

/** Runs suspended waiting on an external event. */
export async function pendingWaits(): Promise<PendingWait[]> {
  return (await bridge()?.waits?.()) ?? [];
}

/** Deliver an inbound event; resumes whichever run is waiting on that key. */
export async function deliverWorkflowEvent(key: string, payload?: unknown) {
  return (await bridge()?.deliverEvent?.(key, payload)) ?? { ok: false, error: "unavailable" };
}

/** Native file picker for a `file` input; returns an absolute path, or null if cancelled. */
export async function pickWorkflowFile(): Promise<string | null> {
  return (await bridge()?.pickFile?.()) ?? null;
}

/** Runs waiting on a human decision. Surfaced on open because the OS notification announcing them
 *  can only have fired if the app happened to be running at that moment. */
export async function pendingApprovals(): Promise<PendingApproval[]> {
  return (await bridge()?.approvals?.()) ?? [];
}

export async function decideApproval(approvalId: string, approved: boolean, note?: string | null) {
  return (await bridge()?.decide?.(approvalId, approved, note ?? null)) ?? { ok: false, error: "unavailable" };
}

/** Hand the main process its translated approval-notification strings (it has no i18n runtime). */
export function syncApprovalStrings(strings: { title: string; expires: string }): void {
  bridge()?.setApprovalStrings?.(strings);
}

/** Subscribe to live run events; no-op unsubscribe outside Electron. */
export function subscribeToRuns(cb: (e: RunEvent) => void): () => void {
  return bridge()?.onEvent?.(cb) ?? (() => {});
}

export function subscribeToRunState(
  cb: (s: { runId: string; state: RunState; error: string | null }) => void,
): () => void {
  return bridge()?.onState?.(cb) ?? (() => {});
}

/** Events arrive from SQLite (snake_case) and from the live bus (camelCase); normalize both. */
export function eventNodeId(e: RunEvent): string | null {
  return e.nodeId ?? e.node_id ?? null;
}
export function eventRunId(e: RunEvent): string {
  return (e.runId ?? e.run_id ?? "") as string;
}
