"""Render a document to PDF and/or PNG pages so the result can be checked visually.

    python render.py report.docx                      # -> report.pdf next to it, prints page count
    python render.py deck.pptx --png --grid           # -> PDF + one PNG per slide + a contact sheet
    python render.py model.xlsx --png --dpi 80 --outdir preview/
    python render.py existing.pdf --png               # PDF input: skips conversion

Works for .docx/.pptx/.xlsx/.odt/... (LibreOffice) and .pdf. Prints a JSON summary on the last line.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lo  # noqa: E402


def page_count(pdf: Path) -> int:
    try:
        from pypdf import PdfReader

        return len(PdfReader(str(pdf)).pages)
    except Exception:
        import fitz

        with fitz.open(str(pdf)) as d:
            return d.page_count


def contact_sheet(pngs: list[Path], out: Path, cols: int) -> Path:
    """Tile page images into one labelled grid (ImageMagick montage, else Pillow)."""
    if shutil.which("montage"):
        cmd = ["montage", *map(str, pngs), "-tile", f"{cols}x", "-geometry", "+6+6",
               "-background", "#dddddd", "-label", "%t", "-pointsize", "14", str(out)]
        subprocess.run(cmd, check=True, capture_output=True)
        return out
    from PIL import Image, ImageDraw

    imgs = [Image.open(p).convert("RGB") for p in pngs]
    w = max(i.width for i in imgs)
    h = max(i.height for i in imgs)
    pad, label = 6, 18
    rows = (len(imgs) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (w + pad) + pad, rows * (h + pad + label) + pad), "#dddddd")
    draw = ImageDraw.Draw(sheet)
    for i, im in enumerate(imgs):
        x = pad + (i % cols) * (w + pad)
        y = pad + (i // cols) * (h + pad + label)
        sheet.paste(im, (x, y))
        draw.text((x + 2, y + h + 2), pngs[i].stem, fill="#222222")
    sheet.save(out)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file")
    ap.add_argument("--outdir", help="where to write outputs (default: next to the input)")
    ap.add_argument("--png", action="store_true", help="also rasterise every page to PNG")
    ap.add_argument("--dpi", type=int, default=60, help="PNG resolution (default 60: small, quick to inspect)")
    ap.add_argument("--grid", action="store_true", help="also tile the PNGs into one contact sheet")
    ap.add_argument("--cols", type=int, default=4, help="contact-sheet columns (default 4)")
    ap.add_argument("--first", type=int, help="first page to rasterise (1-based)")
    ap.add_argument("--last", type=int, help="last page to rasterise")
    a = ap.parse_args()

    src = Path(a.file).resolve()
    outdir = Path(a.outdir).resolve() if a.outdir else src.parent
    outdir.mkdir(parents=True, exist_ok=True)
    pdf = src if src.suffix.lower() == ".pdf" else lo.to_pdf(src, outdir)
    result: dict = {"pdf": str(pdf), "pages": page_count(pdf)}
    if a.png or a.grid:
        pngs = lo.pdf_to_pngs(pdf, outdir / f"{src.stem}-pages", dpi=a.dpi, prefix=src.stem,
                              first=a.first, last=a.last)
        result["png"] = [str(p) for p in pngs]
        if a.grid and pngs:
            result["grid"] = str(contact_sheet(pngs, outdir / f"{src.stem}-grid.png", a.cols))
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
