// Preload（沙箱、CommonJS）：把主进程的 AI 工具集安全地暴露给渲染层。
// 渲染层通过 window.aiTools 列出声明 / 按名调用；真正的 fs / 子进程操作都在主进程。
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("aiTools", {
  /** 列出工具声明，format: "raw" | "openai" | "anthropic"（默认 raw）。 */
  list: (format = "raw") => ipcRenderer.invoke("ai-tools:list", format),
  /** 按名调用工具，返回 { ok, content }。content 即可回灌给模型的结果文本。 */
  call: (name, args = {}) => ipcRenderer.invoke("ai-tools:call", { name, args }),
  /** 读取 / 设置工作目录（所有文件操作都限制在其内）。 */
  getWorkingDir: () => ipcRenderer.invoke("ai-tools:get-workdir"),
  setWorkingDir: (dir) => ipcRenderer.invoke("ai-tools:set-workdir", dir),
  /** 工作区文件浏览：结构化列目录 / 带可打开性判断读文件 / 保存文件（供侧栏文件树 + 右侧编辑器）。 */
  wsReadDir: (relPath = "") => ipcRenderer.invoke("workspace:read-dir", relPath),
  wsReadFile: (relPath) => ipcRenderer.invoke("workspace:read-file", relPath),
  wsWriteFile: (relPath, content) => ipcRenderer.invoke("workspace:write-file", { path: relPath, content }),
  /** 取拖入 / 选择的 File 的宿主真实路径（Electron webUtils；合成/剪贴板文件返回空串）。
   *  在渲染层拿到路径后即可让主进程按路径拷贝，避免把大文件字节经 IPC 结构化克隆传递。 */
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || "";
    } catch {
      return "";
    }
  },
  /** 把附件按宿主路径保存进当前工作目录（文件名安全化 + 重名去重），返回保存的绝对路径。
   *  payload：{ name, srcPath }——主进程内核级拷贝，字节不经 IPC。无宿主路径的合成文件走
   *  window.transfer.toMain("save-attachment", …)（见下方 transfer 世界，以 transfer 移交字节）。 */
  saveAttachment: (payload) => ipcRenderer.invoke("ai-tools:save-attachment", payload),
  /** 注入 / 读取 refine_question 等工具二次调模型所用的大模型配置。 */
  setLLMConfig: (cfg) => ipcRenderer.invoke("ai-tools:set-llm-config", cfg),
  getLLMConfig: () => ipcRenderer.invoke("ai-tools:get-llm-config"),
  /** 弹出原生目录选择框；用户选中则设为工作目录并返回路径，取消返回 null。 */
  chooseWorkingDir: () => ipcRenderer.invoke("ai-tools:choose-workdir"),
  /** 日常模式：在安装目录下创建并返回默认工作目录（用户未自选文件夹时使用）。 */
  defaultWorkingDir: () => ipcRenderer.invoke("ai-tools:default-workdir"),
  /** 停止某个后台服务（按 pid）。 */
  stopProcess: (pid) => ipcRenderer.invoke("ai-tools:stop-process", pid),
  /** 列出当前后台服务 [{ pid, url, command }]。 */
  listProcesses: () => ipcRenderer.invoke("ai-tools:list-processes"),
  /** 订阅后台服务启停事件 { type:'started'|'stopped', pid, url?, command? }；返回取消订阅。 */
  onServiceEvent: (cb) => {
    const handler = (_e, evt) => cb(evt);
    ipcRenderer.on("services:event", handler);
    return () => ipcRenderer.removeListener("services:event", handler);
  },
});

// 项目级技能发现：检测 .claude/.cursor/.zeraix 等目录里的技能文件，并管理用户在
// .zeraix/config.json 里的「添加 / 忽略」决定。主进程实现见 electron/tools/projectSkills.mjs。
contextBridge.exposeInMainWorld("projectSkills", {
  /** 发现当前项目里的技能（含已决定 / 待决定状态）：{ workdir, skills:[{path,source,name,description,status}] }。 */
  discover: () => ipcRenderer.invoke("project-skills:discover"),
  /** 记录一个技能的决定：enabled=true 添加、false 忽略。写入 .zeraix/config.json。 */
  decide: (path, enabled) => ipcRenderer.invoke("project-skills:decide", { path, enabled }),
  /** 读取某个技能文件的原始内容（供「查看内容」）。 */
  read: (path) => ipcRenderer.invoke("project-skills:read", path),
  /** 已启用项目技能（含指令正文），供喂给智能体：[{path,source,name,description,instructions}]。 */
  loadEnabled: () => ipcRenderer.invoke("project-skills:load-enabled"),
});

// 通用「渲染层 → 主进程」大数据传输：以 MessagePort transfer 移交 ArrayBuffer 所有权，
// 避免 ipcRenderer.invoke 的结构化克隆整体复制。主进程侧见 electron/transferBridge.mjs。
// 每次调用起一条一次性 MessageChannel：port2 连同元数据交给主进程，port1 以 transfer 送字节，
// 主进程按 kind 路由处理后经同一端口回传结果，随即两端关闭。
contextBridge.exposeInMainWorld("transfer", {
  /** 把 ArrayBuffer 以 transfer 移交到主进程 kind 处理器并等待结果（Promise）。
   *  @param {string} kind 处理器标识（主进程 onTransfer 注册的同名）
   *  @param {object} meta 小的结构化元数据（随端口一起结构化克隆，别放大对象）
   *  @param {ArrayBuffer} buffer 要移交的字节（调用后在渲染层失效，勿再引用）
   *  @param {number} [timeoutMs=60000] 超时（防止主进程无应答时挂起）。 */
  toMain: (kind, meta, buffer, timeoutMs = 60000) =>
    new Promise((resolve, reject) => {
      const { port1, port2 } = new MessageChannel();
      const finish = (fn, arg) => {
        clearTimeout(timer);
        try {
          port1.close();
        } catch {
          /* 已关闭 */
        }
        fn(arg);
      };
      const timer = setTimeout(
        () => finish(reject, new Error(`transfer "${kind}" timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      port1.onmessage = (e) => {
        const r = e.data || {};
        if (r.ok) finish(resolve, r.value);
        else finish(reject, new Error(r.error || `transfer "${kind}" failed`));
      };
      try {
        ipcRenderer.postMessage("transfer:port", { kind, meta }, [port2]); // 移交端口 + 元数据
        port1.postMessage(buffer, [buffer]); // transfer 移交字节所有权（零拷贝语义）
      } catch (err) {
        finish(reject, err instanceof Error ? err : new Error(String(err)));
      }
    }),
});

// 大模型请求代理：主进程转发 OpenAI 兼容请求，绕过渲染层 CORS。
contextBridge.exposeInMainWorld("llm", {
  chat: (req) => ipcRenderer.invoke("llm:chat", req),
  // 流式：chatStream 发起（resolve 于流结束）；onChatChunk 订阅增量（返回退订函数）；abortChatStream 中断。
  chatStream: (id, req) => ipcRenderer.invoke("llm:chat:stream", { id, req }),
  onChatChunk: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on("llm:chat:chunk", listener);
    return () => ipcRenderer.removeListener("llm:chat:chunk", listener);
  },
  abortChatStream: (id) => ipcRenderer.send("llm:chat:abort", id),
});

// OSS 上传代理：主进程 PUT 预签名 URL，绕过 app:// 源的 CORS 预检拦截。
// payload = { url, contentType, data:ArrayBuffer }。
contextBridge.exposeInMainWorld("upload", {
  putOSS: (payload) => ipcRenderer.invoke("upload:put-oss", payload),
});

// 在系统文件管理器 / 默认应用中打开路径（文件或文件夹）。
contextBridge.exposeInMainWorld("shellApi", {
  openPath: (path) => ipcRenderer.invoke("shell:open-path", path),
});

// 本地 llama.cpp 模型：硬件探测 / 依硬件推荐 / 启停 / 状态订阅。
// 就绪后渲染层据 status().endpoint 注册一条「本地」模型并设为默认（见 src/lib/ai/localModel.ts）。
contextBridge.exposeInMainWorld("localLlm", {
  /** 粗探测硬件 { hw, cuda, supported, minMemGB }。 */
  hardware: () => ipcRenderer.invoke("llm:local:hardware"),
  /** 本地文件存储位置 { dir, custom, freeGB, suggestion }（llama 运行时 + GGUF 模型）。 */
  storageInfo: () => ipcRenderer.invoke("llm:local:storageInfo"),
  /** 设置存储位置（空=恢复默认）；返回最新 storageInfo。 */
  setStorageDir: (dir) => ipcRenderer.invoke("llm:local:setStorageDir", dir),
  /** 弹原生目录选择框并保存；取消返回 null，否则返回最新 storageInfo。 */
  chooseStorageDir: () => ipcRenderer.invoke("llm:local:chooseStorageDir"),
  /** 依 useCuda 选定的构建变体及是否已安装 { variant, installed, version }。opts?: { useCuda? }。 */
  installInfo: (opts) => ipcRenderer.invoke("llm:local:installInfo", opts),
  /** 含/不含 CUDA 两候选变体的安装状态 { version, cuda, variants }（供默认选中已装的，避免多余下载）。 */
  installStatus: () => ipcRenderer.invoke("llm:local:installStatus"),
  /** 第 1 步：安装运行时 bundle（已装跳过下载）。opts?: { useCuda? }。进度经 onStatus 推送。 */
  install: (opts) => ipcRenderer.invoke("llm:local:install", opts),
  /** 第 2 步：用已装二进制探测显存 { vramGB, device, gpuPresent }。opts?: { useCuda? }。 */
  probe: (opts) => ipcRenderer.invoke("llm:local:probe", opts),
  /** 依探测显存推荐模型 { primary, options }。opts?: { vramGB?, device?, budgetGB?, ctx? }。 */
  recommend: (opts) => ipcRenderer.invoke("llm:local:recommend", opts),
  /** 第 3 步：启动本地模型。opts: { modelId?, quantId?, hf?, ctx?, useCuda? }。ready 稍后经 onStatus 到达。 */
  start: (opts) => ipcRenderer.invoke("llm:local:start", opts),
  /** 停止本地模型。 */
  stop: () => ipcRenderer.invoke("llm:local:stop"),
  /** 「重新开始」：停服 + 清除探测/模型，回到第 1 步（保留已装运行时）。 */
  reset: () => ipcRenderer.invoke("llm:local:reset"),
  /** 当前状态 { running, ready, phase, port, endpoint, model, installed, probe, error }。 */
  status: () => ipcRenderer.invoke("llm:local:status"),
  /** 已下载的本地模型列表 [{ repo, quant, dir, sizeBytes, running }]。 */
  listModels: () => ipcRenderer.invoke("llm:local:models"),
  /** 删除一个已下载模型 { dir } → { ok, error? }。 */
  deleteModel: (opts) => ipcRenderer.invoke("llm:local:delete", opts),
  /** GGUF 模型下载目录。 */
  modelsDir: () => ipcRenderer.invoke("llm:local:models-dir"),
  /** 依选项估算内存占用 { totalGB, weightGB, kvGB }。opts: { modelId, quant, ctx, kvBits, vision }。 */
  estimate: (opts) => ipcRenderer.invoke("llm:local:estimate", opts),
  /** llama 运行时信息 { version, installed, upToDate, updatable, binDir, root, variant }。 */
  llamaInfo: () => ipcRenderer.invoke("llm:local:llama-info"),
  /** 订阅状态变化（加载中 / 就绪 / 退出 / 错误）；返回取消订阅。 */
  onStatus: (cb) => {
    const handler = (_e, st) => cb(st);
    ipcRenderer.on("llm:local:status", handler);
    return () => ipcRenderer.removeListener("llm:local:status", handler);
  },
});

// 沙箱（QEMU VM 命令执行引擎）：状态查询 / 模式同步 / 初始化进度订阅。
// 沙箱在主进程后台初始化（装运行时 → 拉镜像 → 验证启动），全程不阻塞命令执行；
// 就绪且处于「日常」模式时命令自动切入沙箱，其余情况保持宿主直跑。
contextBridge.exposeInMainWorld("sandbox", {
  /** 当前状态 { phase, reason, image, pct, mode, active }。 */
  getStatus: () => ipcRenderer.invoke("sandbox:get-status"),
  /** 同步当前模式（"daily" | "dev"）：沙箱只服务日常模式。 */
  setMode: (mode) => ipcRenderer.invoke("sandbox:set-mode", mode),
  /** VM 镜像目录（rootfs.qcow2 等所在）：供启动弹窗展示 / 打开文件夹。 */
  vmDir: () => ipcRenderer.invoke("sandbox:vm-dir"),
  /** VM 镜像版本 / 安装信息（version / complete / updatable / otherVersions / dir）。 */
  vmInfo: () => ipcRenderer.invoke("sandbox:vm-info"),
  /** 更新 / 重启运行环境（下载 versions.json 的目标版本）；进度经 onStatus 推送。 */
  update: () => ipcRenderer.invoke("sandbox:update"),
  /** 重启运行环境（不强制下载，用已有镜像）：VM 崩溃后重新拉起；进度经 onStatus 推送。 */
  restart: () => ipcRenderer.invoke("sandbox:restart"),
  /** 订阅初始化进度 / 就绪 / 错误事件；返回取消订阅。 */
  onStatus: (cb) => {
    const handler = (_e, st) => cb(st);
    ipcRenderer.on("sandbox:status", handler);
    return () => ipcRenderer.removeListener("sandbox:status", handler);
  },
});

// <webview> 自动化：在独立 utilityProcess 中跑 puppeteer-core（CDP）；start 启动监视，
// onEvent 订阅状态 / 触发事件（如检测到站内搜索）。
contextBridge.exposeInMainWorld("automation", {
  start: (config) => ipcRenderer.invoke("automation:start", config),
  stop: () => ipcRenderer.invoke("automation:stop"),
  /** 下发页面操作（read / links / click / type / navigate），返回 { ok, result?, error? }。 */
  action: (payload) => ipcRenderer.invoke("automation:action", payload),
  onEvent: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on("automation:event", handler);
    return () => ipcRenderer.removeListener("automation:event", handler);
  },
  /** 订阅「站内开新标签」（主进程拦截 webview 弹窗后转发）。 */
  onNewTab: (cb) => {
    const handler = (_e, info) => cb(info);
    ipcRenderer.on("webview:new-tab", handler);
    return () => ipcRenderer.removeListener("webview:new-tab", handler);
  },
  /** 告知当前活动标签 URL（决定 CDP 操作哪个 webview）。 */
  setActiveUrl: (url) => ipcRenderer.invoke("automation:set-active-url", url),
  saveShot: (dataUrl) => ipcRenderer.invoke("browser:save-shot", dataUrl),
});

// 对话 / 项目记录持久化：主进程按项目分文件读写（目录可在设置里自定义）。
contextBridge.exposeInMainWorld("agentStore", {
  /** 读取项目索引 { projects }。 */
  loadIndex: () => ipcRenderer.invoke("agent-store:load-index"),
  /** 读取单个项目的对话 { conversations }。 */
  loadProject: (id) => ipcRenderer.invoke("agent-store:load-project", id),
  /** 覆盖写入项目索引。 */
  saveIndex: (projects) => ipcRenderer.invoke("agent-store:save-index", projects),
  /** 覆盖写入单个项目的对话。 */
  saveProject: (id, conversations) => ipcRenderer.invoke("agent-store:save-project", { id, conversations }),
  /** 删除单个项目的对话文件。 */
  deleteProject: (id) => ipcRenderer.invoke("agent-store:delete-project", id),
  /** 当前存储目录。 */
  getPath: () => ipcRenderer.invoke("agent-store:get-path"),
  /** 设置存储目录（迁移数据并持久化），返回新目录。 */
  setPath: (dir) => ipcRenderer.invoke("agent-store:set-path", dir),
  /** 弹出原生目录选择框设置存储目录；返回新目录，取消返回 null。 */
  choosePath: () => ipcRenderer.invoke("agent-store:choose-path"),
});

// 聊天完整性：设备标识、加密状态、以及每会话完整性元数据 sidecar 的读写。
// 加密对渲染层透明（正文加解密在主进程随落盘自动完成）；此处只暴露元数据与标识。
contextBridge.exposeInMainWorld("chatIntegrity", {
  /** 取稳定的本机 deviceId（首次生成并持久化）。 */
  getDeviceId: () => ipcRenderer.invoke("integrity:get-device-id"),
  /** 加密状态 { enabled, mode: "keychain" | "plain" | "disabled" }。 */
  encryptionStatus: () => ipcRenderer.invoke("integrity:encryption-status"),
  /** 读取某会话的完整性元数据（不存在返回 null）。 */
  loadMeta: (chatId) => ipcRenderer.invoke("integrity:load-meta", chatId),
  /** 覆盖写入某会话的完整性元数据。 */
  saveMeta: (chatId, meta) => ipcRenderer.invoke("integrity:save-meta", { chatId, meta }),
  /** 删除某会话的完整性元数据。 */
  deleteMeta: (chatId) => ipcRenderer.invoke("integrity:delete-meta", chatId),
  /** 列出全部会话的完整性元数据（启动批量对账用）。 */
  listMeta: () => ipcRenderer.invoke("integrity:list-meta"),
});

// 基于文件的记忆：每条记忆一个 Markdown 文件（userData/memories/<id>.md）。供 AI 的 save_memory 工具写入。
contextBridge.exposeInMainWorld("memoryFiles", {
  /** 保存/更新一条记忆 { title, content, id? } → { id, title, file, created, updated }。 */
  save: (input) => ipcRenderer.invoke("memory-md:save", input),
  /** 列出全部记忆（按更新时间倒序）。 */
  list: () => ipcRenderer.invoke("memory-md:list"),
  /** 删除一条记忆（按 id）。 */
  remove: (id) => ipcRenderer.invoke("memory-md:delete", id),
  /** 用系统文件管理器打开记忆目录。 */
  openDir: () => ipcRenderer.invoke("memory-md:open-dir"),
  /** 弹出文件选择框导入 .md/.txt 为记忆，返回 { imported }。 */
  import: () => ipcRenderer.invoke("memory-md:import"),
  /** 下载记忆模板 .md（id 随机、时间戳为下载时刻），返回 { ok, path? }。 */
  downloadTemplate: () => ipcRenderer.invoke("memory-md:download-template"),
  /** 一键把全部记忆导出为 ZIP，返回 { ok, path?, count?, empty? }。 */
  exportZip: () => ipcRenderer.invoke("memory-md:export-zip"),
});

// app.config：可执行文件同级的 INI 配置文件（[llm] / [limits] / [ui]）。
// getAllSync 走同步通道，供启动时把文件值灌入渲染层存储，避免异步竞态。
contextBridge.exposeInMainWorld("appConfig", {
  /** 同步取完整配置快照 { section: { key: value } }。 */
  getAllSync: () => ipcRenderer.sendSync("appconfig:get-all-sync"),
  /** 写入一个键（空值即删除），落盘。 */
  set: (section, key, value) => ipcRenderer.invoke("appconfig:set", { section, key, value }),
  /** 删除一个键。 */
  remove: (section, key) => ipcRenderer.invoke("appconfig:remove", { section, key }),
  /** 用系统默认编辑器打开 app.config（不存在则先创建），返回 { ok, path, error? }。 */
  openFile: () => ipcRenderer.invoke("appconfig:open-file"),
  /** 取 app.config 绝对路径。 */
  getPath: () => ipcRenderer.invoke("appconfig:get-path"),
});

// 系统级通知：渲染层 → 主进程通知服务（队列 / 合并 / 限流 / OS 弹窗），点击回传路由。
contextBridge.exposeInMainWorld("notification", {
  /** 发送一条系统通知，返回 { ok, id?, merged?, supported }。payload 见 NotificationItem。 */
  send: (payload) => ipcRenderer.invoke("notify:send", payload),
  /** 当前系统是否支持原生通知。 */
  isSupported: () => ipcRenderer.invoke("notify:supported"),
  /** 列出通知历史（倒序）[{ id, item, read, createdAt }]。 */
  list: () => ipcRenderer.invoke("notify:list"),
  /** 未读数量（徽标用）。 */
  unreadCount: () => ipcRenderer.invoke("notify:unread-count"),
  /** 标记单条 / 全部已读。 */
  markRead: (id) => ipcRenderer.invoke("notify:mark-read", id),
  markAllRead: () => ipcRenderer.invoke("notify:mark-all-read"),
  /** 删除单条 / 清空历史。 */
  remove: (id) => ipcRenderer.invoke("notify:remove", id),
  clear: () => ipcRenderer.invoke("notify:clear"),
  /** 订阅点击通知触发的应用内跳转（Deep Link）；返回取消订阅。 */
  onNavigate: (cb) => {
    const handler = (_e, route) => cb(route);
    ipcRenderer.on("route:navigate", handler);
    return () => ipcRenderer.removeListener("route:navigate", handler);
  },
  /** 订阅动作按钮点击 { id, index, actionId }；返回取消订阅。 */
  onAction: (cb) => {
    const handler = (_e, info) => cb(info);
    ipcRenderer.on("notify:action", handler);
    return () => ipcRenderer.removeListener("notify:action", handler);
  },
  /** 订阅历史变化（新通知 / 已读 / 删除），用于刷新通知中心；返回取消订阅。 */
  onChange: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("notify:changed", handler);
    return () => ipcRenderer.removeListener("notify:changed", handler);
  },
});

// Google 登录：渲染层触发主进程 RFC 8252 原生流程（系统浏览器 + 环回 + PKCE），
// 主进程换取 Google id_token 后交回；渲染层再 POST /auth/google 完成登录。
contextBridge.exposeInMainWorld("googleAuth", {
  /** 启动 Google 登录流程，返回 { ok, idToken?, canceled?, error? }。 */
  signIn: () => ipcRenderer.invoke("google-auth:signin"),
});

// 自定义协议（Deep Link）：用户在系统浏览器点回调页的「Open Zeraix」按钮 → OS 把应用带到前台，
// 主进程把解析后的 zeraix://… 转发到此。渲染层可订阅做可选的应用内路由（登录已在应用内完成）。
contextBridge.exposeInMainWorld("deepLink", {
  /** 订阅深链唤起 { url, host, pathname, params }；返回取消订阅函数。 */
  onOpen: (cb) => {
    const handler = (_e, info) => cb(info);
    ipcRenderer.on("deep-link", handler);
    return () => ipcRenderer.removeListener("deep-link", handler);
  },
});

// 窗口控制：渲染层自绘的 macOS 风格红绿灯调用主进程控制窗口。
contextBridge.exposeInMainWorld("windowControls", {
  /** 最小化窗口。 */
  minimize: () => ipcRenderer.invoke("window:minimize"),
  /** 切换最大化 / 还原，返回切换后的最大化状态。 */
  toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
  /** 关闭窗口。 */
  close: () => ipcRenderer.invoke("window:close"),
  /** 查询当前是否最大化。 */
  isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  /** 订阅最大化状态变化；返回取消订阅函数。 */
  onMaximizeChange: (cb) => {
    const handler = (_e, maximized) => cb(maximized);
    ipcRenderer.on("window:maximize-changed", handler);
    return () => ipcRenderer.removeListener("window:maximize-changed", handler);
  },
  /** macOS 专用：隐藏 / 恢复原生红绿灯（由自绘按钮接管时调用）。 */
  setNativeButtons: (visible) => ipcRenderer.invoke("window:set-native-buttons", visible),
  /** 查询窗口是否置顶（always-on-top）。 */
  isAlwaysOnTop: () => ipcRenderer.invoke("window:is-always-on-top"),
  /** 设置窗口置顶，返回设置后的状态。 */
  setAlwaysOnTop: (on) => ipcRenderer.invoke("window:set-always-on-top", on),
  /** 切换窗口置顶，返回切换后的状态。 */
  toggleAlwaysOnTop: () => ipcRenderer.invoke("window:toggle-always-on-top"),
  /** 订阅置顶状态变化；返回取消订阅函数。 */
  onAlwaysOnTopChange: (cb) => {
    const handler = (_e, on) => cb(on);
    ipcRenderer.on("window:always-on-top-changed", handler);
    return () => ipcRenderer.removeListener("window:always-on-top-changed", handler);
  },
});

// 内置终端：渲染层 xterm.js ⇄ 主进程 node-pty 会话（见 electron/tools/terminal.mjs）。
contextBridge.exposeInMainWorld("terminal", {
  /** 新建 PTY 会话，返回会话 id。opts?: { cols, rows, cwd }（cwd 缺省用当前工作目录）。 */
  create: (opts) => ipcRenderer.invoke("terminal:create", opts || {}),
  /** 写入用户输入（原样透传，含控制字符）。 */
  write: (id, data) => ipcRenderer.send("terminal:write", { id, data }),
  /** 同步终端尺寸（xterm fit 后调用）。 */
  resize: (id, cols, rows) => ipcRenderer.send("terminal:resize", { id, cols, rows }),
  /** 结束会话。 */
  kill: (id) => ipcRenderer.send("terminal:kill", id),
  /** 结束本窗口名下的全部会话（关闭文件侧栏时彻底终止所有终端）。 */
  killAll: () => ipcRenderer.send("terminal:kill-all"),
  /** 订阅 PTY 输出 { id, data }；返回取消订阅函数。 */
  onData: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("terminal:data", handler);
    return () => ipcRenderer.removeListener("terminal:data", handler);
  },
  /** 订阅会话退出 { id, exitCode, signal }；返回取消订阅函数。 */
  onExit: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("terminal:exit", handler);
    return () => ipcRenderer.removeListener("terminal:exit", handler);
  },
});
