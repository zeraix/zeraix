/**
 * A Streamable HTTP MCP server, for testing the HTTP transport against something real.
 *
 * Strict in the same way the stdio fixture is, plus the things only HTTP can get wrong:
 *
 * - it hands out a session on initialize and **requires** it afterwards, answering 404 if it is missing
 *   or stale — which is how a real server reports an expired session, and a client that ignores it will
 *   fail every later call rather than reconnecting;
 * - it answers `tools/call` with **SSE**, and everything else with plain JSON, so a client that only
 *   handles one shape fails against the other;
 * - the SSE stream carries a progress notification *before* the response, so a client that takes the
 *   first message on the stream as its answer gets the wrong one.
 *
 * Prints its base URL on stdout as `LISTENING <url>` so a test can wait for it and know the port.
 *
 *   node mcp-http-server.mjs           normal
 *   node mcp-http-server.mjs --huge    answers tools/call with a body over any sane cap
 *   node mcp-http-server.mjs --nosession  never issues a session (a legitimate, simpler server)
 */
import http from "node:http";
import { randomUUID } from "node:crypto";

const mode = process.argv[2] ?? "";
const useSession = mode !== "--nosession";
let session = null;

const TOOLS = [
  {
    name: "echo",
    description: "Echo the text back.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
];

const server = http.createServer((req, res) => {
  if (req.method === "DELETE") {
    session = null;
    res.writeHead(204).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400).end();
      return;
    }

    const json = (payload, headers = {}) => {
      res.writeHead(200, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    };
    const reply = (result, headers) => json({ jsonrpc: "2.0", id: msg.id, result }, headers);

    if (msg.method === "initialize") {
      const headers = {};
      if (useSession) {
        session = randomUUID();
        headers["mcp-session-id"] = session;
      }
      reply(
        {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "http-fixture", version: "1.0.0" },
        },
        headers,
      );
      return;
    }

    // Everything after initialize must carry the session this server issued.
    if (useSession && req.headers["mcp-session-id"] !== session) {
      res.writeHead(404).end();
      return;
    }

    if (msg.method === "notifications/initialized") {
      // The correct answer to a notification: accepted, no body.
      res.writeHead(202).end();
      return;
    }
    if (msg.method === "ping") {
      reply({});
      return;
    }
    if (msg.method === "tools/list") {
      reply({ tools: TOOLS });
      return;
    }

    if (msg.method === "tools/call") {
      // SSE, deliberately: a client that only handles a JSON body fails here.
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      // A notification FIRST, so taking the first message on the stream as the answer is wrong.
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\n`);
      const text =
        mode === "--huge" ? "x".repeat(200_000) : String(msg.params?.arguments?.text ?? "");
      res.write(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } })}\n\n`,
      );
      res.end();
      return;
    }

    json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method: ${msg.method}` } });
  });
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`LISTENING http://127.0.0.1:${server.address().port}/mcp\n`);
});
