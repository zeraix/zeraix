/**
 * Render-layer wrapper for accessing "project-level skill discovery".
 *
 * The main process scans the current working directory for skill files (Claude Code's `.claude/skills`,
 * Cursor's `.cursor/rules`, and this product's `.zeraix/skills`), and records the user's "add / ignore"
 * decisions to the project root's `.zeraix/config.json`. Exposed via preload as `window.projectSkills`;
 * available only in Electron. See electron/tools/projectSkills.mjs for the implementation.
 */

/** Skill source (which tool brought it in). */
export type ProjectSkillSource = "claude" | "openai" | "cursor" | "copilot" | "windsurf" | "zeraix";
/** Status: discovered = awaiting the user's decision; enabled = added; ignored = ignored. */
export type ProjectSkillStatus = "discovered" | "enabled" | "ignored";

/** A discovered project skill (lightweight metadata). */
export interface ProjectSkill {
  path: string; // relative to the working directory, forward slashes, e.g. ".claude/skills/react.md"
  source: ProjectSkillSource;
  name: string;
  description: string;
  status: ProjectSkillStatus;
}

/** An enabled project skill (including the full instruction body), to feed to the agent. */
export interface LoadedProjectSkill {
  path: string;
  source: ProjectSkillSource;
  name: string;
  description: string;
  instructions: string;
}

interface ProjectSkillsBridge {
  discover(): Promise<{ workdir: string; skills: ProjectSkill[] }>;
  decide(path: string, enabled: boolean): Promise<{ path: string; source: ProjectSkillSource; enabled: boolean }>;
  read(path: string): Promise<string>;
  loadEnabled(): Promise<LoadedProjectSkill[]>;
}

declare global {
  interface Window {
    projectSkills?: ProjectSkillsBridge;
  }
}

/** Whether the current environment supports project-level skill discovery (Electron only). */
export function isProjectSkillsAvailable(): boolean {
  return typeof window !== "undefined" && !!window.projectSkills;
}

/** Discover skills in the current project. Returns an empty list on unavailability / error (does not throw). */
export async function discoverProjectSkills(): Promise<ProjectSkill[]> {
  if (!isProjectSkillsAvailable()) return [];
  try {
    const res = await window.projectSkills!.discover();
    return Array.isArray(res?.skills) ? res.skills : [];
  } catch {
    return [];
  }
}

/** Record a decision for a skill: true = add, false = ignore. Writes to .zeraix/config.json. */
export async function decideProjectSkill(path: string, enabled: boolean): Promise<void> {
  if (!isProjectSkillsAvailable()) return;
  await window.projectSkills!.decide(path, enabled);
}

/** Read a skill file's raw content (for "view content"). */
export async function readProjectSkill(path: string): Promise<string> {
  if (!isProjectSkillsAvailable()) return "";
  try {
    return await window.projectSkills!.read(path);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** The enabled project skills (including instruction bodies). Returns an empty list on unavailability / error. */
export async function loadEnabledProjectSkills(): Promise<LoadedProjectSkill[]> {
  if (!isProjectSkillsAvailable()) return [];
  try {
    return await window.projectSkills!.loadEnabled();
  } catch {
    return [];
  }
}
