"use client";

import { flushSync } from "react-dom";

/**
 * View Transitions API 的最小类型（TS DOM lib 可能尚未内置）
 */
type DocumentWithViewTransition = Document & {
  startViewTransition?: (callback: () => void) => {
    ready: Promise<void>;
    finished: Promise<void>;
  };
};

/** 动画扩散原点（视口坐标，通常取点击位置） */
export interface TransitionOrigin {
  x: number;
  y: number;
}

/**
 * 带过渡动画的主题切换（View Transitions API + clip-path 圆形扩散）
 *
 * - 切到亮色：新（亮色）视图从原点以圆形扩散展开覆盖
 * - 切到暗色：旧（亮色）视图以圆形收缩消失，露出下方的暗色视图
 * - 浏览器不支持 startViewTransition 或用户偏好减弱动效时，直接切换无动画
 *
 * 配套的 ::view-transition-*(root) 层级规则定义在 globals.css 中。
 *
 * @param toDark 切换后的目标是否为暗色（用于决定动画方向与作用层）
 * @param apply  实际执行主题切换的回调（内部会用 flushSync 同步刷新 DOM）
 * @param origin 扩散原点（视口坐标，如点击位置）；缺省为视口中心
 */
export function applyThemeWithTransition(
  toDark: boolean,
  apply: () => void,
  origin?: TransitionOrigin,
) {
  const doc = document as DocumentWithViewTransition;
  const canTransition =
    typeof doc.startViewTransition === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (!canTransition) {
    apply();
    return;
  }

  // 标记"正在进行主题切换过渡"：
  // chat 页面的 view-transitions.css 给部分元素设置了 view-transition-name（页面导航过渡用），
  // 这些元素会脱离 root 快照、各自独立分组，导致整页擦除只作用于剩余部分（如侧边栏）。
  // globals.css 中通过 html.theme-transition 在主题切换期间取消这些分组并屏蔽 root 淡入淡出。
  const root = document.documentElement;
  root.classList.add("theme-transition");

  // 主题切换必须在 startViewTransition 回调内同步完成，
  // 否则快照截取不到新状态 —— 因此用 flushSync 强制同步渲染。
  const transition = doc.startViewTransition!(() => {
    flushSync(apply);
  });

  transition.finished.finally(() => {
    root.classList.remove("theme-transition");
  });

  // 扩散原点：优先使用传入的点击位置，否则取视口中心
  const x = origin?.x ?? innerWidth / 2;
  const y = origin?.y ?? innerHeight / 2;
  // 终止半径：原点到视口最远角的距离，保证圆形完全覆盖视口
  const endRadius = Math.hypot(
    Math.max(x, innerWidth - x),
    Math.max(y, innerHeight - y),
  );
  // clip-path 的圆形百分比半径以 √(宽²+高²)/√2 为参照基准
  const ratioX = (100 * x) / innerWidth;
  const ratioY = (100 * y) / innerHeight;
  const referR = Math.hypot(innerWidth, innerHeight) / Math.SQRT2;
  const ratioR = (100 * endRadius) / referR;

  transition.ready.then(() => {
    const clipPath = [
      `circle(0% at ${ratioX}% ${ratioY}%)`,
      `circle(${ratioR}% at ${ratioX}% ${ratioY}%)`,
    ];
    document.documentElement.animate(
      {
        clipPath: toDark ? [...clipPath].reverse() : clipPath,
      },
      {
        duration: 400,
        easing: "ease-in",
        fill: "both",
        // 切到暗色时收缩旧视图（亮色在上），切到亮色时扩散新视图（亮色在上）
        pseudoElement: toDark
          ? "::view-transition-old(root)"
          : "::view-transition-new(root)",
      },
    );
  });
}
