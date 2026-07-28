/**
 * Runtime wiring of skills within a conversation: exposes enabled skills to the main model and
 * implements progressive disclosure.
 *
 * The skill catalog used to live in the load_skill tool's description and in its `id` enum. That made the tool block differ between
 * installs — and between working directories, since project skills are discovered from the folder — which breaks the prefix on
 * templates that render tools ahead of the system prompt. The declaration below is now identical everywhere, and the catalog is
 * announced as a change event in the conversation instead. See docs/cache-stable-prompt-context.md.
 */
import type { InstalledSkill } from "./types";

/**
 * A sentence in the system prompt telling the model that skills exist and where to find the current list.
 *
 * Unconditional on purpose: making it depend on whether any skill happens to be enabled would make messages[0] differ per install.
 * It points at the reminder rather than asserting that skills are present, so it stays true when the list is empty.
 */
export function skillSystemHint(): string {
  return (
    "You may additionally be equipped with \"skills\". Whenever any are available, they are listed for you in a system-reminder in " +
    "the conversation, with an id and a description for each. When a task matches one, call load_skill with that id to obtain its " +
    "full instructions and act on them; do not guess at a skill's contents. If no such list has appeared, you have no skills available."
  );
}

/**
 * Build the load_skill tool declaration.
 *
 * Byte-identical across installs: no menu in the description, and no `enum` of ids in the parameters (llama.cpp re-serialises tool
 * `parameters` through an order-preserving JSON parser, so an enum of install-specific ids would reach the prefix bytes). Declared
 * unconditionally, including when nothing is enabled — a call with an unknown id already returns a clear "not enabled" result.
 */
export function loadSkillTool() {
  return {
    type: "function" as const,
    function: {
      name: "load_skill",
      description:
        "Load a skill's full operating instructions, then perform that kind of task under its guidance. " +
        "The skills currently available to you are listed in a system-reminder in the conversation; pass one of their ids.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The id of the skill to load, exactly as given in the available-skills list.",
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
