---
id: pptx
name: PowerPoint Slides (.pptx)
version: 1.0.0
author: builtin
audience: user
scope: targeted
tags: [pptx, powerpoint, slides, deck, presentation, pitch, template, office]
description: PowerPoint (.pptx): build a slide deck, pitch or lecture from an outline, data or a template; read slide text and notes; add, edit, reorder or remove slides; replace placeholder text; export to PDF or PNG thumbnails. Load whenever the user says deck, slides or presentation, or names a .pptx as input or deliverable.
allowedTools: [run_command, read_file, write_file, list_directory]
---

# PowerPoint presentations (.pptx)

Preinstalled in the Linux sandbox: **python-pptx** (create / edit), **markitdown** (read), **pandoc**
(Markdown → slides), **LibreOffice** (render, convert), **matplotlib** and **ImageMagick** (charts,
images). Helper scripts: `{{SKILLS_DIR}}/pptx/` and `{{SKILLS_DIR}}/office/`. Write outputs into the
working directory; never overwrite the user's deck — save as a new file.

## Choose the approach

| Task | Do this |
|---|---|
| Read text / notes / structure | `markitdown deck.pptx` or `layouts.py --slides` |
| See what the slides look like | `thumbnails.py` → contact sheet PNG |
| New deck, user has a template or a house style | Open the template with python-pptx, add slides from its layouts |
| New deck from scratch | python-pptx on a blank 16:9 presentation with your own design system |
| Quick text-only deck from an outline | `pandoc outline.md -o deck.pptx [--reference-doc house.pptx]` |
| Edit / update / fill placeholders | python-pptx; `replace_text.py` for text substitution |
| Slides → PDF / images | `{{SKILLS_DIR}}/office/render.py deck.pptx --png` |

## Read

```bash
markitdown deck.pptx > deck.md                      # slide-by-slide text, tables, notes
python {{SKILLS_DIR}}/pptx/layouts.py deck.pptx --slides     # layouts + placeholders + every shape with position and text
python {{SKILLS_DIR}}/pptx/thumbnails.py deck.pptx            # PNG per slide + labelled grid (look at it!)
python {{SKILLS_DIR}}/office/unpack.py deck.pptx unpacked/    # raw XML: ppt/slides/slideN.xml, ppt/media/, ppt/slideLayouts/
```

## Make it look designed

Slides fail visually in ways pages do not: type that is too small to read from the back of a room, six
bullets where one sentence would do, and a different arrangement on every slide. Import the shared design
system and most of it is decided for you.

```python
import sys; sys.path.insert(0, "{{SKILLS_DIR}}/office")
import theme
p = theme.pptx_palette()   # colours as RGBColor, the slide type scale, and a 12-column grid
```

- **Type is large or it is not read.** `p["type"]`: hero 44pt (title slide only), title 30pt, lead 20pt,
  body 17pt. 17pt is the floor — if content will not fit at 17, the slide is holding two ideas, so split it.
- **A grid, so slides do not drift.** `p["grid"]` gives a 0.75in margin, a 0.25in gutter and a 0.9375in
  column on a 13.33in slide. Put every element on a column boundary and the deck reads as one deck. Titles
  start at the same `top` on every slide; nothing else lines up if that does not.
- **One idea per slide, stated in the title.** "Revenue grew 18% on renewals" beats "Revenue". The title is
  the takeaway; the body is the evidence. A deck whose titles read as a list of nouns says nothing.
- **Left-align everything except the title slide.** Centred body text has a ragged left edge, which is the
  one edge the eye actually uses to find the next line.
- **Bullets are a last resort.** One number set large, one chart, one image with a short caption, or three
  short lines — all read better than a five-item list. When bullets are right, cap them at six and at about
  ten words each.
- **Charts show data, not furniture.** `theme.pptx_style_chart(chart, series_count=n)` removes the legend
  for a single series, fades the gridlines to hairline, colours series from the shared palette and sets the
  label type. Never 3-D, never a pie with more than four slices.
- **Let it breathe.** Roughly a third of a good slide is empty. If nothing can be removed, the content
  belongs on two slides.

Never do these: text smaller than 17pt in the body; a wall of bullets; text placed over a busy photograph
without a dark scrim behind it; a different accent per slide; drop shadows and 3-D bevels; a logo on every
slide (title and closing slide are enough); stretched images — crop instead, keeping the aspect ratio;
"Click to add title" left in place anywhere.

## Build a deck with python-pptx

Plan first: write the outline (title, 3–6 bullets or one visual per slide, speaker notes) and agree the
number of slides with the request. Then encode a small design system once and reuse it.

```python
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION

import sys; sys.path.insert(0, "{{SKILLS_DIR}}/office")
import theme

prs = Presentation()                                  # or Presentation("template.pptx") to inherit its masters
prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)   # 16:9 (skip when using a template)
W, H = prs.slide_width, prs.slide_height
P = theme.pptx_palette()
INK, MUTED, ACCENT, PAPER = P["ink"], P["muted"], P["accent"], P["paper"]
FONT, TYPE, GRID = P["font"], P["type"], P["grid"]
BLANK = prs.slide_layouts[6]

def col(n):        # left edge of grid column n (0-based), for placing anything on the grid
    return Inches(GRID["margin"] + n * (GRID["col"] + GRID["gutter"]))

def text(slide, x, y, w, h, s, size=TYPE["body"], bold=False, color=INK, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP):
    box = slide.shapes.add_textbox(x, y, w, h); tf = box.text_frame; tf.word_wrap = True; tf.vertical_anchor = anchor
    lines = s if isinstance(s, list) else [s]
    for i, line in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.text, p.alignment = line, align
        r = p.runs[0]; r.font.name, r.font.size, r.font.bold, r.font.color.rgb = FONT, size, bold, color
    return box

def bullets(slide, x, y, w, h, items, size=TYPE["body"]):
    box = slide.shapes.add_textbox(x, y, w, h); tf = box.text_frame; tf.word_wrap = True
    for i, item in enumerate(items):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        lvl = 1 if item.startswith("  ") else 0
        p.text, p.level = ("• " if lvl == 0 else "– ") + item.strip(), lvl
        p.space_after = Pt(6); r = p.runs[0]; r.font.name, r.font.size, r.font.color.rgb = FONT, Pt(size.pt - 2 * lvl), INK
    return box

def title_bar(slide, title):
    bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, W, Inches(1.1)); bar.fill.solid(); bar.fill.fore_color.rgb = INK; bar.line.fill.background()
    text(slide, Inches(0.6), Inches(0.25), W - Inches(1.2), Inches(0.7), title, size=TYPE["title"], bold=True, color=RGBColor(255, 255, 255), anchor=MSO_ANCHOR.MIDDLE)

# 1. title slide
s = prs.slides.add_slide(BLANK)
bg = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, W, H); bg.fill.solid(); bg.fill.fore_color.rgb = INK; bg.line.fill.background()
text(s, Inches(0.8), Inches(2.6), W - Inches(1.6), Inches(1.2), "Q2 Business Review", size=TYPE["hero"], bold=True, color=RGBColor(255, 255, 255))
text(s, Inches(0.8), Inches(3.9), W - Inches(1.6), Inches(0.8), "Acme Ltd · July 2026", size=TYPE["lead"], color=RGBColor(0xC9, 0xD1, 0xE0))

# 2. bullets + chart
s = prs.slides.add_slide(BLANK); title_bar(s, "Revenue grew 18% year over year")
bullets(s, Inches(0.6), Inches(1.5), Inches(5.6), Inches(5), ["North up 12%", "  driven by renewals", "South up 31%", "Churn flat at 2.1%"])
cd = CategoryChartData(); cd.categories = ["Q1", "Q2", "Q3", "Q4"]; cd.add_series("2025", (4.1, 4.4, 4.9, 5.3)); cd.add_series("2026", (5.0, 5.4, 6.1, 6.4))
chart = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(6.6), Inches(1.5), Inches(6.2), Inches(5), cd).chart
theme.pptx_style_chart(chart, series_count=2)   # legend only when earned, hairline gridlines, palette series

# 3. picture + caption, 4. table
s = prs.slides.add_slide(BLANK); title_bar(s, "Product shots")
s.shapes.add_picture("photo.jpg", Inches(0.6), Inches(1.5), width=Inches(7))          # width only → aspect kept
text(s, Inches(8), Inches(1.5), Inches(4.7), Inches(3), ["What changed", "Faster onboarding, fewer clicks."], size=TYPE["label"], color=MUTED)
s = prs.slides.add_slide(BLANK); title_bar(s, "Plan by region")
rows = [["Region", "Q3 target", "Owner"], ["North", "1,400", "A. Chen"], ["South", "1,100", "R. Silva"]]
tbl = s.shapes.add_table(len(rows), 3, Inches(0.6), Inches(1.6), Inches(12), Inches(0.4) * len(rows)).table
for r, row in enumerate(rows):
    for c, v in enumerate(row):
        cell = tbl.cell(r, c); cell.text = v; p = cell.text_frame.paragraphs[0]
        p.runs[0].font.size, p.runs[0].font.name, p.runs[0].font.bold = TYPE["label"], FONT, r == 0
        if c == 1 and r: p.alignment = PP_ALIGN.RIGHT
s.notes_slide.notes_text_frame.text = "Speaker notes: mention hiring plan."
prs.save("deck.pptx")
```

Sizing rules of thumb (16:9, 13.33 × 7.5 in): title 28–40 pt, body 16–20 pt, never below 12 pt; at most
6 bullets × 10 words; leave ≥ 0.5 in margins; one idea per slide. python-pptx does not shrink text to
fit — estimate ~45 characters per line at 18 pt over 6 in and add lines/slides rather than overflow.

**Charts** come from `add_chart` (native, editable): column/bar for comparisons, line for trends, pie only
for 2–4 shares. For anything python-pptx cannot chart, render a PNG with matplotlib at `dpi=200` and add
it as a picture.

## Use a template

```bash
python {{SKILLS_DIR}}/pptx/layouts.py template.pptx      # layout indexes + placeholder idx per layout
```

```python
prs = Presentation("template.pptx")
layout = prs.slide_layouts[1]                              # e.g. "Title and Content"
s = prs.slides.add_slide(layout)
s.shapes.title.text = "Agenda"
body = s.placeholders[1]                                   # idx from layouts.py, not position
tf = body.text_frame; tf.text = "Welcome"
p = tf.add_paragraph(); p.text = "Numbers"; p.level = 1
pic_ph = next((ph for ph in s.placeholders if "PICTURE" in str(ph.placeholder_format.type)), None)
if pic_ph: pic_ph.insert_picture("photo.jpg")
# Remove the template's sample slides you did not use (from the end, keeping rIds valid)
for idx in reversed([i for i, sl in enumerate(prs.slides) if i >= KEEP_FIRST_N]):
    rid = prs.slides._sldIdLst[idx].rId; prs.part.drop_rel(rid); del prs.slides._sldIdLst[idx]
prs.save("deck.pptx")
```

Keep the template's fonts, colours and placeholder positions; don't draw your own title bars on a
templated slide. Bulk-substitute markers such as `{{client}}` with
`python {{SKILLS_DIR}}/pptx/replace_text.py template.pptx out.pptx --map values.json --notes`.

## Edit an existing deck

```python
prs = Presentation("deck.pptx")
for i, s in enumerate(prs.slides, 1):
    for sh in s.shapes:
        if sh.has_text_frame and "FY24" in sh.text_frame.text:
            for p in sh.text_frame.paragraphs:
                for r in p.runs: r.text = r.text.replace("FY24", "FY25")       # run-level keeps formatting
# reorder: move slide 5 to position 2
lst = prs.slides._sldIdLst; el = list(lst)[4]; lst.remove(el); lst.insert(1, el)
# duplicate a slide: add a slide on the same layout and copy the shapes' XML
import copy
src = prs.slides[0]; dup = prs.slides.add_slide(src.slide_layout)
for sh in list(dup.shapes): sh._element.getparent().remove(sh._element)
for sh in src.shapes: dup.shapes._spTree.insert_element_before(copy.deepcopy(sh._element), "p:extLst")
prs.save("deck-v2.pptx")
```

Pictures in a duplicated slide reference the source slide's relationships — re-add them with
`add_picture`. Anything else (SmartArt, embedded video, transitions): edit the XML after `unpack.py`,
then `pack.py`.

## Outline → deck with pandoc

```bash
pandoc outline.md -o deck.pptx --slide-level=2 [--reference-doc=house.pptx]
```

`#` = section title slide, `##` = one slide, bullets and images (`![](chart.png)`) as content, `:::
notes` blocks for speaker notes. Fast for text decks; use python-pptx when layout matters.

## Verify before delivering

```bash
python {{SKILLS_DIR}}/pptx/thumbnails.py deck.pptx --dpi 50     # then look at deck-grid.png
python {{SKILLS_DIR}}/office/render.py deck.pptx                 # PDF version if the user wants one
```

Check the grid for text running off the slide or over other shapes, empty placeholders ("Click to add
title"), tiny fonts, inconsistent title positions, missing images. Fix and re-render. Report the file
path, slide count and anything you could not verify.
