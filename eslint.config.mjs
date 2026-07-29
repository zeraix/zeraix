import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import globals from "globals";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // The main process and the build scripts are plain .mjs, so tsc never sees them and nothing catches a name that does not
    // resolve. `node --check` only parses. A real example: modelDir was declared in start() and read in launch() — a different
    // function that never received it — so every model launch threw "modelDir is not defined" at runtime, with the whole file
    // passing both tsc and node --check. no-undef is what turns that back into a build-time error.
    files: ["electron/**/*.mjs", "scripts/**/*.mjs", "test/**/*.mjs"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: { ...globals.node, ...globals.browser } },
    rules: { "no-undef": "error" },
  },
]);

export default eslintConfig;
