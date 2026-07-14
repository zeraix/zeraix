/**
 * 主题配置：强调色（accent / primary）预设
 * - 明暗模式由 next-themes 管理（.dark 类）
 * - 强调色由 data-accent 属性管理，CSS 在 globals.css 中定义
 */

export const ACCENT_STORAGE_KEY = "zeraix.accent";

export type AccentKey = "gold" | "blue" | "green" | "purple" | "rose";

export interface AccentPreset {
  key: AccentKey;
  /** 展示名称 */
  label: string;
  /** 选择器上展示的色块（取强调色代表色） */
  swatch: string;
}

export const ACCENTS: AccentPreset[] = [
  { key: "gold", label: "金色", swatch: "#a8841f" },
  { key: "blue", label: "蓝色", swatch: "#2563eb" },
  { key: "green", label: "绿色", swatch: "#16a34a" },
  { key: "purple", label: "紫色", swatch: "#7c3aed" },
  { key: "rose", label: "玫红", swatch: "#e11d48" },
];

export const DEFAULT_ACCENT: AccentKey = "gold";

export const isAccentKey = (v: unknown): v is AccentKey =>
  typeof v === "string" && ACCENTS.some((a) => a.key === v);
