/**
 * 系统通知历史的本地持久化（主进程）—— 通知中心（/notifications）的数据层。
 *
 * 设计文档建议 SQLite；此处沿用项目既有的 JSON 单文件方案（与 conversationStore 一致），
 * 避免引入原生依赖。通知历史体量小（上限 MAX_RECORDS 条，超出丢弃最旧），JSON 足矣；
 * 如后续需要全文检索 / 大体量，可平滑替换为 SQLite，对外接口不变。
 *
 * 布局：userData/notifications/history.json —— { records: NotificationRecord[] }（按时间倒序）
 *   NotificationRecord = { id, item, read: boolean, createdAt: number }
 * 读失败一律回退为空数组，绝不抛异常拖垮主进程。
 */
import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";

/** 历史上限：超出后丢弃最旧记录，防止文件无限增长。 */
const MAX_RECORDS = 500;

let cache = null; // 内存缓存（records 数组，倒序）；惰性加载

function historyFile() {
  return path.join(app.getPath("userData"), "notifications", "history.json");
}

/** 惰性读盘到内存缓存。 */
async function ensureLoaded() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(await fs.readFile(historyFile(), "utf8"));
    cache = Array.isArray(raw?.records) ? raw.records : [];
  } catch {
    cache = []; // 文件缺失 / 损坏 → 空历史
  }
  return cache;
}

/** 整表落盘（防抖：合并同一 tick 内的多次写）。 */
let flushTimer = null;
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, 200);
}
async function flush() {
  if (!cache) return;
  try {
    const file = historyFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ records: cache }, null, 2), "utf8");
  } catch (e) {
    console.error("[notification] 历史落盘失败：", e);
  }
}

/** 追加一条历史记录（倒序插入队首，裁剪到上限）。返回记录本身。 */
export async function appendRecord(item) {
  const records = await ensureLoaded();
  const record = { id: item.id, item, read: false, createdAt: Date.now() };
  records.unshift(record);
  if (records.length > MAX_RECORDS) records.length = MAX_RECORDS;
  scheduleFlush();
  return record;
}

/** 列出全部历史（倒序）。 */
export async function listHistory() {
  return (await ensureLoaded()).slice();
}

/** 未读数量（供徽标）。 */
export async function unreadCount() {
  return (await ensureLoaded()).filter((r) => !r.read).length;
}

/** 标记单条已读；不存在则忽略。返回是否命中。 */
export async function markRead(id) {
  const records = await ensureLoaded();
  const r = records.find((x) => x.id === id);
  if (!r || r.read) return false;
  r.read = true;
  scheduleFlush();
  return true;
}

/** 全部标记已读。返回被标记数量。 */
export async function markAllRead() {
  const records = await ensureLoaded();
  let n = 0;
  for (const r of records) if (!r.read) { r.read = true; n++; }
  if (n) scheduleFlush();
  return n;
}

/** 删除单条。返回是否命中。 */
export async function removeRecord(id) {
  const records = await ensureLoaded();
  const idx = records.findIndex((x) => x.id === id);
  if (idx < 0) return false;
  records.splice(idx, 1);
  scheduleFlush();
  return true;
}

/** 清空全部历史。 */
export async function clearHistory() {
  cache = [];
  scheduleFlush();
  return true;
}
