/**
 * Per-vendor adapters. Each knows exactly one dialect; nothing else in the codebase does.
 *
 * Only vendors verified against live docs get one. A wrong base URL is a runtime 404, and an absent
 * adapter simply means "this vendor cannot generate images" — a safe default. Qwen and Doubao are
 * plausible but unverified, and therefore absent.
 */
import type { AdapterResult, CapabilityAdapter, GenerationArtifact, GenerationModel } from "./types";

/** Shape shared by all three vendors' /images/generations responses (fields vary; all optional). */
interface ImagesResponse {
  data?: { url?: string; b64_json?: string }[];
  /** Zhipu only: safety verdict, delivered in-band with HTTP 200. level 0 is the most severe. */
  content_filter?: { role?: string; level?: number }[];
  /** OpenAI only: the format actually produced ("png" | "jpeg" | "webp"). Reported by the API, so
   *  the data: URL's mime is read from it rather than assumed — a base64 payload carries no other
   *  clue as to what it is. */
  output_format?: string;
  error?: { message?: string; type?: string; code?: string };
  message?: string;
}

const httpError = (json: ImagesResponse, status: number): AdapterResult => {
  const message = json.error?.message || json.message || `HTTP ${status}`;
  const kind = status === 401 || status === 403 ? "auth" : status === 429 ? "quota" : "unknown";
  return { ok: false, error: { kind, message } };
};

/** Only formats the image endpoints actually emit; anything else falls back to png. */
const MIME_BY_FORMAT: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  webp: "image/webp",
};

/**
 * data[0] → artifact. Handles both dialects: a hosted url, or inline base64.
 *
 * The mime is taken from the response's own `output_format` when the vendor reports one (OpenAI
 * does; it can return png/jpeg/webp). It is png in practice because we never send `output_format`
 * and png is its default — but a base64 blob carries no format marker of its own, so a wrong mime
 * in the data: URL is a silently broken image. Read it rather than assume it.
 */
function firstArtifact(json: ImagesResponse, servedBy: string): AdapterResult {
  const first = json.data?.[0];
  const mime = MIME_BY_FORMAT[(json.output_format ?? "").toLowerCase()] ?? "image/png";
  if (first?.url) {
    return { ok: true, artifacts: [{ src: first.url, mime, servedBy }] };
  }
  if (first?.b64_json) {
    return {
      ok: true,
      artifacts: [{ src: `data:${mime};base64,${first.b64_json}`, mime, servedBy }],
    };
  }
  return { ok: false, error: { kind: "unknown", message: "provider returned no image" } };
}

/**
 * Zhipu — https://open.bigmodel.cn/api/paas/v4/images/generations
 * Verified: docs.bigmodel.cn/api-reference/模型-api/图像生成
 *
 * Returns URLs only (never base64), valid for 30 days — hence persistArtifact.
 * `watermark_enabled` is deliberately not sent: it defaults to true, and disabling it obliges an
 * AI-generated disclaimer (content-labelling rules in mainland China). The default keeps us
 * compliant with no extra UI.
 */
export const zhipuImageAdapter: CapabilityAdapter = {
  toRequest: (prompt, model) => ({ model: model.id, prompt }),
  fromResponse: (raw, status) => {
    const json = (raw ?? {}) as ImagesResponse;
    if (status < 200 || status >= 300) return httpError(json, status);
    // The distinctive bit: a refused prompt still arrives as HTTP 200 with a filter verdict.
    if (json.content_filter?.some((c) => c.level === 0)) {
      return { ok: false, error: { kind: "filtered", message: "content filtered by the provider" } };
    }
    return firstArtifact(json, "glm-image");
  },
};

/**
 * OpenAI — https://api.openai.com/v1/images/generations
 * gpt-image-1 returns base64 ONLY (no url), which is why firstArtifact handles both shapes.
 */
export const openaiImageAdapter: CapabilityAdapter = {
  toRequest: (prompt, model) => ({ model: model.id, prompt }),
  fromResponse: (raw, status) => {
    const json = (raw ?? {}) as ImagesResponse;
    if (status < 200 || status >= 300) return httpError(json, status);
    return firstArtifact(json, "gpt-image-1");
  },
};

/**
 * Gemini — https://generativelanguage.googleapis.com/v1beta/openai/images/generations
 * Served by the OpenAI-compatibility layer, from the same base as chat.
 *
 * `response_format: "b64_json"` is sent deliberately, and is the exact opposite of the OpenAI
 * adapter, which must NOT send it (gpt-image-1 rejects the parameter outright). Gemini supports it,
 * every documented example passes it, and the default is unspecified — if that default is "url" we
 * would be asking Google for a hosted link it has no way to provide. This is a protocol detail the
 * adapter owns, not a user-facing parameter.
 *
 * The compat layer silently ignores parameters it does not recognise, so this is safe either way.
 */
export const geminiImageAdapter: CapabilityAdapter = {
  toRequest: (prompt, model) => ({ model: model.id, prompt, response_format: "b64_json" }),
  fromResponse: (raw, status) => {
    const json = (raw ?? {}) as ImagesResponse;
    if (status < 200 || status >= 300) return httpError(json, status);
    return firstArtifact(json, "gemini-image");
  },
};

/**
 * Alibaba Qwen / Wan — https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
 *
 * The odd one out: DashScope exposes NO OpenAI-compatible /images/generations, so both the request
 * and the response are natively shaped and share nothing with the other three.
 *
 * Uses the plain `dashscope.aliyuncs.com` host, which authenticates with the API key alone. The
 * documented `{WorkspaceId}.<region>.maas.aliyuncs.com` form would drag a per-user workspace id and
 * a region into the hostname — neither derivable from the key, and both needing settings this
 * design deliberately does not have.
 *
 * Synchronous: wan2.7-image-pro / qwen-image-2.0-pro return the image inline. (qwen-image-plus and
 * qwen-image also offer an async submit+poll path, which we do not use.)
 *
 * NOTE: returned URLs are valid for only 24 HOURS — the shortest of any vendor here, and the
 * sharpest argument for download-on-receipt.
 */
interface DashScopeResponse {
  output?: {
    choices?: { message?: { content?: { image?: string; text?: string }[] } }[];
  };
  /** DashScope reports failures with a top-level code/message rather than an `error` object. */
  code?: string;
  message?: string;
  request_id?: string;
}

export const qwenImageAdapter: CapabilityAdapter = {
  toRequest: (prompt, model) => ({
    model: model.id,
    // Nested under input.messages[].content[].text — not a flat `prompt`.
    input: { messages: [{ role: "user", content: [{ text: prompt }] }] },
    // No `parameters`: prompt-only by design, so the vendor's own defaults apply (size, n, watermark).
  }),
  fromResponse: (raw, status) => {
    const json = (raw ?? {}) as DashScopeResponse;
    if (status < 200 || status >= 300 || json.code) {
      const message = json.message || `HTTP ${status}`;
      const code = (json.code ?? "").toLowerCase();
      const kind =
        status === 401 || status === 403 || code.includes("apikey") || code.includes("auth")
          ? "auth"
          : status === 429 || code.includes("throttl") || code.includes("limit")
            ? "quota"
            : // "DataInspectionFailed" is DashScope's actual content-safety code — it contains none
              // of the obvious words, so matching only safety/filter/sensitive silently downgrades a
              // refused prompt to a generic failure.
              code.includes("datainspection") ||
                code.includes("safety") ||
                code.includes("filter") ||
                code.includes("sensitive")
              ? "filtered"
              : "unknown";
      return { ok: false, error: { kind, message } };
    }
    // The URL sits four levels down: output.choices[0].message.content[0].image
    const content = json.output?.choices?.[0]?.message?.content;
    const url = content?.find((c) => c.image)?.image;
    if (!url) return { ok: false, error: { kind: "unknown", message: "provider returned no image" } };
    return { ok: true, artifacts: [{ src: url, mime: "image/png", servedBy: "wan-image" }] };
  },
};

/** Overrides `servedBy` with the engine actually used (adapters only know their vendor's default). */
export function withServedBy(result: AdapterResult, model: GenerationModel): AdapterResult {
  // A pending job has no artifacts to stamp yet; it is stamped when its poll settles.
  if (!result.ok || result.pending) return result;
  const artifacts: GenerationArtifact[] = result.artifacts.map((a) => ({ ...a, servedBy: model.id }));
  return { ok: true, artifacts };
}

// ── Async jobs ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * A generic asynchronous generation job.
 *
 * Every vendor's video API works the same way in outline — POST a prompt, get a task id, poll until it
 * settles — and disagrees on the field names. That is a problem for this file, whose whole standard is
 * stated at the top: only vendors verified against live docs get an adapter, because a guessed shape is a
 * runtime failure the user cannot diagnose.
 *
 * So this is deliberately NOT a vendor adapter. It is the shape of the protocol, and it reads the field
 * names listed below — nothing inferred, nothing clever. A user pointing their own endpoint at it can check
 * the list against their vendor's documentation in a few seconds, and when nothing matches it says exactly
 * what it looked for instead of failing silently. When a specific vendor is verified later, it gets its own
 * adapter beside the image ones and this stays as the fallback for everything else.
 *
 * Submit response — a finished result is checked FIRST (same URL fields as below); only when there is none
 * is it read as a job, with the task id from the first of:
 *   `id` · `task_id` · `taskId` · `output.task_id` · `data.task_id`
 * Poll response — the status, from the first of:
 *   `status` · `task_status` · `state` · `output.task_status` · `data.status`
 *   succeeded: SUCCESS SUCCEEDED COMPLETED DONE OK   failed: FAIL FAILED ERROR CANCELLED
 *   anything else is treated as still running.
 * Poll response — the artifact URL, from the first of:
 *   `url` · `video_url` · `output.video_url` · `video_result[0].url` · `output.results[0].url`
 *   `data[0].url` · `output.video[0].url` · `result.url`
 */
const pick = (obj: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    const m = /^(.+)\[(\d+)\]$/.exec(key);
    if (m) {
      const arr = (acc as Record<string, unknown>)[m[1]];
      return Array.isArray(arr) ? arr[Number(m[2])] : undefined;
    }
    return (acc as Record<string, unknown>)[key];
  }, obj);

const firstString = (json: unknown, paths: string[]): string | null => {
  for (const p of paths) {
    const v = pick(json, p);
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
};

/**
 * Where a task handle lives.
 *
 * `request_id` is deliberately NOT here. Several vendors stamp one on every response for support
 * correlation — Zhipu returns both a `request_id` and a separate task `id` — so treating it as a task handle
 * polls a well-formed identifier that names nothing, and the resulting 404 arrives minutes later looking
 * like a vendor fault rather than a wrong field.
 */
const TASK_ID_PATHS = ["id", "task_id", "taskId", "output.task_id", "data.task_id"];
const STATUS_PATHS = ["status", "task_status", "state", "output.task_status", "data.status"];
const URL_PATHS = [
  "url",
  "video_url",
  "output.video_url",
  "video_result[0].url",
  "output.results[0].url",
  "data[0].url",
  "output.video[0].url",
  "result.url",
];
const DONE = new Set(["success", "succeeded", "completed", "done", "ok"]);
const FAILED = new Set(["fail", "failed", "error", "cancelled", "canceled"]);

/** Extension → mime for the formats video endpoints actually emit; anything else is left as mp4. */
const VIDEO_MIME: Record<string, string> = { mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime" };
const mimeOfUrl = (url: string): string => {
  const ext = /\.([a-z0-9]{2,4})(?:\?|#|$)/i.exec(url)?.[1]?.toLowerCase() ?? "";
  return VIDEO_MIME[ext] ?? "video/mp4";
};

/**
 * Explicit field paths, for an endpoint whose names are not in the lists above.
 *
 * Each is optional and, when given, is used INSTEAD of the corresponding list rather than in addition to it.
 * That is the point: a user who has their vendor's documentation open knows the answer exactly, and mixing
 * their answer with guesses would reintroduce the ambiguity they came here to remove — the `request_id`
 * confusion was precisely two plausible fields in one response.
 *
 * Supports dotted paths and array indices, e.g. `output.results[0].url`.
 */
export interface AsyncJobPaths {
  taskId?: string;
  status?: string;
  url?: string;
}

/**
 * The generic async-job reader, optionally told where to look.
 *
 * With no paths it behaves exactly as documented above. With them it looks only where it is told, which
 * turns a silent minutes-long failure into a configuration the user can verify against their vendor's docs
 * in one reading.
 */
export function createAsyncJobAdapter(paths: AsyncJobPaths = {}): CapabilityAdapter {
  const taskIdPaths = paths.taskId ? [paths.taskId] : TASK_ID_PATHS;
  const statusPaths = paths.status ? [paths.status] : STATUS_PATHS;
  const urlPaths = paths.url ? [paths.url] : URL_PATHS;
  return {
    toRequest: (prompt, model) => ({ model: model.id, prompt }),
    fromResponse: (raw, status) => {
      const json = (raw ?? {}) as Record<string, unknown>;
      if (status < 200 || status >= 300) return httpError(json as never, status);
      // A RESULT settles it, whatever else the response carries — see the note on the default reader below.
      const url = firstString(json, urlPaths);
      if (url) return { ok: true, artifacts: [{ src: url, mime: mimeOfUrl(url), servedBy: "custom" }] };
      const taskId = firstString(json, taskIdPaths);
      if (taskId) return { ok: true, pending: { taskId } };
      return {
        ok: false,
        error: {
          kind: "unknown",
          message: `no result or task id in the response (looked for ${urlPaths.join(", ")}, ${taskIdPaths.join(", ")})`,
        },
      };
    },
    poll: {
      url: (taskId, template) =>
        template.includes("{id}")
          ? template.replace("{id}", encodeURIComponent(taskId))
          : `${template.replace(/\/+$/, "")}/${encodeURIComponent(taskId)}`,
      from: (raw, status) => {
        const json = (raw ?? {}) as Record<string, unknown>;
        if (status < 200 || status >= 300) return httpError(json as never, status);
        const state = (firstString(json, statusPaths) ?? "").toLowerCase();
        if (FAILED.has(state)) {
          return { ok: false, error: { kind: "unknown", message: `the job reported ${state}` } };
        }
        const url = firstString(json, urlPaths);
        // A URL settles it whatever the status says: some vendors report "processing" on the same response
        // that carries the finished result.
        if (url) return { ok: true, artifacts: [{ src: url, mime: mimeOfUrl(url), servedBy: "custom" }] };
        if (DONE.has(state)) {
          return {
            ok: false,
            error: {
              kind: "unknown",
              message: `the job succeeded but no URL was found (looked for ${urlPaths.join(", ")})`,
            },
          };
        }
        return { ok: true, pending: { taskId: "" } };
      },
    },
  };
}

/** The unconfigured reader, which is what an engine with no explicit paths gets. */
export const asyncJobAdapter: CapabilityAdapter = createAsyncJobAdapter();

