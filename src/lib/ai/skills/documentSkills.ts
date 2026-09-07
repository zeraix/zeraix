/**
 * The built-in document skills: docx / xlsx / pptx / pdf.
 *
 * Installed on every copy of the app and enabled by default, so a first-run user who drops a spreadsheet into
 * the chat is offered the right recipes without visiting the marketplace. They are ordinary skills in every
 * other respect — listed in the skills change event, disclosed through load_skill, toggleable in the skills
 * panel — except that they cannot be uninstalled: only switched off (store.ts keeps the off-list).
 *
 * Content is original to this project and written against the toolchain baked into the sandbox image
 * (python-docx, openpyxl, python-pptx, pypdf, PyMuPDF, LibreOffice, pandoc, poppler, RapidOCR — see
 * sandbox/qemu/requirements.txt). The helper scripts the text refers to ship in resources/skills/ and are
 * reached through the `{{SKILLS_DIR}}` placeholder, resolved at load time by resolveSkillsDir below.
 *
 * Deliberately NOT part of builtin.ts: that module is imported by promptPrefix.ts, whose import graph is also
 * loaded by scripts/capture-prefix.mjs under tsx, where a raw `.md` import would not resolve. Nothing here
 * touches messages[0] either — the four entries ride the downstream skills reminder, so adding or editing
 * them never invalidates the shipped KV seed.
 */
import type { InstalledSkill } from "./types";
import { skillFromMarkdown } from "./parse";

import docxMd from "@/skills/builtin/docx.md";
import pdfMd from "@/skills/builtin/pdf.md";
import pptxMd from "@/skills/builtin/pptx.md";
import xlsxMd from "@/skills/builtin/xlsx.md";

/** Token the skill text uses for the helper-script folder; replaced per environment when the skill is loaded. */
export const SKILLS_DIR_PLACEHOLDER = "{{SKILLS_DIR}}";

/** The four built-in document skills, in the order the skills panel shows them. Parse failures throw at build time. */
export const DOCUMENT_SKILLS: InstalledSkill[] = [docxMd, xlsxMd, pptxMd, pdfMd].map((md) => ({
  ...skillFromMarkdown(md),
  source: "builtin" as const,
  installedAt: 0,
  enabled: true,
}));

const DOCUMENT_SKILL_IDS = new Set(DOCUMENT_SKILLS.map((s) => s.id));

/** Whether an id names one of the built-in document skills. */
export function isDocumentSkill(id: string): boolean {
  return DOCUMENT_SKILL_IDS.has(id);
}

/**
 * Fill in the helper-script folder for the environment commands run in right now.
 *
 * The sandbox sees the folder at a fixed mount point; the host sees the real path. When the sandbox is down
 * the skill is still worth having — the recipes are plain python-docx / openpyxl / pypdf — but nothing
 * guarantees those libraries, LibreOffice or poppler exist on the user's machine, so the text is prefixed
 * with the one thing the model must know: probe before relying on a tool, and say so when one is missing.
 */
export function resolveSkillsDir(
  instructions: string,
  env: { sandboxUp: boolean; dirs: { host: string; sandbox: string } | null },
): string {
  const dir = env.sandboxUp ? env.dirs?.sandbox : env.dirs?.host;
  const body = instructions.split(SKILLS_DIR_PLACEHOLDER).join(dir || "<skills folder unavailable>");
  if (env.sandboxUp) return body;
  return (
    "NOTE: the Linux sandbox is not running, so commands execute directly on the user's machine, where the toolchain " +
    "this skill assumes (python-docx, openpyxl, python-pptx, pypdf, PyMuPDF, LibreOffice, pandoc, poppler, RapidOCR) is " +
    "NOT guaranteed. Before relying on one, probe for it (e.g. `python -c \"import openpyxl\"`, `soffice --version`); " +
    "when it is missing, say so and tell the user the task needs the secure environment (restart it from the sandbox " +
    "status indicator) or that tool installed locally — never pretend the step succeeded.\n\n" +
    body
  );
}
