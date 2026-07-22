/**
 * Automation run-state database handle (main process). See docs/automation-workflow-design.md §9.
 *
 * Two persistence layers, deliberately split:
 *   - Workflow *definitions* are versioned JSON files (definitions.mjs) -- diffable and exportable.
 *   - Workflow *run state* lives here in SQLite -- append-heavy, queryable, time-ranged.
 *
 * Uses the built-in `node:sqlite` (Electron 42 ships Node 24), NOT better-sqlite3. That keeps this a
 * pure-JS dependency: no electron-rebuild step in dev and no asarUnpack entry when packaging, which
 * is the tax node-pty already charges. `node:sqlite` is still flagged experimental upstream, so the
 * surface used here is deliberately narrow: DatabaseSync + exec/prepare/run/get/all.
 *
 * The schema itself lives in migrations.mjs, and the storage root comes from storage.mjs -- neither
 * imports `electron`, which is what keeps this module testable in a plain Node process.
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "./migrations.mjs";
import { automationRoot, dbFile } from "./storage.mjs";

let db = null;

/** Open the database (idempotent), creating the directory and applying pending migrations. */
export function openDb() {
  if (db) return db;
  fs.mkdirSync(automationRoot(), { recursive: true });
  db = new DatabaseSync(dbFile());

  // WAL lets the scheduler write while the UI reads a projection without blocking each other.
  db.exec("PRAGMA journal_mode = WAL");
  // Enforce the ON DELETE CASCADE declarations in the schema; SQLite ignores them otherwise.
  db.exec("PRAGMA foreign_keys = ON");

  const { from, to } = migrate(db);
  if (from !== to) console.log(`[automation] database migrated v${from} -> v${to}`);
  return db;
}

/** The open handle, opening on first use. */
export function getDb() {
  return db ?? openDb();
}

/** Close the handle (called on quit; safe to call when never opened). */
export function closeDb() {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  db = null;
}
