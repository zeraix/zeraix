/**
 * A minimal but strict MCP server, for testing the stdio transport against something real.
 *
 * Strict on purpose. The interesting failures of an MCP client are the ones a lenient server hides:
 *
 * - It answers NOTHING until `notifications/initialized` arrives. That is what the protocol allows,
 *   and a client that skips the notification passes against every forgiving server and then hangs
 *   against this one. The Rust supervisor sends it; this is what proves it.
 * - It refuses a `tools/call` for an unknown tool with a JSON-RPC error, not a result, so the client
 *   has to distinguish a protocol error from a tool that ran and failed.
 *
 * Behaviour is switched by argv so one file covers every case:
 *   node mcp-server.mjs            normal
 *   node mcp-server.mjs --huge     answers tools/call with a response over any sane cap
 *   node mcp-server.mjs --die      exits as soon as it is initialized
 *   node mcp-server.mjs --deaf     accepts the connection and never answers anything
 */
import readline from "node:readline";

const mode = process.argv[2] ?? "";
let initialized = false;

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, message) => send({ jsonrpc: "2.0", id, error: { code: -32601, message } });

const TOOLS = [
  {
    name: "echo",
    description: "Echo the text back.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "boom",
    description: "Always fails, as a tool rather than as a protocol error.",
    inputSchema: { type: "object", properties: {} },
  },
];

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (mode === "--deaf") return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.method === "initialize") {
    reply(msg.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "fixture", version: "1.0.0" },
    });
    return;
  }

  if (msg.method === "notifications/initialized") {
    initialized = true;
    if (mode === "--die") process.exit(1);
    return;
  }

  // The strictness that makes the handshake testable: before the notification, silence.
  if (!initialized) return;

  if (msg.method === "ping") {
    reply(msg.id, {});
    return;
  }

  if (msg.method === "tools/list") {
    reply(msg.id, { tools: TOOLS });
    return;
  }

  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    if (name === "echo") {
      const text = mode === "--huge" ? "x".repeat(200_000) : String(msg.params?.arguments?.text ?? "");
      reply(msg.id, { content: [{ type: "text", text }] });
      return;
    }
    if (name === "boom") {
      // A tool that ran and failed: `isError` on a normal result, NOT a JSON-RPC error.
      reply(msg.id, { content: [{ type: "text", text: "the tool refused" }], isError: true });
      return;
    }
    fail(msg.id, `unknown tool: ${name}`);
    return;
  }

  if (msg.id !== undefined) fail(msg.id, `unknown method: ${msg.method}`);
});
