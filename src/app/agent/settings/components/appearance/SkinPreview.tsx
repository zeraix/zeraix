"use client";

/**
 * A skin drawn in miniature, without applying it: backdrop, glow, pattern, sidebar, greeting art and title, composer,
 * and (large size) the corner photo. Everything is scoped to this box through container variables (tokenStyle), so
 * a dozen previews of different skins can sit side by side on one page.
 */
import type React from "react";
import { cn } from "@/lib/utils";
import { FONT_STACKS, glyphUrl, motifSrc, patternTile, type Skin } from "@/components/theme/skins";
import { DEFAULT_VEIL, col, glowBackground, safeImage, tokenStyle } from "@/components/theme/skins/visual";

export function SkinPreview({
  skin,
  dark,
  large = false,
  title,
  subtitle,
  className,
}: {
  skin: Skin;
  dark: boolean;
  large?: boolean;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  className?: string;
}) {
  const tk = dark ? skin.dark : skin.light;
  const d = skin.decor ?? {};
  const backdrop = safeImage(d.images?.backdrop);
  const hero = safeImage(d.images?.hero);
  const corner = safeImage(d.images?.corner);
  const motif = !hero && d.motif ? motifSrc(d.motif, tk.primary) : null;
  const tile = d.pattern ? patternTile(d.pattern, tk.primary) : null;
  const display = skin.fonts?.display ? FONT_STACKS[skin.fonts.display] : undefined;
  const body = skin.fonts?.body ? FONT_STACKS[skin.fonts.body] : undefined;
  const surface = col(tk.surface, "#ffffff");
  const dt = skin.details ?? {};
  const headingGlyph = large && dt.headings === "ornament" && dt.ornament ? glyphUrl(dt.ornament, tk.primary) : null;
  const buttonShadow =
    dt.buttons === "glow" ? `0 4px 12px -4px color-mix(in srgb, ${col(tk.primary, "#333")} 80%, transparent)` : dt.buttons === "soft" ? `0 1px 3px color-mix(in srgb, ${col(tk.primary, "#333")} 35%, transparent)` : undefined;

  return (
    <div
      aria-hidden
      className={cn("relative isolate flex overflow-hidden border", large ? "h-80 rounded-xl" : "h-24 rounded-lg", className)}
      style={{ ...tokenStyle(tk, skin.radius), background: col(tk.background, surface), borderColor: col(tk.line, "#0000001f"), fontFamily: body }}
    >
      {backdrop ? (
        <>
          <div className="absolute inset-0 -z-10 bg-cover bg-center" style={{ backgroundImage: `url("${backdrop}")` }} />
          <div className="absolute inset-0 -z-10" style={{ background: col(tk.background, surface), opacity: d.veil ?? DEFAULT_VEIL }} />
        </>
      ) : null}
      {d.glow ? <div className="absolute inset-0 -z-10" style={{ backgroundImage: glowBackground(tk.primary) }} /> : null}
      {tile ? (
        <div
          className="absolute inset-0 -z-10"
          style={{ backgroundImage: tile, backgroundSize: large ? "120px 120px" : "56px 56px", opacity: d.patternOpacity ?? 0.15 }}
        />
      ) : null}

      <div
        className={cn("shrink-0 border-r", large ? "w-[26%] space-y-1.5 p-3" : "w-1/4")}
        style={{ background: `color-mix(in srgb, ${col(tk.sidebar, surface)} 80%, transparent)`, borderColor: col(tk.line, "#0000001f") }}
      >
        {large
          ? [70, 55, 62, 48].map((w, i) => (
              <div key={i} className="h-2 rounded-full" style={{ width: `${w}%`, background: col(i === 0 ? tk.ink : tk["ink-subtle"], "#999"), opacity: i === 0 ? 0.55 : 0.35 }} />
            ))
          : null}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-2 text-center">
          {/* eslint-disable @next/next/no-img-element */}
          {hero ? (
            <img src={hero} alt="" className={large ? "mb-3 h-20 max-w-[85%] rounded-lg object-cover" : "mb-1 h-6 max-w-[70%] rounded object-cover"} />
          ) : motif ? (
            <img src={motif} alt="" className={large ? "mb-1 h-20 w-40" : "h-7 w-14"} />
          ) : null}
          {/* eslint-enable @next/next/no-img-element */}
          <p className={cn("max-w-full truncate leading-tight", large ? "text-xl" : "text-[0.7rem] font-medium")} style={{ color: col(tk.ink, "#111"), fontFamily: display }}>
            {headingGlyph ? (
              <span aria-hidden className="mr-1.5 inline-block size-3.5 bg-contain bg-center bg-no-repeat align-[0.05em]" style={{ backgroundImage: headingGlyph }} />
            ) : null}
            {large ? title : "Aa"}
          </p>
          {large && subtitle ? (
            <p className="mt-1 max-w-full truncate text-xs" style={{ color: col(tk["ink-subtle"], "#777") }}>
              {subtitle}
            </p>
          ) : null}
        </div>
        <div
          className={cn("flex items-center justify-end border", large ? "mx-4 mb-4 px-2 py-2" : "mx-2 mb-2 h-3.5 px-0.5")}
          style={{
            borderRadius: "calc(var(--radius) + 10px)",
            borderColor: col(tk["line-strong"] ?? tk.line, "#0000002a"),
            background: `color-mix(in srgb, ${surface} 90%, transparent)`,
          }}
        >
          <span className={cn("rounded-full", large ? "size-5" : "size-2.5")} style={{ background: col(tk.primary, "#333"), boxShadow: buttonShadow }} />
        </div>
      </div>

      {large && corner ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={corner}
          alt=""
          className={cn(
            "absolute bottom-16 right-4 object-cover shadow-md",
            d.cornerFrame === "round" ? "size-16 rounded-full border-2" : d.cornerFrame === "plain" ? "h-20 w-16 rounded-md" : "h-20 w-16 rotate-3 border-[3px] border-b-[12px]",
          )}
          style={{ borderColor: surface }}
        />
      ) : null}
    </div>
  );
}
