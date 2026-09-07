"""Accept (or reject) every tracked change in a .docx, optionally stripping comments — a clean final copy.

    python accept_changes.py draft.docx final.docx
    python accept_changes.py draft.docx final.docx --strip-comments
    python accept_changes.py draft.docx reverted.docx --reject

Handles insertions, deletions, moves, formatting changes and deleted/inserted paragraph marks in the body,
headers, footers, footnotes and endnotes. Use pandoc first if you only need to READ the final text:
    pandoc draft.docx --track-changes=accept -t gfm
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _docxml as dx  # noqa: E402

PROP_CHANGES = ["rPrChange", "pPrChange", "sectPrChange", "tblPrChange", "tblPrExChange",
                "trPrChange", "tcPrChange", "tblGridChange", "numberingChange"]
RANGE_MARKERS = ["moveFromRangeStart", "moveFromRangeEnd", "moveToRangeStart", "moveToRangeEnd"]


def unwrap(el) -> None:
    parent = el.getparent()
    idx = parent.index(el)
    for child in list(el):
        parent.insert(idx, child)
        idx += 1
    parent.remove(el)


def remove(el) -> None:
    el.getparent().remove(el)


def merge_with_next(p) -> bool:
    """Append the next paragraph's content to p and drop it (a deleted paragraph mark joins two paragraphs)."""
    nxt = p.getnext()
    if nxt is None or nxt.tag != dx.w("p"):
        return False
    for child in list(nxt):
        if child.tag != dx.w("pPr"):
            p.append(child)
    remove(nxt)
    return True


def process(root, reject: bool) -> int:
    n = 0
    drop_tag = dx.w("ins") if reject else dx.w("del")
    keep_tag = dx.w("del") if reject else dx.w("ins")
    drop_move = dx.w("moveTo") if reject else dx.w("moveFrom")
    keep_move = dx.w("moveFrom") if reject else dx.w("moveTo")

    # 1. paragraph marks: in accept mode a deleted mark merges paragraphs; in reject mode an inserted mark does.
    mark_tag = "ins" if reject else "del"
    other_mark = "del" if reject else "ins"
    for p in list(root.iter(dx.w("p"))):
        mark = p.find(f"w:pPr/w:rPr/w:{mark_tag}", dx.NS)
        if mark is not None:
            remove(mark)
            merge_with_next(p)
            n += 1
        other = p.find(f"w:pPr/w:rPr/w:{other_mark}", dx.NS)
        if other is not None:
            remove(other)
            n += 1

    # 2. content: drop the losing side, unwrap the winning side.
    for el in list(root.iter(drop_tag, drop_move)):
        if el.getparent() is not None and el.getparent().tag != dx.w("rPr"):
            remove(el)
            n += 1
    for el in list(root.iter(keep_tag, keep_move)):
        if el.getparent() is not None and el.getparent().tag != dx.w("rPr"):
            if reject:  # deleted text becomes ordinary text again
                for t in el.iter(dx.w("delText")):
                    t.tag = dx.w("t")
            unwrap(el)
            n += 1
    for el in list(root.iter(*[dx.w(t) for t in RANGE_MARKERS])):
        remove(el)

    # 3. property changes: accept = drop the record; reject = restore the recorded old properties.
    for tag in PROP_CHANGES:
        for el in list(root.iter(dx.w(tag))):
            parent = el.getparent()
            if reject:
                old = next(iter(el), None)
                if old is not None:
                    for child in list(parent):
                        if child is not el:
                            parent.remove(child)
                    for child in list(old):
                        parent.append(child)
            remove(el)
            n += 1
    for tag in ("cellIns", "cellDel", "cellMerge"):
        for el in list(root.iter(dx.w(tag))):
            remove(el)
    return n


def strip_comments(pkg: dx.DocxPackage) -> int:
    n = 0
    for name in pkg.text_parts():
        root = pkg.part(name)
        for el in list(root.iter(dx.w("commentRangeStart"), dx.w("commentRangeEnd"))):
            remove(el)
        for el in list(root.iter(dx.w("commentReference"))):
            run = el.getparent()
            remove(run if run.tag == dx.w("r") else el)
            n += 1
    for part in [p for p in pkg.order if p.startswith("word/comments")]:
        pkg.remove_part(part)
    rels = "word/_rels/document.xml.rels"
    if pkg.has(rels):
        root = pkg.part(rels)
        for rel in list(root):
            if "/comments" in (rel.get("Type") or ""):
                remove(rel)
    ct = pkg.part("[Content_Types].xml")
    for o in list(ct):
        if (o.get("PartName") or "").startswith("/word/comments"):
            remove(o)
    return n


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--reject", action="store_true", help="reject every change instead of accepting")
    ap.add_argument("--strip-comments", action="store_true", help="also remove all comments")
    a = ap.parse_args()
    pkg = dx.DocxPackage(a.input)
    total = 0
    for name in pkg.text_parts():
        total += process(pkg.part(name), a.reject)
    removed = strip_comments(pkg) if a.strip_comments else 0
    pkg.save(a.output)
    verb = "rejected" if a.reject else "accepted"
    print(f"{total} change(s) {verb}" + (f", {removed} comment(s) removed" if a.strip_comments else "") + f"; written to {a.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
