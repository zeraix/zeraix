"use client";

/**
 * The sidebar as the active skin package redraws it: sidebar.json read through the shared
 * active-package store, validated (sidebarSchema.ts), and turned into hooks and components the
 * sidebar, the shell and the logo hook call.
 *
 * Every piece here takes the built-in look as its fallback and renders exactly that until a package
 * says otherwise -- including during hydration, when the store's server snapshot is empty. Nothing a
 * package supplies becomes markup: labels are text children, icons are either a component from the
 * built-in icon map or an <img> of a file the engine checked is in the package.
 */
import type React from "react";
import { useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useTheme } from "next-themes";
import { useLocaleStore } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ICONS } from "../primitives/icons";
import { createActivePackageStore } from "./packageFiles";
import {
  arrangeNav,
  brandOf,
  itemOf,
  parseSidebarConfig,
  pickIcon,
  pickLabel,
  skinAssetUrl,
  treeIcon,
  type IconSource,
  type SidebarConfig,
  type SidebarGroup,
} from "./sidebarSchema";

const store = createActivePackageStore<SidebarConfig | null>({
  name: "sidebar",
  files: ["sidebar.json"],
  empty: null,
  parse(skinId, texts) {
    const text = texts["sidebar.json"] ?? null;
    if (text === null) return null;
    const r = parseSidebarConfig(text);
    if (r.ok) return r.config;
    console.warn(`[sidebar] ${skinId}: ${r.message}`);
    return null;
  },
});

/** `{ skinId, generation, value: config | null }` for the active package. */
export const useSkinSidebar = () => store.useSnapshot();

const useDark = () => useTheme().resolvedTheme === "dark";

/** Draw an icon source: a built-in icon (in the current text colour) or a package image; the fallback when there is none. */
export function SkinIcon({ source, className, fallback }: { source: IconSource | null; className?: string; fallback: React.ReactNode }) {
  const { skinId, generation } = useSkinSidebar();
  if (!source) return <>{fallback}</>;
  if (source.kind === "icon") {
    const Icon = ICONS[source.name];
    return <Icon className={className} aria-hidden />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={skinAssetUrl(skinId, source.path, generation)}
      alt=""
      aria-hidden
      draggable={false}
      className={cn("shrink-0 select-none object-contain", className ?? "size-4")}
    />
  );
}

/** The icon of one sidebar thing (a control, a menu entry, a section), or its built-in icon. */
export function SkinSlotIcon({
  group,
  id,
  active = false,
  className,
  fallback,
}: {
  group: SidebarGroup;
  id: string;
  active?: boolean;
  className?: string;
  fallback: React.ReactNode;
}) {
  const { value: config } = useSkinSidebar();
  const dark = useDark();
  return <SkinIcon source={pickIcon(itemOf(config, group, id), { active, dark })} className={className} fallback={fallback} />;
}

/** `(group, id, builtInLabel) => label`: the package's label for this UI language, else the built-in one. */
export function useSkinLabel(): (group: SidebarGroup, id: string, fallback: string) => string {
  const { value: config } = useSkinSidebar();
  const locale = useLocaleStore((s) => s.locale);
  return (group, id, fallback) => pickLabel(itemOf(config, group, id)?.label, locale) || fallback;
}

/** The nav items in the package's order, hidden ones removed. Returns the app's own item objects. */
export function useSkinNav<T extends { id: string }>(items: readonly T[]): T[] {
  const { value: config } = useSkinSidebar();
  return useMemo(() => arrangeNav(items, config), [items, config]);
}

export function useSkinSectionHidden(id: string): boolean {
  const { value: config } = useSkinSidebar();
  return itemOf(config, "sections", id)?.hidden === true;
}

/** Brand image URLs for this colour mode (null keeps the built-in image), the wordmark height, and whether it is hidden. */
export function useSkinBrand(dark: boolean): { logo: string | null; mark: string | null; height: number | null; hidden: boolean } {
  const { skinId, generation, value: config } = useSkinSidebar();
  const b = brandOf(config, dark);
  return {
    logo: b.logo ? skinAssetUrl(skinId, b.logo, generation) : null,
    mark: b.mark ? skinAssetUrl(skinId, b.mark, generation) : null,
    height: b.height,
    hidden: b.hidden,
  };
}

/** A project row's folder icon. */
export function SkinTreeIcon({ expanded, className, fallback }: { expanded: boolean; className?: string; fallback: React.ReactNode }) {
  const { value: config } = useSkinSidebar();
  return <SkinIcon source={treeIcon(config, expanded)} className={className} fallback={fallback} />;
}

const FADE = {
  initial: { opacity: 0, scale: 0.7 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.7 },
  transition: { duration: 0.15 },
} as const;

/**
 * A nav item's icon, cross-fading between selected / unselected -- and between the built-in image
 * and a package's own icon when the skin changes. `defaultSrc` is the built-in image for this state.
 */
export function SkinNavIcon({ id, active, dark, defaultSrc }: { id: string; active: boolean; dark: boolean; defaultSrc: string }) {
  const { skinId, generation, value: config } = useSkinSidebar();
  const source = pickIcon(itemOf(config, "nav", id), { active, dark });
  const key = `${active ? "on" : "off"}-${dark ? "d" : "l"}-${source ? (source.kind === "icon" ? source.name : `${skinId}/${source.path}#${generation}`) : "builtin"}`;
  const Icon = source?.kind === "icon" ? ICONS[source.name] : null;
  return (
    <span className="relative size-[18px] shrink-0">
      <AnimatePresence initial={false}>
        {Icon ? (
          <motion.span key={key} {...FADE} className="absolute inset-0 flex items-center justify-center">
            <Icon className={cn("size-[18px]", active && "text-primary")} aria-hidden />
          </motion.span>
        ) : (
          <motion.img
            key={key}
            src={source?.kind === "asset" ? skinAssetUrl(skinId, source.path, generation) : defaultSrc}
            alt=""
            aria-hidden
            draggable={false}
            {...FADE}
            className="absolute inset-0 size-[18px] object-contain"
          />
        )}
      </AnimatePresence>
    </span>
  );
}
