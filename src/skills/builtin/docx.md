---
id: docx
name: Word Documents (.docx)
version: 1.0.0
author: builtin
audience: user
scope: targeted
tags: [docx, word, document, report, letter, memo, contract, tracked-changes, comments, office]
description: Word documents (.docx): create reports, letters, memos, contracts and templates with headings, tables, images, headers/footers, page numbers and a TOC; read, extract or restructure content; find-and-replace; tracked changes (redlines), comments, accept changes; convert to PDF. Load whenever a .docx / Word file is the input or the deliverable.
allowedTools: [run_command, read_file, write_file, list_directory]
---

# Word documents (.docx)

A .docx is a zip of XML parts (`word/document.xml` holds the body). You have three levels of tooling,
all preinstalled in the Linux sandbox: **pandoc** (read / convert), **python-docx** (create and make
structured edits), and **raw XML** (anything the library cannot express). Helper scripts live in
`{{SKILLS_DIR}}/docx/` and `{{SKILLS_DIR}}/office/`; run them with `python <script> --help`.

Always write results into the working directory and never overwrite the user's input file — produce a
new file (`report-v2.docx`) unless the user explicitly asks for in-place changes.

## Choose the approach

| Task | Do this |
|---|---|
| Read / summarise / extract text, tables, images | `pandoc` (below) |
| New document from scratch | python-docx (below); prose-heavy → Markdown + `pandoc --reference-doc` |
| Edit an existing file, keep its look | python-docx for text/table changes; XML for everything else |
| Tracked changes (redline a contract) | `redline.py`, `accept_changes.py` |
| Comments | `comment.py` |
| Convert to PDF / from .doc, .odt, .rtf | LibreOffice: `{{SKILLS_DIR}}/office/render.py` or `soffice --headless --convert-to` |
| Fill a template's placeholders | python-docx run-level replace (below) or `replace_text` logic per run |

## Read

```bash
pandoc in.docx -t gfm -o out.md                       # Markdown with headings, lists, tables
pandoc in.docx -t gfm --extract-media=media -o out.md # also dump embedded images into ./media
pandoc in.docx --track-changes=all -t gfm             # keep insertions/deletions visible (accept | reject | all)
pandoc in.docx -t plain | head -100                   # quick look
python -c "from docx import Document; d=Document('in.docx'); print([p.style.name for p in d.paragraphs][:40])"  # styles in use
soffice --headless --convert-to docx legacy.doc       # .doc/.odt/.rtf → .docx first, then work as usual
```

Word comments are not exported by pandoc: read `word/comments.xml` after `unpack.py` (below).

## Create with python-docx

```python
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

doc = Document()
# Base font (set on the Normal style so every paragraph inherits it). East Asian text needs w:eastAsia too.
normal = doc.styles["Normal"]
normal.font.name = "Arial"; normal.font.size = Pt(11)
normal.element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
for s in doc.sections:
    s.top_margin = s.bottom_margin = Cm(2.5); s.left_margin = s.right_margin = Cm(2.5)

doc.add_heading("Quarterly Report", level=0)          # Title style
doc.add_heading("1. Summary", level=1)                 # real Heading styles: TOC and navigation depend on them
p = doc.add_paragraph("Revenue grew ")
p.add_run("18%").bold = True
p.add_run(" year over year.")
doc.add_paragraph("First point", style="List Bullet")  # "List Number" for numbered lists
doc.add_paragraph("Second point", style="List Bullet")

table = doc.add_table(rows=1, cols=3, style="Table Grid")
table.alignment = WD_TABLE_ALIGNMENT.CENTER
for cell, text in zip(table.rows[0].cells, ["Region", "Q1", "Q2"]):
    cell.text = text
    cell.paragraphs[0].runs[0].bold = True
    shd = OxmlElement("w:shd"); shd.set(qn("w:fill"), "D9E2F3"); cell._tc.get_or_add_tcPr().append(shd)
for row in [["North", "1,200", "1,350"], ["South", "980", "1,010"]]:
    cells = table.add_row().cells
    for i, v in enumerate(row):
        cells[i].text = v
        if i: cells[i].paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.RIGHT   # numbers right-aligned

doc.add_picture("chart.png", width=Cm(15))            # keeps aspect ratio
doc.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
doc.add_page_break()

# Header text + "Page X of Y" footer via field codes
section = doc.sections[0]
section.header.paragraphs[0].text = "Acme Ltd — Confidential"
footer_p = section.footer.paragraphs[0]; footer_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
def add_field(paragraph, instr):
    run = paragraph.add_run()
    for tag, text in (("begin", None), ("instr", instr), ("separate", None), ("end", None)):
        if tag == "instr":
            el = OxmlElement("w:instrText"); el.set(qn("xml:space"), "preserve"); el.text = text
        else:
            el = OxmlElement("w:fldChar"); el.set(qn("w:fldCharType"), tag)
        run._r.append(el)
footer_p.add_run("Page "); add_field(footer_p, "PAGE"); footer_p.add_run(" of "); add_field(footer_p, "NUMPAGES")

doc.save("report.docx")
```

**Table of contents.** Insert a TOC field where it belongs and ask Word to refresh fields on open:

```python
add_field(doc.add_paragraph(), 'TOC \\o "1-3" \\h \\z \\u')          # right after the title page
upd = OxmlElement("w:updateFields"); upd.set(qn("w:val"), "true"); doc.settings.element.append(upd)
```

Word fills it in when the file is opened (it asks once). LibreOffice does not, so a PDF rendered from the
sandbox shows an empty TOC — if the PDF is the deliverable, write the TOC yourself as plain paragraphs.

**Prose-heavy documents:** write Markdown and let pandoc build the .docx, optionally styled like an
existing document: `pandoc report.md -o report.docx --reference-doc=template.docx --toc`. Pandoc's
`--toc` writes a real TOC for docx output.

## Edit an existing document

Open with python-docx, change what you need, save under a new name. Everything the library does not
understand (tracked changes, content controls, drawings) survives untouched.

```python
from docx import Document
doc = Document("in.docx")
for p in doc.paragraphs:                       # body paragraphs (not inside tables / headers)
    print(p.style.name, "|", p.text)
for t in doc.tables:
    for row in t.rows:
        print([c.text for c in row.cells])

def replace_in_paragraph(p, old, new):
    """Replace text while keeping run formatting. Falls back to merging runs when the match spans runs."""
    for r in p.runs:
        if old in r.text:
            r.text = r.text.replace(old, new); return True
    if old in p.text and p.runs:
        p.runs[0].text = p.text.replace(old, new)
        for r in p.runs[1:]: r._r.getparent().remove(r._r)
        return True
    return False

def all_paragraphs(doc):                       # body + tables + headers/footers
    yield from doc.paragraphs
    for t in doc.tables:
        for row in t.rows:
            for cell in row.cells: yield from cell.paragraphs
    for s in doc.sections:
        yield from s.header.paragraphs; yield from s.footer.paragraphs

for p in all_paragraphs(doc): replace_in_paragraph(p, "{{CLIENT}}", "Acme Ltd")

# Insert a paragraph AFTER an existing one (the library only appends at the end)
import copy
anchor = doc.paragraphs[5]
new_p = copy.deepcopy(anchor._p); anchor._p.addnext(new_p)
from docx.text.paragraph import Paragraph
np = Paragraph(new_p, anchor._parent); np.text = "Inserted paragraph, same style as the anchor"
doc.save("out.docx")
```

Never assign `p.text = ...` on a formatted paragraph unless you accept losing its run formatting.

## Raw XML when the library falls short

```bash
python {{SKILLS_DIR}}/office/unpack.py in.docx unpacked/     # pretty-printed XML you can read_file / grep
# edit unpacked/word/document.xml (body), styles.xml, numbering.xml, header1.xml, media/, _rels/
python {{SKILLS_DIR}}/office/pack.py unpacked/ out.docx       # validates well-formedness, then re-zips
```

Rules for hand edits: text lives only in `<w:t>` inside `<w:r>` — keep `xml:space="preserve"` on text
with leading/trailing spaces; a new part needs a `Relationship` in the matching `_rels` file and an
`Override` in `[Content_Types].xml`; `w:id` values of bookmarks/comments/revisions must stay unique;
replacing an image = overwrite the file in `word/media/` with one of the same format.

## Tracked changes and comments

```bash
python {{SKILLS_DIR}}/docx/redline.py in.docx out.docx --find "30 days" --replace "45 days" --author "Legal"
python {{SKILLS_DIR}}/docx/redline.py in.docx out.docx --find "draft" --replace "" --dry-run     # list matches only
python {{SKILLS_DIR}}/docx/comment.py in.docx out.docx --find "net 30" --comment "Confirm with finance" --author "Reviewer"
python {{SKILLS_DIR}}/docx/comment.py in.docx out.docx --paragraph 2 --comment "Rewrite: too long"
python {{SKILLS_DIR}}/docx/accept_changes.py draft.docx final.docx --strip-comments   # clean copy
python {{SKILLS_DIR}}/docx/accept_changes.py draft.docx reverted.docx --reject
```

Use redlines rather than silent edits whenever the user is reviewing, negotiating or must approve wording
(contracts, policies, submitted drafts). Chain several redlines by feeding each output into the next call.
A match that crosses a tab, line break, field or picture is reported as skipped — fix that one in the XML.

## Render and verify before delivering

```bash
python {{SKILLS_DIR}}/office/render.py out.docx --png --dpi 60     # PDF + one PNG per page (+ page count)
pandoc out.docx -t plain | head -60                                 # text reads in the right order?
```

Check: page count is plausible, no empty pages, headings are real Heading styles (`p.style.name`),
tables have a header row, numbers are right-aligned, fonts consistent (one body font, one heading
font), images not overflowing the margins, header/footer present on every section. When the request
was a PDF, deliver the rendered PDF as well.

## Pitfalls

- `.doc`, `.odt`, `.rtf`: convert to .docx with LibreOffice first; python-docx reads only .docx.
- A document created from `Document()` has the built-in styles ("List Bullet", "Heading 1", "Table
  Grid"). One opened from a user file may lack some — check `doc.styles` before using a style name.
- CJK text shows as boxes if only the Latin font is set; set `w:eastAsia` as shown above.
- LibreOffice rendering differs slightly from Word (line breaks, fonts); use it to catch structural
  problems, not to judge pixel layout.
- Images: `add_picture` with `width=` only, so the aspect ratio holds. Convert SVG to PNG first
  (`rsvg-convert -w 1600 in.svg -o in.png`).
- Deliverable size: compress large photos before embedding (`convert big.jpg -resize 1600x1600> -quality 82 small.jpg`).
