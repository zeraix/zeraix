// Fallback for third-party modules missing type declarations (wildcard module; imports default to `any`).
// @uiw/react-markdown-preview lacks type definitions (imported dynamically via `next/dynamic`).
declare module "@uiw/react-markdown-preview";

// Import `*.md` files as raw text (configured via Turbopack's raw-loader rule in
// next.config.ts). Used to load the agent system prompts from Markdown.
declare module "*.md" {
  const content: string;
  export default content;
}
