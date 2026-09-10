"use client";

/**
 * Text size: the four presets, or an exact pixel size typed by hand.
 *
 * The typed value is held as text while editing and committed on Enter, blur or a stepper -- clamped into range, so
 * typing "30" lands on the maximum instead of being silently ignored. Clearing the field and leaving it restores the
 * current size rather than committing 0.
 */
import { useState } from "react";
import { Minus, Plus } from "lucide-react";
import type { TFunc } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useAppearance } from "@/components/theme/ThemeProvider";
import { FONT_PX, FONT_SIZES, clampFontPx, type FontSizeKey } from "@/components/theme/theme-config";
import { PANEL } from "../pane";
import { FIELD_CLS } from "../styles";
import { Segmented } from "./Segmented";

const STEPPER =
  "grid size-8 place-items-center rounded-lg border border-line-strong bg-surface text-ink transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40";

export function FontSizeControl({ t }: { t: TFunc }) {
  const { appearance, setAppearance } = useAppearance();
  const [text, setText] = useState<string | null>(null);
  const px = appearance.fontSizePx;

  const commit = (value: number) => {
    setText(null);
    setAppearance({ fontSize: "custom", fontSizePx: clampFontPx(value) });
  };
  const commitText = () => {
    if (text === null) return;
    if (text.trim() === "") setText(null);
    else commit(Number(text));
  };

  const options: { key: FontSizeKey; label: string }[] = [
    ...FONT_SIZES.map((f) => ({ key: f.key, label: t(f.labelKey) })),
    { key: "custom", label: t("appearance.fontSize.custom") },
  ];

  return (
    <div className={PANEL}>
      <Segmented
        label={t("appearance.fontSize")}
        value={appearance.fontSize}
        options={options}
        onChange={(key) => (key === "custom" ? setAppearance({ fontSize: "custom", fontSizePx: px }) : setAppearance({ fontSize: key }))}
      />
      {appearance.fontSize === "custom" ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" aria-label={t("appearance.decrease")} disabled={px <= FONT_PX.min} onClick={() => commit(px - 1)} className={STEPPER}>
            <Minus className="size-3.5" />
          </button>
          <div className="relative">
            <input
              type="number"
              inputMode="numeric"
              min={FONT_PX.min}
              max={FONT_PX.max}
              step={1}
              aria-label={t("appearance.fontSizePx")}
              value={text ?? String(px)}
              onChange={(e) => setText(e.target.value)}
              onBlur={commitText}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitText();
                else if (e.key === "Escape") setText(null);
              }}
              className={cn(FIELD_CLS, "w-20 pr-8 text-center tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none")}
            />
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-ink-subtle">px</span>
          </div>
          <button type="button" aria-label={t("appearance.increase")} disabled={px >= FONT_PX.max} onClick={() => commit(px + 1)} className={STEPPER}>
            <Plus className="size-3.5" />
          </button>
          <span className="text-xs text-ink-subtle">{t("appearance.fontSizeRange", { min: FONT_PX.min, max: FONT_PX.max })}</span>
        </div>
      ) : null}
      {/* rem-sized, so it scales with the setting it previews. */}
      <p className="mt-3 text-sm text-ink-muted">{t("appearance.fontSizePreview")}</p>
    </div>
  );
}
