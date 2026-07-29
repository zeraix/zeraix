/**
 * Import .md the way the Next build does — as a raw string default export.
 *
 * The system prompts live in src/app/agent/chat/system/*.md and are imported directly by constants.ts. Next handles that with a
 * loader; plain node/tsx does not, so any script that computes the prompt prefix needs this registered first.
 */
import { register } from "node:module";
register("./md-loader-hook.mjs", import.meta.url);
