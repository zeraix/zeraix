import { app, BrowserWindow, dialog, ipcMain, protocol, shell, utilityProcess } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listTools, runTool, getWorkingDir, setWorkingDir, saveAttachment, setLLMConfig, getLLMConfig, setServiceEventHandler, stopProcess, listProcesses, initEngine, disposeEngines, getSandboxStatus, setSandboxMode, onSandboxStatus, restartSandbox, sandboxVmInfo, wsReadDir, wsReadFile, wsWriteFile } from "./tools/aiToolkit.mjs";
import { discoverProjectSkills, setProjectSkillDecision, readProjectSkillFile, loadEnabledProjectSkills } from "./tools/projectSkills.mjs";
import { createTerminal, writeTerminal, resizeTerminal, killTerminal, killByWebContents, killAllTerminals } from "./tools/terminal.mjs";
import { llmChat, llmChatStream } from "./llm/proxy.mjs";
import * as localLlm from "./llm/localServer.mjs";
import { installTransferBridge, onTransfer } from "./transferBridge.mjs";
import {
  loadIndex,
  loadProject,
  saveIndex,
  saveProject,
  deleteProject,
  getStorePath,
  setStorePath,
} from "./store/conversationStore.mjs";
import {
  loadAppConfig,
  getAppConfig,
  setAppConfig,
  removeAppConfig,
  getConfigPath,
  ensureConfigFile,
  ensureAppConfigKeys,
} from "./appConfig.mjs";
import {
  initIntegrity,
  encryptionStatus,
  getDeviceId,
  loadMeta,
  saveMeta,
  deleteMeta,
  listMeta,
} from "./integrity/integrityStore.mjs";
import {
  saveMemoryFile,
  listMemoryFiles,
  deleteMemoryFile,
  openMemoryDir,
  importFromPaths,
  countMemoryFiles,
  saveTemplateFile,
  exportMemoriesZip,
} from "./memoryFiles.mjs";
import { registerNotifications } from "./ipc/notificationIpc.mjs";
import { registerGoogleAuth } from "./ipc/googleAuthIpc.mjs";
import { loadEnvFiles } from "./loadEnv.mjs";
import { registerProtocolClient, findDeepLink } from "./services/deepLink.mjs";

// CDP 远程调试端口：puppeteer-core 经此连接，自动化在独立 utilityProcess 中驱动 <webview>。
// 必须在 app ready 之前追加这些开关。仅监听 127.0.0.1。
// remote-allow-origins 必不可少：自 Chrome 111+，DevTools WebSocket 默认拒绝非浏览器客户端，
// 不设它 puppeteer.connect 会连不上（403）。
const REMOTE_DEBUG_PORT = 9222;
app.commandLine.appendSwitch("remote-debugging-port", String(REMOTE_DEBUG_PORT));
app.commandLine.appendSwitch("remote-allow-origins", "*");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isDev = !app.isPackaged;
const DEV_SERVER_URL = "http://localhost:3000";

// 主进程不像 Next 那样自动读取 .env*（那是 Next dev server 的行为）。dev 下按 Next 优先级
// 把项目根的 .env 文件灌入 process.env，供主进程逻辑（如 Google 登录读取 client id）使用。
// 打包后这些文件通常不存在，静默跳过（打包分发建议改由 app.config 注入 client id）。
if (isDev) loadEnvFiles(path.join(__dirname, ".."), process.env.NODE_ENV || "development");

// 单实例锁：`zeraix://` 深链在 Windows/Linux 上以「新进程 + argv 带 URL」的方式唤起本应用，
// 必须靠单实例锁把它交回首个实例，否则每次点链接都会另起一个应用窗口。
// 拿不到锁 = 自己是被深链唤起的第二个实例：把 URL 交给首个实例后立即退出（见 second-instance）。
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

// 登记为 zeraix:// 协议的默认处理程序（开发态动态登记，打包态由 electron-builder 声明）。
registerProtocolClient();

// 冷启动即带深链（Windows/Linux：应用未运行时点链接 → 首次启动 argv 里就有 URL）。
// app ready 前只能先暂存，待窗口就绪后再处理。macOS 冷启动走 open-url，见下方监听。
let pendingDeepLink = findDeepLink(process.argv);

/** 把主窗口带到前台（最小化则还原、隐藏则显示并聚焦）；无窗口则新建。 */
function focusMainWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * 处理一条 `zeraix://…` 深链：把应用带到前台，并把解析后的结构转发给渲染层
 * （供登录完成后做可选的应用内路由）。app 未 ready 时先暂存，ready 后由启动流程补处理。
 */
function handleDeepLink(url) {
  if (!url) return;
  if (!app.isReady()) {
    pendingDeepLink = url;
    return;
  }
  console.log("[deep-link] 唤起：", url);
  focusMainWindow();
  try {
    const u = new URL(url);
    mainWindow?.webContents.send("deep-link", {
      url,
      host: u.host,
      pathname: u.pathname,
      params: Object.fromEntries(u.searchParams),
    });
  } catch {
    /* 非法 URL：已把窗口带到前台，忽略解析失败 */
  }
}

// Windows/Linux：第二个实例（多为深链唤起）启动 → 首个实例在此收到其 argv，
// 捞出深链并把窗口带到前台。
app.on("second-instance", (_e, argv) => {
  focusMainWindow();
  handleDeepLink(findDeepLink(argv));
});

// macOS：系统以 open-url 事件递送深链（可能早于 app ready，handleDeepLink 内部会暂存）。
app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

// 兜底：主进程任何未捕获异常 / 未处理拒绝都只记录，绝不让应用整体退出。
// （例如内置浏览器加载失败、自动化/子进程异步错误等，均不应连累主窗口。）
process.on("uncaughtException", (err) => {
  console.error("[main] 未捕获异常（已忽略，应用继续运行）：", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[main] 未处理的 Promise 拒绝（已忽略）：", reason);
});

/** Next.js 静态导出目录（next.config.ts 中 distDir: "Zeraix"） */
const WEB_ROOT = path.join(app.getAppPath(), "Zeraix");

/** 自定义协议，用于在生产环境加载静态导出文件（file:// 无法处理绝对路径资源） */
const APP_SCHEME = "app";
const APP_URL = `${APP_SCHEME}://localhost/`;

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

/**
 * 按 Next.js 静态导出的路由规则解析请求路径：
 * /foo -> foo | foo.html | foo/index.html，最终兜底 404.html / index.html
 */
async function handleAppRequest(request) {
  const { pathname } = new URL(request.url);
  const decoded = decodeURIComponent(pathname);
  // 去掉开头的斜杠并阻止路径穿越
  const rel = path
    .normalize(decoded)
    .replace(/^[/\\]+/, "")
    .replace(/^(\.\.([/\\]|$))+/, "");

  const candidates =
    rel === "" ? ["index.html"] : [rel, `${rel}.html`, path.join(rel, "index.html")];
  candidates.push("404.html", "index.html");

  for (const candidate of candidates) {
    try {
      const data = await fs.promises.readFile(path.join(WEB_ROOT, candidate));
      let type =
        MIME_TYPES[path.extname(candidate).toLowerCase()] ?? "application/octet-stream";
      // Next.js 静态导出把 RSC/段缓存负载写成 .txt（整页 `<route>.txt` 与预取 `__next.*.txt`）。
      // App Router 客户端强校验其 content-type 必须是 text/x-component，否则客户端导航抛错
      // （E394「unexpected response」）：router.push 会靠 __pendingUrl 兜底做整页硬跳转而「看似正常」，
      // 但 <Link> 走预取/段缓存路径没有该兜底，点击后静默无反应（侧边栏「技能/自动化」正是如此）。
      // 本目录为纯 Next 导出，所有 .txt 均为 RSC 负载，故统一按 text/x-component 返回。
      if (candidate.endsWith(".txt")) type = "text/x-component";
      return new Response(data, { headers: { "content-type": type } });
    } catch {
      // 尝试下一个候选路径
    }
  }
  return new Response("Not Found", { status: 404 });
}

let mainWindow = null;
let splashWindow = null;

/** 主窗口就绪：显示主窗口（启动画面已移除，splashWindow 恒为 null，走直接 show 分支）。重复调用安全（幂等）。 */
let splashDismissed = false;
function dismissSplash() {
  if (splashDismissed) return;
  splashDismissed = true;
  if (!splashWindow) {
    mainWindow?.show();
    return;
  }
  // 触发页面淡出动画后再关闭，衔接更顺滑；主窗口在动画末尾显示，避免叠画。
  splashWindow.webContents
    .executeJavaScript(`document.getElementById("stage")?.classList.add("leaving")`)
    .catch(() => {});
  setTimeout(() => {
    try {
      splashWindow?.close();
    } catch {
      /* ignore */
    }
    mainWindow?.show();
    mainWindow?.focus();
  }, 320);
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    autoHideMenuBar: true,
    // 内容就绪前保持隐藏，由启动画面遮挡加载空窗期（见 dismissSplash）
    show: false,
    // 无边框窗口：不使用任何原生标题栏 / 覆盖层按钮，窗口控制全部由渲染层自绘
    // （/agent 用侧边栏红绿灯，旧版页面用 TitleBar 右侧按钮 —— 见 windowControls 桥）。
    // Windows/Linux：去掉 titleBarOverlay，否则系统会在右上角画原生最小化/最大化/关闭。
    titleBarStyle: "hidden",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true, // 启用 <webview>（自动化目标）
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  // 外部链接交给系统默认浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // 内置 <webview> 开新标签：guest 的 window.open / target=_blank（如百度结果）→ 拦截后通知
  // 渲染层在浏览器面板新建标签。did-attach-webview 是访问 webview guest 的规范钩子。
  mainWindow.webContents.on("did-attach-webview", (_e, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      console.log("[webview window-open]", url);
      if (/^https?:\/\//.test(url)) mainWindow?.webContents.send("webview:new-tab", { url });
      return { action: "deny" };
    });
    // 内置浏览器加载失败（如预览尚未启动的本地开发服务器 → ERR_CONNECTION_REFUSED）：
    // 仅记录，guest 自身会显示错误页；绝不冒泡为主进程崩溃。
    guest.on("did-fail-load", (_ev, code, desc, url) => {
      if (code === -3) return; // ERR_ABORTED：导航被新导航取代，正常忽略
      console.warn(`[webview] 加载失败 ${code} ${desc}：${url}`);
    });
    guest.on("render-process-gone", (_ev, details) => {
      console.warn("[webview] guest 进程结束：", details?.reason);
    });
  });

  // 渲染层（主窗口）崩溃：仅记录，交由开发者 / 用户手动刷新。
  // 注意：不要在此自动 reload —— 若渲染层持续崩溃会造成无限刷新循环。
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    console.error("[main] 渲染进程结束：", details?.reason);
  });

  // 向渲染层同步最大化状态，驱动自绘「缩放」按钮的图标切换。
  const emitMaximize = () =>
    mainWindow?.webContents.send("window:maximize-changed", mainWindow.isMaximized());
  mainWindow.on("maximize", emitMaximize);
  mainWindow.on("unmaximize", emitMaximize);

  // 内容首帧就绪即撤下启动画面并显示主窗口（ready-to-show 早于 loadURL 兑现，
  // 空窗期最短）。兜底：万一 ready-to-show 未触发，加载完成后也强制撤下。
  mainWindow.once("ready-to-show", dismissSplash);

  if (isDev) {
    await mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    await mainWindow.loadURL(APP_URL);
  }
  dismissSplash();
}

/** AI 工具集 IPC：渲染层 window.aiTools.* → 主进程执行（fs / 子进程） */
// 内置终端：渲染层 xterm.js ⇄ 主进程 node-pty 会话。create 返回会话 id（走 invoke）；
// write/resize/kill 为高频/单向消息（走 send）。PTY 输出经 terminal:data / terminal:exit 推回发起窗口。
function registerTerminal() {
  ipcMain.handle("terminal:create", (e, opts) => createTerminal(e.sender, opts || {}));
  ipcMain.on("terminal:write", (_e, { id, data }) => writeTerminal(id, data));
  ipcMain.on("terminal:resize", (_e, { id, cols, rows }) => resizeTerminal(id, cols, rows));
  ipcMain.on("terminal:kill", (_e, id) => killTerminal(id));
  // 结束发起窗口名下的全部 PTY 会话（关闭文件侧栏时彻底终止所有终端后台进程）。
  ipcMain.on("terminal:kill-all", (e) => killByWebContents(e.sender));
}

function registerAiTools() {
  ipcMain.handle("ai-tools:list", (_e, format) => listTools(format));
  ipcMain.handle("ai-tools:call", (_e, { name, args }) => runTool(name, args));
  ipcMain.handle("ai-tools:get-workdir", () => getWorkingDir());
  ipcMain.handle("ai-tools:set-workdir", (_e, dir) => setWorkingDir(dir));
  // 工作区文件浏览（侧栏文件树 + 右侧编辑器）：结构化列目录、带可打开性判断的读文件、保存文件。
  ipcMain.handle("workspace:read-dir", (_e, relPath) => wsReadDir(relPath || ""));
  ipcMain.handle("workspace:read-file", (_e, relPath) => wsReadFile(relPath));
  ipcMain.handle("workspace:write-file", (_e, { path: p, content }) => wsWriteFile(p, content));
  // 项目级技能发现：扫描 .claude/.cursor/.zeraix 等目录里的技能文件，读/写用户在 .zeraix/config.json
  // 里的「添加 / 忽略」决定，并读取单个技能内容（供「查看内容」）与已启用技能正文（供喂给智能体）。
  ipcMain.handle("project-skills:discover", () => discoverProjectSkills());
  ipcMain.handle("project-skills:decide", (_e, { path: p, enabled }) => setProjectSkillDecision(p, enabled));
  ipcMain.handle("project-skills:read", (_e, relPath) => readProjectSkillFile(relPath));
  ipcMain.handle("project-skills:load-enabled", () => loadEnabledProjectSkills());
  // 把聊天附件保存到操作目录，模型即可用文件工具/沙箱命令直接处理。
  //  - 真实磁盘文件：payload={ name, srcPath }，主进程按宿主路径内核级拷贝，字节不经 IPC；
  //  - 无宿主路径的合成文件：走下方 transfer 通道（MessagePort 移交字节，见 transferBridge.mjs）。
  ipcMain.handle("ai-tools:save-attachment", (_e, payload) => saveAttachment(payload));
  // 通用「渲染层 → 主进程」大数据传输通道 + 附件字节传输处理器（合成文件走此路）。
  installTransferBridge();
  onTransfer("save-attachment", (meta, buffer) => saveAttachment({ name: meta?.name, bytes: buffer }));
  // 后台服务（dev server 等）启停事件 → 广播给所有窗口（GlobalNotifications 展示「运行中的项目」）。
  setServiceEventHandler((evt) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send("services:event", evt);
  });
  // 停止某个后台服务（按 pid）；列出当前后台服务（初始同步）。
  ipcMain.handle("ai-tools:stop-process", (_e, pid) => stopProcess(pid));
  ipcMain.handle("ai-tools:list-processes", () => listProcesses());
  // 沙箱状态：初始同步 + 模式路由（日常模式才用沙箱）+ 初始化进度广播给所有窗口。
  ipcMain.handle("sandbox:get-status", () => getSandboxStatus());
  ipcMain.handle("sandbox:set-mode", (_e, mode) => setSandboxMode(mode));
  // VM 镜像目录（供沙箱启动弹窗展示 / 打开文件夹）：按需动态加载 qemu.mjs 算静态路径。
  ipcMain.handle("sandbox:vm-dir", async () => {
    try { const m = await import("./tools/sandbox/qemu.mjs"); return m.vmImageDir(); } catch { return null; }
  });
  // VM 镜像版本 / 安装信息（供弹窗展示版本与「更新」判断）。
  ipcMain.handle("sandbox:vm-info", () => sandboxVmInfo());
  // 更新运行环境：停当前 VM → 重新初始化并强制下载 versions.json 的目标版本（下载完成后删旧镜像）。
  ipcMain.handle("sandbox:update", () => restartSandbox({ update: true }));
  // 重启运行环境（不强制下载）：VM 崩溃/退出后用已有镜像重新拉起。
  ipcMain.handle("sandbox:restart", () => restartSandbox({}));
  onSandboxStatus((st) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send("sandbox:status", st);
  });
  // 注入 / 读取需要二次调模型的工具（如 refine_question）所用的大模型配置。
  ipcMain.handle("ai-tools:set-llm-config", (_e, cfg) => setLLMConfig(cfg));
  ipcMain.handle("ai-tools:get-llm-config", () => getLLMConfig());
  // 弹出原生目录选择框，让用户自行选择操作目录；选中即设为工作目录并返回。取消返回 null。
  ipcMain.handle("ai-tools:choose-workdir", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { properties: ["openDirectory", "createDirectory"], defaultPath: getWorkingDir() };
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (res.canceled || res.filePaths.length === 0) return null;
    return setWorkingDir(res.filePaths[0]);
  });
  // 日常模式默认工作目录：当用户未自选文件夹时使用。位于与对话记录默认存储位置一致的
  // userData/agent 下（见 conversationStore 的默认路径），结构 agent/ai-agent/default/<应用名>。
  // 全部「未自选文件夹的日常会话」共用这一个固定目录（不再按会话生成随机目录），避免目录无限堆积；
  // 创建后设为工作目录并返回其绝对路径。
  ipcMain.handle("ai-tools:default-workdir", () => {
    const base = path.join(app.getPath("userData"), "agent"); // 与默认数据存储位置一致
    const dir = path.join(base, "ai-agent", "default", app.getName());
    fs.mkdirSync(dir, { recursive: true });
    return setWorkingDir(dir);
  });
}

/** 每个在途流式请求的 AbortController，键为渲染层生成的 stream id（供 llm:chat:abort 中断）。 */
const llmStreamControllers = new Map();

/** 大模型请求代理 IPC：渲染层 window.llm.chat → 主进程转发（绕过 CORS） */
function registerLlmProxy() {
  ipcMain.handle("llm:chat", (_e, req) => llmChat(req));
  // 流式：invoke 发起，期间经 llm:chat:chunk 向发起窗口推增量，完成时 resolve（同 llmChat 的结果结构）。
  // 中断走 llm:chat:abort（单向 send），按 id 取消对应 AbortController。
  ipcMain.handle("llm:chat:stream", async (e, { id, req }) => {
    const controller = new AbortController();
    llmStreamControllers.set(id, controller);
    try {
      return await llmChatStream(
        req,
        (chunk) => {
          if (!e.sender.isDestroyed()) e.sender.send("llm:chat:chunk", { id, chunk });
        },
        controller.signal,
      );
    } finally {
      llmStreamControllers.delete(id);
    }
  });
  ipcMain.on("llm:chat:abort", (_e, id) => {
    llmStreamControllers.get(id)?.abort();
  });
}

/** OSS 上传代理 IPC：渲染层 window.upload.putOSS → 主进程 PUT 预签名 URL。
 *  生产环境渲染层源为 app://localhost，阿里云 OSS 桶的跨域规则通常不含该源，浏览器直接 PUT 会被 CORS 预检拦截；
 *  改由主进程（Node，不受浏览器 CORS 约束）发起 PUT。data 为经 IPC 传来的 ArrayBuffer。 */
function registerUploadProxy() {
  ipcMain.handle("upload:put-oss", async (_e, { url, contentType, data }) => {
    try {
      const res = await fetch(url, {
        method: "PUT",
        body: Buffer.from(data),
        ...(contentType ? { headers: { "Content-Type": contentType } } : {}),
      });
      return { ok: res.ok, status: res.status };
    } catch (e) {
      return { ok: false, status: 0, error: e && e.message ? String(e.message) : String(e) };
    }
  });
}

/** 本地 llama.cpp 模型 IPC：硬件探测 / 推荐 / 启停 / 状态；状态变化推送到渲染层 window.localLlm。 */
function registerLocalLlm() {
  localLlm.onStatus((st) => mainWindow?.webContents.send("llm:local:status", st));
  ipcMain.handle("llm:local:hardware", () => localLlm.getHardware());
  ipcMain.handle("llm:local:storageInfo", () => localLlm.storageInfo());
  ipcMain.handle("llm:local:setStorageDir", (_e, dir) => localLlm.setStorageDir(dir));
  ipcMain.handle("llm:local:chooseStorageDir", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { properties: ["openDirectory", "createDirectory"], defaultPath: localLlm.storageInfo().dir };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || res.filePaths.length === 0) return null;
    // 选目录即「更改文件夹」：把已下载的运行时/模型/日志迁到新位置（同盘秒级，跨盘拷贝）。
    const r = await localLlm.migrateStorageTo(res.filePaths[0]);
    return { ...localLlm.storageInfo(), migrateOk: r.ok, migrateError: r.error };
  });
  ipcMain.handle("llm:local:migrateStorage", (_e, dir) => localLlm.migrateStorageTo(dir));
  ipcMain.handle("llm:local:installInfo", (_e, opts) => localLlm.installInfo(opts));
  ipcMain.handle("llm:local:installStatus", () => localLlm.installStatus());
  ipcMain.handle("llm:local:install", (_e, opts) => localLlm.install(opts));
  ipcMain.handle("llm:local:probe", (_e, opts) => localLlm.probe(opts));
  ipcMain.handle("llm:local:recommend", (_e, opts) => localLlm.recommend(opts));
  ipcMain.handle("llm:local:start", (_e, opts) => localLlm.start(opts));
  ipcMain.handle("llm:local:stop", () => localLlm.stop());
  ipcMain.handle("llm:local:reset", () => localLlm.reset());
  ipcMain.handle("llm:local:status", () => localLlm.status());
  // 模型库：已下载模型列表 / 删除 / 目录 / 内存估算 / 运行时信息。
  ipcMain.handle("llm:local:models", () => localLlm.listDownloaded());
  ipcMain.handle("llm:local:delete", (_e, opts) => localLlm.deleteLocalModel(opts));
  ipcMain.handle("llm:local:models-dir", () => localLlm.modelsDir());
  ipcMain.handle("llm:local:estimate", (_e, opts) => localLlm.estimate(opts));
  ipcMain.handle("llm:local:llama-info", () => localLlm.llamaInfo());
}

/** app.config（可执行文件同级 INI）IPC：渲染层 window.appConfig.* → 主进程读写。
 *  get-all-sync 走同步通道，供启动时把文件值灌入渲染层存储（避免异步竞态）。 */
function registerAppConfig() {
  loadAppConfig();
  // 预置 [google] 段，让用户在 app.config 里直接看到并填写 Google 登录凭据
  // （dev 用 .env 覆盖即可，打包分发则手填此处）。client_id 与 client_secret 对已分发的
  // Desktop 客户端均「不作机密处理」，可随包分发；Google 的 Desktop 客户端 token 交换要求
  // 带上 client_secret，故两者都预置。
  ensureAppConfigKeys("google", ["client_id", "client_secret"]);
  ipcMain.on("appconfig:get-all-sync", (e) => {
    e.returnValue = getAppConfig();
  });
  ipcMain.handle("appconfig:set", (_e, { section, key, value }) =>
    setAppConfig(section, key, value),
  );
  ipcMain.handle("appconfig:remove", (_e, { section, key }) => removeAppConfig(section, key));
  // 用系统默认编辑器打开 app.config；文件不存在则先落盘创建。返回 { ok, path, error? }。
  ipcMain.handle("appconfig:open-file", async () => {
    const p = ensureConfigFile();
    const error = await shell.openPath(p); // 成功返回 ""，失败返回错误串
    return { ok: !error, path: p, error: error || undefined };
  });
  // 返回 app.config 绝对路径（渲染层展示用）。
  ipcMain.handle("appconfig:get-path", () => getConfigPath());
}

/** 窗口控制 IPC：渲染层自绘的 macOS 风格红绿灯 → 主进程控制窗口（最小化 / 缩放 / 关闭） */
function registerWindowControls() {
  const winOf = (e) => BrowserWindow.fromWebContents(e.sender);
  ipcMain.handle("window:minimize", (e) => winOf(e)?.minimize());
  ipcMain.handle("window:toggle-maximize", (e) => {
    const w = winOf(e);
    if (!w) return false;
    if (w.isMaximized()) {
      w.unmaximize();
      return false;
    }
    w.maximize();
    return true;
  });
  ipcMain.handle("window:close", (e) => winOf(e)?.close());
  ipcMain.handle("window:is-maximized", (e) => !!winOf(e)?.isMaximized());
  // 窗口置顶（always-on-top）：查询 / 设置 / 切换。置顶状态供「输出完成」时决定用应用内提示还是系统通知。
  ipcMain.handle("window:is-always-on-top", (e) => !!winOf(e)?.isAlwaysOnTop());
  ipcMain.handle("window:set-always-on-top", (e, on) => {
    const w = winOf(e);
    if (!w) return false;
    w.setAlwaysOnTop(!!on);
    const next = w.isAlwaysOnTop();
    w.webContents.send("window:always-on-top-changed", next); // 广播新状态，渲染层同步按钮 / 提示策略
    return next;
  });
  ipcMain.handle("window:toggle-always-on-top", (e) => {
    const w = winOf(e);
    if (!w) return false;
    const next = !w.isAlwaysOnTop();
    w.setAlwaysOnTop(next);
    w.webContents.send("window:always-on-top-changed", next);
    return next;
  });
  // macOS 专用：按需隐藏 / 恢复原生红绿灯。/agent 模块挂载时隐藏（改由侧边栏自绘按钮
  // 接管），离开时恢复，避免其它仍依赖原生红绿灯的页面失去窗口控制。
  ipcMain.handle("window:set-native-buttons", (e, visible) => {
    if (process.platform !== "darwin") return;
    winOf(e)?.setWindowButtonVisibility(!!visible);
  });
  // 在系统文件管理器 / 默认应用中打开路径（文件或文件夹）：供侧栏「打开文件夹」等 UI 调用。
  ipcMain.handle("shell:open-path", async (_e, p) => {
    if (!p || typeof p !== "string") return { ok: false, error: "empty path" };
    const error = await shell.openPath(p); // 成功返回 ""，失败返回错误串
    return { ok: !error, error: error || undefined };
  });
}

function registerAgentStore() {
  ipcMain.handle("agent-store:load-index", () => loadIndex());
  ipcMain.handle("agent-store:load-project", (_e, id) => loadProject(id));
  ipcMain.handle("agent-store:save-index", (_e, projects) => saveIndex(projects));
  ipcMain.handle("agent-store:save-project", (_e, { id, conversations }) => saveProject(id, conversations));
  ipcMain.handle("agent-store:delete-project", (_e, id) => deleteProject(id));
  ipcMain.handle("agent-store:get-path", () => getStorePath());
  ipcMain.handle("agent-store:set-path", (_e, dir) => setStorePath(dir));
  // 弹出原生目录选择框，选中即作为存储目录（迁移数据并持久化），返回新文件路径；取消返回 null。
  ipcMain.handle("agent-store:choose-path", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { properties: ["openDirectory", "createDirectory"], defaultPath: path.dirname(getStorePath()) };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || res.filePaths.length === 0) return null;
    return setStorePath(res.filePaths[0]);
  });
}

/**
 * 聊天完整性 IPC：渲染层 window.chatIntegrity.* → 主进程管理 deviceId、加密状态、
 * 以及每会话的完整性元数据 sidecar（version/hash/signature，纯元数据、无正文）。
 * 加密本身对渲染层透明（conversationStore 落盘时自动加解密）。
 */
function registerIntegrity() {
  ipcMain.handle("integrity:get-device-id", () => getDeviceId());
  ipcMain.handle("integrity:encryption-status", () => encryptionStatus());
  ipcMain.handle("integrity:load-meta", (_e, chatId) => loadMeta(chatId));
  ipcMain.handle("integrity:save-meta", (_e, { chatId, meta }) => saveMeta(chatId, meta));
  ipcMain.handle("integrity:delete-meta", (_e, chatId) => deleteMeta(chatId));
  ipcMain.handle("integrity:list-meta", () => listMeta());
}

/**
 * 基于文件的记忆 IPC：渲染层 window.memoryFiles.* → 主进程读写 userData/memories/<id>.md。
 * 每条记忆一个 Markdown 文件；供 AI 的 save_memory 工具写入、渲染层列出/删除/打开目录。
 */
function registerMemoryFiles() {
  ipcMain.handle("memory-md:save", (_e, input) => saveMemoryFile(input || {}));
  ipcMain.handle("memory-md:list", () => listMemoryFiles());
  ipcMain.handle("memory-md:delete", (_e, id) => deleteMemoryFile(id));
  ipcMain.handle("memory-md:open-dir", () => openMemoryDir());
  // 导入：弹原生文件选择框（可多选 .md/.markdown/.txt），逐个解析并保存为记忆。返回 { imported }。
  ipcMain.handle("memory-md:import", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = {
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Markdown / Text", extensions: ["md", "markdown", "txt"] }],
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths?.length) return { imported: 0 };
    const items = importFromPaths(res.filePaths);
    return { imported: items.length };
  });
  // 下载模板：弹保存框，写出一份记忆模板 .md（id 随机、时间戳为下载时刻）。返回 { ok, path? }。
  ipcMain.handle("memory-md:download-template", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = {
      defaultPath: "memory-template.md",
      filters: [{ name: "Markdown", extensions: ["md"] }],
    };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return { ok: false };
    try {
      saveTemplateFile(res.filePath);
      return { ok: true, path: res.filePath };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });
  // 一键导出：把全部记忆打包为 ZIP。无记忆返回 { ok:false, empty:true }。返回 { ok, path?, count? }。
  ipcMain.handle("memory-md:export-zip", async (e) => {
    if (countMemoryFiles() === 0) return { ok: false, empty: true };
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { defaultPath: "memories.zip", filters: [{ name: "ZIP", extensions: ["zip"] }] };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return { ok: false };
    try {
      const count = exportMemoriesZip(res.filePath);
      return { ok: true, path: res.filePath, count };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

/**
 * <webview> 自动化 IPC：渲染层 window.automation.* → 主进程在独立 utilityProcess 中跑 puppeteer-core，
 * 经 CDP 远程调试端口连接并监视 <webview> 页面；命中搜索等触发时把事件回传渲染层。
 * 自动化代码与主线程 / 渲染线程隔离，崩溃不影响主进程。
 */
let automationChild = null;
const automationPending = new Map(); // action id -> resolve
let automationActionSeq = 0;
function registerAutomation() {
  const relay = (msg) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("automation:event", msg);
    }
  };
  const ensureChild = () => {
    if (automationChild) return automationChild;
    automationChild = utilityProcess.fork(path.join(__dirname, "automation", "cdpAgent.cjs"), [], {
      serviceName: "cdp-automation",
      stdio: "inherit",
    });
    automationChild.on("message", (msg) => {
      // action-result：解析对应的 action Promise；其余消息转发给渲染层（状态 / 触发）。
      if (msg && msg.type === "action-result") {
        const resolve = automationPending.get(msg.id);
        if (resolve) {
          automationPending.delete(msg.id);
          resolve(msg);
        }
        return;
      }
      relay(msg);
    });
    automationChild.on("exit", () => {
      automationChild = null;
      // 子进程退出：未决的 action 一律失败返回。
      for (const [, resolve] of automationPending) resolve({ ok: false, error: "自动化进程已退出" });
      automationPending.clear();
    });
    return automationChild;
  };
  ipcMain.handle("automation:start", (_e, config) => {
    ensureChild().postMessage({ type: "start", config: { ...config, port: REMOTE_DEBUG_PORT } });
    return true;
  });
  ipcMain.handle("automation:stop", () => {
    automationChild?.postMessage({ type: "stop" });
    return true;
  });
  // 当前活动标签 URL → 让自动化进程把 CDP 挂到对应的 webview（多标签时定位活动页）。
  ipcMain.handle("automation:set-active-url", (_e, url) => {
    automationChild?.postMessage({ type: "active-url", url });
    return true;
  });
  // 下发页面操作（read / links / click / type / navigate），等待子进程回传结果。
  ipcMain.handle("automation:action", (_e, payload) => {
    const child = ensureChild();
    const id = ++automationActionSeq;
    return new Promise((resolve) => {
      automationPending.set(id, resolve);
      child.postMessage({ type: "action", id, action: payload?.action, params: payload?.params ?? {} });
      setTimeout(() => {
        if (automationPending.has(id)) {
          automationPending.delete(id);
          resolve({ ok: false, error: "操作超时" });
        }
      }, 30000);
    });
  });
  // 保存内置浏览器截图（渲染层 webview.capturePage 得到的 data URL）到临时文件，返回路径。
  ipcMain.handle("browser:save-shot", (_e, dataUrl) => {
    try {
      const b64 = String(dataUrl || "").replace(/^data:image\/\w+;base64,/, "");
      if (!b64) return "";
      const file = path.join(app.getPath("temp"), `zeraix-shot-${Date.now()}.png`);
      fs.writeFileSync(file, Buffer.from(b64, "base64"));
      return file;
    } catch (e) {
      console.warn("[browser] 截图保存失败：", e?.message || e);
      return "";
    }
  });
}

// 内置 <webview> 的开新标签处理：站内结果以 target=_blank / window.open 试图开新窗口（如百度）时，
// 拦截并通知宿主渲染层在浏览器面板中新建标签（对齐各搜索引擎跳转行为，避免弹出失控的系统窗口）。
function registerWebviewWindowOpen() {
  app.on("web-contents-created", (_e, contents) => {
    if (typeof contents.getType === "function" && contents.getType() === "webview") {
      contents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//.test(url)) {
          const host = contents.hostWebContents || mainWindow?.webContents;
          host?.send("webview:new-tab", { url });
        }
        return { action: "deny" };
      });
    }
  });
}

/** 系统通知图标：dev 取源码 public/，打包取 Next 静态导出目录 Zeraix/。缺失时适配层自动忽略。 */
function notificationIconPath() {
  return isDev
    ? path.join(__dirname, "..", "public", "logo.png")
    : path.join(app.getAppPath(), "Zeraix", "logo.png");
}

app.whenReady().then(() => {
  // 第二个实例（深链唤起）此前已 app.quit()，不再初始化窗口与各类服务，直接返回。
  if (!gotSingleInstanceLock) return;
  // Windows：Toast 通知必须设置 AppUserModelID（与 electron-builder appId 一致），
  // 否则通知不显示应用名/图标甚至完全不弹。macOS/Linux 无副作用。
  app.setAppUserModelId("com.operease.app");
  // 启动画面已移除：应用直接加载入口（`/`），入口页按登录态分流到 /agent 或 /login。
  // 主窗口内容首帧就绪（ready-to-show）即显示，dismissSplash 在无 splash 时等价于直接 show 主窗口。
  protocol.handle(APP_SCHEME, handleAppRequest);
  // 先初始化加密主密钥（safeStorage 需 app ready），随后 conversationStore 读写即透明加解密。
  initIntegrity();
  registerAppConfig();
  registerAiTools();
  registerTerminal();
  // 选择命令执行引擎（有硬件虚拟化则后台启动 qemu VM，否则保持 native 宿主直跑）。
  // 后台异步进行，失败静默回落 native，不影响启动。
  initEngine();
  registerLlmProxy();
  registerUploadProxy();
  registerLocalLlm();
  registerWindowControls();
  registerAgentStore();
  registerIntegrity();
  registerMemoryFiles();
  // 系统级通知（渲染层 window.notification.* → 队列/合并/限流 → OS 通知；点击回传 route:navigate）
  registerNotifications({ getWindow: () => mainWindow, iconPath: notificationIconPath() });
  // Google 登录（RFC 8252 原生流程：环回服务 + PKCE + 系统浏览器 → id_token 交回渲染层）
  registerGoogleAuth();
  registerAutomation();
  registerWebviewWindowOpen();
  createWindow();

  // 冷启动即带的深链（Windows/Linux argv / macOS 早到的 open-url）在窗口就绪后补处理。
  if (pendingDeepLink) {
    const url = pendingDeepLink;
    pendingDeepLink = null;
    handleDeepLink(url);
  }

  // macOS：点击 Dock 图标时若无窗口则重新创建
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  // 退出前结束自动化子进程，避免悬挂。
  try {
    automationChild?.kill();
  } catch {
    /* ignore */
  }
  // 退出前结束所有内置终端的 PTY 会话，避免残留 shell 进程。
  try {
    killAllTerminals();
  } catch {
    /* ignore */
  }
  // 退出前结束本地 llama-server 子进程，避免残留孤儿进程占用端口。
  try {
    localLlm.stop();
  } catch {
    /* ignore */
  }
  // 结束 AI 启动的后台进程（dev server / watcher 等）并关停沙箱 VM（若在用），
  // 避免退出后残留孤儿进程占用端口。
  try {
    disposeEngines();
  } catch {
    /* ignore */
  }
});

app.on("window-all-closed", () => {
  // macOS 习惯：关闭所有窗口后应用保持活跃
  if (process.platform !== "darwin") app.quit();
});
