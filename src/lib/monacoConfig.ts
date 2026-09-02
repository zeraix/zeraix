/**
 * Monaco Editor configuration: Based on `monaco-react.json` in the root directory (see FilesPanel).
 * - Fixes two keys written as nested objects in the JSON (Monaco requires them to be string paths).
 * - Automatically injects `automaticLayout`, which is required for responsive panel resizing.
 * - Displays the minimap only when the panel is "maximized" (disabled in the narrow sidebar to save horizontal space); other minimap options follow the JSON.
 * Additionally configures TS/JS/JSON language services to provide language-specific completions and IntelliSense.
 */
import rawConfig from "../../monaco-react.json";
import type { Monaco, EditorProps } from "@monaco-editor/react";

// Direct import of "monaco-editor" fails due to pnpm nested dependency constraints. 
// Workaround: Infer the editor configuration options type (editor.IStandaloneEditorConstructionOptions) directly via EditorProps from @monaco-editor/react.
type EditorOptions = NonNullable<EditorProps["options"]>;

// Inside `monaco-react.json`, `wrappingIndent` and `wrappingStrategy` were incorrectly specified 
// as nested objects (e.g., `{ wrappingIndent: "same" }`), whereas Monaco actually expects a plain string. 
// This step unwraps them into strings.
function unwrap(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : value;
}

/** Derives editor options from `monaco-react.json`; displays the right-side minimap only when maximized. */
export function monacoOptions(maximized: boolean): EditorOptions {
  const cfg: Record<string, unknown> = { ...(rawConfig as Record<string, unknown>) };
  cfg.wrappingIndent = unwrap(cfg.wrappingIndent, "wrappingIndent");
  cfg.wrappingStrategy = unwrap(cfg.wrappingStrategy, "wrappingStrategy");
  cfg.automaticLayout = true; // Automatically recalculates layout when the panel/window size changes (missing from JSON, but required)
  // Minimap: Only display when maximized (retains JSON configurations like side/size/showSlider, overriding only the `enabled` flag).
  cfg.minimap = { ...(cfg.minimap as Record<string, unknown> | undefined), enabled: maximized };
  return cfg as unknown as EditorOptions;
}

/**
 * Editor themes matching the app palette.
 *
 * `vs` / `vs-dark` ship VS Code's blues and reds, which is a second color system sitting
 * next to this app's. These two rebuild the editor on --code-surface / --code-ink and the
 * categorical tints from globals.css, so a file in the viewer looks like the app around it.
 * Monaco takes literal colors only, so the values are duplicated from those tokens -- change
 * them together. Registered under names Monaco will not otherwise use.
 */
export const MONACO_THEME = { light: "zeraix-light", dark: "zeraix-dark" } as const;

/** `rules` are token-scope -> color; `colors` are chrome. Both are Monaco's own vocabulary. */
const THEME_DEFS = {
  [MONACO_THEME.light]: {
    base: "vs" as const,
    inherit: true,
    rules: [
      { token: "comment", foreground: "8b877e", fontStyle: "italic" },
      { token: "string", foreground: "0e7a4a" },
      { token: "number", foreground: "a3402c" },
      { token: "constant", foreground: "a3402c" },
      { token: "keyword", foreground: "6d4aa8" },
      { token: "type", foreground: "0f6f74" },
      { token: "type.identifier", foreground: "0f6f74" },
      { token: "function", foreground: "1f55a8" },
      { token: "identifier", foreground: "201f1c" },
      { token: "operator", foreground: "5f5c55" },
      { token: "delimiter", foreground: "5f5c55" },
      { token: "tag", foreground: "a3402c" },
      { token: "attribute.name", foreground: "9a6200" },
      { token: "attribute.value", foreground: "0e7a4a" },
    ],
    colors: {
      "editor.background": "#f0eee7",
      "editor.foreground": "#201f1c",
      "editor.lineHighlightBackground": "#e6e3da",
      "editor.selectionBackground": "#2f4a7a33",
      "editorCursor.foreground": "#2f4a7a",
      "editorLineNumber.foreground": "#a5a096",
      "editorLineNumber.activeForeground": "#5f5c55",
      "editorGutter.background": "#f0eee7",
      "editorWidget.background": "#fdfcfa",
      "editorWidget.border": "#dcd7cc",
    },
  },
  [MONACO_THEME.dark]: {
    base: "vs-dark" as const,
    inherit: true,
    rules: [
      { token: "comment", foreground: "7a7772", fontStyle: "italic" },
      { token: "string", foreground: "4ed8a0" },
      { token: "number", foreground: "f0a08c" },
      { token: "constant", foreground: "f0a08c" },
      { token: "keyword", foreground: "c4a8f0" },
      { token: "type", foreground: "6fd4d8" },
      { token: "type.identifier", foreground: "6fd4d8" },
      { token: "function", foreground: "8cbaf5" },
      { token: "identifier", foreground: "e6e4e1" },
      { token: "operator", foreground: "9c9992" },
      { token: "delimiter", foreground: "9c9992" },
      { token: "tag", foreground: "f0a08c" },
      { token: "attribute.name", foreground: "f0c46a" },
      { token: "attribute.value", foreground: "4ed8a0" },
    ],
    colors: {
      "editor.background": "#131316",
      "editor.foreground": "#e6e4e1",
      "editor.lineHighlightBackground": "#1c1c21",
      "editor.selectionBackground": "#7fa0d94d",
      "editorCursor.foreground": "#7fa0d9",
      "editorLineNumber.foreground": "#605d58",
      "editorLineNumber.activeForeground": "#9c9992",
      "editorGutter.background": "#131316",
      "editorWidget.background": "#222227",
      "editorWidget.border": "#37373e",
    },
  },
};

/** Registers both themes. Safe to call repeatedly -- defineTheme overwrites by name. */
export function defineMonacoThemes(monaco: Monaco): void {
  for (const [name, def] of Object.entries(THEME_DEFS)) {
    monaco.editor.defineTheme(name, def);
  }
}

/**
 * Configures language services to provide language-specific completions and IntelliSense (invoked inside MonacoEditor's `beforeMount`):
 * - TS/JS: Sets compiler options (JSX, allowJs, ESNext, etc.) + enables immediate model synchronization to provide member, parameter, and keyword completions.
 * Disables semantic diagnostics for single-file editing to prevent false positive "module not found" errors, while retaining syntax validation and completions.
 * - JSON: Enables validation, permits comments, and fetches remote schemas via `$schema` to provide key and enum completions.
 * - CSS/SCSS/LESS and HTML are natively supported by Monaco's built-in language services and require no additional configuration.
 */
export function configureMonacoIntelliSense(monaco: Monaco): void {
  const ts = monaco.languages.typescript;
  if (ts) {
    const compilerOptions = {
      target: ts.ScriptTarget.ESNext,
      allowNonTsExtensions: true,
      allowJs: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
      skipLibCheck: true,
    };
    ts.typescriptDefaults.setCompilerOptions(compilerOptions);
    ts.javascriptDefaults.setCompilerOptions(compilerOptions);
    ts.typescriptDefaults.setEagerModelSync(true);
    ts.javascriptDefaults.setEagerModelSync(true);
    ts.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
    ts.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
  }
  const json = monaco.languages.json;
  if (json) {
    json.jsonDefaults.setDiagnosticsOptions({
      validate: true,
      allowComments: true,
      schemas: [],
      enableSchemaRequest: true,
    });
  }
}
