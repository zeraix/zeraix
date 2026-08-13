/**
 * Version constants: the single source of truth lives in electron/versions.json (easy to read/write
 * and update by hand); this module only reads it out and re-exports named values, for import by the
 * runtime (llamaInstaller / qemu) and build/publish scripts (the import surface stays unchanged).
 * Pure node, no electron dependency.
 *
 * llama: the llama.cpp release tag; `npm run publish:llama <tag>` writes it back to the JSON after publishing.
 * vm: per-arch short hash of the docker image ID. The vm-image workflow reports it; commit it here
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
 * Hash of the [messages[0] + tools] prefix the app currently sends — the seed release tag.
 *
 * A build-time constant because the main process cannot compute it: the prompt and tool declarations are composed in the renderer.
 * Regenerate with `npm run seed:capture && npm run seed:gen`, then bump this to the prefixHash the generator prints. Stale value =
 * the app asks for a seed tag that does not exist, gets a 404, and prefills cold. Wrong value that DOES exist would be worse, but
 * cannot happen: the server refuses any archive whose model_key is not its own.
 */
/**
 * The macOS fork build: its GitHub release tag, and the KV disk format version that build writes.
 *
 * ONE record, because they are one fact. KVD_VER lives in the fork's common/kv-disk.cpp and is not exposed anywhere the app can
 * read it — not in --version, not in the startup log — so the app has to assert it. Keeping it beside the tag means bumping the
 * binary puts the format version directly under your cursor; as two separate keys it was a number nobody would think to check.
 *
 * Getting it wrong is silent, which is why it matters: the seed key embeds kvd<N>, so a stale value asks for an archive that
 * exists, downloads ~300 MB, and is then rejected by the reader (which compares the header and fails closed) — leaving a cold
 * prefill and no error. Bump both together, or better, teach the server to print KVD_VER and read it back.
 *
 * macOS runs the fork; Windows stays on the CDN's pinned upstream `llama` version above. Two separate builds, not two versions of
 * one.
 */
export const MAC_LLAMA = data.macLlama ?? { tag: null, kvdVersion: null };
export const MAC_LLAMA_TAG = MAC_LLAMA.tag;
export const SEED_KVD = MAC_LLAMA.kvdVersion;

export const SEED_PREFIX = data.seedPrefix || null;



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
