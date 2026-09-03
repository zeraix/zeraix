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
 * restores the original window-relative behaviour. Persisted in localStorage like the other prefs.
 */
import { getStorage, setStorage } from "@zzcpt/zztool";
import STORAGE_KEY from "@/constants/Storage";

/**
 * Default budget in K tokens. **0 = off (opt-in).** A fixed cap is deliberately NOT imposed by default:
 * it's inert on common windows (≤160K, where the window's own 75% is tighter) and its "good" value depends
 * on the window, so a single hardcoded number would be arbitrary — and correctness never depends on it
 * (Task Memory preserves the mission regardless). Users on large-window models opt in; the offline replay
 * of a real 186K / 1M-window task suggested ~120K (≈47% lower avg context, ~2 summariser calls) as a
 * sensible starting cap, with tighter values raising re-summary cost.
 */
export const DEFAULT_CONTEXT_BUDGET_K = 0;
/** Suggested cap for a user opting in on a large-window model (see DEFAULT note). */
export const SUGGESTED_CONTEXT_BUDGET_K = 120;
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
 * Exists because "restore the previous value" has no answer the first time: the default is 0, so a UI that
 * restores the default turns the cap on by setting it to off. The toggle then appears to do nothing at all —
 * it flips, the store reads back 0, and it flips straight back — which is exactly what it did.
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
