"use client";

/**
 * The empty-chat greeting, as the active skin draws it: its banner picture or its motif above the title, the title in
 * the skin's display face, and the skin's own greeting text when a custom skin sets one.
 *
 * With no skin active this renders exactly the markup ChatTranscript always had -- the default look is not a skin,
 * and choosing Default has to put back precisely what was there.
 */
import type React from "react";
import { useTheme } from "next-themes";
import { motifSrc, useActiveSkin } from "./skins";
import { safeImage } from "./skins/visual";
import { useAppearance } from "./ThemeProvider";

export default function SkinGreeting({ title, hint }: { title: string; hint: React.ReactNode }) {
  const skin = useActiveSkin();
  const { resolvedTheme } = useTheme();
  const { appearance } = useAppearance();

  // This greeting lives on the chat screen: with "skin on the chat screen" off it is the plain default one.
  if (!skin || !appearance.skinOnChat) {
    return (
      <div className="mt-16 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-primary/70 text-lg font-bold text-primary-foreground shadow-lg shadow-primary/25">
          AI
        </div>
        <p className="text-sm font-medium text-ink-muted">{title}</p>
        <p className="mt-1 text-xs text-ink-subtle">{hint}</p>
      </div>
    );
  }

  const tokens = resolvedTheme === "dark" ? skin.dark : skin.light;
  const hero = safeImage(skin.decor?.images?.hero);
  const motif = !hero && skin.decor?.motif ? motifSrc(skin.decor.motif, tokens.primary) : null;

  return (
    <div className="mt-10 flex flex-col items-center px-4 text-center">
      {/* eslint-disable @next/next/no-img-element */}
      {hero ? (
        <img src={hero} alt="" draggable={false} className="mb-6 max-h-44 w-full max-w-xl select-none rounded-2xl object-cover shadow-sm" />
      ) : motif ? (
        <img src={motif} alt="" aria-hidden draggable={false} className="skin-float mb-3 h-28 w-56 select-none" />
      ) : null}
      {/* eslint-enable @next/next/no-img-element */}
      <h2 className="skin-display text-2xl leading-tight text-ink">{skin.greeting?.title ?? title}</h2>
      <p className="mt-2 max-w-md text-sm text-ink-subtle">{skin.greeting?.subtitle ?? hint}</p>
    </div>
  );
}
