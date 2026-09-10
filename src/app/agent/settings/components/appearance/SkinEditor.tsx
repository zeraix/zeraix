"use client";

/**
 * Create or edit a custom skin: the form on the left, the skin drawn live on the right.
 *
 * State is one draft skin. Colours are edited as six key colours per mode and the full palette is derived from them --
 * but only for a mode the person actually touched, so opening an imported, hand-tuned skin just to rename it does not
 * quietly re-derive (and flatten) its palette.
 *
 * Pictures go to the main process as drafts the moment they are picked (electron/skins/store.mjs). The draft holds
 * their draft addresses; Save promotes them; every other way out -- Cancel, the close button, Escape, clicking outside
 * -- discards them. The parent remounts this per session (a fresh `key`), so no state carries between opens.
 */
import { useState } from "react";
import { useTheme } from "next-themes";
import { Loader2, Moon, Sun } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { TFunc } from "@/lib/i18n";
import { Toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { skinsBridge } from "@/lib/electron/skins";
import {
  CORNER_FRAMES,
  DETAIL_OPTIONS,
  FONT_KEYS,
  IMAGE_SLOTS,
  LIMITS,
  MOTION_KEYS,
  PATTERN_KEYS,
  deriveTokens,
  keyColorsOf,
  newCustomSkinId,
  type CornerFrame,
  type FontKey,
  type ImageSlot,
  type KeyColors,
  type MotionKey,
  type PatternKey,
  type Skin,
  type SkinDecor,
  type SkinDetails,
} from "@/components/theme/skins";
import { FIELD_CLS } from "../styles";
import { Segmented } from "./Segmented";
import { SkinPreview } from "./SkinPreview";
import { skinError } from "./skinErrors";
import { ChoiceSelect, ColorGrid, EditorSection, Field, ImageField, RangeField, ToggleRow } from "./SkinEditorFields";

type Mode = "light" | "dark";
type Art = Exclude<PatternKey, "none">;
type Face = Exclude<FontKey, "system">;
type Motion = Exclude<MotionKey, "none">;

/** Key colours for a brand-new skin with no base: the default warm-graphite palette. */
const FALLBACK_KEYS: Record<Mode, KeyColors> = {
  light: { background: "#f2f0ea", surface: "#fdfcfa", sidebar: "#ebe8e0", primary: "#1a1917", ink: "#171614", line: "#dcd7cc" },
  dark: { background: "#121215", surface: "#1a1a1e", sidebar: "#161619", primary: "#f0eeeb", ink: "#f0eeeb", line: "#303036" },
};

const DEFAULT_RADIUS = 14;
const DEFAULT_PATTERN_OPACITY = 0.15;
const DEFAULT_VEIL = 0.72;

function startDraft(skin: Skin | null, base: Skin | null): Skin {
  if (skin) return structuredClone(skin);
  return {
    id: newCustomSkinId(),
    builtin: false,
    origin: "custom",
    name: "",
    light: base ? { ...base.light } : deriveTokens(FALLBACK_KEYS.light),
    dark: base ? { ...base.dark } : deriveTokens(FALLBACK_KEYS.dark),
    radius: base?.radius ?? DEFAULT_RADIUS,
    fonts: base?.fonts ? { ...base.fonts } : undefined,
    // A base's pictures belong to the base: a new skin inherits its art and effects, never its images.
    decor: base?.decor ? { ...base.decor, images: undefined } : { glow: true },
    details: base?.details ? { ...base.details } : { ornament: "sparkles", buttons: "soft", fields: "outline", cards: "soft", headings: "ornament", nav: "pill" },
  };
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const SECONDARY =
  "rounded-md border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-surface-muted disabled:opacity-60";

export function SkinEditor({
  t,
  skin,
  base,
  onClose,
  onSaved,
}: {
  t: TFunc;
  skin: Skin | null;
  base: Skin | null;
  onClose: () => void;
  onSaved: (skin: Skin) => void;
}) {
  const { resolvedTheme } = useTheme();
  const [start] = useState(() => {
    const draft = startDraft(skin, base);
    return { draft, keys: { light: keyColorsOf(draft.light, FALLBACK_KEYS.light), dark: keyColorsOf(draft.dark, FALLBACK_KEYS.dark) } };
  });
  const [draft, setDraft] = useState<Skin>(start.draft);
  const [keys, setKeys] = useState<Record<Mode, KeyColors>>(start.keys);
  const [mode, setMode] = useState<Mode>(resolvedTheme === "dark" ? "dark" : "light");
  const [picking, setPicking] = useState<ImageSlot | null>(null);
  const [saving, setSaving] = useState(false);

  const decor: SkinDecor = draft.decor ?? {};
  const images = decor.images ?? {};
  const name = (draft.name ?? "").trim();

  const patchDecor = (p: Partial<SkinDecor>) => setDraft((d) => ({ ...d, decor: { ...(d.decor ?? {}), ...p } }));
  const details: SkinDetails = draft.details ?? {};
  const patchDetails = (p: Partial<SkinDetails>) => setDraft((d) => ({ ...d, details: { ...(d.details ?? {}), ...p } }));
  type DetailGroup = Exclude<keyof typeof DETAIL_OPTIONS, "ornament">;
  const detailOptions = <G extends DetailGroup>(group: G) =>
    (DETAIL_OPTIONS[group] as readonly NonNullable<SkinDetails[G]>[]).map((k) => ({ key: k, label: t(`appearance.detail.${group}.${k}`) }));
  const text = (field: "name" | "description" | "author") => (e: React.ChangeEvent<HTMLInputElement>) =>
    setDraft((d) => ({ ...d, [field]: e.target.value }));
  const greeting = (field: "title" | "subtitle") => (e: React.ChangeEvent<HTMLInputElement>) =>
    setDraft((d) => ({ ...d, greeting: { ...(d.greeting ?? {}), [field]: e.target.value || undefined } }));

  // Only the edited mode is re-derived; the other keeps whatever palette it came with.
  const setColor = (colorName: keyof KeyColors, hex: string) => {
    const next = { ...keys[mode], [colorName]: hex };
    setKeys({ ...keys, [mode]: next });
    setDraft((d) => ({ ...d, [mode]: deriveTokens(next) }));
  };

  const pick = async (slot: ImageSlot) => {
    const bridge = skinsBridge();
    if (!bridge) return;
    setPicking(slot);
    try {
      const r = await bridge.pickImage(draft.id, slot);
      if (r.ok) {
        setDraft((d) => ({ ...d, decor: { ...(d.decor ?? {}), images: { ...(d.decor?.images ?? {}), [slot]: r.url } } }));
      } else if (!r.canceled) {
        Toast.error(skinError(t, r.code));
      }
    } finally {
      setPicking(null);
    }
  };

  const unpick = (slot: ImageSlot) =>
    setDraft((d) => {
      const next = { ...(d.decor?.images ?? {}) };
      delete next[slot];
      return { ...d, decor: { ...(d.decor ?? {}), images: next } };
    });

  const dismiss = () => {
    if (saving) return;
    void skinsBridge()?.discardDrafts(draft.id);
    onClose();
  };

  const save = async () => {
    const bridge = skinsBridge();
    if (!bridge || !name || saving) return;
    setSaving(true);
    // An explicit whitelist: nothing the renderer merely carries (builtin, origin, i18n keys) is sent as if it were data.
    const { id, description, author, version, light, dark, radius, fonts, greeting: g } = draft;
    const r = await bridge.save({ id, name, description, author, version, light, dark, radius, fonts, decor, details, greeting: g });
    setSaving(false);
    if (r.ok) {
      Toast.success(t("appearance.editor.saved"), r.skin.name);
      onSaved(r.skin);
    } else {
      Toast.error(skinError(t, r.code));
    }
  };

  const fontOptions = FONT_KEYS.map((k) => ({ key: k, label: t(`appearance.font.${k}`) }));
  const artOptions = PATTERN_KEYS.map((k) => ({ key: k, label: t(`appearance.art.${k}`) }));
  const frameOptions = CORNER_FRAMES.map((k) => ({ key: k, label: t(`appearance.frame.${k}`) }));
  const setFont = (role: "display" | "body") => (k: FontKey) =>
    setDraft((d) => ({ ...d, fonts: { ...(d.fonts ?? {}), [role]: k === "system" ? undefined : (k as Face) } }));

  return (
    <Dialog open onOpenChange={(open) => !open && dismiss()}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
        <DialogHeader className="border-b border-line px-5 py-4 text-left">
          <DialogTitle>{skin ? t("appearance.editor.editTitle") : t("appearance.editor.createTitle")}</DialogTitle>
          <DialogDescription>{t("appearance.editor.desc")}</DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
          <div className="min-h-0 overflow-y-auto">
            <EditorSection title={t("appearance.editor.basics")}>
              <Field label={t("appearance.editor.name")}>
                <input
                  autoFocus
                  value={draft.name ?? ""}
                  maxLength={LIMITS.name}
                  placeholder={t("appearance.editor.namePlaceholder")}
                  onChange={text("name")}
                  className={cn(FIELD_CLS, "w-full")}
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t("appearance.editor.description")}>
                  <input value={draft.description ?? ""} maxLength={LIMITS.description} onChange={text("description")} className={cn(FIELD_CLS, "w-full")} />
                </Field>
                <Field label={t("appearance.editor.author")}>
                  <input value={draft.author ?? ""} maxLength={LIMITS.author} onChange={text("author")} className={cn(FIELD_CLS, "w-full")} />
                </Field>
              </div>
            </EditorSection>

            <EditorSection title={t("appearance.editor.colors")} desc={t("appearance.editor.colorsDesc")}>
              {/* One switch for both: it picks which mode's colours are edited AND which mode the preview shows. */}
              <Segmented
                label={t("appearance.editor.colors")}
                value={mode}
                options={[
                  { key: "light", label: t("appearance.theme.light"), icon: Sun },
                  { key: "dark", label: t("appearance.theme.dark"), icon: Moon },
                ]}
                onChange={(k) => setMode(k)}
                className="max-w-xs"
              />
              <ColorGrid t={t} colors={keys[mode]} onChange={setColor} />
            </EditorSection>

            <EditorSection title={t("appearance.editor.typography")}>
              <div className="grid gap-3 sm:grid-cols-2">
                <ChoiceSelect label={t("appearance.editor.displayFont")} value={draft.fonts?.display ?? "system"} options={fontOptions} onChange={setFont("display")} />
                <ChoiceSelect label={t("appearance.editor.bodyFont")} value={draft.fonts?.body ?? "system"} options={fontOptions} onChange={setFont("body")} />
              </div>
            </EditorSection>

            <EditorSection title={t("appearance.editor.shape")}>
              <RangeField
                label={t("appearance.editor.radius")}
                value={draft.radius ?? DEFAULT_RADIUS}
                min={0}
                max={LIMITS.radiusMax}
                step={1}
                format={(v) => `${v}px`}
                onChange={(v) => setDraft((d) => ({ ...d, radius: v }))}
              />
            </EditorSection>

            <EditorSection title={t("appearance.editor.decoration")}>
              <div className="grid gap-3 sm:grid-cols-2">
                <ChoiceSelect
                  label={t("appearance.editor.pattern")}
                  value={decor.pattern ?? "none"}
                  options={artOptions}
                  onChange={(k) => patchDecor({ pattern: k === "none" ? undefined : (k as Art) })}
                />
                <ChoiceSelect
                  label={t("appearance.editor.motif")}
                  value={decor.motif ?? "none"}
                  options={artOptions}
                  onChange={(k) => patchDecor({ motif: k === "none" ? undefined : (k as Art) })}
                />
              </div>
              <RangeField
                label={t("appearance.editor.patternOpacity")}
                value={decor.patternOpacity ?? DEFAULT_PATTERN_OPACITY}
                min={0}
                max={LIMITS.patternOpacityMax}
                step={0.01}
                format={pct}
                disabled={!decor.pattern}
                onChange={(v) => patchDecor({ patternOpacity: v })}
              />
              <ToggleRow label={t("appearance.editor.glow")} checked={!!decor.glow} onChange={(v) => patchDecor({ glow: v || undefined })} />
              <ChoiceSelect
                label={t("appearance.editor.motion")}
                value={decor.motion ?? "none"}
                options={MOTION_KEYS.map((k) => ({ key: k, label: t(`appearance.motion.${k}`) }))}
                onChange={(k) => patchDecor({ motion: k === "none" ? undefined : (k as Motion) })}
              />
            </EditorSection>

            <EditorSection title={t("appearance.editor.details")} desc={t("appearance.editor.detailsDesc")}>
              <div className="grid gap-3 sm:grid-cols-2">
                <ChoiceSelect
                  label={t("appearance.editor.ornament")}
                  value={details.ornament ?? "none"}
                  options={artOptions}
                  onChange={(k) => patchDetails({ ornament: k === "none" ? undefined : (k as Art) })}
                />
                <ChoiceSelect label={t("appearance.editor.buttons")} value={details.buttons ?? "flat"} options={detailOptions("buttons")} onChange={(k) => patchDetails({ buttons: k })} />
                <ChoiceSelect label={t("appearance.editor.fields")} value={details.fields ?? "outline"} options={detailOptions("fields")} onChange={(k) => patchDetails({ fields: k })} />
                <ChoiceSelect label={t("appearance.editor.cards")} value={details.cards ?? "flat"} options={detailOptions("cards")} onChange={(k) => patchDetails({ cards: k })} />
                <ChoiceSelect label={t("appearance.editor.headings")} value={details.headings ?? "plain"} options={detailOptions("headings")} onChange={(k) => patchDetails({ headings: k })} />
                <ChoiceSelect label={t("appearance.editor.nav")} value={details.nav ?? "pill"} options={detailOptions("nav")} onChange={(k) => patchDetails({ nav: k })} />
                <ChoiceSelect
                  label={t("appearance.editor.cardCorner")}
                  value={details.cardCorner ?? "none"}
                  options={DETAIL_OPTIONS.cardCorner.map((k) => ({ key: k, label: t(`appearance.detail.cardCorner.${k}`) }))}
                  onChange={(k) => patchDetails({ cardCorner: k === "none" ? undefined : k })}
                />
              </div>
              <div className="grid gap-2.5 sm:grid-cols-2">
                {(["buttonGlyph", "composerSprig", "sidebarFlourish", "dialogLace", "accentScrollbar"] as const).map((flag) => (
                  <ToggleRow
                    key={flag}
                    label={t(`appearance.editor.${flag}`)}
                    checked={!!details[flag]}
                    onChange={(v) => patchDetails({ [flag]: v || undefined })}
                  />
                ))}
              </div>
            </EditorSection>

            <EditorSection title={t("appearance.editor.images")} desc={t("appearance.editor.imagesDesc")}>
              {IMAGE_SLOTS.map((slot) => (
                <ImageField
                  key={slot}
                  t={t}
                  label={t(`appearance.editor.image.${slot}`)}
                  url={images[slot]}
                  busy={picking === slot}
                  onPick={() => void pick(slot)}
                  onRemove={() => unpick(slot)}
                />
              ))}
              {images.backdrop ? (
                <RangeField
                  label={t("appearance.editor.veil")}
                  value={decor.veil ?? DEFAULT_VEIL}
                  min={LIMITS.veilMin}
                  max={LIMITS.veilMax}
                  step={0.01}
                  format={pct}
                  onChange={(v) => patchDecor({ veil: v })}
                />
              ) : null}
              {images.corner ? (
                <ChoiceSelect<CornerFrame>
                  label={t("appearance.editor.frame")}
                  value={decor.cornerFrame ?? "polaroid"}
                  options={frameOptions}
                  onChange={(k) => patchDecor({ cornerFrame: k })}
                />
              ) : null}
            </EditorSection>

            <EditorSection title={t("appearance.editor.greeting")}>
              <Field label={t("appearance.editor.greetingTitle")}>
                <input
                  value={draft.greeting?.title ?? ""}
                  maxLength={LIMITS.greetingTitle}
                  placeholder={t("appearance.editor.greetingPlaceholder")}
                  onChange={greeting("title")}
                  className={cn(FIELD_CLS, "w-full")}
                />
              </Field>
              <Field label={t("appearance.editor.greetingSubtitle")}>
                <input
                  value={draft.greeting?.subtitle ?? ""}
                  maxLength={LIMITS.greetingSubtitle}
                  placeholder={t("appearance.editor.greetingPlaceholder")}
                  onChange={greeting("subtitle")}
                  className={cn(FIELD_CLS, "w-full")}
                />
              </Field>
            </EditorSection>
          </div>

          <div className="hidden min-h-0 flex-col gap-3 border-l border-line bg-surface-muted/40 p-5 md:flex">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">{t("appearance.editor.preview")}</p>
            <SkinPreview
              skin={draft}
              dark={mode === "dark"}
              large
              title={draft.greeting?.title || t("chat.emptyTitle")}
              subtitle={draft.greeting?.subtitle || t("chat.emptyHint")}
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
          <button type="button" onClick={dismiss} disabled={saving} className={SECONDARY}>
            {t("appearance.editor.cancel")}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!name || saving}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition hover:brightness-105 disabled:opacity-50"
          >
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t("appearance.editor.save")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
