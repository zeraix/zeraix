"""Describe a presentation or template: slide size, layouts with their placeholders, and (optionally) each slide.

    python layouts.py template.pptx            # layouts: index, name, placeholder idx / type / name / position
    python layouts.py deck.pptx --slides       # plus every slide: its layout, shapes, text snippets

Use it before building on a template: python-pptx needs the layout INDEX and the placeholder IDX to fill them.
"""
from __future__ import annotations

import argparse
import sys

from pptx import Presentation
from pptx.util import Emu


def inches(v) -> str:
    return f"{Emu(v).inches:.2f}in" if v is not None else "?"


def describe_shape(sh) -> str:
    kind = str(sh.shape_type).split(".")[-1] if sh.shape_type is not None else "PLACEHOLDER"
    pos = f"@({inches(sh.left)}, {inches(sh.top)}) {inches(sh.width)}x{inches(sh.height)}"
    ph = ""
    if sh.is_placeholder:
        pf = sh.placeholder_format
        ph = f" placeholder idx={pf.idx} type={str(pf.type).split('.')[-1].split(' ')[0]}"
    text = ""
    if getattr(sh, "has_text_frame", False) and sh.has_text_frame and sh.text_frame.text.strip():
        t = sh.text_frame.text.strip().replace("\n", " / ")
        text = f' text="{t[:60]}{"…" if len(t) > 60 else ""}"'
    return f"{sh.name} [{kind}]{ph} {pos}{text}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file")
    ap.add_argument("--slides", action="store_true")
    a = ap.parse_args()
    prs = Presentation(a.file)
    print(f"slide size: {inches(prs.slide_width)} x {inches(prs.slide_height)}; "
          f"{len(prs.slides)} slide(s); {len(prs.slide_layouts)} layout(s)")
    print("\nLAYOUTS")
    for i, layout in enumerate(prs.slide_layouts):
        print(f"  [{i}] {layout.name}")
        for ph in layout.placeholders:
            pf = ph.placeholder_format
            print(f"      idx={pf.idx:<3} {str(pf.type).split('.')[-1].split(' ')[0]:<14} {ph.name} "
                  f"@({inches(ph.left)}, {inches(ph.top)}) {inches(ph.width)}x{inches(ph.height)}")
    if a.slides:
        print("\nSLIDES")
        for i, slide in enumerate(prs.slides, start=1):
            print(f"  slide {i}: layout \"{slide.slide_layout.name}\"")
            for sh in slide.shapes:
                print("      " + describe_shape(sh))
            if slide.has_notes_slide and slide.notes_slide.notes_text_frame.text.strip():
                print(f"      notes: {slide.notes_slide.notes_text_frame.text.strip()[:80]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
