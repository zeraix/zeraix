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

## Make it look designed

A generated PDF is judged the way print is: by its margins, its type and whether the eye knows where to go.
The shared design system ships the whole thing as CSS, so a weasyprint document inherits it in one line.

```python
import sys; sys.path.insert(0, "{{SKILLS_DIR}}/office")
import theme
from weasyprint import HTML, CSS

HTML(string=html, base_url=".").write_pdf("out.pdf", stylesheets=[CSS(string=theme.PDF_CSS)])
HTML(string=html).write_pdf("out.pdf", stylesheets=[CSS(string=theme.pdf_css("#7A1E2B"))])  # brand accent
```

`theme.PDF_CSS` already sets: A4 with a 2.6cm margin, page numbers in the footer, a type scale, hairline
tables whose header repeats on every page, `break-inside: avoid` on rows and figures, tabular figures for
numeric columns, and a callout style. Write semantic HTML and it is styled: `<h1>`–`<h3>`, `<p>`, `<table>`
with `<thead>`/`<tfoot>`, `td class="num"`, `p class="caption"`, `div class="callout"`,
`div class="page-break"`.

- **Set the measure, not just the margin.** 10.5pt on A4 at a 2.6cm margin gives about 90 characters, which
  is the top of the comfortable range. Longer lines lose the reader between them.
- **Tables get horizontal rules only,** a filled header, right-aligned numbers, and a repeated header on
  every page. Vertical rules are the fastest way to make a report look like a database dump.
- **One accent, spent once** — the table header rule, or a callout's left edge. Not both plus the headings.
- **Anchor figures.** A chart floating between two paragraphs with no caption forces the reader to guess
  what it shows. `p class="caption"` under it, always.
- **Check the page breaks, because that is where generated PDFs fail.** A heading alone at the foot, a table
  header orphaned from its rows, a figure split in half. The CSS prevents the common cases; the render is
  what tells you about the rest.

Never do these: a colour per heading level; underlined body text; centred paragraphs; a full-bleed
background colour behind running text (it wastes ink and lowers contrast); a font not named in the CSS
fallback stack, which silently substitutes on another machine; type below 9pt for anything but a caption.

For **reportlab**, there is no CSS: take the values from `theme` directly — `theme.TYPE`, `theme.INK`,
`theme.ACCENT`, `theme.HAIRLINE`, `theme.MARGIN_CM` — so a programmatic PDF matches the rest.

## Create PDFs

**Styled documents (reports, invoices, letters, certificates): write semantic HTML, style it with
`theme.PDF_CSS`, render with weasyprint.** Write the content; the system does the design.

```python
import sys; sys.path.insert(0, "{{SKILLS_DIR}}/office")
import theme
from weasyprint import HTML, CSS

html = """<html><head><meta charset="utf-8"></head><body>
  <p class="title">Invoice #1042</p>
  <p class="subtitle">Acme Ltd · due 30 July 2026</p>
  <table>
    <thead><tr><th>Item</th><th class="num">Amount</th></tr></thead>
    <tbody><tr><td>Design</td><td class="num">1,200.00</td></tr>
           <tr><td>Build</td><td class="num">3,400.00</td></tr></tbody>
    <tfoot><tr><td>Total</td><td class="num">4,600.00</td></tr></tfoot>
  </table>
  <p class="caption">Table 1. Line items, excluding VAT.</p>
  <div class="callout">Payment is due within 30 days of the invoice date.</div>
</body></html>"""
# base_url resolves relative <img src>; the stylesheet is the whole design system.
HTML(string=html, base_url=".").write_pdf("invoice.pdf", stylesheets=[CSS(string=theme.PDF_CSS)])
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

**Look at the PNGs**, and look at the page breaks first — that is where a generated PDF fails. A heading
alone at the foot of a page, a table header separated from its rows, a figure cut in half, a caption on the
page after its figure. Then check the shape of the page: even margins, one column of text, a clear
hierarchy, the accent used once. Then the details: numbers right-aligned, captions present, the footer on
every page.

Confirm every requested page, field and watermark is present, that text is selectable where it should be
(OCR output), and that the file opens (`qpdf --check`). Report the output path, what was done, and any
fidelity loss — tables approximated, fonts substituted, scans OCR'd with possible errors.
