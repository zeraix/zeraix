/**
 * Skill marketplace.
 *
 * The catalog comes from `src/skills/*.md` (see ./catalog); fetchCatalog / downloadSkill use setTimeout
 * to simulate the async behavior and latency of a "remote fetch". To wire up a real remote marketplace,
 * just change these two function bodies to fetch(remote) — callers (store / SkillsPanel / page.tsx)
 * need no changes.
 *
 * Note: all skill content is plain-text instructions; downloading merely stores the text in
 * localStorage (see store.ts), writing no files to disk and accessing no directory outside testtest.
 */
import type { Skill, SkillManifest } from "./types";
import { CATALOG } from "./catalog";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetch the marketplace catalog (metadata only, without instructions). Simulates a remote list endpoint. */
export async function fetchCatalog(): Promise<SkillManifest[]> {
  await delay(400);
  return CATALOG.map(({ instructions, allowedTools, ...meta }) => {
    void instructions;
    void allowedTools;
    return meta;
  });
}

/** Download a skill's full content. Simulates a remote detail endpoint. Throws if not found. */
export async function downloadSkill(id: string): Promise<Skill> {
  await delay(600);
  const found = CATALOG.find((s) => s.id === id);
  if (!found) throw new Error(`No such skill in the marketplace: ${id}`);
  // Return a deep copy so caller mutations don't pollute the built-in catalog.
  return JSON.parse(JSON.stringify(found)) as Skill;
}
