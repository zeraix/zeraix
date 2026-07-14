/**
 * 通用「渲染层 → 主进程」大数据传输通道（基于 MessagePort transfer）。
 *
 * 为什么不用 ipcRenderer.invoke：invoke 用结构化克隆整体序列化实参，大的 ArrayBuffer 会在
 * 渲染层被完整复制进消息、再在主进程反序列化复制一次；而 MessagePort 以 transfer 语义移交
 * 缓冲区所有权（渲染层不再持有），底层走 Mojo 共享内存，更省内存也不占用主 IPC 通道。适合
 * 传输无宿主路径、字节只在渲染层内存里的数据（如 webview 拖出的合成文件、canvas 生成的 Blob）。
 * 真实磁盘文件仍应只传路径（见 saveAttachment 的 srcPath 分支），根本不必搬字节。
 *
 * 协议（每次调用一条一次性 MessageChannel，用完即弃、请求/应答天然对应，无需请求 id）：
 *   渲染层：ipcRenderer.postMessage("transfer:port", { kind, meta }, [port2])  // 移交一个端口 + 元数据
 *          port1.postMessage(buffer, [buffer])                                 // transfer 移交字节
 *   主进程：按 kind 路由到处理器 handler(meta, ArrayBuffer) → 结果经同一端口回传 → 关闭端口
 *
 * 用法（主进程，app ready 后一次）：
 *   installTransferBridge();
 *   onTransfer("save-attachment", async (meta, buffer) => { …; return absPath; });
 */
import { ipcMain } from "electron";

const handlers = new Map(); // kind -> async (meta, ArrayBuffer) => value

/** 注册一个传输处理器。kind 唯一（重复注册即覆盖）；handler 的返回值回传渲染层。 */
export function onTransfer(kind, handler) {
  handlers.set(kind, handler);
}

let installed = false;

/** 安装 IPC 接收端（幂等；重复调用无副作用）。 */
export function installTransferBridge() {
  if (installed) return;
  installed = true;
  ipcMain.on("transfer:port", (event, envelope) => {
    const port = event.ports?.[0];
    if (!port) return;
    const kind = envelope?.kind;
    const meta = envelope?.meta;
    let done = false; // 每个端口只处理一条数据消息，处理完即关闭
    port.on("message", async (e) => {
      if (done) return;
      done = true;
      try {
        const handler = handlers.get(kind);
        if (!handler) throw new Error(`no transfer handler registered for kind: ${kind}`);
        const value = await handler(meta, e.data);
        port.postMessage({ ok: true, value });
      } catch (err) {
        port.postMessage({ ok: false, error: String(err?.message ?? err) });
      } finally {
        port.close();
      }
    });
    port.start();
  });
}
