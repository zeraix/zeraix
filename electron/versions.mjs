/**
 * 版本常量：数据单一来源在 electron/versions.json（便于读写 / 手动更新）；本模块只读出并具名导出，
 * 供运行时（llamaInstaller / qemu）与构建/发布脚本引入（导入面不变）。纯 node，不依赖 electron。
 *
 * llama：llama.cpp release tag，`npm run publish:llama <tag>` 发布后自动写回 JSON。
 * vm：各架构 docker 镜像 ID 短哈希（per-arch）。`npm run build:rootfs` 依 `docker image inspect` 自动写回。
 *   OSS/CDN 路径为 vm/<arch>/<id>/；本地目录为 .../vm/<id>/。空值 = 尚未构建/发布该架构。
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const data = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./versions.json", import.meta.url)), "utf8"));

export const LLAMA_VERSION = data.llama;
export const VM_VERSION = data.vm; // { amd64, arm64 }
