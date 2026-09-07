"""Render every slide of a deck to small PNGs plus one labelled contact sheet, to check layout at a glance.

    python thumbnails.py deck.pptx                    # -> deck-slides/slide-01.png ... and deck-grid.png next to the deck
    python thumbnails.py deck.pptx --outdir preview/ --dpi 40 --cols 3

Look at the grid for overflowing text, empty placeholders, overlapping shapes and inconsistent alignment.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "office"))
import lo  # noqa: E402
from render import contact_sheet  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("deck")
    ap.add_argument("--outdir")
    ap.add_argument("--dpi", type=int, default=50)
    ap.add_argument("--cols", type=int, default=4)
    a = ap.parse_args()
    deck = Path(a.deck).resolve()
    outdir = Path(a.outdir).resolve() if a.outdir else deck.parent
    pdf = deck if deck.suffix.lower() == ".pdf" else lo.to_pdf(deck, outdir)
    pngs = lo.pdf_to_pngs(pdf, outdir / f"{deck.stem}-slides", dpi=a.dpi, prefix="slide")
    grid = contact_sheet(pngs, outdir / f"{deck.stem}-grid.png", a.cols) if pngs else None
    print(json.dumps({"slides": len(pngs), "png": [str(p) for p in pngs], "grid": str(grid) if grid else None},
                     ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
