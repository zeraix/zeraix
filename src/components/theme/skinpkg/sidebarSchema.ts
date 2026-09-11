/**
 * `sidebar.json` in the renderer: the zod schema, and the pure helpers that turn a validated config
 * into what the sidebar draws.
 *
 * The twin of native/skin-engine/src/sidebar.rs. The engine validated the file at install time --
 * including that every image it names ships in the package, which only the installer can see -- and
 * this validates it again on read, because the installed directory is user-writable. Every other
 * rule matches: the ids come from the same registry (electron/skins/layoutRefs.mjs), icon values are
 * `icon:<name>` or an image under assets/, labels are 1-40 characters of plain text or a map keyed
 * by locale, controls and account-menu entries cannot be hidden, and only nav items have active
 * icons. Change one side, change both.
 *
 * No React here: test/skin-sidebar.test.mjs imports this file under plain Node.
 */
import { z } from "zod";
import {
  ICON_NAMES,
  NAV_ITEM_IDS,
  SIDEBAR_CONTROL_IDS,
  SIDEBAR_MENU_IDS,
  SIDEBAR_SECTION_IDS,
  type IconName,
} from "../../../../electron/skins/layoutRefs.mjs";

export const LABEL_MAX = 40;
export const LOCALES_MAX = 16;
export const LOGO_HEIGHT = Object.freeze({ min: 12, max: 40 });
export const ICON_PREFIX = "icon:";

export type IconSource = { kind: "asset"; path: string } | { kind: "icon"; name: IconName };

const ASSET_IMAGE = /^assets\/[A-Za-z0-9_\-./]+\.(?:png|jpe?g|webp|gif|svg)$/i;

/** An image inside the package's assets/ directory. Same charset as the primitives' asset paths. */
export const isAssetImagePath = (v: string) => v.length <= 200 && ASSET_IMAGE.test(v) && !v.includes("..") && !v.includes("//");

/** `icon:<built-in name>` or an asset image path; anything else is no icon at all -- never a URL. */
export function parseIconValue(v: unknown): IconSource | null {
  if (typeof v !== "string") return null;
  if (v.startsWith(ICON_PREFIX)) {
    const name = v.slice(ICON_PREFIX.length);
    return (ICON_NAMES as readonly string[]).includes(name) ? { kind: "icon", name: name as IconName } : null;
  }
  return isAssetImagePath(v) ? { kind: "asset", path: v } : null;
}

const iconValue = z.string().max(200).refine((v) => parseIconValue(v) !== null, { message: "must be icon:<name> or an image under assets/" });
const imageValue = z.string().max(200).refine(isAssetImagePath, { message: "must be a png, jpg, webp, gif or svg under assets/" });

/** C0 and C1 control characters, as Rust's char::is_control counts them. */
const hasControl = (s: string) =>
  [...s].some((c) => {
    const n = c.codePointAt(0) ?? 0;
    return n < 0x20 || (n >= 0x7f && n <= 0x9f);
  });

const labelText = z.string().refine(
  (s) => {
    const t = s.trim();
    return t.length > 0 && [...t].length <= LABEL_MAX && !hasControl(s);
  },
  { message: `a label is 1-${LABEL_MAX} characters of plain text` },
);

const LOCALE_KEY = /^(?:default|[a-z]{2}(?:-[A-Z]{2})?)$/;

/**
 * A map keyed by names, with every RAW key checked before zod's record transform: JSON.parse gives
 * `{"__proto__": ...}` an own key, but copying it into a fresh object assigns the prototype instead,
 * so a refinement on the parsed record would never see it.
 */
function keyed<T extends z.ZodType>(allowed: readonly string[] | RegExp, value: T, max: number, what: string) {
  return z
    .any()
    .superRefine((raw, ctx) => {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        ctx.addIssue({ code: "custom", message: `${what} must be an object` });
        return;
      }
      const keys = Object.keys(raw as object);
      if (keys.length > max) ctx.addIssue({ code: "custom", message: `more than ${max} ${what} entries` });
      for (const k of keys) {
        const ok = allowed instanceof RegExp ? allowed.test(k) : allowed.includes(k);
        if (!ok) ctx.addIssue({ code: "custom", message: `unknown ${what} "${k}"`, path: [k] });
      }
    })
    .pipe(z.record(z.string(), value));
}

const localizedLabel = keyed(LOCALE_KEY, labelText, LOCALES_MAX, "locale").refine((m) => Object.keys(m).length > 0, {
  message: "a localized label needs at least one entry",
});

export const labelSchema = z.union([labelText, localizedLabel]);
export type Label = z.infer<typeof labelSchema>;

export const slotItemSchema = z
  .object({
    icon: iconValue.optional(),
    activeIcon: iconValue.optional(),
    iconDark: iconValue.optional(),
    activeIconDark: iconValue.optional(),
    label: labelSchema.optional(),
    hidden: z.boolean().optional(),
  })
  .strict();
export type SlotItem = z.infer<typeof slotItemSchema>;

const brandSchema = z
  .object({
    logo: imageValue.optional(),
    logoDark: imageValue.optional(),
    mark: imageValue.optional(),
    markDark: imageValue.optional(),
    height: z.number().min(LOGO_HEIGHT.min).max(LOGO_HEIGHT.max).optional(),
    hidden: z.boolean().optional(),
  })
  .strict();

const navSchema = z
  .object({
    order: z
      .array(z.enum(NAV_ITEM_IDS))
      .max(NAV_ITEM_IDS.length)
      .refine((a) => new Set(a).size === a.length, { message: "an id is listed twice" })
      .optional(),
    items: keyed(NAV_ITEM_IDS, slotItemSchema, NAV_ITEM_IDS.length, "nav item").optional(),
  })
  .strict();

const treeSchema = z.object({ folderIcon: iconValue.optional(), folderOpenIcon: iconValue.optional() }).strict();

export const sidebarConfigSchema = z
  .object({
    version: z.number().int().min(1).optional(),
    brand: brandSchema.optional(),
    nav: navSchema.optional(),
    sections: keyed(SIDEBAR_SECTION_IDS, slotItemSchema, SIDEBAR_SECTION_IDS.length, "section").optional(),
    tree: treeSchema.optional(),
    controls: keyed(SIDEBAR_CONTROL_IDS, slotItemSchema, SIDEBAR_CONTROL_IDS.length, "control").optional(),
    menu: keyed(SIDEBAR_MENU_IDS, slotItemSchema, SIDEBAR_MENU_IDS.length, "menu entry").optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    for (const group of ["controls", "menu"] as const) {
      for (const [id, item] of Object.entries(c[group] ?? {})) {
        if (item.hidden !== undefined) {
          ctx.addIssue({ code: "custom", path: [group, id, "hidden"], message: "only nav items and sections can be hidden" });
        }
      }
    }
    for (const group of ["sections", "controls", "menu"] as const) {
      for (const [id, item] of Object.entries(c[group] ?? {})) {
        if (item.activeIcon !== undefined || item.activeIconDark !== undefined) {
          ctx.addIssue({ code: "custom", path: [group, id, "activeIcon"], message: "only nav items have an active state" });
        }
      }
    }
  });
export type SidebarConfig = z.infer<typeof sidebarConfigSchema>;

export function parseSidebarConfig(text: string): { ok: true; config: SidebarConfig } | { ok: false; message: string } {
  try {
    const r = sidebarConfigSchema.safeParse(JSON.parse(text));
    if (r.success) return { ok: true, config: r.data };
    const issue = r.error.issues[0];
    return { ok: false, message: issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid" };
  } catch (e) {
    return { ok: false, message: String((e as Error)?.message ?? e) };
  }
}

/* ------------------------------------------------------------------- helpers */

export type SidebarGroup = "nav" | "sections" | "controls" | "menu";

export const groupItems = (c: SidebarConfig | null | undefined, group: SidebarGroup): Record<string, SlotItem> | undefined =>
  group === "nav" ? c?.nav?.items : c?.[group];

const own = <T>(map: Record<string, T> | undefined, key: string): T | undefined =>
  map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;

/** Look an item up by id without ever reaching Object.prototype. */
export const itemOf = (c: SidebarConfig | null | undefined, group: SidebarGroup, id: string) => own(groupItems(c, group), id);

/**
 * The icon to draw. Active + dark: activeIconDark, activeIcon, iconDark, icon. Active: activeIcon,
 * icon. Dark: iconDark, icon. An unparsable value is skipped, never drawn.
 */
export function pickIcon(item: SlotItem | undefined, { active = false, dark = false }: { active?: boolean; dark?: boolean } = {}): IconSource | null {
  if (!item) return null;
  const chain = active
    ? dark
      ? [item.activeIconDark, item.activeIcon, item.iconDark, item.icon]
      : [item.activeIcon, item.icon]
    : dark
      ? [item.iconDark, item.icon]
      : [item.icon];
  for (const v of chain) {
    const source = parseIconValue(v);
    if (source) return source;
  }
  return null;
}

/** The label for this locale: exact (`zh-TW`), then language (`zh`), then `default`. Null means "keep the app's own". */
export function pickLabel(label: Label | undefined, locale: string): string | null {
  if (label === undefined) return null;
  if (typeof label === "string") return label.trim();
  const value = own(label, locale) ?? own(label, locale.split("-")[0]) ?? own(label, "default");
  return value === undefined ? null : value.trim();
}

/** Nav items in the package's order (listed ids first, the rest in the built-in order), hidden ones removed. */
export function arrangeNav<T extends { id: string }>(items: readonly T[], config: SidebarConfig | null | undefined): T[] {
  const nav = config?.nav;
  if (!nav) return [...items];
  const order = (nav.order ?? []) as readonly string[];
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i >= 0 ? i : order.length + items.findIndex((x) => x.id === id);
  };
  return items.filter((it) => own(nav.items, it.id)?.hidden !== true).sort((a, b) => rank(a.id) - rank(b.id));
}

/** Brand image paths for this colour mode; the dark variants fall back to the light ones. */
export function brandOf(config: SidebarConfig | null | undefined, dark: boolean) {
  const b = config?.brand;
  return {
    logo: (dark ? (b?.logoDark ?? b?.logo) : b?.logo) ?? null,
    mark: (dark ? (b?.markDark ?? b?.mark) : b?.mark) ?? null,
    height: b?.height ?? null,
    hidden: b?.hidden === true,
  };
}

/** The folder icon for a project row; the open icon falls back to the closed one. */
export function treeIcon(config: SidebarConfig | null | undefined, expanded: boolean): IconSource | null {
  const t = config?.tree;
  return parseIconValue(expanded ? (t?.folderOpenIcon ?? t?.folderIcon) : t?.folderIcon);
}

/**
 * The URL of a package image, served by the skin:// protocol from that package's own folder. The
 * explicit id (not `current`) keeps a switch in progress from showing one package's config with
 * another's files; the generation busts the cache after a reinstall.
 */
export const skinAssetUrl = (skinId: string, path: string, generation: number) => `skin://${skinId}/${path}?g=${generation}`;
