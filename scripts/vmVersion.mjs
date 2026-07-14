/**
 * Version file (electron/versions.json) write-back helper + docker image ID shortening. Pure node, imported by the publish/build scripts.
 *   build:rootfs   → take the image ID from `docker image inspect` and write it back to vm.<arch>;
 *   publish:llama  → write back llama after publishing.
 */
import fs from "node:fs";
import path from "node:path";

const jsonFile = (repoRoot) => path.join(repoRoot, "electron", "versions.json");
const read = (repoRoot) => JSON.parse(fs.readFileSync(jsonFile(repoRoot), "utf8"));
const write = (repoRoot, data) => fs.writeFileSync(jsonFile(repoRoot), JSON.stringify(data, null, 2) + "\n");

/** docker image ID (sha256:…) → short version "sha-<12hex>". */
export function shortImageId(id) {
  return "sha-" + String(id).replace(/^sha256:/, "").slice(0, 12);
}

/** Write back vm.<arch> (amd64 / arm64). Returns true = updated. */
export function writeVmVersion(arch, version, repoRoot = process.cwd()) {
  const d = read(repoRoot);
  (d.vm ??= {});
  if (d.vm[arch] === version) return false;
  d.vm[arch] = version;
  write(repoRoot, d);
  return true;
}

/** Write back llama. Returns true = updated. */
export function writeLlamaVersion(version, repoRoot = process.cwd()) {
  const d = read(repoRoot);
  if (d.llama === version) return false;
  d.llama = version;
  write(repoRoot, d);
  return true;
}
