/**
 * Local persistence of system notification history (main process) -- the data layer for the notification center (/notifications).
 *
 * The design doc suggests SQLite; here we stick with the project's existing single-file JSON approach (consistent with conversationStore),
 * avoiding a native dependency. Notification history is small (capped at MAX_RECORDS entries, discarding the oldest beyond that), so JSON is enough;
 * if full-text search / large volumes are needed later, it can be smoothly swapped for SQLite without changing the external interface.
 *
 * Layout: userData/notifications/history.json -- { records: NotificationRecord[] } (in reverse chronological order)
 *   NotificationRecord = { id, item, read: boolean, createdAt: number }
 * A read failure always falls back to an empty array and never throws in a way that takes down the main process.
 */
import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";

/** History cap: beyond this, discard the oldest records to prevent unbounded file growth. */
const MAX_RECORDS = 500;

let cache = null; // in-memory cache (records array, reverse order); lazily loaded

function historyFile() {
  return path.join(app.getPath("userData"), "notifications", "history.json");
}

/** Lazily read from disk into the in-memory cache. */
async function ensureLoaded() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(await fs.readFile(historyFile(), "utf8"));
    cache = Array.isArray(raw?.records) ? raw.records : [];
  } catch {
    cache = []; // file missing / corrupted -> empty history
  }
  return cache;
}

/** Flush the whole table to disk (debounced: coalesce multiple writes within the same tick). */
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
    console.error("[notification] failed to flush history to disk:", e);
  }
}

/** Append a history record (inserted at the front in reverse order, trimmed to the cap). Returns the record itself. */
export async function appendRecord(item) {
  const records = await ensureLoaded();
  const record = { id: item.id, item, read: false, createdAt: Date.now() };
  records.unshift(record);
  if (records.length > MAX_RECORDS) records.length = MAX_RECORDS;
  scheduleFlush();
  return record;
}

/** List all history (reverse order). */
export async function listHistory() {
  return (await ensureLoaded()).slice();
}

/** Unread count (for the badge). */
export async function unreadCount() {
  return (await ensureLoaded()).filter((r) => !r.read).length;
}

/** Mark a single record as read; ignore if it doesn't exist. Returns whether a record was matched. */
export async function markRead(id) {
  const records = await ensureLoaded();
  const r = records.find((x) => x.id === id);
  if (!r || r.read) return false;
  r.read = true;
  scheduleFlush();
  return true;
}

/** Mark all as read. Returns the number marked. */
export async function markAllRead() {
  const records = await ensureLoaded();
  let n = 0;
  for (const r of records) if (!r.read) { r.read = true; n++; }
  if (n) scheduleFlush();
  return n;
}

/** Delete a single record. Returns whether a record was matched. */
export async function removeRecord(id) {
  const records = await ensureLoaded();
  const idx = records.findIndex((x) => x.id === id);
  if (idx < 0) return false;
  records.splice(idx, 1);
  scheduleFlush();
  return true;
}

/** Clear all history. */
export async function clearHistory() {
  cache = [];
  scheduleFlush();
  return true;
}
