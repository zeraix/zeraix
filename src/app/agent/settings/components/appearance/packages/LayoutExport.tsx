"use client";

/**
 * The layout reference and the "export for manual editing" step of Stage 8 -- the visual
 * drag-and-drop editor is left for a later iteration, as the prompt set allows. What ships: the
 * regions a package may fill, every app component and primitive it may place (from the same
 * registries the renderer uses, so the list cannot drift), and two buttons that save a starter
 * layout.json and an example components.json to edit by hand and zip into a package.
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, FileJson } from "lucide-react";
import type { TFunc } from "@/lib/i18n";
import { Toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { skinAPI } from "@/lib/electron/skinpkg";
import { packageErrorToast } from "@/components/theme/skinpkg";
import {
  LAYOUT_REGIONS,
  NAV_ITEM_IDS,
  SIDEBAR_CONTROL_IDS,
  SIDEBAR_MENU_IDS,
  SIDEBAR_SECTION_IDS,
} from "../../../../../../../electron/skins/layoutRefs.mjs";
import { APP_COMPONENT_LIST } from "@/components/theme/layout/registry";
import { PRIMITIVE_LIST } from "@/components/theme/primitives";

const SECONDARY =
  "flex shrink-0 items-center gap-1 rounded-md border border-line-strong bg-surface px-2.5 py-1 text-xs font-medium text-ink transition hover:bg-surface-muted";

/** A layout that shows one of everything, so the exported file is a worked example rather than a blank. */
export const STARTER_LAYOUT = {
  version: 1,
  regions: {
    greeting: {
      type: "container",
      direction: "column",
      align: "center",
      gap: 12,
      children: [
        { type: "component", ref: "app:brandMark", props: { size: 56 } },
        { type: "component", ref: "app:greetingTitle", props: { size: "lg" } },
        { type: "component", ref: "app:greetingHint" },
        { type: "component", ref: "primitive:badge", props: { text: "Custom layout", variant: "primary" }, visibleWhen: "state.toolsReady === true" },
        { type: "component", ref: "custom:energyCard", props: { title: "Focus", value: 72 }, size: { width: "240px" } },
      ],
    },
    sidebarFooter: {
      type: "container",
      direction: "row",
      align: "center",
      justify: "space-between",
      gap: 8,
      children: [
        { type: "component", ref: "app:today", props: { format: "medium" } },
        { type: "component", ref: "app:appVersion" },
      ],
    },
  },
};

export const STARTER_COMPONENTS = {
  energyCard: {
    params: ["title", "value"],
    template: {
      type: "component",
      ref: "primitive:box",
      props: { padding: 12, borderRadius: 14, background: "var(--surface)", borderWidth: 1, borderColor: "var(--line)", shadow: "sm" },
      children: [
        {
          type: "container",
          direction: "row",
          align: "center",
          gap: 10,
          children: [
            { type: "component", ref: "primitive:icon", props: { name: "zap", size: 20, color: "var(--primary)" } },
            {
              type: "container",
              direction: "column",
              gap: 4,
              children: [
                { type: "component", ref: "primitive:text", props: { content: "{{title}}", fontSize: 13, fontWeight: 600 } },
                { type: "component", ref: "primitive:progressBar", props: { value: "{{value}}", thickness: 6 }, size: { width: "140px" } },
              ],
            },
          ],
        },
      ],
    },
  },
};

/** A sidebar.json using only built-in icons, so it installs as-is before any image is added to the package. */
export const STARTER_SIDEBAR = {
  version: 1,
  brand: { height: 18 },
  nav: {
    order: ["new-chat", "library", "skills", "automation", "models", "plugins"],
    items: {
      "new-chat": { icon: "icon:message-square", activeIcon: "icon:sparkles", label: { default: "Chat", zh: "对话" } },
      library: { icon: "icon:image", activeIcon: "icon:image" },
      plugins: { hidden: false },
    },
  },
  sections: { projects: { label: { default: "Workspaces", zh: "工作区" } } },
  tree: { folderIcon: "icon:folder", folderOpenIcon: "icon:layers" },
  controls: { userMenu: { icon: "icon:settings" } },
  menu: { settings: { icon: "icon:palette", label: { default: "Preferences" } } },
};

/** Every sidebar key a package may set, for the reference column. */
const SIDEBAR_SLOTS = [
  { key: "brand", desc: "logo, logoDark, mark, markDark, height, hidden" },
  { key: "nav.order", desc: "" },
  ...NAV_ITEM_IDS.map((id) => ({ key: `nav.items.${id}`, desc: "" })),
  ...SIDEBAR_SECTION_IDS.map((id) => ({ key: `sections.${id}`, desc: "" })),
  { key: "tree", desc: "folderIcon, folderOpenIcon" },
  ...SIDEBAR_CONTROL_IDS.map((id) => ({ key: `controls.${id}`, desc: "" })),
  ...SIDEBAR_MENU_IDS.map((id) => ({ key: `menu.${id}`, desc: "" })),
];

export function LayoutExport({ t }: { t: TFunc }) {
  const [open, setOpen] = useState(false);
  const api = skinAPI();

  const save = async (defaultName: string, value: unknown) => {
    if (!api) return;
    const r = await api.exportText({ defaultName, text: `${JSON.stringify(value, null, 2)}\n` });
    if (r.ok) Toast.success(t("skinpkg.layout.saved"), r.path);
    else if (!r.canceled) {
      const { title, detail } = packageErrorToast(t, r.error);
      Toast.error(title, detail);
    }
  };

  return (
    <div className="rounded-xl border border-line bg-surface-muted/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium text-ink"
      >
        {open ? <ChevronDown className="size-4 text-ink-muted" /> : <ChevronRight className="size-4 text-ink-muted" />}
        {t("skinpkg.layout.title")}
      </button>
      {open ? (
        <div className="space-y-4 border-t border-line px-4 py-3.5">
          <p className="text-xs text-ink-subtle">{t("skinpkg.layout.desc")}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Column title={t("skinpkg.layout.regions")} items={LAYOUT_REGIONS.map((r) => ({ key: r, desc: "" }))} />
            <Column title={t("skinpkg.layout.appComponents")} items={APP_COMPONENT_LIST.map((c) => ({ key: `app:${c.key}`, desc: c.description }))} />
            <Column title={t("skinpkg.layout.primitives")} items={PRIMITIVE_LIST.map((p) => ({ key: `primitive:${p.key}`, desc: p.description }))} />
            <Column title={t("skinpkg.layout.sidebar")} items={SIDEBAR_SLOTS} />
          </div>
          {api ? (
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void save("layout.json", STARTER_LAYOUT)} className={cn(SECONDARY)}>
                <FileJson className="size-3.5" />
                {t("skinpkg.layout.export")}
              </button>
              <button type="button" onClick={() => void save("components.json", STARTER_COMPONENTS)} className={cn(SECONDARY, "border-transparent text-ink-muted")}>
                <FileJson className="size-3.5" />
                {t("skinpkg.layout.exportComponents")}
              </button>
              <button type="button" onClick={() => void save("sidebar.json", STARTER_SIDEBAR)} className={cn(SECONDARY, "border-transparent text-ink-muted")}>
                <FileJson className="size-3.5" />
                {t("skinpkg.layout.exportSidebar")}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Column({ title, items }: { title: string; items: { key: string; desc: string }[] }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-ink-muted">{title}</p>
      <ul className="space-y-1">
        {items.map((it) => (
          <li key={it.key} className="text-xs">
            <code className="rounded bg-surface-hover px-1 py-px font-mono text-[11px] text-ink">{it.key}</code>
            {it.desc ? <span className="ml-1.5 text-ink-subtle">{it.desc}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
