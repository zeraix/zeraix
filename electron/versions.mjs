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

/**
 * GGUF `general.architecture` tags the pinned llama.cpp build (LLAMA_VERSION) can load — used by the model-library Browse tab
 * to stamp Hub search results supported / unsupported (an arch missing from GGUF metadata shows as "unknown"; nothing is hard-blocked,
 * since this list can lag behind upstream). Update together with LLAMA_VERSION; catalog-model archs must always be present.
 */
export const SUPPORTED_ARCHS = new Set([
  "llama", "llama4", "deci", "falcon", "falcon-h1", "gpt2", "gptj", "gptneox", "mpt", "baichuan",
  "starcoder", "starcoder2", "refact", "bert", "nomic-bert", "jina-bert-v2", "bloom", "stablelm",
  "qwen", "qwen2", "qwen2moe", "qwen2vl", "qwen3", "qwen3moe", "qwen3vl", "qwen3vlmoe", "qwen35", "qwen35moe", // qwen35* = Qwen3.5/3.6 family (verified: unsloth/Qwen3.6-35B-A3B-MTP-GGUF → qwen35moe)
  "phi2", "phi3", "phimoe", "plamo", "plamo2", "codeshell", "orion", "internlm2", "internlm3",
  "minicpm", "minicpm3", "gemma", "gemma2", "gemma3", "gemma3n", "gemma4", "gemma4moe", "gemma-embedding",
  "mamba", "mamba2", "jamba", "command-r", "cohere2", "dbrx", "olmo", "olmo2", "olmoe", "openelm", "arctic",
  "deepseek", "deepseek2", "chatglm", "glm4", "glm4moe", "bitnet", "t5", "t5encoder", "jais",
  "nemotron", "nemotron-h", "exaone", "exaone4", "rwkv6", "rwkv7", "granite", "granitemoe", "granitehybrid",
  "chameleon", "smollm3", "ernie4.5", "ernie4.5-moe", "hunyuan-moe", "hunyuan-dense", "seed-oss",
  "gpt-oss", "lfm2", "lfm2moe", "dots1", "minimax-m2", "kimi-k2", "bailingmoe", "bailingmoe2",
  "smallthinker", "apertus", "afmoe", "grok",
]);
