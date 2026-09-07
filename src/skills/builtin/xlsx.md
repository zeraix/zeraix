---
id: xlsx
name: Excel Spreadsheets (.xlsx)
version: 1.0.0
author: builtin
audience: user
scope: targeted
tags: [xlsx, excel, spreadsheet, csv, formulas, charts, pivot, data, office]
description: Spreadsheets (.xlsx, .xlsm, .csv, .tsv): read, create, edit or fix workbooks — columns, formulas, totals, formatting, charts, summary tables; clean messy tabular data; convert tabular formats; verify formulas calculate with no #REF! / #DIV/0!. Load whenever a spreadsheet file is the input or the deliverable, even mentioned casually. Not for Word reports or data pipelines.
allowedTools: [run_command, read_file, write_file, list_directory]
---

# Spreadsheets (.xlsx, .xlsm, .csv)

Preinstalled in the Linux sandbox: **openpyxl** (write / edit .xlsx with formulas and formatting),
**pandas** (analysis, csv/tsv, bulk data), **LibreOffice Calc** (recalculate, convert, .xls),
**markitdown** (quick read). Helper scripts: `{{SKILLS_DIR}}/xlsx/` and `{{SKILLS_DIR}}/office/`.
Outputs go into the working directory as new files; never overwrite the user's workbook unless asked.

## Inspect first

```bash
markitdown data.xlsx | head -80                                     # every sheet as a Markdown table
python - <<'PY'
from openpyxl import load_workbook
wb = load_workbook("data.xlsx", data_only=False)
for ws in wb.worksheets:
    print(ws.title, ws.dimensions, "merged:", list(ws.merged_cells.ranges)[:5], "freeze:", ws.freeze_panes)
    for row in ws.iter_rows(min_row=1, max_row=6, values_only=True): print("  ", row)
PY
```

Look for: where the header row really is, merged title rows, totals rows, formulas vs values (`data_only=False`
shows `=SUM(...)`), hidden sheets, number formats, and whether the file is a template whose style must be kept.
Legacy `.xls`: `soffice --headless --convert-to xlsx old.xls` first.

## Read data with pandas

```python
import pandas as pd
sheets = pd.read_excel("data.xlsx", sheet_name=None, header=0)      # dict of DataFrames; header=2 when the real header is row 3
df = sheets["Sales"]
df = pd.read_csv("data.csv", encoding="utf-8-sig")                   # try "gbk" / "latin-1" if it fails; sep="\t" for tsv
df.columns = [str(c).strip() for c in df.columns]
df["Amount"] = pd.to_numeric(df["Amount"].astype(str).str.replace(r"[,$]", "", regex=True), errors="coerce")
df["Date"] = pd.to_datetime(df["Date"], errors="coerce")
summary = df.groupby("Region", as_index=False)["Amount"].sum().sort_values("Amount", ascending=False)
```

`pd.read_excel` returns **cached values**, never formulas; a workbook written by openpyxl and never opened
in Excel has no cached values (NaN) — run `recalc.py --inplace` first if you must read computed results.

## Make it look designed

A spreadsheet is read, not admired, so its design job is different: make the numbers scannable and make the
structure obvious at a glance. The shared system does both in four calls.

```python
import sys; sys.path.insert(0, "{{SKILLS_DIR}}/office")
import theme

theme.xlsx_header(ws, 1, last_col)                      # styled, frozen, filtered header row
theme.xlsx_body(ws, 2, last_row, last_col, numeric_from=2)   # font, hairlines, numbers right-aligned
theme.xlsx_total_row(ws, last_row + 1, last_col)        # bold with a rule above, no fill
theme.xlsx_fit_columns(ws); theme.xlsx_finish(ws)       # width to content, screen gridlines off
```

- **Turn the screen gridlines off.** `xlsx_finish` does it. Gridlines are graph paper; once a sheet has a
  styled header and hairline row rules they are visual noise competing with the data.
- **Right-align every number, left-align every label,** and give numbers a format
  (`theme.NUMBER_FORMATS`). A column of numbers that is left-aligned cannot be compared by eye, which is
  the only thing a column of numbers is for.
- **Freeze the header and size the columns.** `#####` or a clipped header is the clearest possible signal
  that nobody looked at the file.
- **One accent, on the header row only.** Not a different fill per column, not a colour per sheet tab.
- **Banding is optional and must be nearly invisible.** `theme.TINT` is deliberately faint; anything
  stronger fights the numbers. Wide tables benefit, narrow ones do not.
- **Colour is for meaning, never decoration.** `theme.POSITIVE` / `NEGATIVE` / `WARNING` on a variance
  column, through conditional formatting, so the rule is visible and stays true when the data changes.
- **A total row reads as a total** because of a rule above it and bold weight — not a heavy fill.

Never do these: merged cells anywhere data is read (they break sorting, filtering and every formula that
crosses them); a rainbow of fills; borders on every cell; a title merged across the top of the data instead
of living in row 1 above a blank row; raw numbers with no format; a sheet still called "Sheet1"; numbers
stored as text, which is what silently breaks every later calculation.

## Create a workbook with openpyxl

```python
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side, numbers
from openpyxl.utils import get_column_letter
from openpyxl.chart import BarChart, LineChart, Reference
from openpyxl.worksheet.table import Table, TableStyleInfo
from openpyxl.formatting.rule import CellIsRule

import sys; sys.path.insert(0, "{{SKILLS_DIR}}/office")
import theme

wb = Workbook(); ws = wb.active; ws.title = "Sales"
FONT = "Arial"
header = ["Region", "Units", "Price", "Revenue", "Share"]
ws.append(header)
rows = [["North", 120, 9.5], ["South", 98, 11.0], ["West", 143, 8.75]]
for r in rows: ws.append(r)
n = len(rows); first, last = 2, n + 1
for i in range(first, last + 1):
    ws[f"D{i}"] = f"=B{i}*C{i}"                                  # formulas as text, English names, comma separators
    ws[f"E{i}"] = f"=IF($D${last + 1}=0,0,D{i}/$D${last + 1})"     # guard divisions
ws[f"A{last + 1}"] = "Total"; ws[f"B{last + 1}"] = f"=SUM(B{first}:B{last})"; ws[f"D{last + 1}"] = f"=SUM(D{first}:D{last})"

# The whole visual system, in four calls (see "Make it look designed" above).
theme.xlsx_header(ws, 1, len(header))
theme.xlsx_body(ws, 2, last, len(header), numeric_from=1)
theme.xlsx_total_row(ws, last + 1, len(header))
for i in range(2, last + 2):
    ws[f"B{i}"].number_format = theme.NUMBER_FORMATS["int"]
    ws[f"C{i}"].number_format = theme.NUMBER_FORMATS["money"]
    ws[f"D{i}"].number_format = theme.NUMBER_FORMATS["money"]
    ws[f"E{i}"].number_format = theme.NUMBER_FORMATS["pct"]
theme.xlsx_fit_columns(ws)
theme.xlsx_finish(ws)   # screen gridlines off; the styled header is the structure now
# Colour for MEANING, through a rule, so it stays true when the data changes.
ws.conditional_formatting.add(
    f"D{first}:D{last}",
    CellIsRule(operator="lessThan", formula=["1000"], font=Font(color=theme.NEGATIVE)),
)

chart = BarChart(); chart.title = "Revenue by region"; chart.y_axis.title = "Revenue"
chart.style = 2                                        # flat, no gradient or bevel
chart.legend = None                                    # one series needs no legend
chart.add_data(Reference(ws, min_col=4, min_row=1, max_row=last), titles_from_data=True)
chart.set_categories(Reference(ws, min_col=1, min_row=first, max_row=last))
chart.width, chart.height = 16, 8; ws.add_chart(chart, "G2")

notes = wb.create_sheet("Notes"); notes["A1"] = "Source: exported 2026-07-01; formulas in Sales!D:E"
wb.save("sales.xlsx")
```

Then **always** run the recalculation check (next section). Dates: write `datetime.date` objects and set
`number_format = "yyyy-mm-dd"`. Cross-sheet references: `='Raw Data'!B2`. Absolute references (`$B$10`)
for constants and totals. Avoid whole-column references (`A:A`) in large files. Use `Table(...)` +
`TableStyleInfo(name="TableStyleMedium2", showRowStripes=True)` when the user wants a filterable table.

pandas is fine for bulk data: `df.to_excel(writer, sheet_name="Data", index=False)` with
`pd.ExcelWriter("out.xlsx", engine="openpyxl")`, then reopen with openpyxl for formulas and formatting.

## Verify formulas (mandatory whenever you wrote formulas)

```bash
python {{SKILLS_DIR}}/xlsx/recalc.py sales.xlsx               # JSON: formula count per sheet + every error cell; exit 1 on errors
python {{SKILLS_DIR}}/xlsx/recalc.py sales.xlsx --inplace     # also store computed values (needed by previewers / pandas readers)
```

Fix every `#REF!`, `#DIV/0!`, `#NAME?`, `#VALUE!`, `#N/A` before delivering: wrong ranges after inserting
rows, non-English function names, semicolons instead of commas, text numbers ("1,200"), missing sheets.
Spot-check a few computed values against a pandas calculation of the same thing. `--inplace` writes the
LibreOffice-recalculated copy — keep the openpyxl original when the workbook has features LibreOffice may
alter (complex conditional formatting, slicers), and prefer the scan-only mode then.

## Edit an existing workbook

```python
from openpyxl import load_workbook
wb = load_workbook("in.xlsx")                       # keep_vba=True for .xlsm; formulas are preserved
ws = wb["Sales"]
ws.insert_cols(4); ws["D1"] = "Margin"               # references in formulas are NOT shifted by openpyxl — rewrite affected formulas
for r in range(2, ws.max_row + 1):
    ws[f"D{r}"] = f"=C{r}-B{r}"
ws.append(["East", 77, 10.0])                        # new row at the bottom; extend totals/charts ranges yourself
wb.save("out.xlsx")
```

Match the file's existing conventions (fonts, fills, number formats, header style, column widths) — copy
a neighbouring cell's style (`new.font = copy(old.font)` etc.) instead of imposing your own. openpyxl
**drops charts and images** it did not create when it loads a file, and does not evaluate formulas: for a
workbook with charts you must keep, edit the XML (`office/unpack.py` → `xl/worksheets/sheetN.xml`,
`xl/sharedStrings.xml` → `pack.py`) or drive LibreOffice (`soffice --headless --convert-to xlsx` after
editing a copy) and tell the user what was preserved.

## Clean messy data

Typical fixes with pandas: find the real header row (`header=n`), drop empty rows/columns
(`df.dropna(how="all")`), strip whitespace, unify column names, coerce numbers and dates, split combined
columns (`str.split`), remove duplicates (`drop_duplicates`), fill merged-cell gaps (`ffill`), unpivot wide
tables (`melt`). Keep the original sheet untouched and write the cleaned data to a new sheet or file, with
a short "Cleaning log" sheet listing what changed and how many rows were affected.

## Convert

```bash
soffice --headless --convert-to xlsx data.csv          # csv → xlsx (also xls, ods → xlsx)
soffice --headless --convert-to pdf report.xlsx        # print view as PDF; python {{SKILLS_DIR}}/office/render.py report.xlsx --png to look at it
python -c "import pandas as pd; pd.read_excel('in.xlsx', sheet_name='Sales').to_csv('out.csv', index=False, encoding='utf-8-sig')"
```

## Deliverable checklist

- **Render it and look**: `python {{SKILLS_DIR}}/office/render.py book.xlsx --png` shows what the print
  view actually looks like, which is the only way to catch a table running off the page.
- Header row styled, frozen and filtered; columns wide enough that nothing shows `#####`; screen gridlines
  off; one consistent font.
- Numbers as numbers with number formats (thousands, decimals, %, dates) — never numeric strings.
- Formulas, not pasted values, wherever the user will change inputs; totals via `SUM`, not hard-coded.
- `recalc.py` reports zero errors; spot-checked values; no stray sheets ("Sheet1") or test cells.
- Report the file path, sheet names, what formulas/charts were added, and any assumptions about the data.
