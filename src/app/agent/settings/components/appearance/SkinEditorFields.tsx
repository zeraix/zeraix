"use client";

/**
 * Controls for the skin editor. Each is presentational -- a value in, an onChange out -- so SkinEditor holds the
 * state and the flow, and this file holds only how each kind of setting is edited.
 */
import { useState } from "react";
import type React from "react";
import { ImagePlus, Loader2, RefreshCw, X } from "lucide-react";
import type { TFunc } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { KEY_COLOR_NAMES, type KeyColors } from "@/components/theme/skins";
import { safeImage } from "@/components/theme/skins/visual";
import { FIELD_CLS } from "../styles";

export function EditorSection({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 border-b border-line px-5 py-4 last:border-b-0">
      <div>
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {desc ? <p className="mt-0.5 text-xs leading-relaxed text-ink-subtle">{desc}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="flex items-baseline justify-between gap-2 text-xs font-medium text-ink-muted">
        <span>{label}</span>
        {hint ? <span className="tabular-nums text-ink-subtle">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

const HEX6 = /^#[0-9a-f]{6}$/i;

/** Editable hex beside the native picker. Commits only a complete #rrggbb; anything else snaps back on blur. */
function HexInput({ value, label, onCommit }: { value: string; label: string; onCommit: (hex: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text === null) return;
    const v = text.trim().startsWith("#") ? text.trim() : `#${text.trim()}`;
    if (HEX6.test(v)) onCommit(v.toLowerCase());
    setText(null);
  };
  return (
    <input
      value={text ?? value}
      aria-label={label}
      spellCheck={false}
      maxLength={7}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") setText(null);
      }}
      className="w-full bg-transparent font-mono text-xs uppercase text-ink outline-none"
    />
  );
}

export function ColorGrid({
  t,
  colors,
  onChange,
}: {
  t: TFunc;
  colors: KeyColors;
  onChange: (name: keyof KeyColors, hex: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {KEY_COLOR_NAMES.map((name) => {
        const label = t(`appearance.editor.color.${name}`);
        return (
          <div key={name} className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2 py-1.5">
            <input
              type="color"
              value={colors[name]}
              aria-label={label}
              onChange={(e) => onChange(name, e.target.value)}
              className="size-7 shrink-0 cursor-pointer rounded-md border border-line bg-transparent p-0 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-[5px] [&::-webkit-color-swatch]:border-0"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[0.6875rem] text-ink-subtle">{label}</p>
              <HexInput value={colors[name]} label={label} onCommit={(hex) => onChange(name, hex)} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ChoiceSelect<K extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: K;
  options: { key: K; label: string }[];
  onChange: (key: K) => void;
  disabled?: boolean;
}) {
  return (
    <Field label={label}>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as K)}
        className={cn(FIELD_CLS, "w-full text-xs disabled:opacity-50")}
      >
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function RangeField({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <Field label={label} hint={format(value)}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-primary disabled:opacity-40"
      />
    </Field>
  );
}

export function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs font-medium text-ink-muted">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

export function ImageField({
  t,
  label,
  url,
  busy,
  onPick,
  onRemove,
}: {
  t: TFunc;
  label: string;
  url: string | undefined;
  busy: boolean;
  onPick: () => void;
  onRemove: () => void;
}) {
  const src = safeImage(url);
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line bg-surface p-2">
      <div className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-md border border-dashed border-line-strong bg-surface-muted">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {src ? <img src={src} alt="" className="size-full object-cover" /> : <ImagePlus className="size-4 text-ink-subtle" />}
      </div>
      <p className="min-w-0 flex-1 truncate text-xs font-medium text-ink">{label}</p>
      <button
        type="button"
        onClick={onPick}
        disabled={busy}
        className="flex shrink-0 items-center gap-1 rounded-md border border-line-strong bg-surface px-2 py-1 text-xs font-medium text-ink transition hover:bg-surface-muted disabled:opacity-60"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : src ? <RefreshCw className="size-3.5" /> : <ImagePlus className="size-3.5" />}
        {src ? t("appearance.editor.replace") : t("appearance.editor.choose")}
      </button>
      {src ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`${t("appearance.remove")}: ${label}`}
          className="grid size-7 shrink-0 place-items-center rounded-md text-ink-subtle transition hover:bg-surface-muted hover:text-destructive"
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
