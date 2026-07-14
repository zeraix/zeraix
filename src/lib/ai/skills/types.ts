/**
 * Skill type definitions.
 *
 * A skill = an instruction pack of "when to use + how to do it". It can be downloaded from the
 * marketplace, installed locally (localStorage), and enabled on demand within a conversation.
 * Once enabled:
 *   1) its "name + applicable scenarios" are written into the load_skill tool's description, for the
 *      main model to discover;
 *   2) only when the model calls load_skill are the full instructions fed back (progressive
 *      disclosure, saving tokens).
 *
 * Important (directory constraint): a skill itself is just "text instructions + an optional tool
 * allowlist", with no filesystem capability of its own. All tool calls a skill triggers remain bound
 * by the main conversation's "working directory" limit (see workdirPrompt in page.tsx), and cannot
 * reach outside testtest / the current working directory.
 */

/** Target audience: developers (writing code / modifying projects) or regular users (everyday tasks). Used for marketplace grouping and filtering. */
export type SkillAudience = "dev" | "user";
/** Skill scope: general (broadly applicable) or targeted (aimed at a specific kind of task). Used for marketplace grouping. */
export type SkillScope = "general" | "targeted";

/** Marketplace list item: lightweight metadata shown when browsing the marketplace, without the full instructions. */
export interface SkillManifest {
  id: string;
  name: string;
  version: string;
  /** One-liner: what this skill does / when to use it (also goes into the load_skill description). */
  description: string;
  author?: string;
  tags?: string[];
  /** Target audience (developer / regular user); defaults to everyone when omitted. */
  audience?: SkillAudience;
  /** General / targeted scope; defaults to general when omitted. */
  scope?: SkillScope;
}

/** Full skill: obtained after download, including the instruction body. */
export interface Skill extends SkillManifest {
  /** The full operating instructions injected into the main conversation after load_skill loads it (can be long). */
  instructions: string;
  /** Optional: an allowlist of tool names this skill recommends (a hint only; injected into the instruction preamble). */
  allowedTools?: string[];
}

/** Installed skill: the shape persisted to localStorage. */
export interface InstalledSkill extends Skill {
  /** Install timestamp. */
  installedAt: number;
  /** Whether it is enabled in the current conversation (= whether it enters the chat config). */
  enabled: boolean;
  /** Source: "user" = a custom skill uploaded by the user (editable); omitted = downloaded from the marketplace. */
  source?: "user";
  /** The raw Markdown of a user skill (frontmatter + body) — the source of truth when editing; can be reloaded into the editor and re-parsed. */
  sourceMarkdown?: string;
}
