"use client";

import { cn } from "@/lib/utils";

/** Toggle switch (reuses the account section's styling). */
export function ToggleSwitch({
  on,
  onChange,
  label,
  disabled = false,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  /** Shown but not operable — for a state the user can see and must not change (e.g. a revoked plugin). */
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn(
        disabled && "cursor-not-allowed opacity-50",
        // inline-flex + items-center vertically centers the knob; border-0 p-0 resets the browser's default button box model,
        // ensuring w-9 is exact and the knob's translation isn't pushed off by default padding (previously an absolute knob with no left would overflow).
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-0 p-0 transition-colors disabled:cursor-not-allowed",
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
