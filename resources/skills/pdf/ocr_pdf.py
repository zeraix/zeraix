"""OCR a scanned PDF with the preinstalled RapidOCR engine.

    python ocr_pdf.py scan.pdf --markdown scan.md            # text per page (OCR only where a page has no text layer)
    python ocr_pdf.py scan.pdf --searchable scan-ocr.pdf     # same PDF with an invisible text layer: searchable, copyable
    python ocr_pdf.py scan.pdf --markdown out.md --pages 1-3 --force --dpi 300

Pages that already carry text are read directly unless --force. Chinese / Japanese / Korean and Latin text are
all handled by the bundled PP-OCR models; nothing needs downloading.
"""
from __future__ import annotations

import argparse
import re
import sys
import tempfile
from pathlib import Path

import fitz  # PyMuPDF

CJK = re.compile(r"[぀-ヿ㐀-䶿一-鿿가-힯]")


def parse_pages(spec: str | None, count: int) -> list[int]:
    if not spec:
        return list(range(count))
    pages: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-", 1)
            pages.update(range(int(a) - 1, min(int(b), count)))
        elif part:
            pages.add(int(part) - 1)
    return sorted(p for p in pages if 0 <= p < count)


class Ocr:
    def __init__(self):
        from rapidocr import RapidOCR

        self.engine = RapidOCR(params={"Global.log_level": "error"})

    def run(self, page: fitz.Page, dpi: int) -> list[tuple[list, str]]:
        """[(box as 4 [x, y] points in PDF points, text)] in reading order."""
        pix = page.get_pixmap(dpi=dpi)
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
            pix.save(tmp.name)
            result = self.engine(tmp.name)
        Path(tmp.name).unlink(missing_ok=True)
        if result is None or not getattr(result, "txts", None):
            return []
        scale = 72.0 / dpi
        out = []
        for box, txt in zip(result.boxes, result.txts):
            pts = [[float(x) * scale, float(y) * scale] for x, y in box]
            out.append((pts, str(txt)))
        return out


def add_text_layer(page: fitz.Page, lines: list[tuple[list, str]]) -> None:
    for pts, txt in lines:
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
        height = max(y1 - y0, 2.0)
        fontsize = max(4.0, min(72.0, height * 0.85))
        font = "china-s" if CJK.search(txt) else "helv"
        for name in (font, "china-s", "helv"):
            try:
                page.insert_text((x0, y1 - height * 0.2), txt, fontsize=fontsize, fontname=name, render_mode=3)
                break
            except Exception:
                continue


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf")
    ap.add_argument("--markdown", help="write recognised text here (## Page N sections)")
    ap.add_argument("--searchable", help="write a copy with an invisible OCR text layer here")
    ap.add_argument("--pages", help="e.g. 1-3,7 (1-based; default all)")
    ap.add_argument("--dpi", type=int, default=200)
    ap.add_argument("--force", action="store_true", help="OCR every page, even those with a text layer")
    ap.add_argument("--min-chars", type=int, default=30, help="a page with fewer characters of text is treated as scanned")
    a = ap.parse_args()
    if not a.markdown and not a.searchable:
        ap.error("give --markdown and/or --searchable")

    doc = fitz.open(a.pdf)
    ocr = None
    md_parts = []
    ocr_pages = 0
    for i in parse_pages(a.pages, doc.page_count):
        page = doc[i]
        existing = page.get_text("text").strip()
        if existing and len(existing) >= a.min_chars and not a.force:
            md_parts.append(f"## Page {i + 1}\n\n{existing}\n")
            continue
        if ocr is None:
            ocr = Ocr()
        lines = ocr.run(page, a.dpi)
        ocr_pages += 1
        md_parts.append(f"## Page {i + 1}\n\n" + "\n".join(t for _, t in lines) + "\n")
        if a.searchable:
            add_text_layer(page, lines)
    if a.markdown:
        Path(a.markdown).write_text("\n".join(md_parts), encoding="utf-8")
        print(f"text written to {a.markdown} ({ocr_pages} page(s) OCR'd)")
    if a.searchable:
        doc.save(a.searchable, garbage=3, deflate=True)
        print(f"searchable PDF written to {a.searchable} ({ocr_pages} page(s) OCR'd)")
    doc.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
