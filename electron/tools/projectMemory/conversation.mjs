/**
 * Capturing what the user says.
 *
 * The last gap in the memory system. Derivation (§ sections) covers the repository's shape;
 * observation (observations.mjs) covers what the agent reads. Neither can reach the third source:
 * things the user simply states — "we use npm here, not pnpm", "never touch fs from the renderer",
 * "the staging key is the one in .env.local". Those exist in no file, and phase 3b established that
 * the model does not reliably call `remember_project` on its own.
 *
 * So the same principle applies a third time: do not ask, observe. Every user message is offered
 * here; a cheap keyword gate discards the overwhelming majority without a single token, and only
 * what survives costs one small extraction call. The model doing the extraction is allowed — and
 * told — to return nothing, which is the common answer.
 *
 * Deliberately NOT registered as a tool: it is invoked over IPC by the chat page, not by the model.
 * `handlers` and `TOOLS` in aiToolkit are separate, so this stays invisible in the tool list.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { MEMORY_FILE } from "./constants.mjs";
import { rememberProject } from "./remember.mjs";

const MIN_CHARS = 12; // Below this there is nothing durable to say
const MAX_CHARS = 4000; // Cap what is fed to the extractor
const MAX_PER_SESSION = 8; // Ceiling on conversational captures per workspace session
const MAX_FACTS_PER_MESSAGE = 2;
const MAX_FACT_CHARS = 160;

/**
 * Cheap gate: does this message even look like it states a rule, correction or convention?
 *
 * Keyword matching, not comprehension — its only job is to keep the extractor off the ~95% of
 * messages that are plain task requests, at zero token cost. False negatives are the accepted
 * trade: missing a fact costs nothing, whereas an LLM call on every message the user types is a
 * real bill. English and Chinese are covered because those are what this app is used in; adding a
 * language means adding its markers here.
 */
const GATE = new RegExp(
  [
    // English: prohibition, obligation, preference, correction, explicit instruction to remember
    "\\b(always|never|don't|do not|must|should|avoid|instead of|rather than|prefer|we use|we don't)\\b",
    "\\b(remember|note that|keep in mind|make sure|be careful|for future reference|from now on)\\b",
    "\\b(in this (project|repo|codebase)|our convention|the rule is|by convention)\\b",
    // Chinese
    "(记住|记得|注意|不要|别用|必须|一定要|总是|永远|应该|避免|而不是|我们用|这个项目|规范|约定|以后)",
  ].join("|"),
  "i",
);

/** workdir → number of facts captured this session. */
const captured = new Map();

/** Forget conversational capture state (workspace switch). */
export function resetConversationCapture(workdir) {
  if (workdir) captured.delete(workdir);
  else captured.clear();
}

/** Existing note bullets, so the extractor is not asked to re-derive what is already recorded. */
async function existingNotes(workdir) {
  try {
    const raw = await fs.readFile(path.join(workdir, MEMORY_FILE), "utf8");
    const body = raw.split("id=notes")[1]?.split("zeraix:end")[0] ?? "";
    return body
      .split("\n")
      .filter((l) => l.trimStart().startsWith("- "))
      .map((l) => l.trim().slice(2).trim())
      .filter((l) => l && l !== "(nothing recorded yet)");
  } catch {
    return null; // no map → nothing to enrich
  }
}

/**
 * Pull durable project facts out of a user message. Returns [] far more often than not, which is
 * the intended behaviour — most messages are requests, not knowledge.
 */
async function extractFacts(llm, text, known) {
  const knownBlock = known.length
    ? `\n\nAlready recorded (do not repeat these):\n${known.map((k) => `- ${k}`).join("\n")}`
    : "";

  const reply = await llm.chat(
    [
      {
        role: "system",
        content:
          "You extract durable project knowledge from a message a developer sent to a coding assistant. " +
          "Record ONLY facts that will still be true next week and that someone new to this project " +
          "would need: conventions, constraints, prohibitions, tool or environment choices, " +
          "architectural rules, and corrections of a wrong assumption. " +
          "Do NOT record: the task being requested, one-off instructions, questions, opinions about " +
          "the current change, or anything already recorded. " +
          "Most messages contain nothing durable — answering NONE is normal and expected. " +
          `Reply with at most ${MAX_FACTS_PER_MESSAGE} facts, one per line, each a single ` +
          "self-contained English sentence under 120 characters, with no bullet marker. " +
          "If there is nothing durable, reply with exactly: NONE",
      },
      { role: "user", content: `Message:\n${text}${knownBlock}` },
    ],
    { temperature: 0, maxTokens: 200 },
  );

  const lines = String(reply ?? "")
    .split("\n")
    .map((l) => l.replace(/^[-*\d.\s]+/, "").trim())
    .filter(Boolean);

  if (!lines.length || /^none$/i.test(lines[0])) return [];
  return lines
    .filter((l) => !/^none$/i.test(l))
    .slice(0, MAX_FACTS_PER_MESSAGE)
    .map((l) => l.slice(0, MAX_FACT_CHARS));
}

/**
 * Offer one user message for capture. Returns immediately; work happens in the background and any
 * failure is swallowed — this must never affect sending a message.
 */
export function noteUserMessage({ workdir, text, llm } = {}) {
  try {
    if (!workdir || !llm?.available) return;
    const body = String(text ?? "").trim();
    if (body.length < MIN_CHARS) return;
    if (!GATE.test(body)) return;
    if ((captured.get(workdir) ?? 0) >= MAX_PER_SESSION) return;

    void (async () => {
      const known = await existingNotes(workdir);
      if (known === null) return; // no ZERAIX.md → the user never asked for project memory
      const facts = await extractFacts(llm, body.slice(0, MAX_CHARS), known);
      for (const note of facts) {
        if ((captured.get(workdir) ?? 0) >= MAX_PER_SESSION) break;
        const res = await rememberProject({ workdir, note });
        if (res.ok) captured.set(workdir, (captured.get(workdir) ?? 0) + 1);
      }
    })().catch(() => {});
  } catch {
    /* capture must never disturb the conversation */
  }
}
