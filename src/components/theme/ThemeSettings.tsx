"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Sun, Moon, Monitor } from "lucide-react";
import { useAccent } from "./ThemeProvider";
import { ACCENTS } from "./theme-config";
import { applyThemeWithTransition } from "./theme-transition";

const MODES = [
  { key: "light", label: "Light", icon: Sun },
  { key: "dark", label: "Dark", icon: Moon },
  { key: "system", label: "System", icon: Monitor },
] as const;

/**
 * Whether client-side hydration has completed. Based on useSyncExternalStore:
 * returns false on the server / before hydration, true after hydration -- no need to setState in an effect.
 */
const noopSubscribe = () => () => {};
const useMounted = () =>
  useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );

/**
 * Appearance settings: theme mode (light/dark/system) + accent color.
 * Used inside the settings drawer.
 */
export default function ThemeSettings() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { accent, setAccent } = useAccent();
  const mounted = useMounted();

  /** Theme switch with a circular-expansion transition animation; switches directly when the light/dark appearance doesn't change (e.g. dark -> system while the system is dark) */
  const changeTheme = (
    key: (typeof MODES)[number]["key"],
    e: React.MouseEvent<HTMLButtonElement>,
  ) => {
    if (key === theme) return;
    const targetDark =
      key === "dark" ||
      (key === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    if ((resolvedTheme === "dark") === targetDark) {
      setTheme(key);
      return;
    }
    // Use the button center as the expansion origin (clientX/Y is 0 when triggered by keyboard, so the element position is more reliable)
    const rect = e.currentTarget.getBoundingClientRect();
    applyThemeWithTransition(targetDark, () => setTheme(key), {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
  };

  // Avoid the flicker/warning caused by the light/dark state being inconsistent before client-side hydration
  if (!mounted) return null;

  return (
    <div className="drawer-section">
      <h4 className="text-sm font-semibold mb-3">Appearance</h4>

      {/* Theme mode */}
      <div className="mb-4">
        <p className="text-xs text-gray-500 mb-2">Theme mode</p>
        <div className="grid grid-cols-3 gap-2">
          {MODES.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              onClick={(e) => changeTheme(key, e)}
              className={`flex flex-col items-center gap-1 rounded-md border py-2 text-xs transition-colors ${
                theme === key
                  ? "border-primary text-primary bg-primary/5"
                  : "border-border text-gray-500 hover:text-foreground"
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Accent color */}
      <div>
        <p className="text-xs text-gray-500 mb-2">Accent color</p>
        <div className="flex items-center gap-3">
          {ACCENTS.map((a) => (
            <button
              key={a.key}
              type="button"
              onClick={() => setAccent(a.key)}
              title={a.label}
              aria-label={a.label}
              aria-pressed={accent === a.key}
              className={`h-7 w-7 rounded-full border-2 transition-transform ${
                accent === a.key
                  ? "scale-110 border-foreground"
                  : "border-transparent hover:scale-105"
              }`}
              style={{ background: a.swatch }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
