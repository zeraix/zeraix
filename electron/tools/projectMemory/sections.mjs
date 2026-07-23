/**
 * The section registry — a plain array of descriptors. This is the only file you edit to add,
 * remove or re-scope a part of ZERAIX.md.
 *
 * Each descriptor declares:
 *   id        stable identifier, written into the marker (never rename casually — it is the key
 *             used to match an existing section in a user's file)
 *   tier      "A" derived + cheap · "B" derived + LLM · "C" authored, never machine-written
 *   inputs    what this section is a function OF (see fingerprint.mjs) — drives partial rebuild
 *   maxChars  self-truncation budget
 *   priority  drop order when the whole document exceeds its budget (higher = dropped first)
 *   build     (ctx) => string | { body, stale } | null   — null omits the section entirely
 *
 * Builders are ported unchanged in behaviour from the previous single-shot init_command.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { isIgnoredEntry, findReadme } from "./fingerprint.mjs";
import { buildModuleMap } from "./modules.mjs";

const MAX_ENTRIES = 30; // Max entries listed per directory level in the tree section
const README_CHARS = 700; // Character cap kept for the README summary
const OVERVIEW_SRC_CHARS = 4000; // Truncation applied to README text fed to the LLM

/**
 * First run of real prose in a Markdown document, skipping the decoration READMEs open with:
 * raw HTML (centred logo blocks), headings, badge/link lines and horizontal rules. Used as the
 * deterministic fallback for the overview when no LLM is configured — a blind slice() of a modern
 * README returns markup, not a description.
 */
function firstProse(text, max = 400) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      if (out.length) break; // blank line after prose has started → end of the first paragraph
      continue;
    }
    if (/^<[^>]+>/.test(line)) continue; // raw HTML
    if (/^#{1,6}\s/.test(line)) continue; // heading
    if (/^[[!]/.test(line)) continue; // badge / link-only line
    if (/^[-*_]{3,}$/.test(line)) continue; // horizontal rule
    if (/^[-*+]\s/.test(line) && !out.length) continue; // leading bullet list
    out.push(line);
    if (out.join(" ").length >= max) break;
  }
  return out.join(" ").slice(0, max).trim();
}

/** Read and parse a JSON file under the workdir; null when missing or malformed. */
async function readJson(workdir, rel) {
  try {
    return JSON.parse(await fs.readFile(path.join(workdir, rel), "utf8"));
  } catch {
    return null;
  }
}

/** Whether a path exists under the workdir. */
async function existsIn(workdir, rel) {
  try {
    await fs.access(path.join(workdir, rel));
    return true;
  } catch {
    return false;
  }
}

/** Repo type: Git or not, and whether it is a monorepo (and how it is managed). */
async function detectRepoType(workdir, pkg) {
  const isGit = await existsIn(workdir, ".git");
  let monorepo = null;
  if (await existsIn(workdir, "pnpm-workspace.yaml")) monorepo = "pnpm workspaces";
  else if (await existsIn(workdir, "lerna.json")) monorepo = "Lerna";
  else if (await existsIn(workdir, "turbo.json")) monorepo = "Turborepo";
  else if (pkg?.workspaces) monorepo = "npm/yarn workspaces";
  return { isGit, monorepo };
}

/** Package manager, inferred from the lock file; null when none is present. */
async function detectPackageManager(workdir) {
  if (await existsIn(workdir, "pnpm-lock.yaml")) return "pnpm";
  if (await existsIn(workdir, "yarn.lock")) return "yarn";
  if (await existsIn(workdir, "bun.lockb")) return "bun";
  if (await existsIn(workdir, "package-lock.json")) return "npm";
  return null;
}

/** Tech stack from the dependency manifest plus config-file presence (never reads source). */
async function detectTechStack(workdir, pkg) {
  const stack = new Set();
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const has = (name) => Object.prototype.hasOwnProperty.call(deps, name);

  if (pkg) stack.add("Node.js");
  if (has("typescript") || (await existsIn(workdir, "tsconfig.json"))) stack.add("TypeScript");
  if (has("next")) stack.add("Next.js");
  else if (has("react")) stack.add("React");
  if (has("vue")) stack.add("Vue");
  if (has("electron")) stack.add("Electron");
  if (has("vite")) stack.add("Vite");
  if (has("webpack")) stack.add("Webpack");
  if (has("tailwindcss")) stack.add("Tailwind CSS");
  if (has("express")) stack.add("Express");
  if (has("@nestjs/core")) stack.add("NestJS");
  if (has("jest")) stack.add("Jest");
  if (has("vitest")) stack.add("Vitest");

  if (await existsIn(workdir, "Cargo.toml")) stack.add("Rust");
  if (await existsIn(workdir, "go.mod")) stack.add("Go");
  if (
    (await existsIn(workdir, "pyproject.toml")) ||
    (await existsIn(workdir, "requirements.txt")) ||
    (await existsIn(workdir, "setup.py"))
  )
    stack.add("Python");
  if ((await existsIn(workdir, "pom.xml")) || (await existsIn(workdir, "build.gradle"))) stack.add("Java");
  if (await existsIn(workdir, "Gemfile")) stack.add("Ruby");
  if (await existsIn(workdir, "composer.json")) stack.add("PHP");
  if ((await existsIn(workdir, "Dockerfile")) || (await existsIn(workdir, "docker-compose.yml")))
    stack.add("Docker");

  return [...stack];
}

/** Top level plus one level of subdirectories, heavy directories skipped, entry count capped. */
async function buildDirTree(workdir) {
  let top;
  try {
    top = await fs.readdir(workdir, { withFileTypes: true });
  } catch {
    return "(unable to read working directory)";
  }
  // Same ignore rule as the shape fingerprint, so what the tree renders and what invalidates it
  // can never disagree.
  const keep = (list) =>
    list
      .filter((e) => !isIgnoredEntry(e.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

  const lines = [];
  for (const e of keep(top).slice(0, MAX_ENTRIES)) {
    if (!e.isDirectory()) {
      lines.push(`      ${e.name}`);
      continue;
    }
    lines.push(`[dir] ${e.name}/`);
    let children = [];
    try {
      children = await fs.readdir(path.join(workdir, e.name), { withFileTypes: true });
    } catch {
      children = [];
    }
    const kids = keep(children);
    for (const c of kids.slice(0, MAX_ENTRIES)) {
      lines.push(`        ${c.isDirectory() ? `${c.name}/` : c.name}`);
    }
    if (kids.length > MAX_ENTRIES) lines.push(`        … (+${kids.length - MAX_ENTRIES})`);
  }
  return lines.join("\n") || "(empty directory)";
}

const CONFIG_CANDIDATES = [
  "package.json", "tsconfig.json", "next.config.js", "next.config.mjs", "next.config.ts",
  "vite.config.ts", "vite.config.js", "electron-builder.yml", "pnpm-workspace.yaml",
  "turbo.json", "eslint.config.mjs", ".eslintrc.json", "tailwind.config.ts", "tailwind.config.js",
  "postcss.config.mjs", "Cargo.toml", "go.mod", "pyproject.toml", "requirements.txt",
  "Dockerfile", "docker-compose.yml", ".env.example",
];

/**
 * Gather everything the builders need, once per rebuild pass (~10 ms). Built only when at least
 * one section is actually stale, so a fully-fresh document costs nothing beyond fingerprinting.
 */
export async function buildContext({ workdir, llm, detectCheckSteps }) {
  const pkg = await readJson(workdir, "package.json");
  const { isGit, monorepo } = await detectRepoType(workdir, pkg);
  return {
    workdir,
    pkg,
    isGit,
    monorepo,
    llm,
    detectCheckSteps,
    pm: await detectPackageManager(workdir),
    stack: await detectTechStack(workdir, pkg),
    readme: await findReadme(workdir),
    projectName: pkg?.name || path.basename(workdir),
  };
}

export const SECTIONS = [
  {
    id: "title",
    tier: "A",
    inputs: ["file:package.json"],
    maxChars: 500,
    priority: 0,
    build: (ctx) =>
      `# Project Memory · ${ctx.projectName}\n\n` +
      "> Maintained by Zeraix. Sections between `zeraix:` markers are regenerated when the files\n" +
      "> they depend on change; everything else — including anything you write yourself — is left\n" +
      "> untouched. Add `lock` to a marker to freeze that section too.",
  },

  {
    id: "overview",
    tier: "B",
    inputs: ["file:package.json", "readme"],
    maxChars: 700,
    priority: 20,
    async build(ctx) {
      const description = ctx.pkg?.description || "";
      const fallback = description || (ctx.readme ? firstProse(ctx.readme.text) : "");
      if (!ctx.llm?.available) {
        return { body: `## Overview\n\n${fallback || "(no description)"}`, stale: fallback ? null : "llm" };
      }
      try {
        const facts = [
          `Project name: ${ctx.projectName}`,
          description && `package.json description: ${description}`,
          ctx.stack.length && `Tech stack: ${ctx.stack.join(", ")}`,
          ctx.readme && `README (excerpt):\n${ctx.readme.text.slice(0, OVERVIEW_SRC_CHARS)}`,
        ]
          .filter(Boolean)
          .join("\n\n");
        const text = await ctx.llm.chat(
          [
            {
              role: "system",
              content:
                "You are a codebase-analysis assistant. Based on the given project information, summarize in 2-4 " +
                "sentences what this project does and its core technologies and purpose. Output only the summary " +
                "itself, in English, with no heading, prefix, or quotes.",
            },
            { role: "user", content: facts },
          ],
          { temperature: 0.2, maxTokens: 300 },
        );
        return `## Overview\n\n${String(text).trim() || fallback || "(no description)"}`;
      } catch {
        // LLM unavailable / request failed: keep the deterministic fallback and flag the section,
        // so the next pass retries instead of leaving a silently degraded summary in place.
        return { body: `## Overview\n\n${fallback || "(no description)"}`, stale: "llm" };
      }
    },
  },

  {
    id: "basics",
    tier: "A",
    inputs: ["file:package.json", "exists:.git", "dirshape:."],
    maxChars: 400,
    priority: 30,
    build: (ctx) =>
      [
        "## Basics",
        `- Working directory: \`${ctx.workdir}\``,
        `- Repository type: ${ctx.isGit ? "Git repository" : "non-Git directory"}${
          ctx.monorepo ? ` · Monorepo (${ctx.monorepo})` : ""
        }`,
        ctx.pm ? `- Package manager: ${ctx.pm}` : null,
        ctx.pkg?.version ? `- Version: ${ctx.pkg.version}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
  },

  {
    id: "stack",
    tier: "A",
    inputs: ["file:package.json", "dirshape:."],
    maxChars: 400,
    priority: 40,
    build: (ctx) =>
      `## Tech Stack\n${ctx.stack.length ? ctx.stack.map((s) => `- ${s}`).join("\n") : "- (not detected)"}`,
  },

  {
    // Tier B. `always: true` — its staleness is per-module and lives inside the builder, so the
    // section-level input fingerprint cannot decide it; the builder is consulted every pass and
    // returns identical content (costing nothing) when no module has moved.
    id: "modules",
    tier: "B",
    always: true,
    inputs: [],
    maxChars: 1600,
    priority: 25,
    build: (ctx) => buildModuleMap(ctx),
  },

  {
    id: "tree",
    tier: "A",
    inputs: ["dirshape:."],
    maxChars: 1400,
    priority: 80,
    async build(ctx) {
      return `## Directory Structure (top level)\n\`\`\`\n${await buildDirTree(ctx.workdir)}\n\`\`\``;
    },
  },

  {
    id: "configs",
    tier: "A",
    inputs: ["dirshape:."],
    maxChars: 500,
    priority: 60,
    async build(ctx) {
      const present = [];
      for (const c of CONFIG_CANDIDATES) {
        if (await existsIn(ctx.workdir, c)) present.push(c);
      }
      return `## Key Config Files\n${present.length ? present.map((c) => `- ${c}`).join("\n") : "- (none)"}`;
    },
  },

  {
    id: "scripts",
    tier: "A",
    inputs: ["file:package.json", "dirshape:."],
    maxChars: 900,
    priority: 50,
    build(ctx) {
      const scripts = ctx.pkg?.scripts || {};
      const runPrefix = ctx.pm === "npm" || !ctx.pm ? "npm run" : `${ctx.pm} run`;
      const lines = Object.entries(scripts)
        .slice(0, 30)
        .map(([k, v]) => `- \`${runPrefix} ${k}\` — ${String(v).slice(0, 120)}`);
      return `## Common Scripts / Commands\n${
        lines.length ? lines.join("\n") : "- (no scripts defined in package.json)"
      }`;
    },
  },

  {
    id: "checks",
    tier: "A",
    inputs: ["file:package.json", "dirshape:."],
    maxChars: 300,
    priority: 70,
    async build(ctx) {
      if (typeof ctx.detectCheckSteps !== "function") return null;
      const steps = await ctx.detectCheckSteps();
      if (!steps.length) return null;
      return `## Checks (build / test)\n${steps.map((s) => `- ${s.label}: \`${s.cmd}\``).join("\n")}`;
    },
  },

  {
    id: "readme",
    tier: "A",
    inputs: ["readme"],
    maxChars: 900,
    priority: 90,
    build(ctx) {
      if (!ctx.readme) return null;
      const { name, text } = ctx.readme;
      const excerpt = text.slice(0, README_CHARS).trim();
      const suffix =
        text.length > README_CHARS ? `\n\n… (truncated; see ${name} for the full content)` : "";
      return `## README Summary (${name})\n\n${excerpt}${suffix}`;
    },
  },

  {
    // Tier C: authored knowledge. Seeded once, then never machine-written — this is where the
    // things no scan can recover live (invariants, gotchas, "don't do X because Y").
    id: "notes",
    tier: "C",
    inputs: [],
    authored: true,
    priority: -1, // never dropped by the size budget
    seed:
      "## Invariants & Gotchas\n\n" +
      "_Hand-authored. Zeraix never overwrites this section — record anything here that scanning " +
      "the repo could not tell you._\n\n" +
      "- (nothing recorded yet)",
  },
];
