"use client";

/**
 * Visual workflow editor (@xyflow/react).
 *
 * The canvas edits the *graph* — nodes, their config, and the edges between them. Workflow-level
 * fields that have no graphical form (triggers, limits, variables) stay on the JSON tab; this editor
 * carries them through untouched rather than dropping what it cannot draw. The one exception is
 * `variables`: the input editor can *append* a workflow input inline (see createVarAndBind), because
 * a first-time user building a step has no other way to declare the value it needs.
 *
 * Node coordinates are persisted as `node.position` and are purely presentational: the runtime
 * derives execution order from `edges[]`, never from geometry. Dragging a node cannot change what a
 * workflow does.
 *
 * The inspector deliberately hides the wire format. The engine only accepts two ref forms
 * (`run://<node>/<key>` and `var://<key>`, see electron/automation/dataBus.mjs) and the prompt
 * templating (`{{inputs.x}}` for agents, `$INPUT_X` env for shell), but a non-technical user should
 * never have to type either — the input rows build the refs from dropdowns and the chips insert the
 * placeholders. Raw editing still lives on the JSON tab for anyone who wants it.
 *
 * Validation deliberately stays in the main process (electron/automation/schema.mjs). This component
 * surfaces one advisory warning — that v1 executes a single chain — because that is a rule the
 * *runtime* enforces at run time (linearOrder), so a branching graph saves fine and then fails on
 * first run. Warning here turns a confusing later failure into an obvious one now.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { useTheme } from "next-themes";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Plus, Trash2, Bot, Terminal, AlertTriangle, Check, X } from "lucide-react";
import { useT } from "@/lib/i18n";
import type { WorkflowDefinition, WorkflowNode, WorkflowVariable } from "@/lib/workflows";

type FlowNode = Node<{ wf: WorkflowNode }>;

const RUNTIME_ICON = { agent: Bot, shell: Terminal } as const;

/** Vertical spacing used when laying out a definition that has no saved coordinates. */
const AUTO_GAP = 110;

/**
 * Output values each runtime publishes, in the order a picker should offer them (first = default).
 * These are the exact keys the runtimes emit — agent.mjs yields { text, model, rounds }, shell.mjs
 * yields { stdout, stderr, exitCode } — so a `run://` ref built from this list always resolves.
 */
const OUTPUT_KEYS: Record<string, string[]> = {
  agent: ["text", "model", "rounds"],
  shell: ["stdout", "stderr", "exitCode"],
};
const KNOWN_KEYS = new Set(Object.values(OUTPUT_KEYS).flat());

type Source = "step" | "var";

/**
 * Decode an input ref into the fields the picker edits. The `source` a row shows is derived by the
 * caller from whether the ref is a `var://` (a `var://` with no key still counts as a chosen variable
 * source that is simply unset). Empty / unrecognised reads as an unset step.
 */
function parseRef(ref = ""): { node: string; key: string; varKey: string } {
  const run = /^run:\/\/([^/]*)\/(.*)$/.exec(ref);
  if (run) return { node: run[1] ?? "", key: run[2] ?? "", varKey: "" };
  if (ref.startsWith("var://")) return { node: "", key: "", varKey: ref.slice(6) };
  return { node: "", key: "", varKey: "" };
}

/** One workflow step on the canvas. */
function StepNode({ data, selected }: NodeProps<FlowNode>) {
  const wf = data.wf;
  const Icon = RUNTIME_ICON[wf.runtime as keyof typeof RUNTIME_ICON] ?? Terminal;
  const summary =
    typeof wf.config?.command === "string"
      ? wf.config.command
      : typeof wf.config?.prompt === "string"
        ? wf.config.prompt
        : wf.runtime;

  return (
    <div
      className={`w-56 rounded-xl border bg-surface px-3 py-2 shadow-sm transition ${
        selected ? "border-primary ring-2 ring-primary/20" : "border-line-strong"
      }`}
    >
      <Handle type="target" position={Position.Top} className="!size-2 !border-0 !bg-primary/60" />
      <div className="flex items-center gap-1.5">
        <Icon className="size-3.5 shrink-0 text-primary" />
        <span className="truncate text-xs font-semibold text-foreground">{wf.id}</span>
        <span className="ml-auto shrink-0 rounded bg-muted px-1 py-px text-[9px] uppercase text-muted-foreground">
          {wf.runtime}
        </span>
      </div>
      <p className="mt-1 line-clamp-2 break-words font-mono text-[10px] leading-snug text-muted-foreground">
        {String(summary)}
      </p>
      <Handle type="source" position={Position.Bottom} className="!size-2 !border-0 !bg-primary/60" />
    </div>
  );
}

const nodeTypes = { step: StepNode };

/** definition -> React Flow, laying out any node that has never been positioned. */
function toFlow(def: WorkflowDefinition): { nodes: FlowNode[]; edges: Edge[] } {
  const nodes: FlowNode[] = (def.nodes ?? []).map((n, i) => ({
    id: n.id,
    type: "step",
    position: (n as WorkflowNode & { position?: { x: number; y: number } }).position ?? {
      x: 40,
      y: i * AUTO_GAP,
    },
    data: { wf: n },
  }));
  const edges: Edge[] = (def.edges ?? []).map((e) => ({
    id: `${e.from}->${e.to}`,
    source: e.from,
    target: e.to,
    animated: true,
  }));
  return { nodes, edges };
}

/** React Flow -> definition, preserving every field the canvas does not model. */
function toDefinition(base: WorkflowDefinition, nodes: FlowNode[], edges: Edge[]): WorkflowDefinition {
  return {
    ...base,
    nodes: nodes.map((n) => ({ ...n.data.wf, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } })),
    edges: edges.map((e) => ({ from: e.source, to: e.target })),
  };
}

const FIELD_CLS =
  "w-full rounded-md border border-line-strong bg-surface px-2 py-1 text-[11px] outline-none focus:border-ring";

export default function WorkflowCanvas({
  definition,
  onChange,
}: {
  definition: WorkflowDefinition;
  onChange: (next: WorkflowDefinition) => void;
}) {
  const t = useT();
  const { resolvedTheme } = useTheme();
  const initial = useMemo(() => toFlow(definition), [definition]);
  const [nodes, setNodes] = useState<FlowNode[]>(initial.nodes);
  const [edges, setEdges] = useState<Edge[]>(initial.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Which input row (index) is mid "new workflow input" entry, and the name being typed for it.
  const [newVarIdx, setNewVarIdx] = useState<number | null>(null);
  const [newVarKey, setNewVarKey] = useState("");
  // The prompt/command textarea, so chips can insert a placeholder at the caret rather than the end.
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  /**
   * Lowest-level write: set the flow state and hand the parent a complete definition built on `base`.
   * Everything funnels through here so the parent always holds graph + workflow-level fields together
   * in one update — two separate onChange calls would let the second rebuild from a stale `definition`
   * and silently drop the first (e.g. a freshly-declared variable).
   */
  const commitFull = useCallback(
    (nextNodes: FlowNode[], nextEdges: Edge[], base: WorkflowDefinition) => {
      setNodes(nextNodes);
      setEdges(nextEdges);
      onChange(toDefinition(base, nextNodes, nextEdges));
    },
    [onChange],
  );

  const commit = useCallback(
    (nextNodes: FlowNode[], nextEdges: Edge[]) => commitFull(nextNodes, nextEdges, definition),
    [commitFull, definition],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => commit(applyNodeChanges(changes, nodes), edges),
    [nodes, edges, commit],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => commit(nodes, applyEdgeChanges(changes, edges)),
    [nodes, edges, commit],
  );
  const onConnect = useCallback(
    (c: Connection) => commit(nodes, addEdge({ ...c, animated: true }, edges)),
    [nodes, edges, commit],
  );

  const addNode = (runtime: "shell" | "agent") => {
    // Ids appear in data-bus refs (run://<nodeId>/<key>), so keep them short and collision-free.
    let n = nodes.length + 1;
    while (nodes.some((x) => x.id === `${runtime}${n}`)) n++;
    const id = `${runtime}${n}`;
    const wf: WorkflowNode = {
      id,
      runtime,
      config: runtime === "shell" ? { command: "echo hello" } : { prompt: "Summarize: {{inputs.data}}" },
      inputs: [],
    };
    const node: FlowNode = {
      id,
      type: "step",
      position: { x: 40, y: nodes.length * AUTO_GAP },
      data: { wf },
    };
    commit([...nodes, node], edges);
    setSelectedId(id);
  };

  const updateNode = (id: string, patch: Partial<WorkflowNode>) => {
    commit(
      nodes.map((n) => (n.id === id ? { ...n, data: { wf: { ...n.data.wf, ...patch } } } : n)),
      edges,
    );
  };

  const removeNode = (id: string) => {
    commit(
      nodes.filter((n) => n.id !== id),
      // Dropping the node's edges too, otherwise the definition keeps references to a node that no
      // longer exists and validation rejects the save with a confusing "unknown node".
      edges.filter((e) => e.source !== id && e.target !== id),
    );
    setSelectedId(null);
  };

  const selected = nodes.find((n) => n.id === selectedId)?.data.wf ?? null;

  // Non-secret variables are the only ones a `var://` input can resolve (buildVariables drops secret
  // defaults), so they are the only ones offered as an input source.
  const askableVars = useMemo(
    () => (definition.variables ?? []).filter((v) => v.type !== "secret"),
    [definition.variables],
  );

  /** Human label for an output key; unknown (legacy hand-typed) keys show verbatim. */
  const keyLabel = (k: string) => (KNOWN_KEYS.has(k) ? t(`auto.canvas.out.${k}`) : k);

  /** Patch one input binding on the selected node. */
  const setInput = (i: number, patch: Partial<{ as: string; ref: string }>) => {
    if (!selected) return;
    const next = [...(selected.inputs ?? [])];
    next[i] = { ...next[i], ...patch };
    updateNode(selected.id, { inputs: next });
  };

  /** First output key of whatever runtime `nodeId` is, used as the sensible default when a step is picked. */
  const defaultKeyFor = (nodeId: string) => {
    const rt = nodes.find((n) => n.id === nodeId)?.data.wf.runtime;
    return (rt && OUTPUT_KEYS[rt]?.[0]) || "";
  };

  /**
   * Declare a new workflow input AND bind the current row to it, in a single write. Marked required
   * with no default so the run dialog asks for it — the same shape the templates use for `topic`.
   */
  const createVarAndBind = (i: number, rawKey: string) => {
    if (!selected) return;
    const key = rawKey.replace(/[^a-zA-Z0-9_]/g, "");
    if (!key) return;
    const base = definition.variables ?? [];
    const nextVars: WorkflowVariable[] = base.some((v) => v.key === key)
      ? base
      : [...base, { key, type: "string", label: key, required: true }];
    const nextNodes = nodes.map((n) =>
      n.id === selected.id
        ? {
            ...n,
            data: {
              wf: {
                ...n.data.wf,
                inputs: (n.data.wf.inputs ?? []).map((b, j) => (j === i ? { ...b, ref: `var://${key}` } : b)),
              },
            },
          }
        : n,
    );
    commitFull(nextNodes, edges, { ...definition, variables: nextVars });
    setNewVarIdx(null);
    setNewVarKey("");
  };

  /** Insert an input placeholder at the caret: `{{inputs.x}}` for an agent, `$INPUT_X` for shell. */
  const insertPlaceholder = (as: string) => {
    if (!selected || !as) return;
    const isShell = selected.runtime === "shell";
    const field = isShell ? "command" : "prompt";
    const token = isShell ? `$INPUT_${as.replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase()}` : `{{inputs.${as}}}`;
    const cur = String(selected.config?.[field] ?? "");
    const el = promptRef.current;
    const start = el?.selectionStart ?? cur.length;
    const end = el?.selectionEnd ?? cur.length;
    const next = cur.slice(0, start) + token + cur.slice(end);
    updateNode(selected.id, { config: { ...selected.config, [field]: next } });
    // The textarea is controlled, so restore the caret after the value re-renders.
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  // v1 executes a single chain (schema.mjs linearOrder). A branch saves fine and fails on first run,
  // so surface it now rather than at 3am.
  const branchWarning = useMemo(() => {
    const outDeg = new Map<string, number>();
    const inDeg = new Map<string, number>();
    for (const e of edges) {
      outDeg.set(e.source, (outDeg.get(e.source) ?? 0) + 1);
      inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
    }
    const branches = [...outDeg.values()].some((v) => v > 1) || [...inDeg.values()].some((v) => v > 1);
    const roots = nodes.filter((n) => !inDeg.has(n.id)).length;
    return nodes.length > 0 && (branches || roots > 1);
  }, [nodes, edges]);

  return (
    // Fills whatever the dialog gives it rather than a fixed height, so the canvas grows with the
    // window instead of leaving the workspace cramped.
    <div className="grid h-full grid-cols-[1fr_300px] gap-3">
      <div className="relative overflow-hidden rounded-lg border border-line">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={(_, n) => {
            setSelectedId(n.id);
            setNewVarIdx(null);
          }}
          onPaneClick={() => {
            setSelectedId(null);
            setNewVarIdx(null);
          }}
          // Follow the APP's theme, not the OS. `colorMode="system"` reads the OS preference, so a
          // light app on a dark machine renders a black canvas inside a white dialog. next-themes'
          // resolvedTheme is what the rest of the app uses (see FilesPanel, TerminalView).
          colorMode={resolvedTheme === "dark" ? "dark" : "light"}
          fitView
          // Cap the zoom: fitView on a two-node workflow would otherwise magnify the cards to fill
          // the (now much larger) canvas, which looks broken rather than spacious.
          fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
          proOptions={{ hideAttribution: false }}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>

        <div className="pointer-events-none absolute left-2 top-2 flex gap-1.5">
          <button
            onClick={() => addNode("shell")}
            className="pointer-events-auto flex items-center gap-1 rounded-md border border-line-strong bg-surface px-2 py-1 text-[11px] font-medium text-foreground shadow-sm transition hover:bg-surface-muted"
          >
            <Plus className="size-3" />
            {t("auto.canvas.addShell")}
          </button>
          <button
            onClick={() => addNode("agent")}
            className="pointer-events-auto flex items-center gap-1 rounded-md border border-line-strong bg-surface px-2 py-1 text-[11px] font-medium text-foreground shadow-sm transition hover:bg-surface-muted"
          >
            <Plus className="size-3" />
            {t("auto.canvas.addAgent")}
          </button>
        </div>

        {branchWarning && (
          <p className="pointer-events-none absolute bottom-2 left-2 right-2 flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-px size-3 shrink-0" />
            {t("auto.canvas.chainWarning")}
          </p>
        )}
      </div>

      {/* Inspector */}
      <div className="overflow-y-auto rounded-lg border border-line bg-surface-muted/40 p-3">
        {!selected ? (
          <p className="py-8 text-center text-xs text-muted-foreground">{t("auto.canvas.selectNode")}</p>
        ) : (
          <div className="space-y-3">
            <Field label={t("auto.canvas.nodeId")}>
              <input
                value={selected.id}
                onChange={(e) => {
                  const nextId = e.target.value.replace(/[^a-zA-Z0-9_-]/g, "");
                  if (!nextId || nodes.some((n) => n.id === nextId)) return;
                  // The React Flow node id and the workflow node id must move together, and any
                  // edge referencing the old id has to follow, or the graph breaks on save.
                  const nextNodes = nodes.map((n) =>
                    n.id === selected.id ? { ...n, id: nextId, data: { wf: { ...n.data.wf, id: nextId } } } : n,
                  );
                  const nextEdges = edges.map((ed) => ({
                    ...ed,
                    source: ed.source === selected.id ? nextId : ed.source,
                    target: ed.target === selected.id ? nextId : ed.target,
                    id: `${ed.source === selected.id ? nextId : ed.source}->${ed.target === selected.id ? nextId : ed.target}`,
                  }));
                  commit(nextNodes, nextEdges);
                  setSelectedId(nextId);
                }}
                className="w-full rounded-md border border-line-strong bg-surface px-2 py-1 font-mono text-xs outline-none focus:border-ring"
              />
            </Field>

            {selected.runtime === "shell" ? (
              <Field label={t("auto.canvas.command")}>
                <textarea
                  ref={promptRef}
                  value={String(selected.config?.command ?? "")}
                  onChange={(e) => updateNode(selected.id, { config: { ...selected.config, command: e.target.value } })}
                  rows={3}
                  spellCheck={false}
                  className="w-full resize-none rounded-md border border-line-strong bg-surface px-2 py-1 font-mono text-[11px] outline-none focus:border-ring"
                />
              </Field>
            ) : (
              <>
                <Field label={t("auto.canvas.prompt")}>
                  <textarea
                    ref={promptRef}
                    value={String(selected.config?.prompt ?? "")}
                    onChange={(e) => updateNode(selected.id, { config: { ...selected.config, prompt: e.target.value } })}
                    rows={4}
                    className="w-full resize-none rounded-md border border-line-strong bg-surface px-2 py-1 text-[11px] outline-none focus:border-ring"
                  />
                </Field>
                <Field label={t("auto.canvas.model")}>
                  <input
                    value={String(selected.config?.model ?? "")}
                    placeholder={t("auto.canvas.modelDefault")}
                    onChange={(e) =>
                      updateNode(selected.id, {
                        config: { ...selected.config, model: e.target.value || undefined },
                      })
                    }
                    className="w-full rounded-md border border-line-strong bg-surface px-2 py-1 text-xs outline-none focus:border-ring"
                  />
                </Field>
              </>
            )}

            {/* Chips insert the placeholder the runtime understands, so the syntax never has to be
                typed or remembered. Only shown once the step has an input to reference. */}
            {(selected.inputs ?? []).length > 0 && (
              <div>
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {selected.runtime === "shell" ? t("auto.canvas.insertShell") : t("auto.canvas.insertPrompt")}
                </span>
                <div className="flex flex-wrap gap-1">
                  {(selected.inputs ?? []).map((inp, i) => (
                    <button
                      key={i}
                      onClick={() => insertPlaceholder(inp.as)}
                      disabled={!inp.as}
                      className="rounded-md border border-line-strong bg-surface px-1.5 py-0.5 font-mono text-[10px] text-primary transition hover:bg-surface-muted disabled:opacity-40"
                    >
                      + {inp.as || "…"}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <Field label={t("auto.canvas.inputs")}>
              <div className="space-y-2">
                {(selected.inputs ?? []).map((inp, i) => {
                  const parsed = parseRef(inp.ref);
                  const source: Source = parsed.varKey || inp.ref.startsWith("var://") ? "var" : "step";
                  const keyOpts = (() => {
                    const rt = nodes.find((n) => n.id === parsed.node)?.data.wf.runtime;
                    const opts = (rt && OUTPUT_KEYS[rt]) || [];
                    // Keep a legacy / hand-typed key visible rather than silently dropping it.
                    return parsed.key && !opts.includes(parsed.key) ? [parsed.key, ...opts] : opts;
                  })();
                  return (
                    <div key={i} className="space-y-1.5 rounded-md border border-line bg-surface/60 p-2">
                      {/* Name — this is exactly what appears inside {{inputs.…}} / $INPUT_… */}
                      <div className="flex items-center gap-1">
                        <input
                          value={inp.as}
                          onChange={(e) => setInput(i, { as: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") })}
                          placeholder={t("auto.canvas.inputName")}
                          className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-1.5 py-1 font-mono text-[11px] outline-none focus:border-ring"
                        />
                        <button
                          onClick={() => {
                            updateNode(selected.id, { inputs: (selected.inputs ?? []).filter((_, j) => j !== i) });
                            if (newVarIdx === i) setNewVarIdx(null);
                          }}
                          className="shrink-0 rounded-md px-1 text-muted-foreground transition hover:text-red-500"
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </div>

                      {/* Source: an earlier step's output, or a workflow input asked at run time. */}
                      <select
                        value={source}
                        onChange={(e) => {
                          setNewVarIdx(null);
                          // Reset to an empty ref of the chosen kind; the follow-up dropdown fills it in.
                          setInput(i, { ref: e.target.value === "var" ? "var://" : "" });
                        }}
                        className={FIELD_CLS}
                      >
                        <option value="step">{t("auto.canvas.sourceStep")}</option>
                        <option value="var">{t("auto.canvas.sourceVar")}</option>
                      </select>

                      {source === "step" ? (
                        <div className="flex gap-1">
                          <select
                            value={parsed.node}
                            onChange={(e) => {
                              const node = e.target.value;
                              setInput(i, { ref: node ? `run://${node}/${parsed.key || defaultKeyFor(node)}` : "" });
                            }}
                            className={FIELD_CLS}
                          >
                            <option value="">{t("auto.canvas.chooseStep")}</option>
                            {nodes
                              .filter((n) => n.id !== selected.id)
                              .map((n) => (
                                <option key={n.id} value={n.id}>
                                  {n.id}
                                </option>
                              ))}
                          </select>
                          <select
                            value={parsed.key}
                            disabled={!parsed.node}
                            onChange={(e) => setInput(i, { ref: `run://${parsed.node}/${e.target.value}` })}
                            className={`${FIELD_CLS} disabled:opacity-40`}
                          >
                            {keyOpts.map((k) => (
                              <option key={k} value={k}>
                                {keyLabel(k)}
                              </option>
                            ))}
                          </select>
                        </div>
                      ) : newVarIdx === i ? (
                        // Inline declaration of a brand-new workflow input.
                        <div className="flex gap-1">
                          <input
                            autoFocus
                            value={newVarKey}
                            onChange={(e) => setNewVarKey(e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") createVarAndBind(i, newVarKey);
                              if (e.key === "Escape") setNewVarIdx(null);
                            }}
                            placeholder={t("auto.canvas.newVarPlaceholder")}
                            className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-1.5 py-1 font-mono text-[11px] outline-none focus:border-ring"
                          />
                          <button
                            onClick={() => createVarAndBind(i, newVarKey)}
                            disabled={!newVarKey}
                            className="shrink-0 rounded-md border border-line-strong px-1.5 text-emerald-600 transition hover:bg-emerald-500/10 disabled:opacity-40 dark:text-emerald-400"
                          >
                            <Check className="size-3" />
                          </button>
                          <button
                            onClick={() => setNewVarIdx(null)}
                            className="shrink-0 rounded-md border border-line-strong px-1.5 text-muted-foreground transition hover:bg-surface-muted"
                          >
                            <X className="size-3" />
                          </button>
                        </div>
                      ) : (
                        <select
                          value={parsed.varKey}
                          onChange={(e) => {
                            if (e.target.value === "__new__") {
                              setNewVarKey("");
                              setNewVarIdx(i);
                            } else {
                              setInput(i, { ref: `var://${e.target.value}` });
                            }
                          }}
                          className={FIELD_CLS}
                        >
                          <option value="">{t("auto.canvas.chooseVar")}</option>
                          {askableVars.map((v) => (
                            <option key={v.key} value={v.key}>
                              {v.label || v.key}
                            </option>
                          ))}
                          <option value="__new__">{t("auto.canvas.newVar")}</option>
                        </select>
                      )}
                    </div>
                  );
                })}
                <button
                  onClick={() => {
                    // Default to the upstream step's primary output so the common "chain" case needs
                    // no configuration at all.
                    const upstream = edges.find((e) => e.target === selected.id)?.source;
                    updateNode(selected.id, {
                      inputs: [
                        ...(selected.inputs ?? []),
                        { as: "data", ref: upstream ? `run://${upstream}/${defaultKeyFor(upstream)}` : "" },
                      ],
                    });
                  }}
                  className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-line px-2 py-1 text-[10px] text-muted-foreground transition hover:bg-surface"
                >
                  <Plus className="size-3" />
                  {t("auto.canvas.addInput")}
                </button>
              </div>
            </Field>

            <button
              onClick={() => removeNode(selected.id)}
              className="flex w-full items-center justify-center gap-1 rounded-md border border-line-strong px-2 py-1 text-[11px] text-red-600 transition hover:bg-red-500/5 dark:text-red-400"
            >
              <Trash2 className="size-3" />
              {t("auto.canvas.deleteNode")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
