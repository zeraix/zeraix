/**
 * native 执行引擎：直接在宿主机上执行命令（即重构前 aiToolkit.mjs 的原始行为，代码
 * 原样迁入）。作为默认引擎与兜底引擎：当 qemu 沙箱不可用或单次调用
 * 失败降级时，一律走这里，行为与历史版本完全一致。
 *
 * 引擎契约（engine.mjs）：
 *   run(cmd, { cwd, timeoutMs, maxBuffer })  → { stdout, stderr, code, killed }（不抛异常）
 *   startBackground(cmd, { cwd })            → Promise<string>（格式化的启动结果文本；
 *                                               自行维护进程表并通过 events.mjs 广播启停）
 *   stopProcess(pid) / listProcesses() / stopAll()
 */

import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";

import { emitService } from "./events.mjs";

const execAsync = promisify(exec);

export const id = "native";

// 后台持久进程（dev server / watcher 等）：pid → { command, url }。用于展示 / 停止 / 退出时清理。
const bgProcs = new Map();

/**
 * 解码控制台输出。Windows 的 cmd/dir 等默认按 OEM 代码页输出（中文系统为 cp936/GBK），
 * 直接按 UTF-8 解码会出现乱码。这里先按 UTF-8 解，若出现替换符 U+FFFD 再回退 GBK(gb18030)，
 * 取替换符更少者，从而同时兼容 UTF-8 与 GBK 输出。
 */
export function decodeConsole(buf) {
  if (!buf || buf.length === 0) return "";
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(data);
  if (!utf8.includes("�")) return utf8;
  try {
    const gbk = new TextDecoder("gb18030", { fatal: false }).decode(data);
    const bad = (s) => (s.match(/�/g) || []).length;
    return bad(gbk) <= bad(utf8) ? gbk : utf8;
  } catch {
    return utf8; // 运行时无该解码器时退回 UTF-8
  }
}

/** 前台执行：exec + 超时 + 输出上限，返回已解码的 { stdout, stderr, code, killed }，不抛异常。 */
export async function run(cmd, { cwd, timeoutMs, maxBuffer } = {}) {
  try {
    // 以原始字节读取，再按代码页解码，避免中文控制台输出（cp936/GBK）乱码。
    const { stdout, stderr } = await execAsync(cmd, {
      cwd,
      timeout: timeoutMs,
      maxBuffer,
      windowsHide: true,
      encoding: "buffer",
    });
    return { stdout: decodeConsole(stdout), stderr: decodeConsole(stderr), code: 0, killed: false };
  } catch (e) {
    // exec 在非零退出码 / 超时时 reject，但仍带 stdout/stderr/code。
    return {
      stdout: decodeConsole(e.stdout),
      stderr: decodeConsole(e.stderr),
      code: e.code ?? "?",
      killed: !!e.killed,
    };
  }
}

/**
 * 以非阻塞后台方式启动命令：不随 60s 超时被杀。抓取启动早期输出（出现本地地址/就绪关键字即提前返回，
 * 否则最多等 8s），进程继续在后台运行。返回启动输出 + pid 提示。
 */
export function startBackground(cmd, { cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, {
        cwd,
        shell: true,
        windowsHide: true,
        detached: process.platform !== "win32", // 非 Windows 自成进程组，便于整树结束
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve(`后台启动失败：${e?.message || e}`);
      return;
    }
    const pid = child.pid;
    if (pid) bgProcs.set(pid, { command: cmd, url: "" });
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length > 64 * 1024) buf = buf.subarray(-64 * 1024);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => {
      if (pid) bgProcs.delete(pid);
      resolve(`后台启动失败：${e?.message || e}`);
    });
    child.on("exit", () => {
      if (pid && bgProcs.has(pid)) {
        bgProcs.delete(pid);
        emitService({ type: "stopped", pid }); // 进程结束 → 通知渲染层移除
      }
    });
    child.unref?.();

    const READY = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+|listening|compiled|ready|started|running at/i;
    const startedAt = Date.now();
    // 从输出里提取首个本地服务地址（dev server 通常会打印，如 http://localhost:8081）。
    const pickUrl = (s) => {
      const m = s.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s"'`)\]]*/i);
      if (!m) return "";
      try {
        const u = new URL(m[0]);
        const host = u.hostname === "0.0.0.0" ? "localhost" : u.hostname;
        return `${u.protocol}//${host}${u.port ? `:${u.port}` : ""}`;
      } catch {
        return m[0];
      }
    };
    const timer = setInterval(() => {
      const out = decodeConsole(buf);
      const exited = !pid || !bgProcs.has(pid);
      if (READY.test(out) || exited || Date.now() - startedAt > 8000) {
        clearInterval(timer);
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onData);
        const alive = pid && bgProcs.has(pid);
        const url = pickUrl(out);
        // 记录地址并通知渲染层展示（GlobalNotifications 显示「运行中的项目 + 地址 + 停止」）。
        if (alive) {
          bgProcs.set(pid, { command: cmd, url });
          emitService({ type: "started", pid, url, command: cmd });
        }
        // 首行给出明确结论，便于模型直接判断「已成功启动」，而不是纠结于原始日志。
        const headline = alive
          ? `✅ 服务已在后台成功启动并持续运行${url ? `：${url}` : ""}${pid ? `（pid ${pid}）` : ""}。`
          : "⚠️ 进程已结束（可能是一次性命令，或启动即退出）。";
        resolve(
          `${headline}\n\n` +
            `--- 启动输出 ---\n${out.trim() || "(暂无输出)"}\n` +
            (alive
              ? "\n说明：服务在后台持续运行，本次调用不阻塞、也不会被超时杀掉。" +
                (url ? `你可以用 openBrowser 打开 ${url} 预览，或直接告知用户「已启动」。` : "") +
                "请勿再次执行同一启动命令、也不要等待它结束。"
              : ""),
        );
      }
    }, 300);
  });
}

/** 停止某个后台进程（按 pid，整树结束）。返回是否已发起停止。 */
export function stopProcess(pid) {
  const n = Number(pid);
  if (!bgProcs.has(n)) return false;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(n), "/T", "/F"], { windowsHide: true });
    } else {
      process.kill(-n, "SIGTERM");
    }
  } catch {
    /* 可能已退出 */
  }
  return true;
}

/** 列出当前后台进程（供渲染层初始同步）。 */
export function listProcesses() {
  return [...bgProcs.entries()].map(([pid, v]) => ({ pid, url: v.url || "", command: v.command || "" }));
}

/** 结束全部后台进程（供应用退出时清理）。Windows 用 taskkill 整树结束，其它平台按进程组。 */
export function stopAll() {
  for (const pid of bgProcs.keys()) {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
      } else {
        process.kill(-pid, "SIGTERM");
      }
    } catch {
      /* 已退出 / 无权限则忽略 */
    }
  }
  bgProcs.clear();
}
