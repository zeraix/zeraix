/**
 * Built-in skills: not from the marketplace, not persisted to localStorage, and not shown in the
 * skills management panel; auto-equipped based on runtime conditions (e.g. when the sandbox is ready).
 * Like installed skills, they use load_skill progressive disclosure — the catalog takes only a
 * one-line description, and the full manifest is fed back only once the model judges the task a match,
 * so no first-turn tokens are wasted.
 *
 * The "Document / Media Processing Toolbox" corresponds one-to-one with the image's
 * sandbox/qemu/Dockerfile + requirements.txt (Debian 13 trixie); keep this file in sync whenever the
 * image adds or removes tools.
 */
import type { InstalledSkill } from "./types";

/** Document / Media Processing Toolbox (equipped only for sandbox execution; see runtimeSkills in page.tsx). */
export const SANDBOX_TOOLBOX_SKILL: InstalledSkill = {
  id: "doc-media-toolbox",
  name: "Document / Media Processing Toolbox",
  version: "2", // follows the image tag (v2)
  description:
    "Processing and format conversion for documents / PDF / Office / OCR / images / audio & video: the current sandbox comes with a full toolchain preinstalled " +
    "(pymupdf4llm, markitdown, pandoc, LibreOffice, RapidOCR, ffmpeg, imagemagick, etc.). " +
    "Load this skill before such tasks and use the preinstalled tools directly per the list; do not pip/apt install anything yourself.",
  author: "Built-in",
  tags: ["sandbox", "pdf", "office", "ocr"],
  allowedTools: ["run_command"],
  installedAt: 0,
  enabled: true,
  instructions: `This sandbox (Debian 13, root, bash) comes with a complete document / media toolchain preinstalled. Prefer using the tools below directly; do not reinstall them, and never install heavyweight ML alternatives such as docling / marker-pdf / tesseract / paddleocr — the sandbox has only ~4GB of writable disk, their torch/CUDA dependencies routinely run to several GB, and their models are hosted on sites unreachable from inside the sandbox, so installation is bound to fail (the built-in tools already cover the equivalent capabilities). If you genuinely must install a lightweight package temporarily, pip / uv already have a China mirror configured and are ready to use, but the sandbox is an ephemeral layer apart from the mounted working directory — installed packages and files outside the working directory are lost when the sandbox restarts, so always write every artifact into the working directory.

## Python 3.13
/opt/venv is already on PATH: python / pip / uv are directly usable, with network access.

## PDF → Markdown (preferred for LLM ingestion)
- pymupdf4llm (good with multi-column / tables):
  python -c "import pymupdf4llm; open('out.md','w').write(pymupdf4llm.to_markdown('in.pdf'))"
- Scanned documents (image-type PDF) plus OCR — RapidOCR (PP-OCRv6) is built in with models packaged offline, strong on mixed Chinese/English:
  python -c "import pymupdf4llm; from rapidocr_v6_api import exec_ocr; open('out.md','w').write(pymupdf4llm.to_markdown('in.pdf', ocr_function=exec_ocr, force_ocr=True))"
- markitdown: a universal front door to Markdown for any document (docx/pptx/xlsx/html/epub/images… 15+ formats): markitdown in.docx > out.md
  (note its PDF path is only pdfminer plain text, weak on layout/tables/scans — always prefer pymupdf4llm for PDFs)
- Plain text only: pdftotext -layout in.pdf out.txt (poppler-utils)

## PDF parsing / generation / transformation
- Parsing: pdfplumber (table extraction), PyMuPDF/fitz (text/image extraction, page rendering), pypdf (merge/split/rotate), pikepdf + qpdf (repair/encrypt/linearize)
- Generation: weasyprint (HTML/CSS → PDF), reportlab (programmatic drawing)
- PDF → images: pdf2image / pdftoppm; compress / convert version: ghostscript (gs)

## Office documents
- Read/write: python-docx / openpyxl / python-pptx / odfpy / pandas (excel/csv)
- Universal conversion: LibreOffice headless: soffice --headless --convert-to pdf in.docx --outdir . (use unoserver for batch / low latency)
- pandoc / pypandoc: convert between md / html / docx / latex / epub
- mammoth: docx → clean HTML/Markdown; trafilatura: web-page body text → Markdown

## Images / media / graphics
imagemagick (convert), ffmpeg (audio/video), librsvg (SVG), pngquant (PNG compression), unpaper (scanned-page cleanup), graphviz (dot). Chinese fonts (Noto CJK) are installed, so PDF / Office rendering won't produce tofu boxes.

## Common CLI
rg, jq, git, curl, wget, 7z, zstd, unzip/zip, xz, make, tmux, bc, ss/lsof/htop, etc. are all available.

## Selection guide (choose by "task → tool", not by impression)
- PDF read → Markdown: pymupdf4llm (strong on multi-column / tables / structure; for scans add exec_ocr — note its bundled
  auto-OCR uses tesseract, which is not in the image, so be sure to use the exec_ocr adapter). Use it to do its best even on the
  most difficult PDFs (dense financial tables, complex multi-column academic layouts), and honestly explain to the user the possible fidelity loss
- docx / odt read → Markdown: pandoc (highest structural fidelity: tables, footnotes, nesting; mammoth as an alternative for clean semantic output)
- xlsx / pptx read → Markdown: markitdown (pandoc can't read xlsx / pptx)
- Markdown → docx / pptx (generate office): pandoc
- office → PDF and any office-to-office conversion (visual fidelity): LibreOffice (soffice --headless --convert-to pdf,
  a real rendering engine — PDFs generated by pandoc don't reproduce Word layout; use unoserver for batch / low latency)
- Compute spreadsheet formulas: LibreOffice's UNO/Calc engine (python3-uno + unoserver installed) — openpyxl only reads cached formula values, it won't recompute
- Simple structured edits (add a row, change a cell, replace a paragraph): python-docx / openpyxl, lighter, no need to involve LibreOffice
- Extract PDF text / tables (programmatic processing): PyMuPDF (fast) / pdfplumber (tables + layout); plain text only: pdftotext
- Web-page body text → Markdown: trafilatura
- Do not install: docling / marker-pdf (torch/CUDA dependencies of several GB, exceeding sandbox disk and with unreachable model sites, bound to fail),
  tesseract / paddleocr (the built-in RapidOCR already covers OCR)`,
};
