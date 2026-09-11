"use client";

/**
 * Appearance: theme mode, skins, accent colour, text size, and the skin store.
 *
 * This file is the layout and the flow between the pieces; each piece lives in ./appearance. Every control writes
 * through useAppearance, which paints on the same frame and hands the change to the main process ([ui] in app.config,
 * broadcast to every window). Skins themselves live in the main process's skin store (electron/skins/store.mjs).
 */
import { useState, useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Check, Droplet, Monitor, Moon, Package, Palette, Store, Sun, SunMoon, Type } from "lucide-react";
import { type TFunc } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useAppearance } from "@/components/theme/ThemeProvider";
import { isAppearanceSynced } from "@/components/theme/appearance";
import { applyThemeWithTransition } from "@/components/theme/theme-transition";
import { ACCENTS, type ThemeMode } from "@/components/theme/theme-config";
import { findSkin, useInstalledSkins, type Skin } from "@/components/theme/skins";
import { Switch } from "@/components/ui/switch";
import { Group, LIST, NOTE, PANEL, Pane, Row } from "./pane";
import { FontSizeControl } from "./appearance/FontSizeControl";
import { Segmented } from "./appearance/Segmented";
import { SkinEditor } from "./appearance/SkinEditor";
import { SkinGallery } from "./appearance/SkinGallery";
import { SkinStoreActions, SkinStoreList } from "./appearance/SkinStore";
import { LayoutExport } from "./appearance/packages/LayoutExport";
import { PackageGallery } from "./appearance/packages/PackageGallery";
import { PackageAvailabilityNote, PackageImportActions } from "./appearance/packages/PackageImport";

const noopSubscribe = () => () => {};

export function AppearanceSection({ t }: { t: TFunc }) {
  const { appearance, setAppearance } = useAppearance();
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const installed = useInstalledSkins();
  // Server snapshot claims "synced" so the web-only note never flashes into the desktop app on hydration.
  const synced = useSyncExternalStore(noopSubscribe, isAppearanceSynced, () => true);
  // One editor session at a time; `session` remounts the editor so nothing carries over between opens.
  const [editor, setEditor] = useState<{ session: number; skin: Skin | null; base: Skin | null } | null>(null);

  const activeSkin = findSkin(appearance.skin, installed);
  const skinSetsAccent = !!activeSkin && !!(activeSkin.light.primary || activeSkin.dark.primary);

  /** Circular reveal when light/dark actually flips; a plain switch when it would not (dark -> system on a dark OS). */
  const changeTheme = (key: ThemeMode, el: HTMLElement) => {
    if (key === appearance.theme) return;
    const targetDark = key === "dark" || (key === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    if ((resolvedTheme === "dark") === targetDark) {
      setAppearance({ theme: key });
      return;
    }
    const r = el.getBoundingClientRect();
    applyThemeWithTransition(targetDark, () => setAppearance({ theme: key }), {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
    });
  };

  return (
    <Pane title={t("settings.appearance")} desc={t("appearance.desc")}>
      {!synced ? <p className={NOTE}>{t("appearance.localOnly")}</p> : null}

      <Group title={t("appearance.theme")} desc={t("appearance.themeDesc")} icon={SunMoon} anchor="appearance/theme">
        <div className={PANEL}>
          <Segmented
            label={t("appearance.theme")}
            value={appearance.theme}
            options={[
              { key: "light", label: t("appearance.theme.light"), icon: Sun },
              { key: "dark", label: t("appearance.theme.dark"), icon: Moon },
              { key: "system", label: t("appearance.theme.system"), icon: Monitor },
            ]}
            onChange={changeTheme}
          />
        </div>
      </Group>

      <Group title={t("appearance.skins")} desc={t("appearance.skinsDesc")} icon={Palette} anchor="appearance/skins">
        <SkinGallery t={t} onEdit={(skin) => setEditor({ session: Date.now(), skin, base: null })} />
        <div className={cn(LIST, "mt-3")}>
          <Row title={t("appearance.skinOnChat")} desc={t("appearance.skinOnChatDesc")}>
            <Switch
              checked={appearance.skinOnChat}
              onCheckedChange={(v) => setAppearance({ skinOnChat: v })}
              aria-label={t("appearance.skinOnChat")}
            />
          </Row>
          <Row title={t("appearance.motion")} desc={t("appearance.motionDesc")}>
            <Switch
              checked={appearance.skinMotion}
              onCheckedChange={(v) => setAppearance({ skinMotion: v })}
              aria-label={t("appearance.motion")}
            />
          </Row>
        </div>
      </Group>

      {/* Skin packages (v2): Rust-validated .skinpkg archives and built-in presets. One skin at a time across
          this group and the one above -- ThemeProvider's SkinPackageSync resets the other when either changes. */}
      <Group
        title={t("skinpkg.title")}
        desc={t("skinpkg.desc")}
        icon={Package}
        anchor="appearance/packages"
        actions={<PackageImportActions t={t} />}
      >
        <div className="space-y-3">
          <PackageAvailabilityNote t={t} />
          <PackageGallery t={t} />
          <LayoutExport t={t} />
        </div>
      </Group>

      <Group title={t("appearance.accent")} desc={t("appearance.accentDesc")} icon={Droplet} anchor="appearance/accent">
        <div
          role="radiogroup"
          aria-label={t("appearance.accent")}
          aria-disabled={skinSetsAccent}
          className={cn(PANEL, "flex flex-wrap items-center gap-3", skinSetsAccent && "opacity-40")}
        >
          {ACCENTS.map((a) => {
            const on = a.key === appearance.accent;
            const name = t(`appearance.accentName.${a.key}`);
            return (
              <button
                key={a.key}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={name}
                title={name}
                disabled={skinSetsAccent}
                onClick={() => setAppearance({ accent: a.key })}
                className={cn(
                  "flex size-8 items-center justify-center rounded-full ring-offset-2 ring-offset-surface transition disabled:cursor-not-allowed",
                  on ? "ring-2 ring-ink" : "hover:scale-105",
                )}
                style={{ background: dark ? a.swatchDark : a.swatch }}
              >
                {/* Dark swatches are light and vice versa, so the tick inverts with the theme. */}
                {on ? <Check className="size-4" style={{ color: dark ? "#10131a" : "#ffffff" }} /> : null}
              </button>
            );
          })}
        </div>
        {skinSetsAccent ? <p className="mt-2 text-xs text-ink-subtle">{t("appearance.accentLocked")}</p> : null}
      </Group>

      <Group title={t("appearance.fontSize")} desc={t("appearance.fontSizeDesc")} icon={Type} anchor="appearance/font-size">
        <FontSizeControl t={t} />
      </Group>

      <Group
        title={t("appearance.store")}
        desc={t("appearance.storeDesc")}
        icon={Store}
        anchor="appearance/store"
        actions={<SkinStoreActions t={t} onCreate={() => setEditor({ session: Date.now(), skin: null, base: activeSkin })} />}
      >
        <SkinStoreList t={t} />
      </Group>

      {editor ? (
        <SkinEditor
          key={editor.session}
          t={t}
          skin={editor.skin}
          base={editor.base}
          onClose={() => setEditor(null)}
          onSaved={(saved) => {
            setEditor(null);
            setAppearance({ skin: saved.id });
          }}
        />
      ) : null}
    </Pane>
  );
}
