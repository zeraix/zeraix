/**
 * Fakes for driving a chat turn through the real runtime bridge: Electron's `ipcMain`, a window, and a provider.
 *
 * Shared by runtime-turn-bridge.test.mjs (the four hops) and chat-runtime-round.test.mjs (the chat page's
 * adapter on top of them). Everything else in those tests is the real module.
 */
import http from "node:http";
import { register } from "node:module";

/**
 * Stub `electron` with an `ipcMain` that records its handlers. Call before importing anything that imports
 * electron. Returns the two maps the fake window dispatches through.
 */
export function stubElectron() {
  const handlers = new Map();
  const listeners = new Map();
  globalThis.__turnBridgeElectron = {
    ipcMain: {
      handle: (channel, fn) => handlers.set(channel, fn),
      on: (channel, fn) => listeners.set(channel, fn),
    },
  };
  register(
    new URL(
      `data:text/javascript,${encodeURIComponent(`
        export async function resolve(specifier, context, next) {
          if (specifier === "electron") return { url: "zeraix:turn-bridge-electron", format: "module", shortCircuit: true };
          return next(specifier, context);
        }
        export async function load(url, context, next) {
          if (url === "zeraix:turn-bridge-electron") {
            return { format: "module", shortCircuit: true, source: "export const { ipcMain } = globalThis.__turnBridgeElectron;" };
          }
          return next(url, context);
        }
      `)}`,
    ),
  );
  return { handlers, listeners };
}

/**
 * A window: what the main process sends to it, and a preload-shaped API over the bridge's handlers.
 *
 * Requests are answered only by whoever subscribes through `api.onRequest` and replies. The client module does
 * that itself; a test that subscribes and does NOT reply is how an unresponsive or closing window is modelled.
 */
export function fakeWindow({ handlers, listeners }) {
  const subs = { "agent-run:event": new Set(), "agent-run:request": new Set() };
  const gone = new Set();
  const wc = {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    send(channel, payload) {
      for (const cb of subs[channel] ?? []) cb(payload);
    },
    once(event, cb) {
      if (event === "destroyed") gone.add(cb);
    },
    removeListener(event, cb) {
      if (event === "destroyed") gone.delete(cb);
    },
    destroy() {
      this.destroyed = true;
      for (const cb of [...gone]) cb();
      gone.clear();
    },
  };
  const event = { sender: wc };
  const api = {
    start: (runId, params, gated) => handlers.get("agent-run:start")(event, { runId, params, gated }),
    cancel: (runId) => listeners.get("agent-run:cancel")(event, { runId }),
    reply: (requestId, body) => listeners.get("agent-run:reply")(event, { requestId, ...body }),
    onEvent: (cb) => {
      subs["agent-run:event"].add(cb);
      return () => subs["agent-run:event"].delete(cb);
    },
    onRequest: (cb) => {
      subs["agent-run:request"].add(cb);
      return () => subs["agent-run:request"].delete(cb);
    },
  };
  return { wc, api, event };
}

/**
 * What a real OpenAI-compatible provider would refuse in this request body, or null.
 *
 * The fakes used to accept anything, and a runtime that replayed every tool call as `{ id, name, arguments }`
 * passed every test here while no real provider would take its second request.
 */
export function wireProblem(body) {
  for (const m of body?.messages ?? []) {
    for (const tc of m.tool_calls ?? []) {
      if (tc?.type !== "function" || typeof tc?.function?.name !== "string" || typeof tc.function.arguments !== "string") {
        return `messages[].tool_calls[] must be { id, type: "function", function: { name, arguments } }; got ${JSON.stringify(tc)}`;
      }
    }
  }
  return null;
}

/**
 * An OpenAI-compatible endpoint answering from a script, recording every request and its headers.
 *
 * A script entry that is a FUNCTION writes the response itself — a refusal, a stream, a stream cut off. Any
 * other entry is a completion, sent as JSON or, when the request asked for one, as a stream.
 */
export function provider(script, { delayMs = 0 } = {}) {
  const seen = [];
  const headers = [];
  const urls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push(JSON.parse(body || "{}"));
      headers.push(req.headers);
      urls.push(req.url);
      const problem = wireProblem(seen[seen.length - 1]);
      if (problem) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: problem } }));
        return;
      }
      const next = script.shift() ?? { choices: [{ message: { content: "out of script" } }] };
      if (typeof next === "function") return next(res);
      const reply = { usage: { prompt_tokens: 10, completion_tokens: 5 }, ...next };
      setTimeout(() => {
        if (res.destroyed) return;
        // A request that asked to stream gets a stream, as it would from a real provider. Answering it with a
        // plain JSON body reads, to a stream parser, as an empty reply — a turn that "completes" having said
        // and done nothing.
        if (seen[seen.length - 1]?.stream) {
          const msg = reply.choices?.[0]?.message ?? {};
          const delta = {
            ...(msg.content ? { content: msg.content } : {}),
            ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}),
            ...(msg.tool_calls ? { tool_calls: msg.tool_calls.map((tc, index) => ({ index, ...tc })) } : {}),
          };
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [], usage: reply.usage })}\n\n`);
          res.end("data: [DONE]\n\n");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply));
      }, delayMs);
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
        seen,
        headers,
        urls,
        close: () => new Promise((done) => server.close(done)),
      }),
    ),
  );
}
export const text = (content) => ({ choices: [{ message: { role: "assistant", content } }] });
export const call = (id, name, args) => ({
  choices: [
    {
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
    },
  ],
});
export const declare = (name) => ({ type: "function", function: { name, parameters: { type: "object" } } });
