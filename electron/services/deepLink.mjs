/**
 * 自定义协议（Deep Link）注册与解析。
 *
 * 用途：Google 登录在系统浏览器里完成后，回调页放一个 `zeraix://…` 按钮，用户点一下
 * 由操作系统把这个 URL 路由回本应用（把窗口带到前台）。RFC 8252 的环回流程已在应用内
 * 拿到 id_token，深链的职责只是「把用户从浏览器带回应用」，不承载令牌。
 *
 * 平台差异（由 main.mjs 消费本模块的解析结果）：
 *   - macOS：系统发 `open-url` 事件，URL 直接给到；
 *   - Windows/Linux：系统以「新进程 + argv 带上 URL」方式唤起，靠单实例锁把它交回首个实例，
 *     再从 argv 里捞出这个 URL（见 findDeepLink）。
 *
 * 打包分发时协议在 electron-builder.yml 的 protocols 段声明（写入 Info.plist / 注册表）；
 * 开发态（electron .）由 setAsDefaultProtocolClient 动态登记，需显式把入口脚本路径传给系统，
 * 否则系统不知道用哪个参数重新拉起 Electron。
 */
import { app } from "electron";
import path from "node:path";

/** 自定义协议名（不含 ://）。改这里需同步 electron-builder.yml 的 protocols 段。 */
export const DEEP_LINK_SCHEME = "zeraix";

/**
 * 把本应用登记为 `zeraix://` 的默认处理程序。
 * 打包态直接登记；开发态（process.defaultApp 为真，即 `electron .`）必须把入口脚本路径
 * 作为附加参数传入，系统才能用「electron <入口>」的形式在点击深链时把应用重新拉起。
 */
export function registerProtocolClient() {
  if (process.defaultApp) {
    // 开发态：argv 形如 [electron, <入口脚本>, …]；把入口脚本绝对路径登记进去。
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [
        path.resolve(process.argv[1]),
      ]);
    }
  } else {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  }
}

/**
 * 从一组命令行参数里找出 `zeraix://…` 深链（Windows/Linux 唤起时 URL 就在 argv 里）。
 * 找不到返回 null。
 */
export function findDeepLink(argv) {
  if (!Array.isArray(argv)) return null;
  return argv.find((a) => typeof a === "string" && a.startsWith(`${DEEP_LINK_SCHEME}://`)) || null;
}
