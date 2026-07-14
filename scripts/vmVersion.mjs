/**
 * 版本文件（electron/versions.json）写回助手 + docker 镜像 ID 短化。纯 node，供发布/构建脚本引入。
 *   build:rootfs   → 取 `docker image inspect` 的镜像 ID，写回 vm.<arch>；
 *   publish:llama  → 发布后写回 llama。
 */
import fs from "node:fs";
import path from "node:path";

const jsonFile = (repoRoot) => path.join(repoRoot, "electron", "versions.json");
const read = (repoRoot) => JSON.parse(fs.readFileSync(jsonFile(repoRoot), "utf8"));
const write = (repoRoot, data) => fs.writeFileSync(jsonFile(repoRoot), JSON.stringify(data, null, 2) + "\n");

/** docker 镜像 ID（sha256:…）→ 短版本 "sha-<12hex>"。 */
export function shortImageId(id) {
  return "sha-" + String(id).replace(/^sha256:/, "").slice(0, 12);
}

/** 写回 vm.<arch>（amd64 / arm64）。返回 true=已更新。 */
export function writeVmVersion(arch, version, repoRoot = process.cwd()) {
  const d = read(repoRoot);
  (d.vm ??= {});
  if (d.vm[arch] === version) return false;
  d.vm[arch] = version;
  write(repoRoot, d);
  return true;
}

/** 写回 llama。返回 true=已更新。 */
export function writeLlamaVersion(version, repoRoot = process.cwd()) {
  const d = read(repoRoot);
  if (d.llama === version) return false;
  d.llama = version;
  write(repoRoot, d);
  return true;
}
