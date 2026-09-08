import { Boxes, Brain, Info, KeyRound, Plug, ScrollText, SlidersHorizontal, User, Volume2 } from "lucide-react";


export type SectionId = "account" | "models" | "keys" | "mcp" | "memory" | "notify" | "logs" | "general" | "about";

export interface NavItem {
  id: SectionId;
  labelKey: string;
  icon: typeof User;
}

/**
 * The nav, in groups.
 *
 * Nine flat entries gave no clue which of them was the one you wanted -- "Keys" and "MCP" and
 * "Memory" all read as peers of "About". The groups say what each section is *for*: who you are and
 * how the app behaves, what the agent can do, and the machinery underneath.
 *
 * Order within a group is deliberate (the thing people came for first); the group order is the order
 * of the list below.
 */
export const NAV_GROUPS: { labelKey: string; items: NavItem[] }[] = [
  {
    labelKey: "settings.group.basic",
    items: [
      { id: "account", labelKey: "settings.account", icon: User },
      { id: "general", labelKey: "settings.general", icon: SlidersHorizontal },
      { id: "notify", labelKey: "settings.notify", icon: Volume2 },
    ],
  },
  {
    labelKey: "settings.group.agent",
    items: [
      { id: "models", labelKey: "settings.models", icon: Boxes },
      { id: "keys", labelKey: "settings.keys", icon: KeyRound },
      { id: "mcp", labelKey: "settings.mcp", icon: Plug },
      { id: "memory", labelKey: "settings.memory", icon: Brain },
    ],
  },
  {
    labelKey: "settings.group.system",
    items: [
      { id: "logs", labelKey: "settings.logs", icon: ScrollText },
      { id: "about", labelKey: "settings.about", icon: Info },
    ],
  },
];

/** Flattened, for anything that only cares about the sections themselves (deep links, search). */
export const NAV: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** The i18n keys each section contributes to search (title + description + fields), matched by substring after translation. */
export const SECTION_KEYS: Record<SectionId, string[]> = {
  account: [
    "settings.account",
    "account.info",
    "account.manage",
    "account.privacy",
    "account.privacyDesc",
    "account.logout",
    "account.upgrade",
    "account.upgradeDesc",
    "plan.free",
  ],
  models: [
    "settings.models",
    "models.desc",
    "models.added",
    "models.addOfficial",
    "models.addCustom",
    "models.provider",
    "models.model",
    "models.default",
    "models.empty",
    "models.apiFormat",
    "models.apiFormatOpenAI",
    "models.apiFormatResponses",
    "models.customUrl",
    "models.fullUrl",
    "models.modelId",
    "models.multimodal",
    "models.apiKey",
    "models.official",
    "models.officialNote",
  ],
  keys: [
    "settings.keys",
    "keys.desc",
    "keys.empty",
    "keys.forProvider",
    "keys.placeholder",
    "keys.official",
    "keys.officialDesc",
    "keys.localTitle",
    "keys.generate",
    "keys.regenerate",
  ],
  mcp: [
    "settings.mcp",
    "mcp.desc",
    "mcp.add",
    "mcp.import",
    "mcp.openConfig",
    "mcp.typeStdio",
    "mcp.typeHttp",
    "mcp.command",
    "mcp.url",
    "mcp.env",
    "mcp.headers",
    "mcp.tools",
    "mcp.approveTitle",
  ],
  memory: [
    "settings.memory",
    "memory.desc",
    "memory.items",
    "memory.empty",
    "memory.openDir",
    "memory.create",
    "memory.import",
    "memory.template",
    "memory.export",
    "projmem.title",
    "projmem.desc",
    "projmem.rebuild",
  ],
  general: [
    "settings.general",
    "general.storage",
    "general.storageDesc",
    "general.migrateNote",
    "general.contextBudget",
    "general.contextBudgetDesc",
    "general.appConfig",
    "general.appConfigDesc",
    "general.appConfigOpen",
    "general.background",
    "general.backgroundDesc",
    "general.backgroundEnable",
    "general.backgroundAutostart",
  ],
  notify: [
    "settings.notify",
    "notify.desc",
    "notify.roundComplete",
    "notify.roundCompleteDesc",
    "notify.mode.never",
    "notify.mode.unfocused",
    "notify.mode.always",
    "notify.permission",
    "notify.permissionDesc",
    "notify.question",
    "notify.questionDesc",
    "notify.remindersTitle",
    "notify.soundsTitle",
    "notify.master",
    "notify.masterDesc",
    "notify.volume",
    "notify.typeInfo",
    "notify.typeSuccess",
    "notify.typeWarning",
    "notify.typeError",
    "notify.preview",
    "notify.upload",
    "notify.custom",
    "notify.builtin",
    "notify.reset",
    "notify.unsupported",
  ],
  logs: [
    "settings.logs",
    "logs.desc",
    "logs.enable",
    "logs.enableDesc",
    "logs.viewList",
    "logs.viewTimeline",
    "logs.totalTokens",
    "logs.modelCalls",
    "logs.toolCalls",
    "logs.subagentRuns",
    "logs.byModel",
    "logs.byActor",
    "logs.byTool",
    "logs.openDir",
    "logs.clearDay",
  ],
  about: [
    "settings.about",
    "about.title",
    "about.desc",
    "about.version",
    "about.updates",
    "about.check",
    "about.upToDate",
    "about.unsupported",
    "about.links",
    "about.github",
    "about.githubDesc",
  ],
};

/** Normalized substring matcher: an empty query always matches. */
export function makeMatcher(query: string) {
  const q = query.trim().toLowerCase();
  return (...texts: string[]) => q === "" || texts.some((t) => t.toLowerCase().includes(q));
}
