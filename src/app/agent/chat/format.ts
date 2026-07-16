/** Re-export shared attachment utilities (implemented in @/lib/ai/attachments, reused by the home and chat pages). */
export { formatBytes, uploadFileToOSS } from "@/lib/ai/attachments";

/** One decimal place, dropping a trailing .0: 84.836 → "84.8", 2.0 → "2". */
const trimZero = (x: number): string => x.toFixed(1).replace(/\.0$/, "");

/**
 * Number abbreviation: for compactly displaying larger counts (such as token usage).
 *  Below 1000, returned as-is; otherwise uses K / M / B (thousand / million / billion), keeping one decimal place and dropping a trailing .0.
 *  E.g.: 84836 → "84.8K", 1400 → "1.4K", 1234567 → "1.2M".
 */
export function abbreviateNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs < 1000) return String(n);
  if (abs < 1e6) return `${trimZero(n / 1e3)}K`;
  if (abs < 1e9) return `${trimZero(n / 1e6)}M`;
  return `${trimZero(n / 1e9)}B`;
}

/**
 * Compact wall-clock duration for a conversation round.
 *  Under a minute, seconds with one decimal (a round trip differing by 200ms is worth seeing); at or above,
 *  m:ss so a long round stays readable at a glance.
 *  E.g.: 840 → "0.8s", 12400 → "12.4s", 65000 → "1m05s", 3725000 → "62m05s".
 *  Unit-only, so it needs no translation — the label beside it carries the i18n.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 60_000) return `${trimZero(ms / 1000)}s`;
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m${String(sec).padStart(2, "0")}s`;
}
