"""One design system for every document these skills produce.

The four document skills each know how to *drive* their library. What decides whether the result looks
considered or merely generated is a much smaller set of choices — a type scale, a restrained palette,
spacing that groups related things — and those choices should be identical whether the deliverable is a
Word report, a deck, a spreadsheet or a PDF. They live here so a model does not have to remember hex
codes, and so a report and the slides summarising it look like they came from the same place.

## The palette, and why these values

Business documents fail visually in one of two ways: they use the library defaults (Calibri 11 on white
with Office blue #4472C4 and grey gridlines everywhere), which reads as "nobody chose this"; or they use
a lot of colour, which reads as a school project. The way out is a near-neutral document with a single
accent spent in one place.

`ACCENT` is a deep petrol teal, not the default Office blue. Two reasons: the default blue is the tell of
an unstyled document, and this hue keeps its contrast when printed in greyscale, which matters for things
people actually print. Every value below meets WCAG AA against the ground it is used on.

Swap it for a brand: change `ACCENT` and `ACCENT_TINT` together, keep everything else, and check the tint
stays light enough for black text (aim for a luminance around 0.9).

## Using it

    import sys; sys.path.insert(0, "<skills>/office"); import theme
    theme.docx_base(doc)        # Word: styles, margins, the type scale
    theme.pptx_palette()        # Slides: the same colours as pptx RGBColor
    theme.xlsx_header(ws, 1, 5) # Excel: a header row that looks deliberate
    theme.PDF_CSS               # weasyprint: the whole system as CSS
"""

# ── Colour ───────────────────────────────────────────────────────────────────────────────────────
# Hex without the "#", which is what python-docx, openpyxl and python-pptx all want.

INK = "1A1D21"        # headings and anything that must read as structural
BODY = "2E3338"       # running text: not pure black, which vibrates against white on screen
MUTED = "6B727A"      # captions, axis labels, secondary rows
HAIRLINE = "D8DCE0"   # rules and table borders — visible, never assertive
TINT = "F1F4F6"       # banded rows, callout fills, a table header on a light document
PAPER = "FFFFFF"

ACCENT = "0F5257"       # the one colour with an opinion; spend it once per page
ACCENT_TINT = "E3EDEC"  # its wash, for a header fill behind dark text
ACCENT_INK = "0B3D41"   # a darker step, for text on the tint

# Semantic, for data only — never decoration. Muted on purpose: a red that shouts makes every
# spreadsheet look like an alert.
POSITIVE = "1F6F4A"
NEGATIVE = "9B2C2C"
WARNING = "8A6A1E"

# Categorical series for charts, in order.
#
# Ordered and spaced by LIGHTNESS, not by hue. Greyscale printing and the commonest forms of colour
# blindness both collapse a palette to lightness, so series that differ only in hue become one series on
# paper — which is how a chart that looked fine on screen arrives at a meeting unreadable. Every adjacent
# pair here is separated by a relative-luminance step of at least 0.029; the test in
# test/document-skills.test.mjs holds that line, because it is invisible to inspection.
SERIES = [ACCENT, "6B4E71", "2F6F8F", "B4643C", "8FA05A", "C89A63"]

# ── Type ─────────────────────────────────────────────────────────────────────────────────────────
# One family for the document, one for figures. Named rather than exotic: a document that opens on
# someone else's machine with a substituted font has no design at all.

BODY_FONT = "Aptos"          # Word/Office default since 2024; falls back cleanly
BODY_FONT_FALLBACK = "Calibri"
SERIF_FONT = "Georgia"       # for long-form prose, where a serif reads better on paper
MONO_FONT = "Consolas"
CJK_FONT = "Microsoft YaHei"  # East Asian companion; without this CJK text renders as boxes

# A scale, not a set of guesses. Ratios near 1.25, rounded to half-points that Word will not fight.
TYPE = {
    "title": 26,
    "h1": 17,
    "h2": 13.5,
    "h3": 11.5,
    "body": 10.5,
    "small": 9,
    "caption": 8.5,
}

# Line spacing as a multiple. 1.0 is the library default and is too tight for 10.5pt text.
LEADING = 1.30
LEADING_TIGHT = 1.15  # headings and table cells, where lines belong together

# ── Space ────────────────────────────────────────────────────────────────────────────────────────
# In points. The rule that does most of the work: space BEFORE a heading is larger than the space
# after it, so a heading belongs to the text below rather than floating between two blocks.

SPACE = {"before_h": 16, "after_h": 5, "para": 7, "tight": 3}
MARGIN_CM = 2.6  # A4 with this and 10.5pt gives a measure near 90 characters


# ── Word ─────────────────────────────────────────────────────────────────────────────────────────
def docx_base(doc, *, serif: bool = False, cjk: bool = True):
    """Apply the whole system to a python-docx Document: fonts, sizes, spacing, margins, heading styles.

    Call it immediately after `Document()` and before adding content. Returns the document.
    """
    from docx.shared import Pt, Cm, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml.ns import qn

    family = SERIF_FONT if serif else BODY_FONT

    normal = doc.styles["Normal"]
    normal.font.name = family
    normal.font.size = Pt(TYPE["body"])
    normal.font.color.rgb = RGBColor.from_string(BODY)
    if cjk:
        # Word stores the East Asian face separately; without this CJK runs fall back to a default
        # that usually is not installed, and the text renders as boxes.
        normal.element.rPr.rFonts.set(qn("w:eastAsia"), CJK_FONT)
    pf = normal.paragraph_format
    pf.line_spacing = LEADING
    pf.space_after = Pt(SPACE["para"])
    pf.space_before = Pt(0)

    for name, size, colour, before in (
        ("Title", TYPE["title"], INK, 0),
        ("Heading 1", TYPE["h1"], INK, SPACE["before_h"]),
        ("Heading 2", TYPE["h2"], INK, SPACE["before_h"] - 4),
        ("Heading 3", TYPE["h3"], ACCENT_INK, SPACE["before_h"] - 6),
    ):
        if name not in [s.name for s in doc.styles]:
            continue
        st = doc.styles[name]
        st.font.name = family
        st.font.size = Pt(size)
        st.font.bold = name != "Title"
        st.font.color.rgb = RGBColor.from_string(colour)
        if cjk:
            st.element.rPr.rFonts.set(qn("w:eastAsia"), CJK_FONT)
        st.paragraph_format.space_before = Pt(before)
        st.paragraph_format.space_after = Pt(SPACE["after_h"])
        st.paragraph_format.line_spacing = LEADING_TIGHT
        st.paragraph_format.keep_with_next = True  # a heading never ends a page alone

    for s in doc.sections:
        s.top_margin = s.bottom_margin = Cm(MARGIN_CM)
        s.left_margin = s.right_margin = Cm(MARGIN_CM)

    _ = WD_ALIGN_PARAGRAPH  # imported for callers that follow this with alignment work
    return doc


def docx_table(table, *, header=True, numeric_from=1, zebra=False):
    """Make a python-docx table look designed: hairline horizontal rules, no vertical clutter.

    The single biggest visual upgrade available to a Word document. "Table Grid" boxes every cell,
    which turns data into a wall of lines; real typographic tables use a rule under the header, a
    light rule between rows, and nothing else.

    numeric_from: the first column index whose cells hold numbers, right-aligned from there on.
    """
    from docx.shared import Pt, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH

    table.style = "Table Grid"
    _clear_borders(table)
    for r, row in enumerate(table.rows):
        for c, cell in enumerate(row.cells):
            for p in cell.paragraphs:
                p.paragraph_format.space_before = Pt(SPACE["tight"])
                p.paragraph_format.space_after = Pt(SPACE["tight"])
                p.paragraph_format.line_spacing = LEADING_TIGHT
                if c >= numeric_from and r > 0:
                    p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
                for run in p.runs:
                    run.font.size = Pt(TYPE["small"])
                    run.font.name = BODY_FONT
                    if header and r == 0:
                        run.font.bold = True
                        run.font.color.rgb = RGBColor.from_string(INK)
        if header and r == 0:
            _cell_fill(row, ACCENT_TINT)
            _row_border(row, "bottom", ACCENT, 8)
        elif r < len(table.rows) - 1:
            _row_border(row, "bottom", HAIRLINE, 4)
    return table


def docx_caption(doc, text):
    """A figure or table caption: small, muted, tight to the thing above it."""
    from docx.shared import Pt, RGBColor

    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(SPACE["tight"])
    p.paragraph_format.space_after = Pt(SPACE["para"])
    run = p.add_run(text)
    run.font.size = Pt(TYPE["caption"])
    run.font.color.rgb = RGBColor.from_string(MUTED)
    run.font.italic = True
    return p


def _xml(tag):
    from docx.oxml import OxmlElement

    return OxmlElement(tag)


def _q(name):
    from docx.oxml.ns import qn

    return qn(name)


def _clear_borders(table):
    tbl_pr = table._tbl.tblPr
    for existing in tbl_pr.findall(_q("w:tblBorders")):
        tbl_pr.remove(existing)
    borders = _xml("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = _xml(f"w:{edge}")
        el.set(_q("w:val"), "none")
        el.set(_q("w:sz"), "0")
        borders.append(el)
    tbl_pr.append(borders)


def _row_border(row, edge, colour, eighths):
    for cell in row.cells:
        tc_pr = cell._tc.get_or_add_tcPr()
        borders = tc_pr.find(_q("w:tcBorders"))
        if borders is None:
            borders = _xml("w:tcBorders")
            tc_pr.append(borders)
        el = _xml(f"w:{edge}")
        el.set(_q("w:val"), "single")
        el.set(_q("w:sz"), str(eighths))  # eighths of a point
        el.set(_q("w:color"), colour)
        borders.append(el)


def _cell_fill(row, colour):
    for cell in row.cells:
        shd = _xml("w:shd")
        shd.set(_q("w:fill"), colour)
        cell._tc.get_or_add_tcPr().append(shd)


# ── Slides ───────────────────────────────────────────────────────────────────────────────────────
def pptx_palette():
    """The palette as python-pptx RGBColor objects, plus the deck's type scale in points.

    Slide type is much larger than page type: what is comfortable at 10.5pt on A4 is unreadable from
    the back of a room. The scale below assumes a 13.33in wide slide.
    """
    from pptx.dml.color import RGBColor
    from pptx.util import Pt

    c = lambda h: RGBColor.from_string(h)  # noqa: E731
    return {
        "ink": c(INK), "body": c(BODY), "muted": c(MUTED), "paper": c(PAPER),
        "hairline": c(HAIRLINE), "tint": c(TINT),
        "accent": c(ACCENT), "accent_tint": c(ACCENT_TINT), "accent_ink": c(ACCENT_INK),
        "series": [c(h) for h in SERIES],
        "font": BODY_FONT,
        "type": {
            "hero": Pt(44),    # title slide only
            "title": Pt(30),   # every other slide
            "lead": Pt(20),    # one-sentence takeaway under a title
            "body": Pt(17),    # the floor: never smaller in body copy
            "label": Pt(12),   # axis labels, source notes, page numbers
        },
        # A 12-column grid on a 13.33in slide, in inches: margin 0.75, gutter 0.25.
        "grid": {"margin": 0.75, "gutter": 0.25, "col": 0.9375, "top": 1.5, "width": 11.83},
    }


def pptx_style_chart(chart, *, series_count=1):
    """Strip a python-pptx chart back to its data: no 3-D, faint gridlines, a legend only if earned."""
    from pptx.util import Pt
    from pptx.enum.chart import XL_LEGEND_POSITION
    from pptx.dml.color import RGBColor

    chart.font.size = Pt(12)
    chart.font.name = BODY_FONT
    chart.font.color.rgb = RGBColor.from_string(MUTED)
    # One series needs no legend: the title already says what the bars are, and a legend for a single
    # colour is pure furniture.
    chart.has_legend = series_count > 1
    if chart.has_legend:
        chart.legend.position = XL_LEGEND_POSITION.BOTTOM
        chart.legend.include_in_layout = False
    try:
        va = chart.value_axis
        va.has_major_gridlines = True
        gl = va.major_gridlines.format.line
        gl.color.rgb = RGBColor.from_string(HAIRLINE)
        gl.width = Pt(0.75)
        va.format.line.color.rgb = RGBColor.from_string(HAIRLINE)
        ca = chart.category_axis
        ca.has_major_gridlines = False
        ca.format.line.color.rgb = RGBColor.from_string(HAIRLINE)
    except Exception:
        pass  # pie and doughnut charts have no value axis
    try:
        for i, plot_series in enumerate(chart.series):
            plot_series.format.fill.solid()
            plot_series.format.fill.fore_color.rgb = RGBColor.from_string(SERIES[i % len(SERIES)])
    except Exception:
        pass
    return chart


# ── Excel ────────────────────────────────────────────────────────────────────────────────────────
def xlsx_header(ws, row: int, last_col: int, *, freeze=True, filter_row=True):
    """Style a header row and freeze it. The row people look at most, and usually the least styled."""
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter

    for col in range(1, last_col + 1):
        cell = ws.cell(row=row, column=col)
        cell.font = Font(name=BODY_FONT, bold=True, color="FFFFFF", size=10)
        cell.fill = PatternFill("solid", fgColor=ACCENT)
        cell.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)
        cell.border = Border(bottom=Side(style="thin", color=ACCENT_INK))
    ws.row_dimensions[row].height = 22
    if freeze:
        ws.freeze_panes = ws.cell(row=row + 1, column=1)
    if filter_row:
        ws.auto_filter.ref = f"A{row}:{get_column_letter(last_col)}{ws.max_row}"
    return ws


def xlsx_body(ws, first_row: int, last_row: int, last_col: int, *, numeric_from=2, zebra=True):
    """Body rows: the app font, tight rules, numbers right-aligned, optional very light banding."""
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

    hair = Side(style="thin", color=HAIRLINE)
    for r in range(first_row, last_row + 1):
        for c in range(1, last_col + 1):
            cell = ws.cell(row=r, column=c)
            cell.font = Font(name=BODY_FONT, size=10, color=BODY)
            cell.border = Border(bottom=hair)
            cell.alignment = Alignment(
                horizontal="right" if c >= numeric_from else "left", vertical="center"
            )
            if zebra and (r - first_row) % 2 == 1:
                cell.fill = PatternFill("solid", fgColor=TINT)
    return ws


def xlsx_total_row(ws, row: int, last_col: int):
    """A totals row that reads as a total: bold, a rule above, no fill."""
    from openpyxl.styles import Font, Border, Side

    for c in range(1, last_col + 1):
        cell = ws.cell(row=row, column=c)
        cell.font = Font(name=BODY_FONT, size=10, bold=True, color=INK)
        cell.border = Border(top=Side(style="thin", color=INK))
    return ws


def xlsx_fit_columns(ws, *, min_width=9, max_width=52):
    """Size every column to its content. Nothing looks less finished than ##### or a truncated header."""
    from openpyxl.utils import get_column_letter

    for col in ws.columns:
        letter = get_column_letter(col[0].column)
        longest = max((len(str(c.value)) for c in col if c.value is not None), default=0)
        ws.column_dimensions[letter].width = max(min_width, min(max_width, longest + 3))
    return ws


def xlsx_finish(ws, *, gridlines=False):
    """The last touches a presentation sheet needs: hide the screen gridlines, start at the top."""
    ws.sheet_view.showGridLines = gridlines
    ws.sheet_view.zoomScale = 100
    ws.sheet_properties.tabColor = ACCENT
    return ws


# Number formats worth using by name rather than inventing per sheet.
NUMBER_FORMATS = {
    "int": "#,##0",
    "money": '#,##0.00;[Red]-#,##0.00',
    "money0": '#,##0;[Red]-#,##0',
    "pct": "0.0%",
    "pct0": "0%",
    "date": "yyyy-mm-dd",
    "month": "mmm yyyy",
}


# ── PDF / HTML ───────────────────────────────────────────────────────────────────────────────────
# The same system as CSS, for weasyprint. Includes running page numbers and print-safe colours.
PDF_CSS = f"""
@page {{
  size: A4;
  margin: {MARGIN_CM}cm;
  @bottom-center {{
    content: counter(page) " / " counter(pages);
    font-family: {BODY_FONT}, {BODY_FONT_FALLBACK}, sans-serif;
    font-size: {TYPE["caption"]}pt;
    color: #{MUTED};
  }}
}}
html {{ font-size: {TYPE["body"]}pt; }}
body {{
  font-family: {BODY_FONT}, {BODY_FONT_FALLBACK}, "Noto Sans CJK SC", sans-serif;
  font-size: {TYPE["body"]}pt;
  line-height: {LEADING};
  color: #{BODY};
  -webkit-font-smoothing: antialiased;
}}
h1, h2, h3 {{ color: #{INK}; line-height: {LEADING_TIGHT}; break-after: avoid; }}
h1 {{ font-size: {TYPE["h1"]}pt; margin: 0 0 {SPACE["after_h"]}pt; }}
h2 {{ font-size: {TYPE["h2"]}pt; margin: {SPACE["before_h"]}pt 0 {SPACE["after_h"]}pt; }}
h3 {{ font-size: {TYPE["h3"]}pt; color: #{ACCENT_INK}; margin: {SPACE["before_h"] - 6}pt 0 {SPACE["after_h"]}pt; }}
p {{ margin: 0 0 {SPACE["para"]}pt; }}
.title {{ font-size: {TYPE["title"]}pt; color: #{INK}; line-height: 1.1; margin: 0 0 4pt; }}
.subtitle {{ font-size: {TYPE["h3"]}pt; color: #{MUTED}; margin: 0 0 {SPACE["before_h"]}pt; }}
.muted {{ color: #{MUTED}; }}
.caption {{ font-size: {TYPE["caption"]}pt; color: #{MUTED}; font-style: italic; margin-top: {SPACE["tight"]}pt; }}
a {{ color: #{ACCENT_INK}; text-decoration: none; border-bottom: 0.5pt solid #{HAIRLINE}; }}
code, pre {{ font-family: {MONO_FONT}, monospace; font-size: {TYPE["small"]}pt; background: #{TINT}; }}
pre {{ padding: 8pt; border-left: 2pt solid #{ACCENT}; white-space: pre-wrap; break-inside: avoid; }}

/* Tables: a rule under the header, hairlines between rows, nothing vertical. */
table {{ width: 100%; border-collapse: collapse; margin: {SPACE["para"]}pt 0; font-size: {TYPE["small"]}pt; }}
thead th {{
  background: #{ACCENT_TINT}; color: #{INK}; text-align: left; font-weight: 600;
  padding: 5pt 7pt; border-bottom: 1pt solid #{ACCENT};
}}
tbody td {{ padding: 4.5pt 7pt; border-bottom: 0.5pt solid #{HAIRLINE}; vertical-align: top; }}
tbody tr:last-child td {{ border-bottom: none; }}
td.num, th.num {{ text-align: right; font-variant-numeric: tabular-nums; }}
tfoot td {{ font-weight: 600; color: #{INK}; border-top: 1pt solid #{INK}; padding-top: 5pt; }}
thead {{ display: table-header-group; }}   /* repeat the header on every page */
tr, img, figure {{ break-inside: avoid; }}

.callout {{
  background: #{TINT}; border-left: 2.5pt solid #{ACCENT};
  padding: 8pt 11pt; margin: {SPACE["para"]}pt 0; break-inside: avoid;
}}
.page-break {{ break-before: page; }}
"""


def pdf_css(accent: str | None = None) -> str:
    """PDF_CSS with a different accent, for a brand. Everything else is unchanged."""
    if not accent:
        return PDF_CSS
    return PDF_CSS.replace(f"#{ACCENT}", f"#{accent.lstrip('#')}")


if __name__ == "__main__":  # a quick look at the tokens
    print(f"accent #{ACCENT}  ink #{INK}  body #{BODY}  hairline #{HAIRLINE}")
    print("type:", TYPE)
    print("series:", SERIES)
