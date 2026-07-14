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
