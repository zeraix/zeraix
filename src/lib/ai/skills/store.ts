/**
 * Local storage for installed skills.
 *
 * Via @zzcpt/zztool's getStorage / setStorage, persisted to the `skills` field of the `agent` object
 * (dot path `agent.skills`), shared by /agent/skills (download / manage) and /agent/chat (enable on
 * demand); writes no disk files. Any read/write failure degrades to empty rather than throwing.
 *
 * Two populations share one list as far as callers are concerned:
 *   - the built-in document skills (documentSkills.ts): defined in code, always present, enabled unless the
 *     user switched one off. Only that off-list is persisted (`agent.builtinSkillsOff`), so a skill's text
 *     is always the version shipped with the running app, never a stale copy frozen in localStorage;
 *   - user-installed skills (marketplace downloads and uploads): the persisted `agent.skills` array.
 * Every function returns the merged view, built-ins first, so the panels can render one list.
 */
import { getStorage, setStorage } from "@zzcpt/zztool";
import type { InstalledSkill, Skill } from "./types";
import { AGENT_BUILTIN_SKILLS_OFF_KEY as OFF_KEY, AGENT_SKILLS_KEY as KEY } from "@/constants/Agent";
import { migrateLegacyAgentStorage } from "../agentStorage";
import { DOCUMENT_SKILLS, isDocumentSkill } from "./documentSkills";

/** The user-installed list only. A built-in id that somehow landed here is dropped: the code copy is the truth. */
function read(): InstalledSkill[] {
  if (typeof window === "undefined") return [];
  migrateLegacyAgentStorage(); // before the first read, merge the old flat keys into the agent object
  const list = getStorage(KEY);
  return Array.isArray(list) ? (list as InstalledSkill[]).filter((s) => !isDocumentSkill(s.id)) : [];
}

function write(list: InstalledSkill[]): void {
  if (typeof window === "undefined") return;
  setStorage(KEY, list); // an empty array is stored too ([] is truthy), faithfully reflecting "everything uninstalled"
}

/** Ids of built-in skills the user switched off. */
function readOff(): string[] {
  if (typeof window === "undefined") return [];
  const v = getStorage(OFF_KEY);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function writeOff(ids: string[]): void {
  if (typeof window === "undefined") return;
  setStorage(OFF_KEY, ids);
}

/** The built-in skills with their current enabled flag applied. */
function builtins(): InstalledSkill[] {
  if (typeof window === "undefined") return [];
  const off = new Set(readOff());
  return DOCUMENT_SKILLS.map((s) => ({ ...s, enabled: !off.has(s.id) }));
}

/** The merged list every caller sees: built-ins first, then user-installed skills. */
function all(): InstalledSkill[] {
  return [...builtins(), ...read()];
}

/** Read all installed skills (built-ins included). */
export function loadInstalled(): InstalledSkill[] {
  return all();
}

/** Install (or overwrite/upgrade by id) a skill; enabled by default. Returns the updated list. */
export function installSkill(skill: Skill): InstalledSkill[] {
  if (isDocumentSkill(skill.id)) return all(); // already there, by construction
  const others = read().filter((s) => s.id !== skill.id);
  const installed: InstalledSkill = { ...skill, installedAt: Date.now(), enabled: true };
  write([...others, installed]);
  return all();
}

/**
 * Save a user-uploaded / edited custom skill (source="user"). Upsert by id:
 *   - new: enabled by default, records the install time;
 *   - editing an existing one: keeps its enabled state and install time (updates content only),
 *     preserving source="user".
 * sourceMarkdown stores the raw .md as the source of truth for future edits. Returns the updated list.
 * A built-in id is refused: two skills answering to one id would leave load_skill loading whichever won.
 */
export function saveUserSkill(skill: Skill, sourceMarkdown: string): InstalledSkill[] {
  if (isDocumentSkill(skill.id)) throw new Error(`"${skill.id}" is the id of a built-in skill; choose another name or id`);
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
  write([...others, saved]);
  return all();
}

/** Uninstall a skill. Built-ins cannot be uninstalled (switch them off instead). Returns the updated list. */
export function uninstallSkill(id: string): InstalledSkill[] {
  if (!isDocumentSkill(id)) write(read().filter((s) => s.id !== id));
  return all();
}

/** Enable / disable a skill (= whether it enters the chat config). Returns the updated list. */
export function setSkillEnabled(id: string, enabled: boolean): InstalledSkill[] {
  if (isDocumentSkill(id)) {
    const off = readOff().filter((x) => x !== id);
    writeOff(enabled ? off : [...off, id]);
  } else {
    write(read().map((s) => (s.id === id ? { ...s, enabled } : s)));
  }
  return all();
}

/** Filter the enabled skills out of a list (pure function, easy to reuse in the render layer). */
export function enabledSkills(list: InstalledSkill[]): InstalledSkill[] {
  return list.filter((s) => s.enabled);
}
