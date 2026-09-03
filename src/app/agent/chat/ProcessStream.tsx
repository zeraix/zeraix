"use client";

import { memo, useState } from "react";
import {
  ArrowRight,
  BookMarked,
  BookOpen,
  Brain,
  ChevronDown,
  CircleEllipsis,
  CircleStop,
  Copy,
  ExternalLink,
  Film,
  FolderPlus,
  Globe,
  Image as ImageIcon,
  ListChecks,
  Loader2,
  MessageCircleQuestion,
  PencilLine,
  Plug,
  Search,
  Sparkles,
  Terminal,
  Trash2,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { DiffView, extractDiff } from "./DiffView";
import {
  countDiffLines,
  groupCalls,
  splitPath,
  tallyExplore,
  targetOf,
  toolNameOf,
  type TraceCall,
} from "./processTrace";
import { clipForDisplay, formatDuration } from "./format";
import { Markdown } from "./Markdown";
import type { DisplayMsg, ToolMsg } from "./types";

/**
 * The thinking-process stream: the AI's trace of reasoning, phase summaries and tool calls, rendered as a flat run of
 * lines rather than a card.
 *
 * It used to be one collapsible card wrapping nested "Executing" cards wrapping per-tool bubbles, which put three
 * borders and two clicks between the user and "which file did it just write". Here each round reads as a short
 * paragraph under a muted `Thinking process · took 6s` header, followed by one line per action — `Wrote  index.html
 * src/  +85`. Consecutive read-only lookups collapse into a single `Explored · 2 read, 1 listed` line, because a run of
 * greps is one activity, not five.
 *
 * Nothing is lost to the flattening: every line is still a disclosure, and every one starts closed. A narration header
 * unfolds its paragraph, an action row opens onto the diff (or the arguments and result) the old card carried, and an
 * "Explored" line opens back into the individual lookups it merged. What changed against the old card is the reach:
 * each of those is one click from the stream instead of two clicks and a scroll inside a nested card. A sub-agent
 * delegation keeps its own card, since it is a whole nested run rather than a single action.
 */

/** Members received by ProcessGroup: a stretch of the AI's "thinking trace" — deep reasoning, phase summaries, tool calls. */
export type ProcessItem = Extract<
  DisplayMsg,
  { kind: "tool" | "reasoning" | "phase" }
>;

/** How a tool call presents itself on its line: which verb, which glyph, and which shape of target it names. */
type ActionKind =
  /** Read-only lookups. Merged with their neighbours into one "Explored" line. */
  | "explore"
  /** Touches a file. The line names the file, its folder, and how many lines changed. */
  | "file"
  /** Names a command / query / URL instead of a path. */
  | "text"
  /** Hands work to a sub-agent. Keeps its card. */
  | "delegate";

type Action = { labelKey: string; icon: LucideIcon; kind: ActionKind };

const CALLED: Action = {
  labelKey: "chat.act.called",
  icon: Wrench,
  kind: "text",
};

const EXPLORE = (icon: LucideIcon = Search): Action => ({
  labelKey: "chat.act.explored",
  icon,
  kind: "explore",
});

const TOOL_ACTIONS: Record<string, Action> = {
  // Files
  write_file: { labelKey: "chat.act.wrote", icon: PencilLine, kind: "file" },
  edit_file: { labelKey: "chat.act.edited", icon: PencilLine, kind: "file" },
  append_file: { labelKey: "chat.act.appended", icon: PencilLine, kind: "file" },
  delete_file: { labelKey: "chat.act.deleted", icon: Trash2, kind: "file" },
  create_directory: { labelKey: "chat.act.created", icon: FolderPlus, kind: "file" },
  move_file: { labelKey: "chat.act.moved", icon: ArrowRight, kind: "file" },
  copy_file: { labelKey: "chat.act.copied", icon: Copy, kind: "file" },

  // Lookups. Only the filesystem ones merge into an "Explored" run: a web or memory search is one deliberate act
  // worth its own line, where a run of greps is a single activity.
  read_file: EXPLORE(),
  list_directory: EXPLORE(),
  file_info: EXPLORE(),
  search_files: EXPLORE(),
  search_in_files: EXPLORE(),

  // Commands
  run_command: { labelKey: "chat.act.ran", icon: Terminal, kind: "text" },
  check_project: { labelKey: "chat.act.ran", icon: Terminal, kind: "text" },
  init_command: { labelKey: "chat.act.ran", icon: Terminal, kind: "text" },
  stop_service: { labelKey: "chat.act.stopped", icon: CircleStop, kind: "text" },

  // Web and the browser panel
  web_search: { labelKey: "chat.act.searched", icon: Globe, kind: "text" },
  fetch_url: { labelKey: "chat.act.fetched", icon: Globe, kind: "text" },
  page_console: { labelKey: "chat.act.checked", icon: Globe, kind: "text" },
  openBrowser: { labelKey: "chat.act.opened", icon: Globe, kind: "text" },
  browser: { labelKey: "chat.act.opened", icon: Globe, kind: "text" },
  open_path: { labelKey: "chat.act.opened", icon: ExternalLink, kind: "text" },

  // Delegation. spawn_sub_agent is the brokered singular — a different tool from spawn_subagents, and easy to miss.
  run_subagent: { labelKey: "chat.act.delegated", icon: Sparkles, kind: "delegate" },
  spawn_subagents: { labelKey: "chat.act.delegated", icon: Sparkles, kind: "delegate" },
  spawn_sub_agent: { labelKey: "chat.act.delegated", icon: Sparkles, kind: "delegate" },
  join_subagents: { labelKey: "chat.act.delegated", icon: Sparkles, kind: "delegate" },

  // Renderer-handled tools (RENDERER_HANDLED_TOOLS, constants.ts): they drive UI or renderer-local state rather than
  // the toolkit, and every one of them used to land on the generic "Called" fallback.
  ask_user: { labelKey: "chat.act.asked", icon: MessageCircleQuestion, kind: "text" },
  refine_question: { labelKey: "chat.act.asked", icon: MessageCircleQuestion, kind: "text" },
  update_todos: { labelKey: "chat.act.updated", icon: ListChecks, kind: "text" },
  set_task_state: { labelKey: "chat.act.updated", icon: ListChecks, kind: "text" },
  save_memory: { labelKey: "chat.act.remembered", icon: BookMarked, kind: "text" },
  remember_project: { labelKey: "chat.act.remembered", icon: BookMarked, kind: "text" },
  delete_memory: { labelKey: "chat.act.deleted", icon: Trash2, kind: "text" },
  search_memory: { labelKey: "chat.act.searched", icon: Search, kind: "text" },
  load_skill: { labelKey: "chat.act.loaded", icon: BookOpen, kind: "text" },
  image_generation: { labelKey: "chat.act.generated", icon: ImageIcon, kind: "text" },
  video_generation: { labelKey: "chat.act.generated", icon: Film, kind: "text" },

  // Integrations
  mcp_discover: { labelKey: "chat.act.searched", icon: Plug, kind: "text" },
  mcp_connect: { labelKey: "chat.act.connected", icon: Plug, kind: "text" },
  mcp_tools: { labelKey: "chat.act.checked", icon: Plug, kind: "text" },
  plugin_tools: { labelKey: "chat.act.checked", icon: Wrench, kind: "text" },
  sandbox_tools: { labelKey: "chat.act.checked", icon: Wrench, kind: "text" },
};

/**
 * The tool behind a display name, with any `agentId→` prefix resolved away. An MCP server's own tools arrive with
 * names this table has never heard of (`mcp__github__search_issues`) and land on CALLED, which is why that row shows
 * the tool's name as well as its target.
 */
const isKnownTool = (name: string) => name in TOOL_ACTIONS;
const resolveName = (display: string) => toolNameOf(display, isKnownTool);

const actionFor = (name: string): Action => TOOL_ACTIONS[resolveName(name)] ?? CALLED;

/** Tint for a file badge, by extension. Unlisted types fall back to the neutral surface colour. */
const EXT_TINTS: Record<string, string> = {
  html: "bg-[#e34f26] text-white",
  css: "bg-[#8b5cf6] text-white",
  scss: "bg-[#c76494] text-white",
  js: "bg-[#f7df1e] text-black",
  mjs: "bg-[#f7df1e] text-black",
  jsx: "bg-[#f7df1e] text-black",
  ts: "bg-[#3178c6] text-white",
  tsx: "bg-[#3178c6] text-white",
  json: "bg-[#8bc34a] text-black",
  md: "bg-[#64748b] text-white",
  py: "bg-[#3776ab] text-white",
  rs: "bg-[#ce422b] text-white",
  go: "bg-[#00add8] text-black",
  sh: "bg-[#4eaa25] text-black",
  yml: "bg-[#cb171e] text-white",
  yaml: "bg-[#cb171e] text-white",
  toml: "bg-[#9c4221] text-white",
  svg: "bg-[#ffb13b] text-black",
  png: "bg-[#0ea5e9] text-white",
  jpg: "bg-[#0ea5e9] text-white",
};

/** The little colour-coded chip in front of a filename, carrying the first two letters of its extension. */
function FileBadge({ name }: { name: string }) {
  const ext = name.includes(".")
    ? name.slice(name.lastIndexOf(".") + 1).toLowerCase()
    : "";
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[3px] text-[8px] font-bold uppercase leading-none",
        EXT_TINTS[ext] ?? "bg-line-strong text-ink-muted",
      )}
    >
      {ext.slice(0, 2) || "•"}
    </span>
  );
}

/**
 * "took 6s" / "took 1m 12s", in the reading language, phrasing included — hence a translated template rather than
 * `format.ts`'s `formatDuration`, which produces the bare "6s" the usage tag wants. Rounded to whole seconds, because
 * sub-second precision is noise next to a paragraph of narration.
 */
function formatTook(
  ms: number,
  t: (k: string, v?: Record<string, string | number>) => string,
): string {
  const total = Math.max(1, Math.round(ms / 1000));
  return total < 60
    ? t("chat.tookSec", { n: total })
    : t("chat.tookMin", { m: Math.floor(total / 60), s: total % 60 });
}

/**
 * A row's disclosure chevron. Stays invisible until the row is hovered or opened, so a settled stream reads as the flat
 * run of lines it is meant to be, and the affordance is still there the moment the pointer goes looking for it.
 */
function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronDown
      className={cn(
        "ml-auto size-3 shrink-0 text-ink-subtle transition-all duration-200",
        open ? "rotate-180 opacity-100" : "opacity-0 group-hover:opacity-100",
      )}
    />
  );
}

/** Shared shape for anything a row reveals: indented under the row, hung off a rule rather than boxed in a card. */
function RowDetail({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 ml-[7px] space-y-1.5 border-l border-line pl-3 text-[11px]">
      {children}
    </div>
  );
}

/**
 * The text a still-running call is about to write, if it is that kind of call.
 *
 * `write_file` carries the whole new file in `content` and `edit_file` the replacement in `new_string`, so the
 * preview is already in the arguments — nothing has to be streamed to show it. Returns null for a call with
 * nothing to preview (a search, a command), where the arguments alone are the honest thing to show.
 */
function pendingContent(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  for (const key of ["content", "new_string"]) {
    const v = a[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/** A tool call's arguments as JSON, or `{}` when they cannot be serialised (a cycle, a BigInt). */
/**
 * A body clipped for layout, with a line saying how much was left out.
 *
 * Every argument and result body in the stream goes through this. See clipForDisplay for why: a result the size of
 * a file is the one thing here that can take the main thread down, and the text itself is unaffected.
 */
function Clipped({ text }: { text: string }) {
  const t = useT();
  const { text: head, hidden } = clipForDisplay(text);
  return (
    <>
      {head}
      {hidden > 0 && (
        <span className="mt-1 block text-ink-subtle">{t("chat.resultClipped", { n: hidden })}</span>
      )}
    </>
  );
}

function argsJson(args: unknown): string {
  try {
    return JSON.stringify(args, null, 2) ?? "{}";
  } catch {
    return "{}";
  }
}

/**
 * What one tool call actually did: its diff if it changed a file, otherwise its arguments and what it returned.
 *
 * The same material the old per-tool card carried, minus the card — the row above already says which tool and which
 * file, so this only has to supply what the row could not fit.
 *
 * While a call is still running there is no result to show, so it shows the CONTENT instead — which for a file
 * edit is the thing the user actually wants to watch. Without it a write of any size was an unexplained pause.
 */
function ToolDetail({ call }: { call: TraceCall }) {
  const t = useT();
  const preview = call.running ? pendingContent(call.args) : null;
  const { before, diff, after } = extractDiff(call.result);
  const argStr = argsJson(call.args);

  if (preview !== null) {
    return (
      <RowDetail>
        <div>
          <div className="mb-0.5 font-semibold text-ink-subtle">{t("chat.writing")}</div>
          {/* Bounded and scrollable for the same reason the diff panel is: the content of a file is as long as
              the file, and an unbounded preview pushes the conversation off the screen while it is written. */}
          <pre className="max-h-96 overflow-auto overscroll-contain whitespace-pre-wrap break-all font-mono text-ink-muted">
            {preview}
          </pre>
        </div>
      </RowDetail>
    );
  }

  return (
    <RowDetail>
      {diff ? (
        <>
          {before && (
            <p
              className={cn(
                "font-mono",
                call.ok ? "text-ink-muted" : "text-destructive",
              )}
            >
              {before}
            </p>
          )}
          <DiffView diff={diff} />
          {after && <p className="font-mono text-ink-muted">{after}</p>}
        </>
      ) : (
        <>
          <div>
            <div className="mb-0.5 font-semibold text-ink-subtle">
              {t("chat.args")}
            </div>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-ink-muted">
              <Clipped text={argStr} />
            </pre>
          </div>
          <div>
            <div className="mb-0.5 font-semibold text-ink-subtle">
              {t("chat.result")}
            </div>
            <pre
              className={cn(
                "max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono",
                call.ok ? "text-ink-muted" : "text-destructive",
              )}
            >
              <Clipped text={call.result} />
            </pre>
          </div>
        </>
      )}
    </RowDetail>
  );
}

/**
 * The muted `⋯ Thinking process · took 6s` line that heads each stretch of narration, and the switch that unfolds it.
 *
 * Collapsed by default, like every other row here: what the reader is owed at a glance is the shape of the turn —
 * thought, then these files, then more thought — and a paragraph per round buries that under prose. While a round is
 * still running the header keeps its spinner and its clock, so a folded segment still reads as live.
 */
function TraceSegment({
  label,
  type,
  icon: Icon,
  content,
  ms,
  live = false,
}: {
  label: string;
  type: string;
  icon: LucideIcon;
  content: string;
  /** How long the round took. Absent on records written before this was measured — the label is then just the title. */
  ms?: number;
  live?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-1">
      {type === "phase" ? (
        <div className="py-1">
          <Markdown content={content} />
        </div>
      ) : (
        // Deep thinking is a row like any other: the same trigger as an action or a delegation, opening onto the same
        // indented detail. It used to have a shape of its own — a tighter, text-only header whose body sat flush with
        // the stream — which read as a different kind of thing sitting among the rows rather than one more of them.
        <>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="group flex w-full min-w-0 items-center gap-1.5 rounded py-1 text-left text-[12px] transition-colors hover:bg-surface-muted/60"
          >
            {live ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
            ) : (
              <Icon className="size-3.5 shrink-0 text-ink-subtle" />
            )}
            <span className="shrink-0 text-ink-subtle">{label}</span>
            {ms !== undefined && (
              <>
                <span aria-hidden className="text-ink-subtle">
                  ·
                </span>
                <span className="tabular-nums text-ink-subtle">{formatTook(ms, t)}</span>
              </>
            )}
            <Chevron open={open} />
          </button>
          {open && (
            <RowDetail>
              {/* Pre-wrapped rather than Markdown, matching a delegation's task and result: a chain of thought is raw
                  text the model talked to itself in, not authored prose, and running it through Markdown turns stray
                  asterisks and hashes into formatting the model never meant.

                  Capped and scrolled at 350px, the same way ToolDetail caps a result: a model can think for pages, and
                  an uncapped block pushes every row after it off the screen for a reader who only wanted a glance. */}
              <p className="max-h-[350px] overflow-y-auto whitespace-pre-wrap break-words text-ink-muted">
                {content}
              </p>
            </RowDetail>
          )}
        </>
      )}
    </div>
  );
}

/** One action, on one line: what was done, to what, and how big the change was. Click it for the rest. */
function ActionRow({ call }: { call: TraceCall }) {
  const t = useT();
  // Collapsed by default, like every other row here — including while the call is still running.
  //
  // A running row used to open itself, on the reasoning that a live preview nobody can see is not a preview.
  // That was wrong about the cost: a turn is dozens of calls, each one unfolding a block of file content as it
  // starts, and the trace turns into a wall that scrolls the conversation away from under the reader. The
  // preview is still one click away, and the click is the reader saying they want it.
  const [open, setOpen] = useState(false);
  const tool = resolveName(call.name);
  const action = actionFor(call.name);
  const Icon = action.icon;
  const target = targetOf(tool, call.args);
  const counts = countDiffLines(extractDiff(call.result).diff);
  const isFile = action.kind === "file" && !!target;
  const { dir, name } = isFile ? splitPath(target) : { dir: "", name: target };
  // "Called" says nothing about which tool ran, and it is exactly the rows that land there — an MCP server's own
  // tools, a plugin's — whose identity is not guessable from the target. So those rows name the tool as well.
  const showTool = action === CALLED;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="group flex w-full min-w-0 items-center gap-1.5 rounded py-1 text-left text-[12px] transition-colors hover:bg-surface-muted/60"
      >
        {call.running ? (
          // The spinner replaces the tool's own icon rather than sitting beside it: two glyphs on a one-line
          // row reads as two things happening.
          <Loader2 className="size-3.5 shrink-0 animate-spin text-ink-subtle" />
        ) : (
          <Icon
            className={cn(
              "size-3.5 shrink-0",
              call.ok ? "text-ink-subtle" : "text-destructive",
            )}
          />
        )}
        <span
          className={cn(
            "shrink-0",
            call.ok ? "text-ink-subtle" : "text-destructive",
          )}
        >
          {t(action.labelKey)}
        </span>
        {showTool && <span className="shrink-0 font-mono text-ink">{tool}</span>}
        {/* The bare "1.8s" rather than the narration row's "took 6s": a tool call is routinely sub-second, and
            formatTook rounds that to "took 1s" for everything under a second and a half. */}
        {call.ms !== undefined && (
          <span className="shrink-0 tabular-nums text-ink-subtle">{formatDuration(call.ms)}</span>
        )}
        {isFile && <FileBadge name={name} />}
        {name && (
          <span
            className={cn(
              "min-w-0 truncate",
              isFile ? "font-medium text-ink" : "font-mono text-ink-muted",
            )}
          >
            {name}
          </span>
        )}
        {dir && <span className="min-w-0 truncate text-ink-subtle">{dir}</span>}
        {counts && (
          <span className="ml-1 flex shrink-0 items-center gap-1.5 tabular-nums">
            {counts.add > 0 && (
              <span className="text-success-ink">
                +{counts.add}
                {counts.partial && "…"}
              </span>
            )}
            {counts.del > 0 && (
              <span className="text-destructive">
                -{counts.del}
                {counts.partial && "…"}
              </span>
            )}
          </span>
        )}
        <Chevron open={open} />
      </button>
      {open && <ToolDetail call={call} />}
    </div>
  );
}

/**
 * A run of consecutive read-only lookups, on one line: `Explored · 2 read, 1 listed`.
 * Reading around a codebase is one activity; listing every grep as its own line buries the writes between them.
 * Opening it gives the run back as the individual lookups it was made of.
 */
function ExploreRow({ calls }: { calls: TraceCall[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const tally = tallyExplore(calls.map((c) => resolveName(c.name)));
  const parts = [
    tally.read && t("chat.explore.read", { n: tally.read }),
    tally.list && t("chat.explore.list", { n: tally.list }),
    tally.search && t("chat.explore.search", { n: tally.search }),
  ].filter(Boolean) as string[];
  const failed = calls.some((c) => !c.ok);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="group flex w-full min-w-0 items-center gap-1.5 rounded py-1 text-left text-[12px] transition-colors hover:bg-surface-muted/60"
      >
        <Search
          className={cn(
            "size-3.5 shrink-0",
            failed ? "text-destructive" : "text-ink-subtle",
          )}
        />
        <span
          className={cn(
            "shrink-0",
            failed ? "text-destructive" : "text-ink-subtle",
          )}
        >
          {t("chat.act.explored")}
        </span>
        <span aria-hidden className="text-ink-subtle">
          ·
        </span>
        <span className="truncate text-ink-muted">{parts.join(", ")}</span>
        <Chevron open={open} />
      </button>
      {open && (
        <RowDetail>
          {calls.map((c, i) => (
            <div key={i} className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  "shrink-0",
                  c.ok ? "text-ink-subtle" : "text-destructive",
                )}
              >
                {resolveName(c.name)}
              </span>
              <span className="min-w-0 truncate font-mono text-ink-muted">
                {targetOf(resolveName(c.name), c.args)}
              </span>
            </div>
          ))}
        </RowDetail>
      )}
    </div>
  );
}

/**
 * A run of tool calls, drawn as the stream draws them: lookups merged, everything else on its own line.
 *
 * Shared by the top-level trace and by a single tool bubble that renders on its own (MessageItem), so a call reads
 * the same wherever it appears — same verbs, same file chips, same +/- counts.
 */
export function CallRows({ calls }: { calls: TraceCall[] }) {
  return (
    <>
      {groupCalls(calls, (name) => actionFor(name).kind === "explore").map(
        (g, i) =>
          "explore" in g ? (
            <ExploreRow key={i} calls={g.explore} />
          ) : (
            <ActionRow key={i} call={g.call} />
          ),
      )}
    </>
  );
}

/**
 * A delegation, on one line: `Delegated  explore`, opening onto the task it was given and the answer it came back with.
 *
 * What the sub-agent DID on the way there is deliberately not here. It used to be — the row unfolded into the whole
 * nested run — and that was the best available answer while there was nowhere else to put it. The Sub-agent Inspector
 * is now that place, and it shows the run as a page of its own: the task, every tool call with its arguments and
 * result, the timing, the conclusion. Rendering it in both would say the same thing twice, and the transcript is the
 * one that cannot afford the room — its job is the conversation, not the machinery underneath it.
 *
 * Collapsed by default, like everything else here.
 */
function DelegateRow({ m }: { m: ToolMsg }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const failed = !m.ok;
  const args =
    m.args && typeof m.args === "object"
      ? (m.args as Record<string, unknown>)
      : {};
  // The delegation's display name is built as "run_subagent → explore", so the agent is in the args when they survived
  // the round trip and after the arrow otherwise.
  const agent = String(args.agent ?? m.name.split("→").pop() ?? m.name).trim();
  const task = String(args.task ?? "");

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="group flex w-full min-w-0 items-center gap-1.5 rounded py-1 text-left text-[12px] transition-colors hover:bg-surface-muted/60"
      >
        <Sparkles
          className={cn(
            "size-3.5 shrink-0",
            failed ? "text-destructive" : "text-ink-subtle",
          )}
        />
        <span
          className={cn(
            "shrink-0",
            failed ? "text-destructive" : "text-ink-subtle",
          )}
        >
          {t("chat.act.delegated")}
        </span>
        <span className="min-w-0 truncate font-medium text-ink">{agent}</span>
        <Chevron open={open} />
      </button>
      {open && (
        <RowDetail>
          {task ? (
            <div>
              <div className="mb-0.5 font-semibold text-ink-subtle">
                {t("chat.subagentTask")}
              </div>
              <p className="whitespace-pre-wrap break-words text-ink-muted">
                {task}
              </p>
            </div>
          ) : (
            // `spawn_subagents` carries a LIST of tasks, and `join_subagents` a list of handles — neither has
            // a single `task` to name. What the main agent asked for is its own action and belongs in the
            // transcript (only what the sub-agents then DID moved to the Inspector), so the arguments are
            // shown the way every other tool row shows them rather than being dropped for want of a field.
            <div>
              <div className="mb-0.5 font-semibold text-ink-subtle">{t("chat.args")}</div>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-ink-muted">
                <Clipped text={argsJson(m.args)} />
              </pre>
            </div>
          )}
          {m.result && (
            <div>
              <div className="mb-0.5 font-semibold text-ink-subtle">
                {t("chat.result")}
              </div>
              <p className="whitespace-pre-wrap break-words text-ink-muted">
                <Clipped text={m.result} />
              </p>
            </div>
          )}
        </RowDetail>
      )}
    </div>
  );
}

/** What one pass over `items` turns into: narration blocks, delegations, and runs of ordinary calls. */
type Segment =
  | { type: "trace"; kind: "reasoning" | "phase"; content: string; ms?: number }
  | { type: "delegate"; tool: ToolMsg }
  | { type: "calls"; calls: TraceCall[] };

function toSegments(items: ProcessItem[]): Segment[] {
  const out: Segment[] = [];
  for (const m of items) {
    if (m.kind === "reasoning" || m.kind === "phase") {
      out.push({ type: "trace", kind: m.kind, content: m.content, ms: m.ms });
      continue;
    }
    // A delegation is named by the tool that made it, not by whether a trace happened to be recorded against
    // it — which is what this used to test, and what stopped being true when the sub-agent's steps moved to
    // the Inspector. The action table already knows which tools delegate; asking it keeps one answer.
    if (actionFor(m.name).kind === "delegate") {
      out.push({ type: "delegate", tool: m });
      continue;
    }
    const last = out[out.length - 1];
    if (last?.type === "calls") last.calls.push(m);
    else out.push({ type: "calls", calls: [m] });
  }
  return out;
}

/**
 * A continuous stretch of the AI's trace, rendered inline beneath the reply it belongs to.
 *
 * `turnActive` is still accepted so the call site does not have to change, and is deliberately unused: it existed to
 * auto-collapse the old card when a turn ended, and nothing collapses any more.
 */
export const ProcessGroup = memo(function ProcessGroup({
  items,
  live = false,
}: {
  items: ProcessItem[];
  live?: boolean;
  turnActive?: boolean;
}) {
  const t = useT();
  const segments = toSegments(items);
  // The narration block currently being written, so its header can spin and count up instead of sitting finished.
  let liveTrace = -1;
  segments.forEach((s, i) => {
    if (s.type === "trace") liveTrace = i;
  });

  return (
    // Full width and flush left, exactly like the assistant reply below it: the trace is narration in the same voice,
    // and the old avatar-width gutter indented it away from the text it belongs to. (Avatars are long gone; the
    // placeholder outlived them.)
    <div className="flex w-full min-w-0 flex-col items-start">
      <div className="w-full min-w-0 space-y-2">
        {segments.map((seg, i) => {
          if (seg.type === "trace") {
            return (
              <TraceSegment
                key={i}
                type={seg.kind}
                label={
                  seg.kind === "reasoning"
                    ? t("chat.reasoning")
                    : t("chat.process")
                }
                icon={seg.kind === "reasoning" ? Brain : CircleEllipsis}
                content={seg.content}
                ms={seg.ms}
                live={live && i === liveTrace}
              />
            );
          }
          if (seg.type === "delegate")
            return <DelegateRow key={i} m={seg.tool} />;
          return <CallRows key={i} calls={seg.calls} />;
        })}
      </div>
    </div>
  );
});
