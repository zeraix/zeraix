/**
 * Runtime wiring of skills within a conversation: exposes enabled skills to the main model and
 * implements progressive disclosure.
 *
 * Design note: the skill catalog is written into the load_skill tool's description, and that tool is
 * rebuilt on every send in page.tsx, so a skill newly downloaded / enabled mid-conversation can be
 * discovered by the model on the very next message, with no need to reset the conversation.
 */
import type { InstalledSkill } from "./types";

/** A sentence appended to the first-turn system prompt, telling the model "you are equipped with skills, call load_skill as needed". */
export function skillSystemHint(enabled: InstalledSkill[]): string {
  if (enabled.length === 0) return "";
  return (
    "You are additionally equipped with several \"skills\". When a task matches a skill's applicable scenario, first call load_skill to obtain its full instructions, " +
    "then act on them; do not guess at a skill's contents."
  );
}

/** Build the load_skill tool declaration (rebuilt every turn). Returns null when no skills are enabled. */
export function loadSkillTool(enabled: InstalledSkill[]) {
  if (enabled.length === 0) return null;
  const menu = enabled.map((s) => `- ${s.id}: ${s.description}`).join("\n");
  return {
    type: "function" as const,
    function: {
      name: "load_skill",
      description:
        "Load a skill's full operating instructions, then perform that kind of task under its guidance. Enabled skills:\n" +
        menu +
        "\nWhen a task matches one of the above, first call this tool to get the full steps, then start.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            enum: enabled.map((s) => s.id),
            description: "The id of the skill to load.",
          },
        },
        required: ["id"],
      },
    },
  };
}

/**
 * Returns a skill's full instruction text, fed back to the model as the load_skill tool result.
 * The instructions are prefixed with a "directory constraint" preamble: all file / command operations
 * a skill triggers remain confined to the current working directory.
 */
export function getSkillInstructions(enabled: InstalledSkill[], id: string): string {
  const s = enabled.find((x) => x.id === id);
  if (!s) return `Skill not enabled or does not exist: ${id} (please download and enable it first in the "Skills" panel).`;
  const toolNote =
    s.allowedTools && s.allowedTools.length
      ? `\n\nThis skill mainly uses these tools: ${s.allowedTools.join(", ")}.`
      : "";
  return (
    `[Skill: ${s.name} v${s.version}]\n` +
    "Constraint: all file reads/writes and command executions this skill triggers remain confined to the current \"working directory\"; accessing paths outside that directory is forbidden.\n\n" +
    s.instructions +
    toolNote
  );
}
