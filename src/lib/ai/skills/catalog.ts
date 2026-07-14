/**
 * Skill catalog: generated from `src/skills/*.md`.
 *
 * Each skill is a Markdown file (YAML frontmatter metadata + a body of instructions), imported as a
 * raw string via the Turbopack raw-loader (see the *.md rule in next.config.ts and the *.md
 * declaration in shims.d.ts). This file parses that raw text into Skill objects (parsing logic in
 * ./parse, shared with user uploads), serving as the catalog source for the "skill marketplace"
 * — to add a skill, just drop a .md into src/skills and register it in SKILL_FILES below, with no
 * other code changes.
 */
import type { Skill } from "./types";
import { skillFromMarkdown } from "./parse";

import coderMd from "@/skills/coder.md";
import bugFixerMd from "@/skills/bug-fixer.md";
import refactorMd from "@/skills/refactor.md";
import codeReviewerMd from "@/skills/code-reviewer.md";
import testWriterMd from "@/skills/test-writer.md";
import apiIntegratorMd from "@/skills/api-integrator.md";
import writingAssistantMd from "@/skills/writing-assistant.md";
import researchAssistantMd from "@/skills/research-assistant.md";
import documentConverterMd from "@/skills/document-converter.md";
import dataExtractorMd from "@/skills/data-extractor.md";

/** Registry: the marketplace display order follows this order. Append a new skill's raw Markdown import here. */
const SKILL_FILES: string[] = [
  coderMd,
  bugFixerMd,
  refactorMd,
  codeReviewerMd,
  testWriterMd,
  apiIntegratorMd,
  writingAssistantMd,
  researchAssistantMd,
  documentConverterMd,
  dataExtractorMd,
];

/** The skill marketplace catalog (parsed from src/skills/*.md). Parse failures (missing id/name, etc.) throw at build time.
 *  Note the arrow wrapper: it prevents Array.map from passing the index as skillFromMarkdown's fallbackName. */
export const CATALOG: Skill[] = SKILL_FILES.map((md) => skillFromMarkdown(md));
