/**
 * Same-tab event for "open a file in the right-hand file panel" (triggered by the sidebar file tree, listened to by FilesPanel).
 * Uses the same CustomEvent mechanism as requestOpenBrowser (see src/lib/automation.ts). `path` is relative to the working directory.
 */
export const OPEN_FILE_EVENT = "agent-open-file";

/** Request to open a file in the right-hand file panel (path relative to the working directory). */
export function requestOpenFile(path: string): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(OPEN_FILE_EVENT, { detail: { path } }));
  }
}

/** Subscribe to "request to open a file"; returns an unsubscribe function. */
export function onOpenFile(cb: (path: string) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const h = (e: Event) => cb((e as CustomEvent<{ path?: string }>).detail?.path ?? "");
  window.addEventListener(OPEN_FILE_EVENT, h);
  return () => window.removeEventListener(OPEN_FILE_EVENT, h);
}

/** Same-tab event for "request to close the right-hand file panel" (e.g. collapse the file panel together with the file tree sidebar). */
export const CLOSE_FILE_EVENT = "agent-close-file";

/** Request to close the right-hand file panel. */
export function requestCloseFile(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CLOSE_FILE_EVENT));
  }
}

/** Subscribe to "request to close the file panel"; returns an unsubscribe function. */
export function onCloseFile(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const h = () => cb();
  window.addEventListener(CLOSE_FILE_EVENT, h);
  return () => window.removeEventListener(CLOSE_FILE_EVENT, h);
}

/** File extension → Monaco language id (plaintext if unknown). */
export function monacoLanguage(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    json: "json", md: "markdown", markdown: "markdown", css: "css", scss: "scss", less: "less",
    html: "html", htm: "html", xml: "xml", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini",
    sh: "shell", bash: "shell", py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
    c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", php: "php", sql: "sql",
    vue: "html", svg: "xml", txt: "plaintext", env: "ini",
  };
  return map[ext] ?? "plaintext";
}
