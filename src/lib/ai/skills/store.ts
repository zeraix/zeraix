/**
 * Local storage for installed skills.
 *
 * Via @zzcpt/zztool's getStorage / setStorage, persisted to the `skills` field of the `agent` object
 * (dot path `agent.skills`), shared by /agent/skills (download / manage) and /agent/chat (enable on
 * demand); writes no disk files. Any read/write failure degrades to empty rather than throwing.
 */
import { getStorage, setStorage } from "@zzcpt/zztool";
import type { InstalledSkill, Skill } from "./types";
import { AGENT_SKILLS_KEY as KEY } from "@/constants/Agent";
import { migrateLegacyAgentStorage } from "../agentStorage";

function read(): InstalledSkill[] {
  if (typeof window === "undefined") return [];
  migrateLegacyAgentStorage(); // before the first read, merge the old flat keys into the agent object
  const list = getStorage(KEY);
  return Array.isArray(list) ? (list as InstalledSkill[]) : [];
}

function write(list: InstalledSkill[]): void {
  if (typeof window === "undefined") return;
  setStorage(KEY, list); // an empty array is stored too ([] is truthy), faithfully reflecting "everything uninstalled"
}

/** Read all installed skills. */
export function loadInstalled(): InstalledSkill[] {
  return read();
}

/** Install (or overwrite/upgrade by id) a skill; enabled by default. Returns the updated list. */
export function installSkill(skill: Skill): InstalledSkill[] {
  const others = read().filter((s) => s.id !== skill.id);
  const installed: InstalledSkill = { ...skill, installedAt: Date.now(), enabled: true };
  const next = [...others, installed];
  write(next);
  return next;
}

/**
 * Save a user-uploaded / edited custom skill (source="user"). Upsert by id:
 *   - new: enabled by default, records the install time;
 *   - editing an existing one: keeps its enabled state and install time (updates content only),
 *     preserving source="user".
 * sourceMarkdown stores the raw .md as the source of truth for future edits. Returns the updated list.
 */
export function saveUserSkill(skill: Skill, sourceMarkdown: string): InstalledSkill[] {
  const list = read();
  const existing = list.find((s) => s.id === skill.id);
  const others = list.filter((s) => s.id !== skill.id);
  const saved: InstalledSkill = {
    ...skill,
    source: "user",
    sourceMarkdown,
    installedAt: existing?.installedAt ?? Date.now(),
    enabled: existing?.enabled ?? true,
  };
  const next = [...others, saved];
  write(next);
  return next;
}

/** Uninstall a skill. Returns the updated list. */
export function uninstallSkill(id: string): InstalledSkill[] {
  const next = read().filter((s) => s.id !== id);
  write(next);
  return next;
}

/** Enable / disable a skill (= whether it enters the chat config). Returns the updated list. */
export function setSkillEnabled(id: string, enabled: boolean): InstalledSkill[] {
  const next = read().map((s) => (s.id === id ? { ...s, enabled } : s));
  write(next);
  return next;
}

/** Filter the enabled skills out of a list (pure function, easy to reuse in the render layer). */
export function enabledSkills(list: InstalledSkill[]): InstalledSkill[] {
  return list.filter((s) => s.enabled);
}
