/**
 * Version constants: the single source of truth lives in electron/versions.json (easy to read/write
 * and update by hand); this module only reads it out and re-exports named values, for import by the
 * runtime (llamaInstaller / qemu) and build/publish scripts (the import surface stays unchanged).
 * Pure node, no electron dependency.
 *
 * llama: the llama.cpp release tag; `npm run publish:llama <tag>` writes it back to the JSON after publishing.
 * vm: per-arch short hash of the docker image ID. `npm run build:rootfs` writes it back automatically
 *   based on `docker image inspect`.
 *   The OSS/CDN path is vm/<arch>/<id>/; the local directory is .../vm/<id>/. An empty value = that
 *   architecture has not been built/published yet.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const data = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./versions.json", import.meta.url)), "utf8"));

export const LLAMA_VERSION = data.llama;
export const VM_VERSION = data.vm; // { amd64, arm64 }
