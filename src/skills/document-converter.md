---
id: document-converter
name: Document Converter
version: 1.0.0
author: builtin
audience: user
scope: targeted
tags: [documents, pdf, office, conversion]
description: Convert documents between formats and extract their content — PDF, Word/Excel/PowerPoint, Markdown, HTML, images, and scans (with OCR). Use when the user asks to convert a file, turn a PDF/Office doc into text/Markdown, merge or split PDFs, or read a scanned document.
allowedTools: [read_file, list_directory, write_file, run_command]
---

# Document Converter

You are now executing the **Document Converter** skill. Convert and extract
document content reliably, writing all outputs into the working directory.

## Workflow

1. **Identify inputs and the goal.** Which file(s), what output format, and where
   the result should go. Use `list_directory` / `read_file` to confirm the files
   exist and see what you're dealing with (real format, not just the extension).
2. **Pick the right tool for the job** (the sandbox has a full toolchain
   pre-installed — use it via `run_command`, do NOT try to `pip`/`apt` install
   heavy alternatives):
   - **PDF → Markdown/text:** `pymupdf4llm` (handles columns/tables well); for
     scanned/image PDFs add OCR (`RapidOCR`); plain text only → `pdftotext -layout`.
   - **Word/Excel/PowerPoint → Markdown/text:** `pandoc` for docx/odt;
     `markitdown` for xlsx/pptx.
   - **Anything → PDF, or Office ↔ Office (visual fidelity):** LibreOffice headless
     (`soffice --headless --convert-to pdf ...`).
   - **PDF manipulation:** merge/split/rotate (`pypdf`), compress (`ghostscript`),
     PDF → images (`pdftoppm`).
   - **Images/scans:** `imagemagick` for conversion; OCR for text extraction.
   - If a matching skill for the deep toolchain is available (doc/media toolbox),
     load it for the exact commands.
3. **Convert and verify.** Run the conversion, then check the output actually
   exists and looks right (`read_file` / `list_directory`). Report honestly if
   fidelity was lost (complex tables, heavy layout, poor scans).

## Guardrails

- Always write outputs into the working directory; the sandbox is otherwise
  ephemeral and files elsewhere are lost on restart.
- Do NOT install heavy ML tools (docling, marker-pdf, tesseract, paddleocr) — the
  pre-installed toolchain already covers these; such installs will fail.
- Do NOT overwrite the user's original file in place — write a new output file.
- Preserve the source content faithfully; if a conversion is lossy, say so.

## When you're done

Report the output file path(s), the tool used, and any fidelity caveats.
