"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Sun, Moon, Monitor } from "lucide-react";
import { useAccent } from "./ThemeProvider";
import { ACCENTS } from "./theme-config";
import { applyThemeWithTransition } from "./theme-transition";

const MODES = [
  { key: "light", label: "浅色", icon: Sun },
  { key: "dark", label: "深色", icon: Moon },
  { key: "system", label: "系统", icon: Monitor },
] as const;

/**
 * 是否已在客户端水合完成。基于 useSyncExternalStore：
 * 服务端/水合前返回 false，水合后返回 true —— 无需在 effect 中 setState。
 */
const noopSubscribe = () => () => {};
const useMounted = () =>
  useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );

/**
 * 外观设置：主题模式（明/暗/系统）+ 强调色
 * 放在设置抽屉中使用。
 */
export default function ThemeSettings() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { accent, setAccent } = useAccent();
  const mounted = useMounted();

  /** 带圆形扩散过渡动画的主题切换；明暗外观不变时（如 dark -> system 且系统为暗色）直接切换 */
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
    // 扩散原点取按钮中心（键盘触发时 clientX/Y 为 0，用元素位置更稳定）
    const rect = e.currentTarget.getBoundingClientRect();
    applyThemeWithTransition(targetDark, () => setTheme(key), {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
  };

  // 避免明暗状态在客户端水合前不一致导致的闪烁/告警
  if (!mounted) return null;

  return (
    <div className="drawer-section">
      <h4 className="text-sm font-semibold mb-3">外观</h4>

      {/* 主题模式 */}
      <div className="mb-4">
        <p className="text-xs text-gray-500 mb-2">主题模式</p>
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

      {/* 强调色 */}
      <div>
        <p className="text-xs text-gray-500 mb-2">主题色</p>
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
