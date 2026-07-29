import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function load(url, context, next) {
  if (url.endsWith(".md")) {
    const src = await readFile(fileURLToPath(url), "utf8");
    return { format: "module", shortCircuit: true, source: `export default ${JSON.stringify(src)};` };
  }
  return next(url, context);
}
