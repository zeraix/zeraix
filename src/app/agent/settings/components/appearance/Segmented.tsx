"use client";

/**
 * Segmented control: one choice from a few, as a WAI-ARIA radiogroup.
 *
 * The thumb slides instead of each segment toggling its own fill, so a change reads as movement from one option to
 * the next. Arrow keys move the selection and focus together; only the selected segment is in the tab order.
 */
import { useRef } from "react";
import { cn } from "@/lib/utils";

export function Segmented<K extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: K;
  options: { key: K; label: string; icon?: React.ComponentType<{ className?: string }> }[];
  onChange: (key: K, el: HTMLElement) => void;
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(0, options.findIndex((o) => o.key === value));

  const move = (delta: number) => {
    const next = (index + delta + options.length) % options.length;
    const el = refs.current[next];
    if (!el) return;
    el.focus();
    onChange(options[next].key, el);
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          move(1);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          move(-1);
        }
      }}
      className={cn("relative grid rounded-lg border border-line bg-surface-muted p-0.5", className)}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      <span
        aria-hidden
        className="absolute inset-y-0.5 left-0.5 rounded-md border border-line bg-surface shadow-sm transition-transform duration-200 ease-out motion-reduce:transition-none"
        // translateX in % is measured against the thumb's own width, which is one segment wide.
        style={{ width: `calc((100% - 0.25rem) / ${options.length})`, transform: `translateX(${index * 100}%)` }}
      />
      {options.map((o, i) => {
        const on = i === index;
        const Icon = o.icon;
        return (
          <button
            key={o.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={(e) => onChange(o.key, e.currentTarget)}
            className={cn(
              "relative z-10 flex min-w-0 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              on ? "text-ink" : "text-ink-muted hover:text-ink",
            )}
          >
            {Icon ? <Icon className="size-3.5 shrink-0" /> : null}
            <span className="truncate">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
