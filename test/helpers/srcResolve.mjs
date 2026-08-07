/**
 * Module hooks that let a plain `node --test` run import from `src/`.
 *
 * Two things stand between node and this project's TypeScript: the `@/*` path alias, which only the
 * bundler and tsc know about, and `.md` imports, which Next serves through a raw-text loader. Node 24
 * strips types on its own, so those two are the whole gap.
 *
 * `scripts/md-loader-hook.mjs` already does the second half for the seed tooling, which runs under tsx
 * and therefore never needed the first. This is the same idea with the alias added, kept beside the tests
 * so `npm test` stays a bare `node --test` with no runner to configure.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = new URL("../../src/", import.meta.url);

/** Bundler resolution also means extensionless imports, so each candidate is tried in turn. */
const EXTS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

export async function resolve(specifier, context, next) {
  const base = specifier.startsWith("@/") ? new URL(specifier.slice(2), SRC).href : specifier;
  let firstError;
  for (const ext of EXTS) {
    try {
      return await next(base + ext, context);
    } catch (e) {
      firstError ??= e;
    }
  }
  throw firstError;
}

export async function load(url, context, next) {
  if (url.endsWith(".md")) {
    const src = await readFile(fileURLToPath(url), "utf8");
    return { format: "module", shortCircuit: true, source: `export default ${JSON.stringify(src)};` };
  }
  return next(url, context);
}

export { pathToFileURL };
