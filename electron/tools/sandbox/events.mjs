/**
 * 后台服务启停事件枢纽（引擎层共享）。
 *
 * 原先位于 aiToolkit.mjs：main 注入回调 → 引擎（native / qemu）在后台服务
 * 启动 / 停止时广播给渲染层（GlobalNotifications 展示与停止按钮）。
 * 独立成小模块以避免 engine.mjs ↔ 各引擎实现之间的循环依赖。
 */

let serviceEvents = null;

/** 由 main 注入事件回调（evt → 广播给所有窗口）。传非函数则清空。 */
export function setServiceEventHandler(fn) {
  serviceEvents = typeof fn === "function" ? fn : null;
}

/** 引擎侧发出事件：{ type: "started"|"stopped", pid, url?, command? }。 */
export function emitService(evt) {
  try {
    serviceEvents?.(evt);
  } catch {
    /* 广播失败不影响进程 */
  }
}
