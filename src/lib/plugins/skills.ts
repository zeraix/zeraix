/**
 * Installed plugin skills, in the shape the chat loop already understands.
 *
 * This is the last link in the chain: without it a user can browse the marketplace, install a
 * plugin, see it enabled — and the agent never hears about it. `runtimeSkills()` in the chat page
 * merges three sources (installed skills, project skills, plugin skills) and this supplies the third,
 * mirroring `toInstalledProjectSkill` in chat/wireHelpers.ts.
 *
 * Two properties inherited from the store, not re-implemented here:
 *   - `active()` already excludes anything disabled or revoked, so a withdrawn plugin's skill stops
 *     reaching the model on the next reload without this file knowing what revocation is.
 *   - `read()` re-verifies the file against its pinned hash, so content that changed on disk since
 *     install is refused rather than fed to the agent.
 */
import { skillFromMarkdown } from "@/lib/ai/skills/parse";
import type { InstalledSkill } from "@/lib/ai/skills/types";
import { pluginBridge } from "./bridge";

/**
 * Namespaced so a plugin cannot shadow a built-in or project skill by picking its id — `load_skill`
 * takes an id, and two skills answering to one name is the model loading whichever won.
 */
export const pluginSkillId = (pluginId: string, capabilityId: string) => `plugin:${pluginId}:${capabilityId}`;

/**
 * Read every active plugin-provided skill.
 *
 * Never throws and never rejects the batch over one bad member: a plugin whose file fails its hash
 * check, or whose markdown will not parse, is dropped with a console warning while the rest load.
 * The alternative — one corrupt plugin silently removing every skill from the conversation — is a
 * far worse failure than losing the one that is broken.
 */
export async function loadPluginSkills(): Promise<InstalledSkill[]> {
  const bridge = pluginBridge();
  if (!bridge) return [];

  let active: Awaited<ReturnType<typeof bridge.active>>;
  try {
    active = await bridge.active();
  } catch {
    return [];
  }

  const out: InstalledSkill[] = [];
  for (const cap of active) {
    if (cap.type !== "skill") continue;
    try {
      const file = await bridge.read(cap.pluginId, cap.id);
      if (!file.ok || !file.content) {
        console.warn(`[plugins] skipping ${cap.pluginId}:${cap.id} — ${file.error ?? "no content"}`);
        continue;
      }
      // The whole file including frontmatter, parsed by the app's own reader — the exporter ships it
      // intact for exactly this reason.
      const skill = skillFromMarkdown(file.content, cap.id);
      out.push({
        ...skill,
        id: pluginSkillId(cap.pluginId, cap.id),
        installedAt: 0,
        // Enablement is the plugin's, decided in the marketplace and already applied by `active()`.
        // A second per-skill toggle here would be a switch that silently disagrees with that one.
        enabled: true,
      });
    } catch (e) {
      console.warn(`[plugins] skipping ${cap.pluginId}:${cap.id} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}
