"use client";

/**
 * Simple mode — the beginner-first editor.
 *
 * The same `WorkflowDefinition` the Professional canvas edits, drawn as a top-to-bottom stack of
 * large blocks that read like a set of instructions. Nothing here exposes the wire format: a step's
 * inputs are picked from a visual list ("Use result from Research" / "Ask me when it runs"), never
 * typed as `run://` or `var://`; its output is described as what it "Creates". Advanced knobs (model,
 * failure policy) stay collapsed.
 *
 * The chain is enforced by construction — every mutation rebuilds the definition through `fromOrder`,
 * so the blocks' order *is* the run order and a beginner can never draw an invalid branch. Anything
 * Simple mode can't express (a hand-authored branch, a non-agent/shell runtime) still round-trips
 * untouched because it's carried through the shared definition, and surfaces an "Advanced" badge.
 */
import { useMemo, useRef, useState } from "react";
import {
  Bot,
  Terminal,
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  ChevronRight,
  X,
  CornerDownRight,
  HelpCircle,
  Settings2,
} from "lucide-react";
import { useT } from "@/lib/i18n";
import type { WorkflowDefinition, WorkflowNode } from "@/lib/workflows";
import {
  RUNTIME_META,
  KNOWN_KEYS,
  STEP_TYPES,
  getStepType,
  defaultConfig,
  primaryOutputKey,
  parseRef,
  linearize,
  fromOrder,
  type AdvancedField,
} from "./blocks";
import { loadModelList, resolveModelById, resolveActiveModel } from "@/lib/ai/models";
import { isLocalEndpoint } from "@/lib/ai/localModel";

type Picker = { node: string; idx: number } | null;

export default function SimpleFlow({
  definition,
  onChange,
}: {
  definition: WorkflowDefinition;
  onChange: (next: WorkflowDefinition) => void;
}) {
  const t = useT();
  const ordered = useMemo(() => linearize(definition), [definition]);
  // Configured models for the per-step picker — local models first (this feature prioritizes them).
  const modelList = useMemo(
    () =>
      [...loadModelList()].sort(
        (a, b) =>
          Number(isLocalEndpoint(String(b.endpoint ?? ""))) - Number(isLocalEndpoint(String(a.endpoint ?? ""))),
      ),
    [],
  );
  const [picker, setPicker] = useState<Picker>(null);
  // Textareas keyed by node id, so an "insert" chip can drop a placeholder at the caret.
  const taRefs = useRef(new Map<string, HTMLTextAreaElement | null>());

  /** Any node the visual editor can't fully represent — a branch, or a runtime with no block form. */
  const advancedShape = useMemo(() => {
    const outDeg = new Map<string, number>();
    for (const e of definition.edges ?? []) outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
    return (id: string, runtime: string) => (outDeg.get(id) ?? 0) > 1 || !RUNTIME_META[runtime];
  }, [definition.edges]);

  /* ---------------- mutations (all funnel through fromOrder → onChange) ---------------- */

  const commitOrder = (next: WorkflowNode[], base: WorkflowDefinition = definition) =>
    onChange(fromOrder(base, next));

  const patchNode = (id: string, patch: Partial<WorkflowNode>) =>
    commitOrder(ordered.map((n) => (n.id === id ? { ...n, ...patch } : n)));

  const patchConfig = (id: string, key: string, value: unknown) => {
    const n = ordered.find((x) => x.id === id);
    if (!n) return;
    patchNode(id, { config: { ...n.config, [key]: value } });
  };

  const move = (id: string, dir: -1 | 1) => {
    const i = ordered.findIndex((n) => n.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ordered.length) return;
    const next = [...ordered];
    [next[i], next[j]] = [next[j], next[i]];
    commitOrder(next);
  };

  const addStep = (runtime: string) => {
    let k = ordered.length + 1;
    while (ordered.some((n) => n.id === `${runtime}${k}`)) k++;
    const id = `${runtime}${k}`;
    const node: WorkflowNode = {
      id,
      runtime: runtime as WorkflowNode["runtime"],
      config: defaultConfig(runtime, t),
      inputs: [],
    };
    commitOrder([...ordered, node]);
    setPicker(null);
  };

  const removeStep = (id: string) => {
    commitOrder(ordered.filter((n) => n.id !== id));
    setPicker(null);
  };

  const setInputs = (id: string, inputs: { as: string; ref: string }[]) => patchNode(id, { inputs });

  /** Add an empty input the user then points at a source. */
  const addInput = (node: WorkflowNode) => {
    const base = node.inputs ?? [];
    const as = uniqueInputName("info", base);
    setInputs(node.id, [...base, { as, ref: "" }]);
    setPicker({ node: node.id, idx: base.length });
  };

  /** Point an input at an upstream step's output. */
  const bindResult = (node: WorkflowNode, idx: number, fromId: string) => {
    const rt = ordered.find((n) => n.id === fromId)?.runtime ?? "agent";
    const next = [...(node.inputs ?? [])];
    next[idx] = { ...next[idx], ref: `run://${fromId}/${primaryOutputKey(rt)}` };
    setInputs(node.id, next);
    setPicker(null);
  };

  /** Point an input at a "the app asks me when it runs" value, declaring the variable if needed. */
  const bindAsk = (node: WorkflowNode, idx: number) => {
    const input = (node.inputs ?? [])[idx];
    const already = parseRef(input?.ref ?? "").varKey;
    if (already) {
      setPicker(null);
      return;
    }
    const vars = definition.variables ?? [];
    const key = uniqueVarKey(input?.as || "value", vars);
    const nextVars = [...vars, { key, type: "string" as const, label: input?.as || key, required: true }];
    const nextNodes = ordered.map((n) =>
      n.id === node.id
        ? {
            ...n,
            inputs: (n.inputs ?? []).map((b, j) => (j === idx ? { ...b, ref: `var://${key}` } : b)),
          }
        : n,
    );
    commitOrder(nextNodes, { ...definition, variables: nextVars });
    setPicker(null);
  };

  /**
   * Insert an input placeholder at the caret — {{inputs.x}} for AI, and the correct env-var syntax
   * for a command (shell inputs are env vars named INPUT_<NAME>; the syntax differs per shell, so we
   * pick from the command text: PowerShell $env:INPUT_X, cmd %INPUT_X%, else bash $INPUT_X).
   */
  const insertPlaceholder = (node: WorkflowNode, as: string) => {
    const isShell = node.runtime === "shell";
    const field = isShell ? "command" : "prompt";
    const el = taRefs.current.get(node.id);
    const cur = String(node.config?.[field] ?? "");
    const token = isShell ? shellInputRef(as, cur) : `{{inputs.${as}}}`;
    const start = el?.selectionStart ?? cur.length;
    const end = el?.selectionEnd ?? cur.length;
    patchConfig(node.id, field, cur.slice(0, start) + token + cur.slice(end));
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  /* ---------------- helpers ---------------- */

  const keyLabel = (k: string) => (KNOWN_KEYS.has(k) ? t(`auto.canvas.out.${k}`) : k);
  const createsLabel = (n: WorkflowNode) => keyLabel(primaryOutputKey(n.runtime));

  /** Whether the model this step will use runs locally — local models are uncapped (see turn.mjs). */
  const stepModelIsLocal = (n: WorkflowNode): boolean => {
    const id = n.config?.model;
    const resolved = id ? resolveModelById(String(id)) : resolveActiveModel();
    return !!resolved && isLocalEndpoint(resolved.endpoint);
  };

  /** One-line human title for a block header, derived from its instruction so nothing extra is stored. */
  const titleOf = (n: WorkflowNode) => {
    const text = String(n.config?.prompt ?? n.config?.command ?? "").trim();
    if (!text) return t(RUNTIME_META[n.runtime]?.kindKey ?? "auto.simple.kind.agent");
    const firstLine = text.split(/\n/)[0].replace(/\{\{[^}]*\}\}|\$INPUT_\w+/g, "…");
    return firstLine.length > 52 ? firstLine.slice(0, 52).trimEnd() + "…" : firstLine;
  };

  /** Describe an input's current source in plain words for its chip. */
  const sourceLabel = (n: WorkflowNode, ref: string) => {
    const p = parseRef(ref);
    if (p.varKey) return t("auto.simple.askLabel");
    if (p.node) {
      const from = ordered.find((x) => x.id === p.node);
      return t("auto.simple.fromLabel", { step: from ? titleOf(from) : p.node });
    }
    return t("auto.simple.pickSource");
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col items-stretch pb-8">
      {/* Start rail — the workflow reads from here downward. */}
      <div className="mx-auto mb-1 inline-flex items-center gap-2 rounded-full border border-line-strong bg-surface px-4 py-1.5 text-xs font-semibold text-foreground shadow-sm">
        <span className="flex size-5 items-center justify-center rounded-full bg-primary/10 text-primary">
          <ChevronRight className="size-3" />
        </span>
        {t("auto.simple.start")}
      </div>

      {ordered.map((node, p) => {
        const Icon = node.runtime === "shell" ? Terminal : Bot;
        const isShell = node.runtime === "shell";
        const inputs = node.inputs ?? [];
        const upstream = ordered.slice(0, p);
        const modelLocal = stepModelIsLocal(node);
        const advFields = (getStepType(node.runtime)?.advancedFields ?? []).filter(
          (f) => !(modelLocal && f.localExempt),
        );
        return (
          <div key={node.id} className="flex flex-col items-stretch">
            <Connector />
            <div className="rounded-2xl border border-line-strong bg-surface p-4 shadow-sm transition hover:shadow-md">
              {/* header */}
              <div className="flex items-start gap-3">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-line bg-primary/5 text-primary">
                  <Icon className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="rounded bg-primary/10 px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-primary">
                      {t(RUNTIME_META[node.runtime]?.kindKey ?? "auto.simple.kind.agent")}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground">{node.id}</span>
                    {advancedShape(node.id, node.runtime) && (
                      <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-px text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                        <Settings2 className="size-3" />
                        {t("auto.simple.advBadge")}
                      </span>
                    )}
                  </div>
                  <h3 className="mt-0.5 truncate text-[15px] font-semibold text-foreground">{titleOf(node)}</h3>
                </div>
                {/* reorder + delete */}
                <div className="flex shrink-0 items-center gap-0.5">
                  <IconBtn label={t("auto.simple.moveUp")} disabled={p === 0} onClick={() => move(node.id, -1)}>
                    <ArrowUp className="size-3.5" />
                  </IconBtn>
                  <IconBtn
                    label={t("auto.simple.moveDown")}
                    disabled={p === ordered.length - 1}
                    onClick={() => move(node.id, 1)}
                  >
                    <ArrowDown className="size-3.5" />
                  </IconBtn>
                  <IconBtn label={t("auto.simple.remove")} danger onClick={() => removeStep(node.id)}>
                    <Trash2 className="size-3.5" />
                  </IconBtn>
                </div>
              </div>

              {/* the instruction */}
              <label className="mt-3 block">
                <span className="mb-1 block text-[11px] font-semibold text-muted-foreground">
                  {isShell ? t("auto.simple.commandLabel") : t("auto.simple.instructionLabel")}
                </span>
                <textarea
                  ref={(el) => {
                    if (el) taRefs.current.set(node.id, el);
                    else taRefs.current.delete(node.id);
                  }}
                  value={String((isShell ? node.config?.command : node.config?.prompt) ?? "")}
                  onChange={(e) => patchConfig(node.id, isShell ? "command" : "prompt", e.target.value)}
                  rows={3}
                  spellCheck={!isShell}
                  className={`w-full resize-none rounded-lg border border-line-strong bg-surface-muted/40 px-3 py-2 text-[13.5px] leading-relaxed text-foreground outline-none focus:border-ring ${
                    isShell ? "font-mono text-xs" : ""
                  }`}
                />
              </label>

              {/* insert chips — reference an input without typing the placeholder */}
              {inputs.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-muted-foreground">{t("auto.simple.insert")}</span>
                  {inputs.map((inp, i) => (
                    <button
                      key={i}
                      onClick={() => insertPlaceholder(node, inp.as)}
                      disabled={!inp.as}
                      className="rounded-md border border-line-strong bg-surface px-1.5 py-0.5 font-mono text-[10.5px] text-primary transition hover:bg-surface-muted disabled:opacity-40"
                    >
                      + {inp.as || "…"}
                    </button>
                  ))}
                </div>
              )}

              {/* Needs / Creates */}
              <div className="mt-3 space-y-2 border-t border-line pt-3">
                <div className="flex flex-wrap items-start gap-x-2 gap-y-1.5">
                  <span className="mt-1 text-[11px] font-semibold text-muted-foreground">
                    {t("auto.simple.needs")}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    {inputs.length === 0 && (
                      <span className="text-[12px] text-muted-foreground/70">{t("auto.simple.needsNothing")}</span>
                    )}
                    {inputs.map((inp, i) => {
                      const open = picker?.node === node.id && picker?.idx === i;
                      return (
                        <div key={i} className="rounded-lg border border-line bg-surface-muted/30 p-1.5">
                          <div className="flex items-center gap-1.5">
                            <input
                              value={inp.as}
                              onChange={(e) => {
                                const next = [...inputs];
                                next[i] = { ...next[i], as: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") };
                                setInputs(node.id, next);
                              }}
                              placeholder={t("auto.simple.infoName")}
                              className="w-24 shrink-0 rounded-md border border-line-strong bg-surface px-1.5 py-1 font-mono text-[11px] outline-none focus:border-ring"
                            />
                            <CornerDownRight className="size-3 shrink-0 text-muted-foreground" />
                            <button
                              onClick={() => setPicker(open ? null : { node: node.id, idx: i })}
                              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2 py-1 text-left text-[12px] text-foreground transition hover:border-primary hover:bg-primary/5"
                            >
                              <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                              <span className="truncate">{sourceLabel(node, inp.ref)}</span>
                              <ChevronRight
                                className={`ml-auto size-3 shrink-0 text-muted-foreground transition ${open ? "rotate-90" : ""}`}
                              />
                            </button>
                            <IconBtn
                              label={t("auto.simple.remove")}
                              onClick={() => setInputs(node.id, inputs.filter((_, j) => j !== i))}
                            >
                              <X className="size-3.5" />
                            </IconBtn>
                          </div>

                          {open && (
                            <div className="mt-1.5 overflow-hidden rounded-lg border border-line bg-surface">
                              <p className="px-2.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                {t("auto.simple.pickTitle")}
                              </p>
                              <div className="p-1">
                                {upstream.length === 0 && (
                                  <p className="px-2 py-1 text-[11px] text-muted-foreground/70">
                                    {t("auto.simple.noUpstream")}
                                  </p>
                                )}
                                {upstream.map((up) => {
                                  const checked = parseRef(inp.ref).node === up.id;
                                  return (
                                    <PickOption
                                      key={up.id}
                                      checked={checked}
                                      emoji={RUNTIME_META[up.runtime]?.emoji ?? "⚙️"}
                                      title={titleOf(up)}
                                      sub={t("auto.simple.createsColon", { value: createsLabel(up) })}
                                      onClick={() => bindResult(node, i, up.id)}
                                    />
                                  );
                                })}
                                <div className="my-1 h-px bg-line" />
                                <PickOption
                                  ask
                                  checked={!!parseRef(inp.ref).varKey}
                                  emoji="🙋"
                                  title={t("auto.simple.askTitle")}
                                  sub={t("auto.simple.askSub")}
                                  onClick={() => bindAsk(node, i)}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    <button
                      onClick={() => addInput(node)}
                      className="inline-flex w-fit items-center gap-1 rounded-md border border-dashed border-line px-2 py-1 text-[11px] text-muted-foreground transition hover:border-primary hover:text-primary"
                    >
                      <Plus className="size-3" />
                      {t("auto.simple.addInfo")}
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-semibold text-muted-foreground">{t("auto.simple.creates")}</span>
                  <span className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-line-strong px-2 py-1 text-[12px] text-foreground">
                    <span className="size-1.5 rounded-full bg-primary" />
                    {createsLabel(node)}
                  </span>
                </div>
              </div>

              {/* Advanced */}
              <details className="mt-2 group">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 text-[12px] font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="size-3.5 transition group-open:rotate-90" />
                  {t("auto.simple.advanced")}
                </summary>
                <div className="mt-2 grid gap-3 rounded-lg border border-line bg-surface-muted/40 p-3">
                  {advFields.map((f) => (
                    <label key={f.key} className="grid gap-1">
                      <span className="text-[11px] font-semibold text-muted-foreground">{t(f.labelKey)}</span>
                      {f.type === "model" ? (
                        <select
                          value={fieldValue(node.config?.[f.key])}
                          onChange={(e) => patchConfig(node.id, f.key, e.target.value || undefined)}
                          className="rounded-md border border-line-strong bg-surface px-2 py-1.5 text-[13px] outline-none focus:border-ring"
                        >
                          <option value="">{t("auto.canvas.modelDefault")}</option>
                          {modelList.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.label}
                              {isLocalEndpoint(String(m.endpoint ?? "")) ? ` · ${t("auto.simple.localTag")}` : ""}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type={f.type === "number" ? "number" : "text"}
                          min={f.min}
                          value={fieldValue(node.config?.[f.key])}
                          placeholder={f.placeholderKey ? t(f.placeholderKey) : f.placeholder}
                          onChange={(e) => patchConfig(node.id, f.key, coerceField(f, e.target.value))}
                          className="rounded-md border border-line-strong bg-surface px-2 py-1.5 text-[13px] outline-none focus:border-ring"
                        />
                      )}
                      {f.hintKey && <span className="text-[11px] text-muted-foreground">{t(f.hintKey)}</span>}
                    </label>
                  ))}
                  {modelLocal && (
                    <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                      <HelpCircle className="mt-px size-3.5 shrink-0" />
                      {t("auto.simple.localNoLimit")}
                    </p>
                  )}
                  {!modelLocal && advFields.length === 0 && (
                    <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                      <HelpCircle className="mt-px size-3.5 shrink-0" />
                      {t("auto.simple.advHint")}
                    </p>
                  )}
                </div>
              </details>
            </div>
          </div>
        );
      })}

      {/* Add a step */}
      <Connector />
      <div className="mx-auto flex flex-wrap justify-center gap-2">
        {STEP_TYPES.map((st) => (
          <button
            key={st.runtime}
            onClick={() => addStep(st.runtime)}
            className="inline-flex items-center gap-2 rounded-xl border border-line-strong bg-surface px-4 py-2.5 text-sm font-medium text-foreground shadow-sm transition hover:border-primary hover:bg-primary/5"
          >
            <span className="text-base leading-none">{st.emoji}</span>
            {t(st.addLabelKey)}
          </button>
        ))}
      </div>

      {ordered.length === 0 && (
        <p className="mx-auto mt-4 max-w-sm text-center text-sm text-muted-foreground">{t("auto.simple.empty")}</p>
      )}
    </div>
  );
}

/* ---------------- small pieces ---------------- */

function Connector() {
  return <div className="mx-auto h-6 w-px bg-line-strong" />;
}

function IconBtn({
  children,
  label,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-surface-muted disabled:opacity-30 ${
        danger ? "hover:text-red-500" : "hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function PickOption({
  emoji,
  title,
  sub,
  checked,
  ask,
  onClick,
}: {
  emoji: string;
  title: string;
  sub: string;
  checked: boolean;
  ask?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition hover:bg-surface-muted"
    >
      <span
        className={`grid size-4 shrink-0 place-items-center rounded-full border-2 ${
          checked ? (ask ? "border-sky-500" : "border-primary") : "border-line-strong"
        }`}
      >
        {checked && <span className={`size-2 rounded-full ${ask ? "bg-sky-500" : "bg-primary"}`} />}
      </span>
      <span className="text-base leading-none">{emoji}</span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-medium text-foreground">{title}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{sub}</span>
      </span>
    </button>
  );
}

/**
 * How a shell step references an input. Inputs reach a shell as environment variables named
 * INPUT_<NAME> (see electron/automation/runtimes/shell.mjs) — never substituted into the command — so
 * the reference must keep the INPUT_ prefix and use the invoked shell's syntax. Explicit markers in the
 * command win; otherwise we default to the platform's shell (Windows shell steps run under PowerShell),
 * so "+ SUMMARY" inserts $env:INPUT_SUMMARY on Windows and $INPUT_SUMMARY on macOS/Linux.
 */
function shellInputRef(as: string, command: string): string {
  const name = as.replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase();
  const c = command.toLowerCase();
  if (c.includes("powershell") || c.includes("pwsh")) return `$env:INPUT_${name}`;
  if (/(^|\s|["'&|])cmd(\.exe)?\b/.test(c) || c.includes("%input_")) return `%INPUT_${name}%`;
  if (/\b(bash|zsh|sh)\s+-c|#!\/|(^|\s)export\s/.test(c)) return `$INPUT_${name}`;
  const win = typeof navigator !== "undefined" && /win/i.test(navigator.platform || navigator.userAgent || "");
  return win ? `$env:INPUT_${name}` : `$INPUT_${name}`;
}

/* ---------------- advanced-field coercion ---------------- */

/** Display value for a config field (undefined → empty string). */
function fieldValue(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

/** Parse a field's raw input to what belongs in config; empty / invalid clears it so the default applies. */
function coerceField(f: AdvancedField, raw: string): unknown {
  if (f.type === "number") {
    const n = parseInt(raw, 10);
    return raw.trim() && Number.isFinite(n) && n > 0 ? n : undefined;
  }
  return raw ? raw : undefined;
}

/* ---------------- name uniqueness ---------------- */

function uniqueInputName(base: string, inputs: { as: string }[]): string {
  const taken = new Set(inputs.map((i) => i.as));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

function uniqueVarKey(base: string, vars: { key: string }[]): string {
  const clean = base.replace(/[^a-zA-Z0-9_]/g, "") || "value";
  const taken = new Set(vars.map((v) => v.key));
  if (!taken.has(clean)) return clean;
  let n = 2;
  while (taken.has(`${clean}${n}`)) n++;
  return `${clean}${n}`;
}
