/**
 * app.config: an INI config file located alongside the executable that persists the
 * [llm] / [limits] / [ui] parameters the user adjusts under "Settings". Loaded into memory at
 * startup; the renderer reads/writes it via IPC; every write is flushed to disk.
 *
 * Structure: { [section]: { [key]: string } }, serialized as INI (; comments, [section], key=value).
 * Only string scalars are stored; no escaping (key names are controlled, values are endpoints / models / keys / numbers, none with newlines).
 * A value may contain '=' (e.g. an endpoint with a query string): on parse, split only on the "first =".
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

/** Config file path: prefer the electron-builder portable directory, otherwise the directory containing the executable. */
function configPath() {
  const dir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath("exe"));
  return path.join(dir, "app.config");
}

/** Expose the config file's absolute path (for the main process's "Open app.config" action). */
export function getConfigPath() {
  return configPath();
}

/** Ensure the config file exists on disk (if not, flush the current in-memory snapshot), and return its path. */
export function ensureConfigFile() {
  const p = configPath();
  try {
    if (!fs.existsSync(p)) persist();
  } catch {
    /* a failed flush does not prevent a later open attempt */
  }
  return p;
}

let cache = null; // { section: { key: value } }; null means not yet loaded from disk

function parseIni(text) {
  const out = {};
  let section = "default";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      section = sec[1].trim();
      out[section] ??= {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (!key) continue;
    (out[section] ??= {})[key] = val;
  }
  return out;
}

function serializeIni(obj) {
  const lines = [
    "; Zeraix app.config",
    "; Written automatically by \"Settings\"; may also be edited by hand (takes effect after restarting the app).",
    "",
  ];
  for (const section of Object.keys(obj)) {
    const entries = Object.entries(obj[section] || {});
    if (entries.length === 0) continue;
    lines.push(`[${section}]`);
    for (const [k, v] of entries) lines.push(`${k}=${v}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Load the config into memory (idempotent; a missing file / read failure is treated as empty config). */
export function loadAppConfig() {
  try {
    cache = parseIni(fs.readFileSync(configPath(), "utf8"));
  } catch {
    cache = {};
  }
  return cache;
}

function ensure() {
  if (cache === null) loadAppConfig();
  return cache;
}

/** Return the full in-memory config object (for the renderer to synchronously grab the initial snapshot). */
export function getAppConfig() {
  return ensure();
}

function persist() {
  try {
    fs.writeFileSync(configPath(), serializeIni(cache), "utf8");
  } catch (e) {
    console.error("[app.config] write failed:", e?.message || e);
  }
}

/** Set a key (an empty value / null deletes the key). Flushed to disk on write; returns the latest config object. */
export function setAppConfig(section, key, value) {
  const c = ensure();
  if (!section || !key) return c;
  if (value === "" || value == null) {
    if (c[section]) {
      delete c[section][key];
      if (Object.keys(c[section]).length === 0) delete c[section];
    }
  } else {
    (c[section] ??= {})[key] = String(value);
  }
  persist();
  return c;
}

/** Delete a key. */
export function removeAppConfig(section, key) {
  return setAppConfig(section, key, "");
}

/**
 * Ensure a section contains the given keys: any missing ones are filled with an empty string and flushed.
 * Used to seed "user must fill in manually" config items (e.g. [google] client_id) into app.config -- so the
 * user can see the section directly in dev / after packaging and fill it in, without having to guess the key
 * names out of thin air. An empty-string value serializes normally to `key=` (parse/serialize round-trip
 * safe) and is treated as "unconfigured" by readers (e.g. googleAuth). Existing keys are left untouched (user values are not overwritten).
 */
export function ensureAppConfigKeys(section, keys) {
  const c = ensure();
  const target = (c[section] ??= {});
  let changed = false;
  for (const key of keys) {
    if (!(key in target)) {
      target[key] = "";
      changed = true;
    }
  }
  if (changed) persist();
  return c;
}
