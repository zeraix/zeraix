/**
 * Which Hugging Face host to talk to: huggingface.co, or hf-mirror.com when the direct one is unreachable.
 *
 * Probed once per process and cached, because every caller wants the same answer and the probe costs a round trip:
 * model weights (llama-server's -hf), the resident KV seeds, and the llama runtime packages themselves.
 *
 * It lives in its own module rather than in localServer because llamaInstaller needs it too, and localServer already
 * imports llamaInstaller — importing back the other way would be a cycle.
 */
import https from "node:https";

let _endpoint = null;

/** Any response at all counts as reachable: we are testing the network path, not the status code. */
function reachable(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    try {
      const req = https.get(url, { timeout: timeoutMs }, (res) => { res.resume(); finish(true); });
      req.on("error", () => finish(false));
      req.on("timeout", () => { req.destroy(); finish(false); });
    } catch { finish(false); }
  });
}

/**
 * Resolve the endpoint (cached). HF_ENDPOINT overrides the probe entirely.
 * onLog receives one line the first time the probe runs, so each caller can route it to its own log.
 */
export async function resolveHfEndpoint(onLog = () => {}) {
  if (_endpoint) return _endpoint;
  if (process.env.HF_ENDPOINT) { _endpoint = process.env.HF_ENDPOINT; return _endpoint; }
  const ok = await reachable("https://huggingface.co/");
  _endpoint = ok ? "https://huggingface.co" : "https://hf-mirror.com";
  onLog(`HF endpoint: ${_endpoint} (huggingface.co ${ok ? "reachable, connecting directly" : "unreachable -> using mirror"})`);
  return _endpoint;
}
