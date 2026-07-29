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

import sys

import numpy as np
import pymupdf

# Both of these are UPSTREAM INTERNALS, not public API: `get_culled_pixmap` is a private module path inside pymupdf4llm, and
# the FZ_STEXT_* constants below come from PyMuPDF's low-level SWIG binding. Either can move on a minor upgrade without notice,
# so pin pymupdf4llm and pymupdf in requirements.txt and re-check this file when bumping them.
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


def exec_ocr(page, dpi=150, pixmap=None, language="eng", keep_ocr_text=False):
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
    # Reshape by the pixmap's ACTUAL channel count. Hardcoding 3 raises "cannot reshape array" the first time the helper hands
    # back RGBA or grayscale, which is a crash on an unusual page rather than a degraded result. The engine wants 3 channels.
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
    if pix.n == 4:
        # ascontiguousarray is required, not defensive: dropping alpha with a slice leaves a view that strides over the 4th
        # byte, and an ONNX engine fed a non-contiguous buffer either copies it anyway or rejects it. Make the copy here where
        # it is visible. The n == 3 path below is untouched and allocates nothing, as before.
        img = np.ascontiguousarray(img[:, :, :3])
    elif pix.n == 1:
        img = np.repeat(img, 3, axis=2)  # already returns a fresh contiguous array

    # ── PP-OCRv6 call (new API returns a RapidOCROutput) ─────────────────────
    # exec_ocr runs once per page, so an uncaught failure here — model download, a malformed image, the engine running out of
    # memory — destroys the whole to_markdown run and every page already processed with it. Degrade this page instead.
    try:
        out = _engine()(img)
    except MemoryError:
        # NOT confined to this page: running out of memory says the machine cannot do this document, and grinding through the
        # remaining pages would produce an empty result while hiding the reason. Fail loudly and let the caller resize or
        # process page by page. (KeyboardInterrupt and SystemExit are BaseException, so they already pass through below.)
        raise
    except Exception as e:  # noqa: BLE001 - any other engine failure must stay confined to this page
        print(f"[rapidocr_v6_api] OCR failed on page {page.number}: {e}", file=sys.stderr)
        return
    boxes = getattr(out, "boxes", None)
    txts = getattr(out, "txts", None)
    if boxes is None or txts is None:
        return

    # Nothing recognised => return BEFORE touching the page. Two reasons, and the second is a correctness one:
    #  - insert_font embeds a full CJK font, and doing that on a page we are about to insert nothing into is pure cost, paid
    #    per page across the document;
    #  - the redactions below delete the existing illegible/old-OCR text on the promise that the engine restores it. With no
    #    recognised text there is nothing to restore, so applying them would destroy content rather than replace it.
    items = [(b, t) for b, t in zip(boxes, txts) if t and t.strip()]
    redaction_rects = fffd_spans + ocr_spans
    if not items:
        # Behaviour change worth seeing: previously these spans were redacted here even with nothing to put back, which
        # removed the page's illegible/old-OCR text and left a hole. They now survive, so the extracted markdown keeps that
        # text (U+FFFD and all) instead of losing it. Say so rather than differing from the old behaviour in silence.
        if redaction_rects:
            print(f"[rapidocr_v6_api] page {page.number}: OCR recognised nothing; leaving "
                  f"{len(redaction_rects)} illegible span(s) in place", file=sys.stderr)
        return

    # Redact old OCR / illegible spans; the engine restores them.
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
    for box, text in items:
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
