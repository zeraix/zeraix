"use client";

import { flushSync } from "react-dom";

/**
 * Minimal type for the View Transitions API (may not yet be built into the TS DOM lib)
 */
type DocumentWithViewTransition = Document & {
  startViewTransition?: (callback: () => void) => {
    ready: Promise<void>;
    finished: Promise<void>;
  };
};

/** Animation expansion origin (viewport coordinates, usually the click position) */
export interface TransitionOrigin {
  x: number;
  y: number;
}

/**
 * Theme switch with a transition animation (View Transitions API + clip-path circular expansion)
 *
 * - Switching to light: the new (light) view expands in a circle from the origin to cover the screen
 * - Switching to dark: the old (light) view shrinks away in a circle, revealing the dark view underneath
 * - When the browser doesn't support startViewTransition, or the user prefers reduced motion, switch directly with no animation
 *
 * The accompanying ::view-transition-*(root) layer rules are defined in globals.css.
 *
 * @param toDark Whether the target after switching is dark (determines the animation direction and target layer)
 * @param apply  The callback that actually performs the theme switch (uses flushSync internally to synchronously flush the DOM)
 * @param origin The expansion origin (viewport coordinates, e.g. the click position); defaults to the viewport center
 */
export function applyThemeWithTransition(
  toDark: boolean,
  apply: () => void,
  origin?: TransitionOrigin,
) {
  const doc = document as DocumentWithViewTransition;
  const canTransition =
    typeof doc.startViewTransition === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (!canTransition) {
    apply();
    return;
  }

  // Mark that a theme-switch transition is in progress:
  // The chat page's view-transitions.css sets view-transition-name on some elements (used for page-navigation transitions),
  // which pulls those elements out of the root snapshot into their own separate groups, so the full-page wipe only affects the rest (e.g. the sidebar).
  // globals.css uses html.theme-transition to cancel those groups and suppress the root fade during a theme switch.
  const root = document.documentElement;
  root.classList.add("theme-transition");

  // The theme switch must complete synchronously inside the startViewTransition callback,
  // otherwise the snapshot won't capture the new state -- so use flushSync to force synchronous rendering.
  const transition = doc.startViewTransition!(() => {
    flushSync(apply);
  });

  transition.finished.finally(() => {
    root.classList.remove("theme-transition");
  });

  // Expansion origin: prefer the passed-in click position, otherwise use the viewport center
  const x = origin?.x ?? innerWidth / 2;
  const y = origin?.y ?? innerHeight / 2;
  // End radius: distance from the origin to the farthest viewport corner, ensuring the circle fully covers the viewport
  const endRadius = Math.hypot(
    Math.max(x, innerWidth - x),
    Math.max(y, innerHeight - y),
  );
  // The clip-path circle's percentage radius is measured against sqrt(w^2+h^2)/sqrt(2) as the reference baseline
  const ratioX = (100 * x) / innerWidth;
  const ratioY = (100 * y) / innerHeight;
  const referR = Math.hypot(innerWidth, innerHeight) / Math.SQRT2;
  const ratioR = (100 * endRadius) / referR;

  transition.ready.then(() => {
    const clipPath = [
      `circle(0% at ${ratioX}% ${ratioY}%)`,
      `circle(${ratioR}% at ${ratioX}% ${ratioY}%)`,
    ];
    document.documentElement.animate(
      {
        clipPath: toDark ? [...clipPath].reverse() : clipPath,
      },
      {
        duration: 400,
        easing: "ease-in",
        fill: "both",
        // When switching to dark, shrink the old view (light on top); when switching to light, expand the new view (light on top)
        pseudoElement: toDark
          ? "::view-transition-old(root)"
          : "::view-transition-new(root)",
      },
    );
  });
}
