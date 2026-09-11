"use client";

/**
 * A miniature of what a skin does to the UI: page, card, button and input drawn with the skin's
 * own variables. Given `tokens`, the variables are set inline on the preview root, so `var(--x)`
 * inside resolves to the skin's value and falls through to the live palette for anything the skin
 * leaves alone. Given `image`, that screenshot is shown instead -- a package that ships one knows
 * better than a synthetic card what it looks like.
 */
import type React from "react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { TFunc } from "@/lib/i18n";
import { skinAPI } from "@/lib/electron/skinpkg";

export interface PackagePreviewProps {
  t: TFunc;
  tokens?: Readonly<Record<string, string>>;
  image?: string | null;
  className?: string;
}

const VAR_RE = /(--[a-zA-Z0-9-]+)\s*:\s*([^;{}]+);/g;

/**
 * The custom properties a package's tokens.css declares, first occurrence wins (light mode is
 * conventionally written first). A parse of declarations only: selectors are ignored, and a
 * value that is not a plain colour-ish token is skipped so nothing in the preview can load
 * anything -- the stylesheet was already checked by the engine, but the preview needs less.
 */
export function parseTokens(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let m: RegExpExecArray | null;
  while ((m = VAR_RE.exec(text))) {
    const [, name, raw] = m;
    const value = raw.trim();
    if (name in out || value.length > 80 || /url\(|expression\(|@/i.test(value)) continue;
    out[name] = value;
  }
  return out;
}

/** Read and parse a package's tokens.css through the bridge; null until loaded or when unavailable. */
export function usePackageTokens(id: string | null): Record<string, string> | null {
  // Keyed by id rather than reset in the effect: a result for another id is simply not this id's.
  const [loaded, setLoaded] = useState<{ id: string; tokens: Record<string, string> } | null>(null);
  useEffect(() => {
    const api = skinAPI();
    if (!id || !api) return;
    let alive = true;
    api
      .readText("tokens.css", id)
      .then((r) => {
        if (alive) setLoaded({ id, tokens: parseTokens(r.ok ? (r.text ?? "") : "") });
      })
      .catch(() => {
        if (alive) setLoaded({ id, tokens: {} });
      });
    return () => {
      alive = false;
    };
  }, [id]);
  return loaded && loaded.id === id ? loaded.tokens : null;
}

export function PackagePreview({ t, tokens, image, className }: PackagePreviewProps) {
  if (image) {
    return (
      <div className={cn("aspect-[16/10] w-full overflow-hidden rounded-lg border border-line bg-surface-muted", className)}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={image} alt="" draggable={false} className="h-full w-full object-cover" />
      </div>
    );
  }
  const style = { ...(tokens ?? {}) } as React.CSSProperties;
  return (
    <div
      className={cn("aspect-[16/10] w-full overflow-hidden rounded-lg border border-line", className)}
      style={{ ...style, background: "var(--background)", color: "var(--ink)" }}
      aria-hidden
    >
      <div className="flex h-full gap-2 p-2">
        <div className="w-[26%] rounded-md" style={{ background: "var(--sidebar, var(--background))", border: "1px solid var(--line)" }}>
          <div className="m-1.5 h-1.5 w-1/2 rounded-full" style={{ background: "var(--primary)" }} />
          <div className="mx-1.5 my-1 h-1 rounded-full" style={{ background: "var(--surface-hover)" }} />
          <div className="mx-1.5 my-1 h-1 w-3/4 rounded-full" style={{ background: "var(--surface-hover)" }} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="rounded-md p-1.5" style={{ background: "var(--surface)", border: "1px solid var(--line)" }}>
            <div className="text-[8px] font-semibold leading-tight" style={{ color: "var(--ink)" }}>
              {t("skinpkg.preview.card")}
            </div>
            <div className="mt-0.5 text-[6.5px] leading-tight" style={{ color: "var(--ink-muted)" }}>
              {t("skinpkg.preview.cardText")}
            </div>
          </div>
          <div className="mt-auto flex items-center gap-1.5">
            <div className="flex-1 rounded px-1.5 py-0.5 text-[6.5px]" style={{ background: "var(--surface)", border: "1px solid var(--line-strong)", color: "var(--ink-subtle)" }}>
              {t("skinpkg.preview.input")}
            </div>
            <div className="rounded px-1.5 py-0.5 text-[6.5px] font-semibold" style={{ background: "var(--primary)", color: "var(--primary-foreground)" }}>
              {t("skinpkg.preview.button")}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
