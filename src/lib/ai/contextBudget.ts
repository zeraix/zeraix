/**
 * Absolute context working-set budget (Phase 3 of the context-management optimisation).
 *
 * The old auto-compaction trigger was purely window-relative (compact at 75% of the model's context
 * window). On a large-window model that let a task carry hundreds of thousands of tokens before it ever
 * compacted — high latency and diluted attention even though it "fit". This preference caps the working
 * set at an ABSOLUTE token budget as well, so behaviour no longer depends on how big the window happens
 * to be. The effective trigger becomes min(window * 75%, budget) — see resolveHybridBudget().
 *
 * The value is user-configurable (Settings → General), NOT hardcoded. 0 disables the absolute cap and
 * restores the original window-relative behaviour. Persisted in localStorage like the other prefs; an install
 * that never set it gets DEFAULT_CONTEXT_BUDGET_K.
 */
import { getStorage, setStorage } from "@zzcpt/zztool";
import STORAGE_KEY from "@/constants/Storage";

/**
 * The cap an install starts with, and the one the switch in Settings turns back on to (see restoreBudgetK).
 *
 * 120K, from the offline replay of a real 186K / 1M-window task: about 47% lower average context for ~2
 * summariser calls, where tighter values raise the re-summary cost.
 */
export const SUGGESTED_CONTEXT_BUDGET_K = 120;

/**
 * Default budget in K tokens: ON, at the suggested cap.
 *
 * It shipped OFF, for two reasons that no longer hold. The first was losing the task to a summary, which Task
 * Memory now prevents. The second was that a fixed cap looks arbitrary — but it only binds above a 160K window
 * (below that, 75% of the window is already tighter), and above it "off" meant compacting at 750K of a 1M model:
 * never. Measured on 2026-09-29, conversations on 1M models ran requests of 130K–318K tokens and were never once
 * summarised. A user who switched the cap off keeps it off: an explicit 0 is stored, and only an unset value
 * falls back to this.
 */
export const DEFAULT_CONTEXT_BUDGET_K = SUGGESTED_CONTEXT_BUDGET_K;
/** Below this the summariser thrashes (re-summary cost dominates); above it the cap is moot on any real window. */
export const MIN_CONTEXT_BUDGET_K = 40;
export const MAX_CONTEXT_BUDGET_K = 500;

/** Clamp a positive budget into the sane band; pass-through 0 (disabled). */
function clampBudgetK(k: number): number {
  if (!Number.isFinite(k) || k <= 0) return 0;
  return Math.min(MAX_CONTEXT_BUDGET_K, Math.max(MIN_CONTEXT_BUDGET_K, Math.round(k)));
}

/** The configured budget in K tokens: DEFAULT when unset, 0 when explicitly disabled, else clamped. */
export function getContextBudgetK(): number {
  const raw = getStorage(STORAGE_KEY.contextBudget);
  if (raw == null || raw === "") return DEFAULT_CONTEXT_BUDGET_K;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_CONTEXT_BUDGET_K;
  if (n <= 0) return 0; // explicitly disabled
  return clampBudgetK(n);
}

/**
 * What to apply when the cap is switched back ON, given the last positive budget seen.
 *
 * Exists because "restore the previous value" has no answer the first time. When the default was 0, a UI that
 * restored the default turned the cap on by setting it to off: the toggle flipped, the store read back 0, and it
 * flipped straight back. The default is on now, but a user who has only ever had it off is in the same place.
 *
 * So the fallback is the SUGGESTED value rather than the default. Turning something on has to result in it
 * being on; a switch whose "on" position means off is not a preference, it is a broken control.
 */
export function restoreBudgetK(lastPositiveK: number): number {
  const restored = clampBudgetK(lastPositiveK);
  return restored > 0 ? restored : SUGGESTED_CONTEXT_BUDGET_K;
}

/**
 * Persist the budget in K tokens (0 disables; positive values are clamped to the sane band).
 *
 * Written as a STRING. The storage layer silently drops falsy values, so a numeric 0 was never written:
 * switching the cap off left the previous budget in place, the switch read it straight back and re-ticked
 * itself — the control "did nothing", and so did typing 0. "0" is truthy, and getContextBudgetK parses it
 * back to the explicit "disabled" it means (distinct from unset, which is the default).
 */
export function setContextBudgetK(k: number): void {
  setStorage(STORAGE_KEY.contextBudget, String(k <= 0 ? 0 : clampBudgetK(k)));
}
