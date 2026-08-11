"use client";

/**
 * "When to run" — the schedule control at the top of Simple mode.
 *
 * This is the difference between a workflow engine and an automation product. Triggers used to be
 * reachable only by hand-writing cron into the Professional JSON tab, which meant a user who could
 * not write cron could not automate anything: every workflow was, in practice, a button they had to
 * remember to press. The presets here compile to cron underneath (`scheduleToCron`) so that syntax
 * is never something anyone has to see.
 *
 * It also deliberately states the *current* answer even when that answer is "manual". An automation
 * tool whose scheduling lives behind a mode switch the beginner never clicks does not read as
 * "advanced feature available" — it reads as "this product cannot do that". Naming the manual state
 * and pointing at the way out turns an invisible ceiling into a door.
 */
import { CalendarClock, ChevronRight, Hand, Info } from "lucide-react";
import { useT } from "@/lib/i18n";
import type { WorkflowDefinition } from "@/lib/workflows";
import {
  MINUTE_CHOICES,
  applySchedule,
  readSchedule,
  type SchedulePreset,
  type ScheduleValue,
} from "./blocks";

/** Presets in the order they are offered: least to most frequent, manual first as the default. */
const PRESETS: { value: SchedulePreset; labelKey: string }[] = [
  { value: "manual", labelKey: "auto.trigger.manual" },
  { value: "daily", labelKey: "auto.trigger.daily" },
  { value: "weekdays", labelKey: "auto.trigger.weekdays" },
  { value: "hourly", labelKey: "auto.trigger.hourly" },
  { value: "everyMinutes", labelKey: "auto.trigger.everyMinutes" },
];

const MISSED_POLICIES: { value: ScheduleValue["missedRunPolicy"]; labelKey: string }[] = [
  { value: "skip", labelKey: "auto.trigger.missed.skip" },
  { value: "run-once-on-launch", labelKey: "auto.trigger.missed.once" },
  { value: "backfill", labelKey: "auto.trigger.missed.backfill" },
];

export default function TriggerPicker({
  definition,
  onChange,
  onOpenAdvanced,
}: {
  definition: WorkflowDefinition;
  onChange: (next: WorkflowDefinition) => void;
  /** Switches the editor to Professional mode — the escape hatch for schedules this cannot draw. */
  onOpenAdvanced?: () => void;
}) {
  const t = useT();
  const value = readSchedule(definition);
  const scheduled = value.preset !== "manual";

  const set = (patch: Partial<ScheduleValue>) => onChange(applySchedule(definition, { ...value, ...patch }));

  /* A schedule Simple mode cannot draw is shown, not silently replaced — see readSchedule. */
  if (value.preset === "custom") {
    return (
      <Frame scheduled>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-foreground">{t("auto.trigger.customTitle")}</p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
            {value.expression || t("auto.trigger.customOther")}
          </p>
        </div>
        {onOpenAdvanced && <AdvancedLink onClick={onOpenAdvanced} label={t("auto.trigger.editAdvanced")} />}
      </Frame>
    );
  }

  return (
    <div className="mb-3">
      <Frame scheduled={scheduled}>
        <label className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-foreground">{t("auto.trigger.label")}</span>
          <select
            value={value.preset}
            onChange={(e) => set({ preset: e.target.value as SchedulePreset })}
            className="rounded-md border border-line-strong bg-surface px-2 py-1 text-xs text-foreground outline-none transition focus:border-ring"
          >
            {PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {t(p.labelKey)}
              </option>
            ))}
          </select>

          {/* A time field only where a time means something. */}
          {(value.preset === "daily" || value.preset === "weekdays") && (
            <input
              type="time"
              value={value.time}
              onChange={(e) => set({ time: e.target.value })}
              className="rounded-md border border-line-strong bg-surface px-2 py-1 text-xs tabular-nums text-foreground outline-none transition focus:border-ring"
            />
          )}

          {value.preset === "everyMinutes" && (
            <select
              value={value.minutes}
              onChange={(e) => set({ minutes: Number(e.target.value) })}
              className="rounded-md border border-line-strong bg-surface px-2 py-1 text-xs tabular-nums text-foreground outline-none transition focus:border-ring"
            >
              {MINUTE_CHOICES.map((m) => (
                <option key={m} value={m}>
                  {t("auto.trigger.minutes", { n: String(m) })}
                </option>
              ))}
            </select>
          )}

          {value.preset === "hourly" && (
            <span className="text-[11px] text-muted-foreground">{t("auto.trigger.hourlyHint")}</span>
          )}
        </label>
      </Frame>

      {/* The honest part: what happens to fires that came due while the app was shut. A desktop app
          is closed most of the time, so this is a normal question, not an edge case (§12.2). */}
      {scheduled && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-1">
          <span className="text-[11px] text-muted-foreground">{t("auto.trigger.missedLabel")}</span>
          <select
            value={value.missedRunPolicy}
            onChange={(e) => set({ missedRunPolicy: e.target.value as ScheduleValue["missedRunPolicy"] })}
            className="rounded-md border border-line-strong bg-surface px-2 py-1 text-[11px] text-foreground outline-none transition focus:border-ring"
          >
            {MISSED_POLICIES.map((p) => (
              <option key={p.value} value={p.value}>
                {t(p.labelKey)}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Finding #3: name the ceiling and point past it, rather than leaving Simple mode looking like
          the whole product. Shown only while manual — once a schedule exists the hint is noise. */}
      {!scheduled && onOpenAdvanced && (
        <p className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-1 text-[11px] text-muted-foreground">
          <Info className="size-3 shrink-0" />
          {t("auto.trigger.ceilingHint")}
          <AdvancedLink onClick={onOpenAdvanced} label={t("auto.trigger.openAdvanced")} />
        </p>
      )}
    </div>
  );
}

/** The rail the schedule sits in. Tinted once a schedule exists, so "this runs by itself" is visible. */
function Frame({ scheduled, children }: { scheduled: boolean; children: React.ReactNode }) {
  return (
    <div
      className={`flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 transition ${
        scheduled ? "border-primary/30 bg-primary/[0.05]" : "border-line bg-surface"
      }`}
    >
      <span
        className={`flex size-6 shrink-0 items-center justify-center rounded-lg ${
          scheduled ? "bg-primary/10 text-primary" : "bg-surface-muted text-muted-foreground"
        }`}
      >
        {scheduled ? <CalendarClock className="size-3.5" /> : <Hand className="size-3.5" />}
      </span>
      {children}
    </div>
  );
}

function AdvancedLink({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-0.5 rounded font-medium text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {label}
      <ChevronRight className="size-3" />
    </button>
  );
}
