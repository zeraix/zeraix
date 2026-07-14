"""
PyMuPDF4LLM OCR plugin for PP-OCRv6 via the NEW `rapidocr` package.

Why this exists
---------------
pymupdf4llm's built-in `rapidocr_api` targets the LEGACY `rapidocr_onnxruntime`
package (PP-OCRv4-era) and its `(list[[box, text, conf]], elapse)` return shape.
The new `rapidocr` package ships PP-OCRv6 but returns a `RapidOCROutput` object
(`.boxes / .txts / .scores`) — incompatible with the built-in plugin. This module
is a drop-in `ocr_function` that uses the new engine so you get PP-OCRv6.

Usage
-----
    import pymupdf4llm
    from rapidocr_v6_api import exec_ocr
    md = pymupdf4llm.to_markdown("scan.pdf", ocr_function=exec_ocr, force_ocr=True)

Requires
--------
    pip install rapidocr        # PP-OCRv6 (new package; NOT rapidocr_onnxruntime)

Notes
-----
- Reuses pymupdf4llm's culled-pixmap helper; `pymupdf4llm.ocr.__init__` only
  defines an enum (no eager engine import), so this is safe even when the legacy
  `rapidocr_onnxruntime` package is absent.
- Same "hybrid" strategy as the built-in plugins: only page regions lacking
  legible extractable text are rendered and OCRed.
"""

import numpy as np
import pymupdf
from pymupdf4llm.ocr.get_culled_pixmap import get_pixmap

FONT = pymupdf.Font("cjk")  # Droid Sans Fallback — covers CJK
FONTNAME = "myfont"
REPLACEMENT_UNICODE = chr(0xFFFD)
STROKED_TEXT = pymupdf.mupdf.FZ_STEXT_STROKED
FILLED_TEXT = pymupdf.mupdf.FZ_STEXT_FILLED

_ENGINE = None


def _engine():
    """Lazily build the PP-OCRv6 engine (defers model download to first use)."""
    global _ENGINE
    if _ENGINE is None:
        from rapidocr import RapidOCR  # NEW package == PP-OCRv6 by default

        _ENGINE = RapidOCR()
    return _ENGINE


def ocr_text(span) -> bool:
    if (span["char_flags"] & STROKED_TEXT) or (span["char_flags"] & FILLED_TEXT):
        return False
    return True


def exec_ocr(page, dpi=300, pixmap=None, language="eng", keep_ocr_text=False):
    """Page-level OCR callback for pymupdf4llm, using PP-OCRv6 (new `rapidocr`).

    Signature matches pymupdf4llm's ocr_function contract. `language` is unused:
    the v6 multilingual models auto-handle CJK + Latin. Mutates the page in place
    (inserts a recognized-text layer) and returns None.
    """

    def adjust_width(text, fontsize, rect):
        tl = FONT.text_length(text, fontsize)
        return pymupdf.Matrix(rect.width / tl, 1) if tl > 0 else pymupdf.Matrix(1, 1)

    # Render the page WITHOUT its already-legible text, so we only OCR the gaps.
    displaylist = page.get_displaylist()
    stextpage = displaylist.get_textpage(flags=pymupdf.TEXT_ACCURATE_BBOXES)
    text_blocks = pymupdf.TextPage(stextpage).extractDICT()["blocks"]

    spans, fffd_spans, ocr_spans = [], [], []
    for b in text_blocks:
        for l in b["lines"]:
            for s in l["spans"]:
                if ocr_text(s):
                    ocr_spans.append(s["bbox"])
                elif REPLACEMENT_UNICODE in s["text"]:
                    fffd_spans.append(s["bbox"])
                else:
                    spans.append(s["bbox"])
    if ocr_spans and keep_ocr_text:
        return

    pix = get_pixmap(displaylist, dpi=dpi, rects=spans)
    matrix = pymupdf.Rect(pix.irect).torect(page.rect)
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)

    # ── PP-OCRv6 call (new API returns a RapidOCROutput) ─────────────────────
    out = _engine()(img)
    boxes = getattr(out, "boxes", None)
    txts = getattr(out, "txts", None)
    scores = getattr(out, "scores", None)
    if boxes is None or txts is None:
        return
    if scores is None:
        scores = [1.0] * len(txts)

    # Redact old OCR / illegible spans; the engine restores them.
    redaction_rects = fffd_spans + ocr_spans
    if redaction_rects:
        for sbbox in redaction_rects:
            page.add_redact_annot(sbbox)
        page.apply_redactions(
            images=pymupdf.PDF_REDACT_IMAGE_NONE,
            graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
            text=pymupdf.PDF_REDACT_TEXT_REMOVE,
        )

    page.insert_font(fontname=FONTNAME, fontbuffer=FONT.buffer)

    # Insert recognized text. `box` = 4 (x, y) points → build a page-space rect.
    for box, text, conf in zip(boxes, txts, scores):
        if not text or not text.strip():
            continue
        xs = [float(p[0]) for p in box]
        ys = [float(p[1]) for p in box]
        rect = pymupdf.Rect(min(xs), min(ys), max(xs), max(ys)) * matrix
        fontsize = rect.height
        mat = adjust_width(text, fontsize, rect)
        page.insert_text(
            rect.bl + (0, -0.2 * fontsize),
            text,
            fontsize=fontsize,
            fontname=FONTNAME,
            morph=(rect.bl, mat),
        )
