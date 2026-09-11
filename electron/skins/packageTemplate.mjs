/**
 * The official skin package template, as the zip that Settings → Appearance → Skin packages →
 * "Download package template" saves.
 *
 * Source: electron/skins/package-template/ -- README.md, my-skin/ (a package that installs as it is)
 * and schemas/ (JSON Schemas generated from the app's own registries and validators by
 * scripts/gen-skin-template-schemas.mjs; test/skin-template.test.mjs fails while they are stale).
 * Kept under electron/ so the packaged main process can read it: Node's fs reads through app.asar.
 * Plain readdir + stat rather than `withFileTypes`, which asar has not always supported.
 *
 * `.vscode/settings.json` is added here rather than stored, because electron-builder's `**` globs
 * skip dot-folders: a stored copy would never reach the installer.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeZip } from "./zipio.mjs";

export const TEMPLATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "package-template");
export const TEMPLATE_FILE_NAME = "zeraix-skin-package-template.zip";
/** The folder inside the template that is the package itself. */
export const TEMPLATE_PACKAGE_DIR = "my-skin";

/** VS Code: completion and inline checks for every JSON file of the package. */
export const VSCODE_SETTINGS = Object.freeze({
  "json.schemas": [
    { fileMatch: ["**/manifest.json"], url: "./schemas/manifest.schema.json" },
    { fileMatch: ["**/layout.json"], url: "./schemas/layout.schema.json" },
    { fileMatch: ["**/components.json"], url: "./schemas/components.schema.json" },
    { fileMatch: ["**/sidebar.json"], url: "./schemas/sidebar.schema.json" },
  ],
});

function walk(dir, rel = "") {
  const out = [];
  for (const name of fs.readdirSync(dir).sort((a, b) => a.localeCompare(b))) {
    if (name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...walk(full, r));
    else if (st.isFile()) out.push({ name: r, data: fs.readFileSync(full) });
  }
  return out;
}

/** Every file of the template zip, in a stable order. */
export function templateEntries(dir = TEMPLATE_DIR) {
  return [...walk(dir), { name: ".vscode/settings.json", data: Buffer.from(`${JSON.stringify(VSCODE_SETTINGS, null, 2)}\n`) }];
}

export const buildPackageTemplateZip = (dir = TEMPLATE_DIR) => writeZip(templateEntries(dir));
