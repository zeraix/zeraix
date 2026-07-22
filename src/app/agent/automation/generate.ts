/**
 * AI workflow assistant — a conversation that can build.
 *
 * This is deliberately NOT a "every message becomes a workflow" generator. The model talks to the user
 * like an assistant: it answers greetings and questions in plain language, and only emits a workflow
 * when the user actually asks to build or change one. A turn therefore returns a natural-language reply
 * plus an OPTIONAL definition — the reply is always shown; the definition is applied only when present.
 *
 * Reuses the app's existing model plumbing: the currently-selected model (models.ts) through the
 * main-process LLM proxy (llm.ts), exactly like the chat page. The catalog of step types the model may
 * use comes from the registry (blocks.ts), so the assistant's vocabulary tracks the editor's.
 *
 * When the model does build, we merge onto the *current* definition so identity (id, version, triggers,
 * limits) is preserved and Save records a new version. Structural validation still runs in the main
 * process on Save — this only has to produce something renderable for review.
 */
import { resolveActiveModel } from "@/lib/ai/models";
import { chatViaProxy, isLlmProxyAvailable } from "@/lib/ai/llm";
import type { WorkflowDefinition, WorkflowNode } from "@/lib/workflows";
import { stepCatalogText, getStepType } from "./blocks";

export type AssistantMessage = { role: "user" | "assistant"; text: string };

export type AssistantResult =
  | { ok: true; reply: string; definition?: WorkflowDefinition; stepCount?: number }
  | { ok: false; error: string };

/** The user's OS — the generator knows it even though the model doesn't, so shell steps target it. */
function detectPlatform(): "windows" | "mac" | "linux" {
  const s = (typeof navigator !== "undefined" ? `${navigator.platform} ${navigator.userAgent}` : "").toLowerCase();
  if (s.includes("win")) return "windows";
  if (s.includes("mac")) return "mac";
  return "linux";
}

/** How shell steps actually execute on the user's machine — decisive for getting commands to run at all. */
function shellEnvironmentLines(): string[] {
  const os = detectPlatform();
  if (os === "windows") {
    return [
      "Shell environment: the user is on WINDOWS, and shell steps run directly under Windows PowerShell.",
      "Write the command as PLAIN PowerShell (Out-File, Test-Path, Get-Date, New-Item, etc.). Do NOT wrap it in `powershell -Command \"...\"` and do NOT write cmd.exe/batch syntax — the command IS already a PowerShell script.",
      "Reference inputs as $env:INPUT_<NAME>. Use Windows paths like E:\\\\folder\\\\file. To make a folder if missing: if (!(Test-Path $dir)) { New-Item -ItemType Directory $dir | Out-Null }.",
    ];
  }
  return [
    `Shell environment: the user is on ${os === "mac" ? "macOS" : "Linux"}. Shell steps run through /bin/sh. Write POSIX-compatible commands and Unix paths (/home/... ), and reference inputs as "$INPUT_<NAME>".`,
  ];
}

function systemPrompt(t: (k: string) => string): string {
  return [
    "You are a friendly assistant embedded in an automation-workflow editor. You help the user build and refine ONE workflow by chatting with them.",
    "",
    "How to respond:",
    "- Always reply in the SAME LANGUAGE as the user, warmly and briefly.",
    "- If the user greets you, asks a question, or is just chatting, simply reply. Do NOT output a workflow.",
    "- Only when the user asks you to build, add, remove, or change steps do you modify the workflow.",
    "- When you DO change the workflow: write one short friendly sentence about what you did, then append the COMPLETE updated workflow as a single ```json code block at the very end of your message. Never output a partial workflow.",
    "- Never show JSON, node ids, or the words run:// / var:// when you are only chatting.",
    "",
    "Workflow JSON shape:",
    `{ "name": string, "nodes": Node[], "edges": {"from": nodeId, "to": nodeId}[], "variables"?: Var[] }`,
    'Node: { "id": string, "runtime": string, "config": object, "inputs"?: {"as": string, "ref": string}[] }',
    "Node ids: short, unique, lowercase letters/digits/underscore (e.g. \"research\", \"save\").",
    "",
    "Available step types:",
    stepCatalogText(t),
    "",
    ...shellEnvironmentLines(),
    "",
    "Rules for the workflow JSON:",
    "1. Steps run as one top-to-bottom chain: order `nodes` in run order and make `edges` connect each node to the next (n1->n2->n3). No branching.",
    "2. Give a step data by adding an input: { \"as\": \"<name>\", \"ref\": \"run://<earlierId>/<outputKey>\" } for an earlier step's output, or \"var://<key>\" for a run-time value.",
    "3. Reference that input INSIDE the step:",
    "   - agent steps: write {{inputs.<name>}} in the prompt (substituted as text).",
    "   - shell steps: each input is exposed as an ENVIRONMENT VARIABLE named INPUT_<NAME> — the `as` name uppercased, every non-alphanumeric character replaced with '_'. It is NOT substituted into the command text, so you MUST read the env var, and you MUST keep the INPUT_ prefix:",
    "       PowerShell:  $env:INPUT_<NAME>   (e.g. $env:INPUT_SUMMARY — NEVER $env:SUMMARY)",
    "       bash/sh:     \"$INPUT_<NAME>\"",
    "       cmd.exe:     %INPUT_<NAME>%",
    "4. For a value the user supplies when the workflow runs: declare a variable { \"key\": \"<k>\", \"type\": \"string\", \"required\": true, \"label\": \"<friendly>\" } and reference it via input { \"as\": \"<k>\", \"ref\": \"var://<k>\" }.",
    "5. Use ONLY the runtimes listed above.",
    "6. To save a spreadsheet, write CSV text (comma- or tab-separated, first row = headers) to a .csv file — Excel opens .csv directly. Do NOT pipe plain text into a .xlsx file; that yields an empty or unreadable spreadsheet.",
  ].join("\n");
}

/** The current workflow, given to the model each turn so "add a step / change the second one" works. */
function currentContext(current: WorkflowDefinition): string {
  const compact = {
    name: current.name,
    nodes: current.nodes,
    edges: current.edges,
    variables: current.variables,
  };
  const empty = (current.nodes ?? []).length === 0;
  return empty
    ? "The workflow is currently empty."
    : `The workflow the user is editing right now:\n\`\`\`json\n${JSON.stringify(compact, null, 2)}\n\`\`\``;
}

/** Split a reply into its prose and a trailing workflow JSON block, if the model included one. */
function splitReply(text: string): { reply: string; json: string | null } {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i;
  const m = fence.exec(text);
  if (m && m[1].trim().startsWith("{")) {
    return { reply: text.replace(m[0], "").trim(), json: m[1].trim() };
  }
  return { reply: text.trim(), json: null };
}

/**
 * Coerce a model's loose JSON into a definition we can render, merged onto `current`.
 * Preserves identity + trigger/limit config; only the graph, name and variables move.
 */
function normalize(parsed: unknown, current: WorkflowDefinition): WorkflowDefinition | null {
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  const rawNodes = Array.isArray(p.nodes) ? p.nodes : [];
  if (rawNodes.length === 0) return null;

  const nodes: WorkflowNode[] = rawNodes.map((n, i) => {
    const node = (n ?? {}) as Record<string, unknown>;
    const runtime = getStepType(String(node.runtime)) ? String(node.runtime) : "agent";
    const id = typeof node.id === "string" && node.id.trim() ? node.id.replace(/[^a-zA-Z0-9_]/g, "") : `step${i + 1}`;
    const config = node.config && typeof node.config === "object" ? (node.config as Record<string, unknown>) : {};
    const inputs = Array.isArray(node.inputs)
      ? node.inputs
          .filter((b): b is { as: string; ref: string } => !!b && typeof b === "object")
          .map((b) => ({ as: String((b as { as: unknown }).as ?? ""), ref: String((b as { ref: unknown }).ref ?? "") }))
          .filter((b) => b.as && b.ref)
      : [];
    return { id, runtime: runtime as WorkflowNode["runtime"], config, inputs };
  });

  // De-duplicate ids so one bad id can't collapse two steps.
  const seen = new Set<string>();
  for (const n of nodes) {
    let id = n.id || "step";
    while (seen.has(id)) id = `${id}_2`;
    n.id = id;
    seen.add(id);
  }

  // Trust the model's edges only if they form a clean chain over these ids; otherwise wire a chain.
  const ids = new Set(nodes.map((n) => n.id));
  const rawEdges = Array.isArray(p.edges) ? (p.edges as Array<Record<string, unknown>>) : [];
  const edgesValid =
    rawEdges.length === nodes.length - 1 && rawEdges.every((e) => ids.has(String(e.from)) && ids.has(String(e.to)));
  const edges = edgesValid
    ? rawEdges.map((e) => ({ from: String(e.from), to: String(e.to) }))
    : nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id }));

  const variables = Array.isArray(p.variables) ? (p.variables as WorkflowDefinition["variables"]) : current.variables;

  return {
    ...current, // keep id, version, triggers, limits
    name: typeof p.name === "string" && p.name.trim() ? p.name : current.name,
    variables,
    nodes: nodes.map((n, i) => ({ ...n, position: { x: 40, y: i * 110 } })),
    edges,
  };
}

/**
 * Run one assistant turn over the conversation so far.
 * @returns a natural reply, plus a definition when the model actually built/changed one.
 */
export async function runAssistant(
  { history, current }: { history: AssistantMessage[]; current: WorkflowDefinition },
  t: (k: string) => string,
): Promise<AssistantResult> {
  if (!isLlmProxyAvailable()) return { ok: false, error: t("auto.ai.errUnavailable") };
  const model = resolveActiveModel();
  if (!model?.endpoint) return { ok: false, error: t("auto.ai.errNoModel") };

  let res;
  try {
    res = await chatViaProxy({
      endpoint: model.endpoint,
      apiKey: model.apiKey,
      body: {
        model: model.model,
        messages: [
          { role: "system", content: systemPrompt(t) },
          { role: "system", content: currentContext(current) },
          ...history.map((m) => ({ role: m.role, content: m.text })),
        ],
        temperature: 0.4,
      },
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (!res.ok) return { ok: false, error: res.error || t("auto.ai.errRequest") };

  const data = res.data as { choices?: Array<{ message?: { content?: string } }> } | undefined;
  const content = data?.choices?.[0]?.message?.content ?? "";
  if (!content.trim()) return { ok: false, error: t("auto.ai.errRequest") };

  const { reply, json } = splitReply(content);
  if (!json) return { ok: true, reply };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // The model tried to build but the JSON was malformed: keep the prose, skip applying.
    return { ok: true, reply: reply || t("auto.ai.errBadJson") };
  }
  const definition = normalize(parsed, current);
  if (!definition) return { ok: true, reply: reply || t("auto.ai.errNoWorkflow") };
  return { ok: true, reply, definition, stepCount: definition.nodes.length };
}
