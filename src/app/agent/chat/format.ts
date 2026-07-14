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
