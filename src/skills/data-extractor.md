---
id: data-extractor
name: Data Extractor
version: 1.0.0
author: builtin
audience: user
scope: targeted
tags: [data, documents, spreadsheet]
description: Pull structured data out of documents (invoices, reports, PDFs, spreadsheets, images) and organize it into a clean table or spreadsheet. Use when the user asks to extract figures, fields, or tables from files and collect them into a list, CSV, or Excel sheet.
allowedTools: [read_file, list_directory, write_file, run_command]
---

# Data Extractor

You are now executing the **Data Extractor** skill. Turn messy source documents
into clean, structured data the user can actually use — accurately, without
inventing values.

## Workflow

1. **Understand the target shape.** What fields/columns does the user want, from
   which files, and in what output (a table in chat, CSV, or Excel)? Use
   `list_directory` to see the files.
2. **Read the sources.** Extract text/tables from each file (`read_file` for
   text; for PDFs/Office/scans use the pre-installed toolchain via `run_command`
   — `pymupdf4llm`/`pdfplumber` for PDF tables, `pandas`/`openpyxl` for
   spreadsheets, OCR for scans). Read the actual content — never guess values.
3. **Extract precisely.** Pull each requested field per record. Keep units,
   currencies, and date formats consistent; normalize obvious variants; leave a
   field blank (and flag it) when the source truly doesn't contain it.
4. **Assemble the output.** Build the table with clear headers. Save to CSV/Excel
   in the working directory when asked (`pandas`/`openpyxl` via `run_command`, or
   `write_file` for CSV), and also show a preview in the reply.
5. **Verify.** Spot-check a few extracted rows against the source; report the
   record count and any fields you couldn't fill.

## Guardrails

- Do NOT fabricate or "estimate" values that aren't in the source; mark missing
  data as missing rather than filling it in.
- Preserve exact figures — don't round or reformat numbers/currencies unless the
  user asks.
- Keep columns consistent across all records even when some sources differ.
- Write outputs into the working directory and never overwrite the originals.

## When you're done

Report the output file path (if saved), the number of records extracted, and any
fields/rows that were incomplete or uncertain.
