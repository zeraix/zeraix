---
id: pdf
name: PDF Files (.pdf)
version: 1.0.0
author: builtin
audience: user
scope: targeted
tags: [pdf, document, merge, split, forms, ocr, watermark, extract, report]
description: PDF files: read or extract text, tables and images; merge, split, reorder, rotate, crop; watermarks, stamps, page numbers, bookmarks; compress, encrypt/decrypt; inspect or fill forms; OCR scans into text or a searchable PDF; PDF to Word/images; generate PDFs (reports, invoices, certificates) from HTML/CSS or code. Load whenever a .pdf is the input or the deliverable.
allowedTools: [run_command, read_file, write_file, list_directory]
---

# PDF files

Preinstalled in the Linux sandbox: **pypdf** (pages, metadata, forms, encryption), **PyMuPDF / fitz**
(fast text, images, rendering, annotations, redaction), **pdfplumber** (tables with layout),
**pymupdf4llm** (PDF → Markdown), **reportlab** and **weasyprint** (create PDFs), **poppler**
(`pdftotext`, `pdftoppm`, `pdfinfo`), **qpdf**, **ghostscript**, and **RapidOCR** for scans. Helper
scripts: `{{SKILLS_DIR}}/pdf/` and `{{SKILLS_DIR}}/office/`. Write outputs into the working directory
and never overwrite the input.

## Inspect first

```bash
pdfinfo in.pdf                                   # pages, size, encryption, producer
pdffonts in.pdf | head                           # no fonts listed → probably a scan → OCR
pdftotext -layout -f 1 -l 2 in.pdf - | head -80  # first two pages of text, columns kept
python -c "import fitz; d=fitz.open('in.pdf'); print(d.page_count, d.metadata, d.get_toc()[:20])"
```

If `pdftotext` returns almost nothing for a page with visible content, it is an image: go to **OCR**.

## Read and extract

```bash
python -c "import pymupdf4llm; open('out.md','w').write(pymupdf4llm.to_markdown('in.pdf'))"   # best for reading / LLM use
pdftotext -layout in.pdf out.txt                                                              # plain text, fast
pdfimages -png in.pdf img/page                                                                # all embedded images
pdftoppm -r 120 -png -f 3 -l 3 in.pdf page3                                                   # render page 3 to PNG
```

```python
import pdfplumber                                 # tables
with pdfplumber.open("in.pdf") as pdf:
    for i, page in enumerate(pdf.pages, 1):
        for t in page.extract_tables():          # list of rows; tune with table_settings={"vertical_strategy": "text"} for borderless tables
            print(i, t)

import fitz                                       # positions, blocks, links, search
doc = fitz.open("in.pdf")
page = doc[0]
print(page.get_text("blocks"))                    # (x0, y0, x1, y1, text, block_no, type)
print(page.search_for("Total"))                   # rectangles where the word appears
print(page.get_links())
```

Tables from scans or from a very messy layout: render the page (`pdftoppm -r 200`) and OCR it, or
ask the user whether approximate extraction is acceptable — say clearly when fidelity is lost.

## Pages: merge, split, reorder, rotate, crop, delete

```python
from pypdf import PdfReader, PdfWriter
w = PdfWriter()
w.append("a.pdf"); w.append("b.pdf", pages=(0, 3))          # merge; pages=(start, stop) subset
w.write("merged.pdf")

r = PdfReader("in.pdf"); w = PdfWriter()
for i in [2, 0, 1]: w.add_page(r.pages[i])                   # reorder / pick pages
w.write("reordered.pdf")

w = PdfWriter(clone_from="in.pdf")
w.pages[0].rotate(90)                                        # clockwise degrees
w.remove_page(3)                                             # delete page 4 (0-based index)
w.write("edited.pdf")

for i, p in enumerate(PdfReader("in.pdf").pages, 1):         # split one file per page
    out = PdfWriter(); out.add_page(p); out.write(f"page-{i:03d}.pdf")
```

```bash
qpdf in.pdf --pages . 1-3,7,9-z -- out.pdf     # page ranges without Python ("z" = last)
qpdf --split-pages=1 in.pdf part-%d.pdf
```

Crop: set `page.cropbox = (x0, y0, x1, y1)` in points (origin bottom-left) on a pypdf page, or in PyMuPDF
`page.set_cropbox(fitz.Rect(...))`. Get the current size with `page.mediabox`.

## Watermarks, stamps, page numbers, bookmarks, metadata

```python
import fitz
doc = fitz.open("in.pdf")
for i, page in enumerate(doc, 1):
    r = page.rect
    page.insert_text((r.width - 80, r.height - 20), f"{i} / {doc.page_count}", fontsize=9, fontname="helv")   # page numbers
    page.insert_textbox(r, "DRAFT", fontsize=80, fontname="helv", rotate=0, color=(1, 0, 0), fill_opacity=0.15,
                        align=fitz.TEXT_ALIGN_CENTER)                                                            # text watermark
    page.insert_image(fitz.Rect(r.width - 120, 20, r.width - 20, 70), filename="logo.png", overlay=True)          # stamp / logo
doc.set_toc([[1, "Introduction", 1], [1, "Results", 4], [2, "Detail", 5]])                                      # bookmarks (level, title, page)
doc.set_metadata({"title": "Report", "author": "Acme", "subject": "Q2"})
doc.save("out.pdf", garbage=3, deflate=True)
```

Chinese / Japanese / Korean text in `insert_text`: use `fontname="china-s"` / `"japan"` / `"korea"`
(built into PyMuPDF), or `fontfile="/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"`.

## Compress, encrypt, decrypt, repair

```bash
gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.5 -dPDFSETTINGS=/ebook -dNOPAUSE -dQUIET -dBATCH -sOutputFile=small.pdf in.pdf   # /screen smaller, /printer better
qpdf --encrypt userpw ownerpw 256 -- in.pdf locked.pdf          # open password + owner password (empty "" allowed)
qpdf --decrypt --password=userpw locked.pdf open.pdf
qpdf --check in.pdf ; qpdf in.pdf repaired.pdf                   # diagnose / rebuild a damaged file
qpdf --linearize in.pdf web.pdf                                  # fast web view
```

pypdf equivalents: `writer.encrypt("userpw", "ownerpw")`, `reader.decrypt("pw")`. Check
`reader.is_encrypted` before reading — an encrypted file yields empty text.

## Forms

```bash
python {{SKILLS_DIR}}/pdf/forms.py list form.pdf --out fields.json     # names, types, options, page, rectangle
python {{SKILLS_DIR}}/pdf/forms.py fill form.pdf values.json filled.pdf [--flatten]
```

`values.json` maps field names to values: text as strings, checkboxes as `true`/`false`, radio/dropdown as
one of the listed options. `--flatten` bakes values in (no longer editable). A form with **no fields**
(a printed form saved as PDF) is filled by drawing text at coordinates: find the boxes with
`page.get_text("blocks")` or by rendering the page and reading pixel positions (× 72 / dpi → points),
then `page.insert_text((x, y), value, fontsize=10)` per field; render again and inspect the result.

## OCR scanned PDFs

```bash
python {{SKILLS_DIR}}/pdf/ocr_pdf.py scan.pdf --markdown scan.md           # text per page, OCR only where needed
python {{SKILLS_DIR}}/pdf/ocr_pdf.py scan.pdf --searchable scan-ocr.pdf    # invisible text layer: searchable / copyable
python -c "import pymupdf4llm; from rapidocr_v6_api import exec_ocr; open('out.md','w').write(pymupdf4llm.to_markdown('scan.pdf', ocr_function=exec_ocr, force_ocr=True))"   # Markdown with layout
```

RapidOCR is built in (Chinese, Japanese, Korean, Latin scripts). Do **not** install tesseract, paddleocr,
docling or marker — they will not fit or cannot download models in the sandbox. Skewed or dark scans
improve with `unpaper` or `convert page.png -deskew 40% -normalize page2.png` before OCR.

## Create PDFs

**Styled documents (reports, invoices, letters, certificates): write HTML + CSS, render with weasyprint.**

```python
from weasyprint import HTML, CSS
html = """<html><head><meta charset="utf-8"><style>
@page { size: A4; margin: 20mm; @bottom-center { content: "Page " counter(page) " of " counter(pages); font-size: 9pt; color: #666; } }
body { font-family: "Noto Sans", "Noto Sans CJK SC", sans-serif; font-size: 11pt; line-height: 1.45; color: #222; }
h1 { font-size: 22pt; margin: 0 0 4mm; } h2 { font-size: 14pt; margin-top: 8mm; border-bottom: 1px solid #ccc; }
table { border-collapse: collapse; width: 100%; } th, td { border: 1px solid #bbb; padding: 4px 8px; }
th { background: #eef2f7; text-align: left; } td.num { text-align: right; font-variant-numeric: tabular-nums; }
.page-break { page-break-before: always; }
</style></head><body>
<h1>Invoice #1042</h1> ... <table><tr><th>Item</th><th>Amount</th></tr><tr><td>Design</td><td class="num">1,200.00</td></tr></table>
</body></html>"""
HTML(string=html, base_url=".").write_pdf("invoice.pdf")     # base_url resolves relative <img src>
```

Charts for a report: make a PNG with matplotlib (`plt.savefig("chart.png", dpi=200, bbox_inches="tight")`)
and embed it with `<img src="chart.png" style="width: 100%">`.

**Precise drawing / programmatic layout: reportlab.**

```python
from reportlab.lib.pagesizes import A4
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Image, PageBreak
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))      # CJK without font files (HeiseiMin-W3 ja, HYSMyeongJo-Medium ko)
styles = getSampleStyleSheet()
story = [Paragraph("Quarterly Report", styles["Title"]), Spacer(1, 12), Paragraph("Body text…", styles["BodyText"])]
t = Table([["Region", "Q1"], ["North", "1,200"]], hAlign="LEFT")
t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eef2f7")), ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
                       ("ALIGN", (1, 1), (-1, -1), "RIGHT")]))
story += [t, PageBreak()]
SimpleDocTemplate("report.pdf", pagesize=A4).build(story)
```

**From existing files:** Office → PDF: `python {{SKILLS_DIR}}/office/render.py in.docx` (LibreOffice);
images → PDF: `img2pdf`-style with PyMuPDF (`doc.insert_page(-1); page.insert_image(page.rect, filename=…)`)
or `convert a.png b.png out.pdf` (ImageMagick); Markdown → PDF: `pandoc in.md -o out.pdf --pdf-engine=weasyprint`.

## PDF → Word / other formats

- Reflowable text (letters, articles): `pymupdf4llm` → Markdown → `pandoc out.md -o out.docx`. Clean, editable, loses exact layout.
- Layout-faithful but frame-based: `soffice --headless --infilter="writer_pdf_import" --convert-to docx in.pdf`. Each line becomes a text frame — tell the user which they get.
- Images: `pdftoppm -r 150 -png in.pdf page` (one file per page). Single page to JPEG: add `-f N -l N -jpeg`.

## Verify before delivering

```bash
pdfinfo out.pdf | grep -E "Pages|Page size"          # expected page count and size
pdftotext -layout out.pdf - | head -40               # text present and in order
pdftoppm -r 50 -png out.pdf check                    # small PNGs: look at them for layout problems
```

Confirm every requested page/field/watermark is present, that text is selectable where it should be (OCR
output), and that the file opens (`qpdf --check`). Report the output path, what was done, and any fidelity
loss (tables approximated, fonts substituted, scans OCR'd with possible errors).
