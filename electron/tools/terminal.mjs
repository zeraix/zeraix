/**
 * 内置终端的 PTY 后端（主进程）。
 *
 * 用 node-pty 起一个「真实伪终端」，桥接到渲染层的 xterm.js，达到与系统原生终端一致的交互：
 * 全屏 TUI（vim / top / less）、真彩色、Ctrl-C 等信号、Tab 补全、行编辑等——这些是 child_process
 * 管道方案（如 run_command）做不到的，因此终端另起一套 PTY，不复用命令执行引擎。
 *
 * 每个会话一个自增 id。PTY 输出经 webContents.send("terminal:data", {id,data}) 推给「发起该会话
 * 的渲染窗口」；退出经 "terminal:exit" 推送。会话按发起窗口归类，窗口销毁时一并清理，避免泄漏 shell。
 *
 * 说明：node-pty 是原生模块，须随主进程打包并从 asar 解出（见 electron-builder.yml 的 files /
 * asarUnpack），且按目标平台的 Electron ABI 重新编译（electron-builder 默认 npmRebuild）。
 */
import os from "node:os";
import process from "node:process";
import fs from "node:fs";
import nodePty from "node-pty";
import { getWorkingDir } from "./aiToolkit.mjs";

/** id -> { pty, webContents }。全部在位会话。 */
const sessions = new Map();
let seq = 0;

const isDir = (p) => {
  try {
    return !!p && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (p) => {
  try {
    return !!p && fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * 选一个「确实存在且可执行」的 shell，避免 posix_spawnp 因 shell 路径无效而失败：
 *  - Windows：优先 PowerShell（COMSPEC 通常是 cmd，这里显式取更现代的 PowerShell），走 PATH 解析；
 *  - *nix：依次尝试 $SHELL → /bin/zsh（macOS 默认）→ /bin/bash → /bin/sh，取第一个真实存在的可执行文件。
 */
function resolveShell() {
  if (process.platform === "win32") return process.env.COMSPEC || "powershell.exe";
  for (const c of [process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"]) {
    if (c && isFile(c)) return c;
  }
  return "/bin/sh";
}

/**
 * 选一个「确实存在」的工作目录：目标目录不存在时先尝试创建（默认工作目录 ~/zeraix-workspace
 * 在 macOS 上可能尚未建立，直接用它 spawn 会 posix_spawnp 失败），仍不行则回退到用户主目录 / cwd。
 */
function resolveCwd(preferred) {
  let dir = preferred || getWorkingDir() || os.homedir();
  if (!isDir(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* 无权限 / 非法路径：下面回退 */
    }
  }
  if (!isDir(dir)) dir = os.homedir();
  if (!isDir(dir)) dir = process.cwd();
  return dir;
}

/**
 * 新建一个 PTY 会话，绑定到发起窗口的 webContents（用于回推输出）。
 * cwd 默认取当前工作目录（与文件树 / AI 工具一致），落在用户所选项目目录下。
 * 返回会话 id，供后续 write / resize / kill 引用。spawn 失败时抛出清晰错误（供渲染层提示，不静默崩溃）。
 */
export function createTerminal(webContents, opts = {}) {
  const shell = opts.shell || resolveShell();
  const cwd = resolveCwd(opts.cwd);
  const cols = Math.max(1, Math.floor(opts.cols) || 80);
  const rows = Math.max(1, Math.floor(opts.rows) || 24);

  let pty;
  try {
    pty = nodePty.spawn(shell, opts.args || [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      // 继承主进程环境，并声明 256 色终端类型，令交互程序输出彩色 / 走 TUI 分支。
      env: { ...process.env, TERM: "xterm-256color" },
    });
  } catch (e) {
    // 抛出可读错误（含 shell/cwd），渲染层 catch 后在终端里提示，而非「Uncaught (in promise)」。
    throw new Error(`无法启动终端（shell=${shell}, cwd=${cwd}）：${e instanceof Error ? e.message : String(e)}`);
  }

  const id = ++seq;
  sessions.set(id, { pty, webContents });

  pty.onData((data) => {
    if (!webContents.isDestroyed()) webContents.send("terminal:data", { id, data });
  });
  pty.onExit(({ exitCode, signal }) => {
    sessions.delete(id);
    if (!webContents.isDestroyed()) webContents.send("terminal:exit", { id, exitCode, signal });
  });
  // 渲染窗口销毁（关闭 / 刷新）→ 清理其名下所有会话。
  webContents.once("destroyed", () => killByWebContents(webContents));

  return id;
}

/** 写入用户输入（原样透传给 PTY，含控制字符 / 组合键序列）。 */
export function writeTerminal(id, data) {
  const s = sessions.get(id);
  if (s && typeof data === "string") s.pty.write(data);
}

/** 调整 PTY 尺寸（xterm fit 后同步，供 TUI 正确重排）。 */
export function resizeTerminal(id, cols, rows) {
  const s = sessions.get(id);
  if (s && cols > 0 && rows > 0) {
    try {
      s.pty.resize(Math.floor(cols), Math.floor(rows));
    } catch {
      /* 尺寸非法 / 会话已退出，忽略 */
    }
  }
}

/** 结束单个会话。 */
export function killTerminal(id) {
  const s = sessions.get(id);
  if (!s) return;
  try {
    s.pty.kill();
  } catch {
    /* 已退出，忽略 */
  }
  sessions.delete(id);
}

/** 结束某窗口名下的全部会话（窗口销毁时调用）。 */
export function killByWebContents(wc) {
  for (const [id, s] of sessions) {
    if (s.webContents === wc) {
      try {
        s.pty.kill();
      } catch {
        /* 忽略 */
      }
      sessions.delete(id);
    }
  }
}

/** 结束所有会话（应用退出前清理）。 */
export function killAllTerminals() {
  for (const [, s] of sessions) {
    try {
      s.pty.kill();
    } catch {
      /* 忽略 */
    }
  }
  sessions.clear();
}
