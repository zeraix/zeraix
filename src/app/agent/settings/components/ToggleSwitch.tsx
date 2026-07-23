"use client";

import { cn } from "@/lib/utils";

/** Toggle switch (reuses the account section's styling). */
export function ToggleSwitch({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cn(
        // inline-flex + items-center vertically centers the knob; border-0 p-0 resets the browser's default button box model,
        // ensuring w-9 is exact and the knob's translation isn't pushed off by default padding (previously an absolute knob with no left would overflow).
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-0 p-0 transition-colors",
        on ? "bg-primary" : "bg-line-strong",
      )}
    >
      <span
        className={cn(
          "pointer-events-none inline-block size-4 rounded-full bg-white shadow transition-transform",
          on ? "translate-x-[18px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
