"use client";

/**
 * The layers a skin paints that CSS variables cannot: behind the whole app (backdrop image under a veil, accent glow,
 * tiled pattern, moving particles) and a framed corner photo over the chat.
 *
 * Mounted once by AgentShell as the first child of its root, which is `isolate` -- so this can sit at -z-10 beneath
 * every surface without escaping under the window itself. The surfaces above go see-through only while the skin
 * actually paints something here (the `data-skin-backdrop` rules in skins.css), so with no skin, or a palette-only
 * skin, nothing about the app changes.
 *
 * Movement is CSS on composited layers (transform / opacity), and CSS is also where it stops: skins.css hides the
 * particles and freezes drift and float under `data-skin-motion-off` and under prefers-reduced-motion. This component
 * only decides what exists, never whether it may move.
 */
import { useMemo } from "react";
import type React from "react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import { useAppearance } from "./ThemeProvider";
import { glyphUrl, hasBackdrop, patternTile, useActiveSkin, type Skin } from "./skins";
import { DEFAULT_VEIL, glowBackground, safeImage } from "./skins/visual";

/** A small seeded PRNG: particles are scattered the same way on every render, so they never jump mid-flight. */
function seeded(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hashString = (value: string) => [...value].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);

type ParticleStyle = React.CSSProperties & Record<`--${string}`, string>;

function Particles({ skin, glyph, motion }: { skin: Skin; glyph: string; motion: "fall" | "twinkle" }) {
  const items = useMemo(() => {
    const rand = seeded(hashString(`${skin.id}:${motion}`));
    const count = motion === "fall" ? 16 : 24;
    return Array.from({ length: count }, (_, i) => {
      const size = motion === "fall" ? 10 + rand() * 12 : 6 + rand() * 10;
      const style: ParticleStyle = {
        left: `${(i / count) * 100 + rand() * (100 / count)}%`,
        width: `${size}px`,
        height: `${size}px`,
        // Negative delays start each particle part-way through its cycle, so the sky is already full on arrival.
        animationDuration: `${motion === "fall" ? 14 + rand() * 12 : 3 + rand() * 4}s`,
        animationDelay: `-${rand() * 20}s`,
      };
      if (motion === "fall") {
        style["--skin-sway"] = `${Math.round((rand() - 0.5) * 160)}px`;
        style["--skin-spin"] = `${Math.round((rand() - 0.5) * 540)}deg`;
        style.opacity = String(0.22 + rand() * 0.23);
      } else {
        style.top = `${rand() * 100}%`;
        style["--skin-peak"] = String(0.3 + rand() * 0.35);
      }
      return style;
    });
  }, [skin.id, motion]);

  return (
    <div aria-hidden className="skin-particles pointer-events-none absolute inset-0 overflow-hidden">
      {items.map((style, i) => (
        <span
          key={i}
          className={cn("skin-particle", motion === "fall" ? "skin-fall" : "skin-twinkle")}
          style={{ ...style, backgroundImage: glyph }}
        />
      ))}
    </div>
  );
}

export default function SkinDecor({ showCorner }: { showCorner: boolean }) {
  const skin = useActiveSkin();
  const { resolvedTheme } = useTheme();
  const { appearance } = useAppearance();
  if (!skin) return null;

  const tokens = resolvedTheme === "dark" ? skin.dark : skin.light;
  const d = skin.decor ?? {};
  const backdrop = safeImage(d.images?.backdrop);
  const corner = safeImage(d.images?.corner);
  const tile = d.pattern ? patternTile(d.pattern, tokens.primary) : null;
  const frame = d.cornerFrame ?? "polaroid";
  const particleArt = skin.details?.ornament ?? d.pattern ?? d.motif;
  const particleGlyph =
    (d.motion === "fall" || d.motion === "twinkle") && particleArt ? glyphUrl(particleArt, tokens.primary, 0.9) : null;

  return (
    <>
      {hasBackdrop(skin) || particleGlyph ? (
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden bg-background">
          {backdrop ? (
            <>
              <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url("${backdrop}")` }} />
              {/* The veil is the readability guarantee: text never sits on the bare picture. */}
              <div className="absolute inset-0 bg-background" style={{ opacity: d.veil ?? DEFAULT_VEIL }} />
            </>
          ) : null}
          {d.glow ? <div className="absolute inset-0" style={{ backgroundImage: glowBackground(tokens.primary) }} /> : null}
          {tile ? (
            // A drifting pattern is oversized by one tile, so sliding it by exactly one tile loops without a seam.
            <div
              className={cn("absolute", d.motion === "drift" ? "-inset-[120px] skin-drift" : "inset-0")}
              style={{ backgroundImage: tile, backgroundSize: "120px 120px", opacity: d.patternOpacity ?? 0.15 }}
            />
          ) : null}
          {particleGlyph ? <Particles skin={skin} glyph={particleGlyph} motion={d.motion as "fall" | "twinkle"} /> : null}
        </div>
      ) : null}

      {/* Wide windows only: on a narrow one the chat column reaches the corner and the photo would sit on text. */}
      {/* The corner photo sits over the conversation, so "skin on the chat screen" off removes it. */}
      {showCorner && appearance.skinOnChat && corner ? (
        <div aria-hidden className="pointer-events-none absolute bottom-32 right-8 z-[5] hidden select-none xl:block">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={corner}
            alt=""
            draggable={false}
            className={cn(
              "skin-float object-cover shadow-lg",
              frame === "polaroid" && "h-40 w-32 rotate-3 rounded-sm border-[6px] border-b-[26px] border-surface",
              frame === "round" && "size-32 rounded-full border-4 border-surface",
              frame === "plain" && "h-40 w-32 rounded-[var(--radius)]",
            )}
          />
        </div>
      ) : null}
    </>
  );
}
