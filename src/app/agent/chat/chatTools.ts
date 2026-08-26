/**
 * The renderer's own tools — the model-facing handlers that page.tsx executes itself.
 *
 * Most tools go through `execToolCall`, the unified path that asks for consent and runs the call in the
 * sandbox. These do not, because none of them is a call to the outside world: they drive the app. A choice
 * card has to be rendered and awaited, a skill's instructions are already in memory, the todo list is a piece
 * of React state the user is watching, an image lands in a display bubble whose pixels must never re-enter
 * the wire. Routing them through the sandbox would mean asking permission to update a checklist.
 *
 * They live here rather than in the component for one reason: they are the largest cluster in page.tsx that
 * does not touch the turn loop. What they need instead is a narrow, explicit slice of component state — the
 * refs and accessors in `RendererToolDeps` and nothing else — which is what made this the first extraction
 * worth doing, and what keeps it honest: if this interface starts growing, the split was drawn wrong.
 *
 * The delegation family (`run_subagent`, `spawn_subagents`, `join_subagents`, `spawn_sub_agent`) is
 * deliberately NOT here. Those handlers own the sub-agent scheduler and its per-turn lifecycle, so they
 * belong with the turn, and the component merges them into this table at the call site.
 *
 * Nothing in this module is a hook. The factory is called during render like any other expression and closes
 * over that render's values, which is exactly what the inline handlers did before they moved.
 */
import { getSkillInstructions } from "@/lib/ai/skills/runtime";
import { SANDBOX_TOOLBOX_SKILL } from "@/lib/ai/skills/builtin";
import type { InstalledSkill } from "@/lib/ai/skills/types";
import { isSandboxEngine, type SandboxStatus } from "@/lib/ai/sandbox";
import { capabilityAvailable, generate, imageErrorKey } from "@/lib/ai/generation";
import { modelPathFor, storeArtifact } from "@/lib/ai/mediaLibrary";
import { startGenerationJob } from "@/lib/ai/generation/jobs";
import { saveMemoryFile, deleteMemoryFile, listMemoryFiles } from "@/lib/ai/memoryFiles";
import { searchMemories } from "@/lib/ai/memoryRetrieval";
import { browserAction, requestOpenBrowser, setBrowserBusy, type BrowserAction } from "@/lib/automation";
import { detectServices } from "@/store/servicesStore";
import type { ResolvedModel } from "@/lib/ai/models";
import { applyTaskState, type TaskMemory } from "./taskMemory";
import { applyTodoStatuses, isGoalActive, type GoalState } from "./goalState";
import type { ChoiceQuestion, RunCtx, Todo, TodoStatus } from "./types";

/** A tool the renderer executes itself: same contract as every other tool — text in, text back to the model. */
export type RendererTool = (ctx: RunCtx, args: Record<string, unknown>) => string | Promise<string>;

/**
 * Everything these handlers need from the component, and the whole of it.
 *
 * Per-conversation state arrives as accessor PAIRS keyed by conversation id rather than as values, because a
 * handler can be running for a background conversation while the user is looking at another one — reading
 * "the current todo list" would then update the wrong conversation's checklist. Refs arrive as refs for the
 * same reason: they are read at call time, which can be many seconds after the render that built this table.
 */
export interface RendererToolDeps {
  t: (key: string, vars?: Record<string, string>) => string;
  /** The conversation currently on screen. Handlers compare against it before touching shared UI. */
  convIdRef: { current: string | null };
  /** Skills enabled for this run, resolved fresh per call (the set changes while a turn is in flight). */
  runtimeSkills: () => InstalledSkill[];
  sandboxStatusRef: { current: SandboxStatus | null };
  /** Whether the Electron toolkit is available; false in a browser tab, where nothing can be written to disk. */
  toolsReady: boolean;
  /** Only `providerId` is read — the image engine is derived from the chat vendor's key. */
  activeModel: ResolvedModel | null;
  /** Counts a started generation job, so the goal check defers rather than judging a turn that is waiting. */
  onJobStarted: (convId: string) => void;
  /** Side channel for a generated image's artifact, consumed by the persist step in the turn loop. */
  lastArtifactRef: { current: { src: string; kind: "image" | "video"; servedBy?: string } | null };
  /**
   * Ask the user a question and wait, through the §13 boundary.
   *
   * Returns the text to feed back to the model, already formatted — the formatting depends on how the card
   * was answered (multi-select, a request to discuss), which is knowledge the host has and this module does
   * not need.
   */
  askUser: (convId: string, questions: ChoiceQuestion[]) => Promise<string>;
  setTodosFor: (convId: string | null, next: Todo[]) => void;
  taskMemoryFor: (convId: string | null) => TaskMemory;
  setTaskMemoryFor: (convId: string | null, tm: TaskMemory) => void;
  goalFor: (convId: string | null) => GoalState;
  setGoalFor: (convId: string | null, g: GoalState) => void;
}

/**
 * Build the renderer's tool table for this render.
 *
 * The table is the only thing that actually EXECUTES a renderer tool: `call_tool` resolves a name back
 * through resolveToolCall and the turn loop then looks it up here, so a name that survives in this object
 * stays callable however thoroughly it was removed from the declared set and from the catalog. That is why
 * `set_goal` and `update_plan` are absent rather than merely undeclared — removing the entry is what makes
 * the goal untouchable by the model.
 */
export function createRendererTools(deps: RendererToolDeps): Record<string, RendererTool> {
  const {
    t,
    convIdRef,
    runtimeSkills,
    sandboxStatusRef,
    toolsReady,
    activeModel,
    lastArtifactRef,
    onJobStarted,
    askUser,
    setTodosFor,
    taskMemoryFor,
    setTaskMemoryFor,
    goalFor,
    setGoalFor,
  } = deps;

  // The model calls set_task_state: record its internal mission brief into Task Memory (source "model"),
  // pinned into the wire every turn and preserved across compaction. Not shown to the user. When the brief
  // is unchanged, return a discouraging result so the model stops re-recording it every turn (it over-calls
  // otherwise; the brief is already in context and the compaction extractor backstops it).
  const setTaskState = (ctx: RunCtx, rawArgs: Record<string, unknown>): string => {
    if (typeof rawArgs.notes !== "string") {
      return "No change — pass `notes` (your mission brief) to record it.";
    }
    const next = rawArgs.notes.trim();
    if (next === taskMemoryFor(ctx.convId).notes) {
      return "Task state unchanged — it is already pinned in your context; do not call set_task_state again unless the plan or goal materially changes.";
    }
    setTaskMemoryFor(ctx.convId, applyTaskState(taskMemoryFor(ctx.convId), { notes: next }));
    return "Task state recorded.";
  };

  // The model calls update_todos: overwrite that conversation's list with the full list, returning a short confirmation.
  // A background conversation's list is kept (keyed by its own id) but not shown, so it is intact when the user switches back.
  const updateTodos = (ctx: RunCtx, rawArgs: Record<string, unknown>): string => {
    const raw = Array.isArray(rawArgs.todos) ? rawArgs.todos : [];
    const parsed: Todo[] = raw
      .map((t) => {
        const o = (t ?? {}) as Record<string, unknown>;
        const status = o.status;
        return {
          title: String(o.title ?? "").trim(),
          status: (status === "in_progress" || status === "completed"
            ? status
            : "pending") as TodoStatus,
        };
      })
      .filter((t) => t.title);
    setTodosFor(ctx.convId, parsed);
    // Fold the checklist back into the plan it came from, so the two do not drift: the plan is what the goal
    // reminder shows every turn, and a step the model just ticked off here would otherwise still read as pending
    // there. Matched by title, so a list the model rewrote in its own words simply does not match and the plan is
    // left alone rather than corrupted. See applyTodoStatuses.
    const goal = applyTodoStatuses(goalFor(ctx.convId), parsed);
    if (goal !== goalFor(ctx.convId)) setGoalFor(ctx.convId, goal);
    const done = parsed.filter((t) => t.status === "completed").length;
    return (
      `Updated the todo list (${done}/${parsed.length} completed).` +
      // A ticked-off checklist is progress through the plan, never proof that the goal is met — the evaluator
      // decides that, from the transcript. Said here because a fully ticked list is the moment the model is
      // most likely to conclude otherwise and stop.
      (isGoalActive(goal) && done === parsed.length && parsed.length > 0
        ? " Every step is marked done, but that is not the same as the goal being met: the evaluator checks the" +
          " goal condition against what this conversation actually shows. Make sure the evidence for it is here."
        : "")
    );
  };

  // load_skill: return the full instructions of an enabled skill (progressive disclosure), fed back to the model; also show a bubble.
  const loadSkill = (ctx: RunCtx, rawArgs: Record<string, unknown>): string => {
    const id = String(rawArgs.id ?? "");
    const enabled = runtimeSkills();
    // The built-in toolbox is advertised in messages[0] unconditionally — it has to be, or the prompt prefix would differ per
    // install — so the model can legitimately ask for it. But its whole toolchain (imagemagick, ffmpeg, pandoc, OCR) lives in the
    // sandbox image, so handing over the instructions while running natively would send it off to call tools that do not exist.
    // Only resolve it while the sandbox is actually up.
    const sandboxUp = isSandboxEngine(sandboxStatusRef.current?.active);
    const text =
      id === SANDBOX_TOOLBOX_SKILL.id && !sandboxUp
        ? `Skill not enabled: ${id} requires the Linux sandbox, which is not running right now (commands are executing directly on the host). ` +
          "Its tools are not installed on this machine — do not try to run them. Tell the user that media / document processing needs the sandbox, " +
          "and that it can be restarted from the sandbox status indicator."
        : getSkillInstructions(sandboxUp ? [...enabled, SANDBOX_TOOLBOX_SKILL] : enabled, id);
    const ok = !text.startsWith("Skill not enabled");
    ctx.status(ok ? t("chat.loadingSkill", { id }) : t("chat.skillDisabled"));
    ctx.push({ kind: "tool", name: `load_skill → ${id}`, args: { id }, ok, result: text });
    return text;
  };

  // openBrowser: open the built-in browser panel on the right and (optionally) navigate; show a bubble and return the text fed back to the model.
  const openBrowserAction = (ctx: RunCtx, rawArgs: Record<string, unknown>): string => {
    const url = String(rawArgs.url ?? "").trim();
    if (url) detectServices(url); // A local address opened by the AI is also registered with the running indicator
    requestOpenBrowser(url);
    const result = url ? `Opened the built-in browser and navigated to ${url}` : "Opened the built-in browser";
    ctx.push({ kind: "tool", name: "openBrowser", args: { url }, ok: true, result });
    return `${result}.`;
  };

  /**
   * Write a generated artifact into the working directory and return its absolute path (null when
   * tools are unavailable or the write fails — the caller treats the path as a bonus, never a
   * precondition). Handles both artifact shapes: a data: URL decodes inline, a vendor URL downloads
   * once, which also rescues the pixels before the vendor link expires.
   *
   * The download happens in the MAIN process, via the media store's `url` source (mediaStore.saveMedia). It used to `fetch()`
   * here and hand over the bytes, which worked only for the base64 dialect: an adapter that returns a
   * hosted link instead (OpenAI's `data[0].url`, and wan-image always — see firstArtifact in
   * generation/adapters.ts) produces a cross-origin URL, and the renderer has webSecurity on, so the
   * fetch failed CORS and the catch below swallowed it. The image still appeared on screen, because an
   * <img> tag is not CORS-bound, while nothing ever reached disk and the model got no path. Main has no
   * such limit, and this also keeps a multi-MB base64 from crossing IPC.
   */
  const saveGeneratedArtifact = async (
    src: string,
    mime: string,
    prompt: string,
    convId: string,
  ): Promise<string | null> => {
    if (!toolsReady) return null;
    const { path } = await storeArtifact({ src, mime, origin: "generated", convId, prompt });
    return path;
  };


  // image_generation: text-to-image through the user's own provider key. The engine is derived from
  // the configured keys (their chat vendor first, then any keyed vendor) — never picked by the model
  // and never shown in the model picker. See docs/generation-capabilities-design.md.
  const generateImageAction = async (ctx: RunCtx, rawArgs: Record<string, unknown>): Promise<string> => {
    const prompt = String(rawArgs.prompt ?? "").trim();
    if (!prompt) return "(image_generation is missing prompt)";

    ctx.status?.(t("image.generating"));
    const res = await generate({ capability: "image_generation", prompt, chatProviderId: activeModel?.providerId });

    if (!res.ok) {
      ctx.push({ kind: "tool", name: "image_generation", args: { prompt }, ok: false, result: t(imageErrorKey(res.error.kind)) });
      // The model relays this to the user in its own words, so it must be plain and actionable.
      return `Image generation failed (${res.error.kind}): ${res.error.message}`;
    }

    // The artifact must NOT be fed back to the model: a base64 payload is 1-3 MB and would be
    // re-sent on every subsequent turn, wrecking the context window and the prompt cache.
    // The bubble carries the pixels; the model gets metadata only.
    ctx.push({
      kind: "tool",
      name: "image_generation",
      args: { prompt },
      ok: true,
      result: res.artifact.src,
      image: res.artifact.src,
      servedBy: res.artifact.servedBy,
    });
    // Stash the artifact so the persist step can store it (display-only) and the image survives a conversation switch.
    lastArtifactRef.current = { src: res.artifact.src, kind: "image", servedBy: res.artifact.servedBy };

    // Also drop the pixels into the media library. The artifact reaches the renderer as a data: or vendor
    // URL, neither of which exists for the sandbox — so a model asked to "generate frames, then stitch them
    // with ffmpeg" would find nothing on disk and fall back to drawing the frames in code. A real path is
    // what makes a generated image composable with every other tool. Best-effort: the image is already shown
    // to the user, so a failed write must not turn into a failed generation.
    const savedPath = await saveGeneratedArtifact(res.artifact.src, res.artifact.mime, prompt, ctx.convId);
    // Named the way the model can actually reach it. It lands in the LIBRARY, which is read-only to the
    // model — saying "the working directory" here was not a loose phrasing but a wrong instruction: it
    // invited an in-place edit that tools/paths.mjs then refused.
    const shown = modelPathFor(savedPath ?? "", isSandboxEngine(sandboxStatusRef.current?.active));

    return (
      `Generated the image with ${res.artifact.servedBy}. It is already displayed to the user — do not repeat the URL or embed it in markdown.` +
      (shown
        ? ` The file is saved in the media library at ${shown} — use that exact path to process it further (convert, compose into a video); do not redraw it in code. The library is READ-ONLY: to change the image itself, copy it into the working directory first and write the result there.`
        : // Said outright rather than left to silence. The model otherwise assumes the usual path exists and
          // goes looking for a file that was never written, or invents a plausible-looking one.
          " It could NOT be written to disk, so there is no file to process — do not guess a path for it. If the user needs it on disk, say the save failed.")
    );
  };

  /**
   * video_generation: start the job and hand back an acknowledgement.
   *
   * It does NOT wait. Video takes minutes on every vendor, and awaiting it here — which is what the first
   * implementation did — holds the turn open for all of them: the model cannot act, the user cannot be
   * answered, and a spinner that has not moved in four minutes is indistinguishable from one that has hung.
   *
   * The job runs on its own (see generation/jobs.ts) and reports back through the same two routes a
   * `notify` background command uses: riding the next tool result if a turn is still going, or opening a new
   * turn if the conversation went idle. So the model is told "started", carries on, and is handed the clip
   * when it exists.
   */
  const generateVideoAction = async (ctx: RunCtx, rawArgs: Record<string, unknown>): Promise<string> => {
    const prompt = String(rawArgs.prompt ?? "").trim();
    if (!prompt) return "(video_generation is missing prompt)";
    if (!capabilityAvailable("video_generation")) {
      return "Video generation is not configured: no video engine has been added in Settings. Tell the user rather than retrying.";
    }

    const job = startGenerationJob({
      convId: ctx.convId,
      capability: "video_generation",
      prompt,
      chatProviderId: activeModel?.providerId,
    });
    ctx.push({
      kind: "tool",
      name: "video_generation",
      args: { prompt },
      ok: true,
      result: t("video.started"),
    });
    onJobStarted(ctx.convId);

    return (
      `Video generation started (job ${job.id}). This takes MINUTES and is running in the background — you have NOT been given the video yet.\n` +
      "Do not wait for it, do not poll for it, and do not call video_generation again for the same request. " +
      "The result will be delivered to you automatically when it is ready, and it is shown to the user at that point. " +
      "Carry on with anything else the user asked for, or tell them it is running and end your turn."
    );
  };

  // save_memory: write a memory as a standalone Markdown file (retained across conversations), show a bubble, and feed the result back to the model.
  const saveMemory = async (ctx: RunCtx, rawArgs: Record<string, unknown>): Promise<string> => {
    const title = String(rawArgs.title ?? "").trim();
    const content = String(rawArgs.content ?? "").trim();
    const id = typeof rawArgs.id === "string" && rawArgs.id.trim() ? rawArgs.id.trim() : undefined;
    if (!title && !content) return "(save_memory is missing title / content)";
    const saved = await saveMemoryFile({ title, content, id });
    if (!saved) {
      ctx.push({ kind: "tool", name: "save_memory", args: { title }, ok: false, result: "Failed to save memory" });
      return "Failed to save memory (the current environment does not support it, or a write error occurred).";
    }
    ctx.push({ kind: "tool", name: "save_memory", args: { title: saved.title }, ok: true, result: `Remembered: ${saved.title}` });
    return `Saved the memory "${saved.title}" (id: ${saved.id}).`;
  };

  // delete_memory: permanently delete a memory by id (deleting its Markdown file), show a bubble, and feed it back to the model.
  const deleteMemory = async (ctx: RunCtx, rawArgs: Record<string, unknown>): Promise<string> => {
    const id = String(rawArgs.id ?? "").trim();
    if (!id) return "(delete_memory is missing id)";
    const ok = await deleteMemoryFile(id);
    ctx.push({
      kind: "tool",
      name: "delete_memory",
      args: { id },
      ok,
      result: ok ? `Deleted memory ${id}` : `Memory ${id} not found`,
    });
    return ok ? `Permanently deleted the memory (id: ${id}).` : `No memory found with id ${id} (it may already be deleted).`;
  };

  // search_memory: retrieve relevant memories from the memory store by query (reads the current file each time → memories added / modified in this conversation are immediately visible),
  // formatted and fed back to the model as the tool result. This is the retrieval side of "RAG": results land at the end of the wire, do not enter the frozen prefix, and do not disturb the prefix cache.
  const searchMemory = async (ctx: RunCtx, rawArgs: Record<string, unknown>): Promise<string> => {
    const query = String(rawArgs.query ?? "").trim();
    const limit = Math.max(1, Math.min(50, Number(rawArgs.limit) || 20));
    const all = await listMemoryFiles(); // Reads the current file each time: additions / modifications are immediately visible
    const hits = searchMemories(all, query, limit);
    ctx.push({
      kind: "tool",
      name: "search_memory",
      args: query ? { query } : {},
      ok: true,
      result: `Retrieved ${hits.length}/${all.length} memories`,
    });
    if (all.length === 0) return "The memory store is empty: no long-term memories about the user have been saved yet.";
    if (hits.length === 0) return `No memories related to "${query}" (${all.length} saved in total).`;
    const body = hits
      .map((m) => `- [${m.id}] ${m.title}: ${m.content.replace(/\s+/g, " ").trim().slice(0, 800)}`)
      .join("\n");
    const scope = query ? `Memories related to "${query}"` : "All saved memories";
    return `${scope} (${hits.length}/${all.length}, earlier means more relevant / more recent):\n${body}`;
  };

  // browser: operate the built-in browser via CDP (read / list links / click / type / navigate), with the result fed back to the model.
  const browserControl = async (ctx: RunCtx, rawArgs: Record<string, unknown>): Promise<string> => {
    const action = String(rawArgs.action ?? "") as BrowserAction;
    ctx.status(t("chat.browserAction", { action }));
    // When the AI operates the browser, ensure the panel is visible (the user may have manually closed it); no url, just expand without re-navigating.
    // Only the active conversation drives the browser panel / halo; a background conversation operates silently.
    if (ctx.convId === convIdRef.current) {
      requestOpenBrowser();
      // Mark "the AI is operating the browser": turn on the glowing halo, lasting until the end of this round (closed in send's finally),
      // so the halo spins continuously during multi-step browser operations, rather than flickering on each call.
      setBrowserBusy(true);
    }
    const res = await browserAction(action, rawArgs);
    const text = res.ok
      ? typeof res.result === "string"
        ? res.result
        : JSON.stringify(res.result)
      : `Operation failed: ${res.error ?? "unknown error"}`;
    ctx.push({ kind: "tool", name: `browser → ${action}`, args: rawArgs, ok: res.ok, result: text });
    return text;
  };

  // ask_user: render a choice card and wait for the user to click; return the text fed back to the model.
  const askUserChoice = async (ctx: RunCtx, rawArgs: Record<string, unknown>): Promise<string> => {
    // Accepts both shapes. `questions` is what the tool now declares; the flat `question` + `options` pair
    // is the older one, still honoured because a model mid-conversation may have the previous declaration
    // in its cached prefix and would otherwise get an unusable error for a well-formed call.
    const asQuestion = (v: unknown): ChoiceQuestion | null => {
      if (!v || typeof v !== "object") return null;
      const o = v as Record<string, unknown>;
      const question = String(o.question ?? "").trim();
      const options = Array.isArray(o.options) ? o.options.map((x) => String(x)).filter(Boolean) : [];
      // snake_case accepted alongside the declared camelCase: models mix the two conventions freely, and a
      // multi-select question silently rendered as single-select is a wrong answer, not a cosmetic slip.
      const multiSelect = o.multiSelect === true || o.multi_select === true;
      return question || options.length ? { question, options, multiSelect } : null;
    };
    const questions = Array.isArray(rawArgs.questions)
      ? (rawArgs.questions.map(asQuestion).filter(Boolean) as ChoiceQuestion[])
      : ([asQuestion(rawArgs)].filter(Boolean) as ChoiceQuestion[]);
    if (questions.length === 0) return "(ask_user is missing question / options)";

    // Rendering the card and parking the promise are the HOST's job (docs/agent-runtime-loop.md §13, M2b).
    // What stays here is the argument parsing above, which is a tool concern. What left is the resolver map
    // — and that is the whole point: a tool that awaits a React ref cannot run anywhere but inside the
    // component, which is what kept the loop trapped in page.tsx.
    return askUser(ctx.convId, questions);
  };

  return {
    ask_user: askUserChoice,
    update_todos: updateTodos,
    set_task_state: setTaskState,
    openBrowser: openBrowserAction,
    browser: browserControl,
    image_generation: generateImageAction,
    video_generation: generateVideoAction,
    load_skill: loadSkill,
    save_memory: saveMemory,
    delete_memory: deleteMemory,
    search_memory: searchMemory,
  };
}
