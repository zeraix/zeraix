"""Find-and-replace text across a presentation while keeping each run's formatting.

    python replace_text.py in.pptx out.pptx --find "{{client}}" --replace "Acme Ltd"
    python replace_text.py in.pptx out.pptx --map values.json          # {"{{client}}": "Acme", "FY24": "FY25"}
    python replace_text.py in.pptx out.pptx --map values.json --notes   # also speaker notes

Handles text boxes, placeholders, grouped shapes and table cells. When a match is split across differently
formatted runs, the runs of that paragraph are merged into the first one (its formatting wins) — reported.
"""
from __future__ import annotations

import argparse
import json
import sys

from pptx import Presentation


def iter_text_frames(shapes):
    for shape in shapes:
        if shape.shape_type == 6 and hasattr(shape, "shapes"):  # group
            yield from iter_text_frames(shape.shapes)
            continue
        if getattr(shape, "has_text_frame", False) and shape.has_text_frame:
            yield shape.text_frame
        if getattr(shape, "has_table", False) and shape.has_table:
            for row in shape.table.rows:
                for cell in row.cells:
                    yield cell.text_frame


def replace_in_frame(tf, mapping: dict[str, str], where: str, merged: list[str]) -> int:
    n = 0
    for para in tf.paragraphs:
        for find, repl in mapping.items():
            if find not in para.text:
                continue
            hit_run = False
            for run in para.runs:
                if find in run.text:
                    run.text = run.text.replace(find, repl)
                    hit_run = True
                    n += 1
            if hit_run or find not in para.text:
                continue
            runs = para.runs
            if not runs:
                continue
            runs[0].text = para.text.replace(find, repl)
            for r in runs[1:]:
                r._r.getparent().remove(r._r)
            merged.append(f"{where}: merged runs to replace {find!r}")
            n += 1
    return n


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--find")
    ap.add_argument("--replace", default="")
    ap.add_argument("--map", help="JSON file of {find: replace}")
    ap.add_argument("--notes", action="store_true", help="also replace inside speaker notes")
    a = ap.parse_args()
    mapping: dict[str, str] = {}
    if a.map:
        with open(a.map, encoding="utf-8") as fh:
            mapping.update(json.load(fh))
    if a.find:
        mapping[a.find] = a.replace
    if not mapping:
        ap.error("give --find/--replace or --map")

    prs = Presentation(a.input)
    total = 0
    merged: list[str] = []
    for i, slide in enumerate(prs.slides, start=1):
        for tf in iter_text_frames(slide.shapes):
            total += replace_in_frame(tf, mapping, f"slide {i}", merged)
        if a.notes and slide.has_notes_slide:
            total += replace_in_frame(slide.notes_slide.notes_text_frame, mapping, f"slide {i} notes", merged)
    prs.save(a.output)
    for m in merged:
        print("note: " + m)
    print(f"{total} replacement(s); written to {a.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
