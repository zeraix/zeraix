"""Add a Word comment anchored to a piece of text (or to a whole paragraph).

    python comment.py in.docx out.docx --find "net 30" --comment "Confirm payment terms" --author "Reviewer"
    python comment.py in.docx out.docx --paragraph 3 --comment "Rewrite this section"

--find anchors the comment to the first occurrence of that text; --paragraph N anchors it to the Nth body
paragraph (0-based, counting only paragraphs with text). Creates word/comments.xml when the document has none.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lxml import etree  # noqa: E402

import _docxml as dx  # noqa: E402

COMMENTS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments"
COMMENTS_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"


def ensure_comments_part(pkg: dx.DocxPackage):
    name = "word/comments.xml"
    if not pkg.has(name):
        root = etree.Element(dx.w("comments"), nsmap={"w": dx.W_NS})
        pkg.set_part(name, root)
        pkg.add_relationship("word/_rels/document.xml.rels", COMMENTS_REL, "comments.xml")
        pkg.add_content_type("/word/comments.xml", COMMENTS_CT)
    return pkg.part(name)


def initials_of(author: str) -> str:
    return "".join(part[0] for part in author.split() if part)[:3].upper() or "ZX"


def add_comment(pkg: dx.DocxPackage, p, start: int | None, end: int | None, text: str, author: str) -> int:
    comments = ensure_comments_part(pkg)
    cid = pkg.next_id()
    date = dx.now_iso()
    attrs = {dx.w("id"): str(cid), dx.w("author"): author, dx.w("date"): date, dx.w("initials"): initials_of(author)}

    runs = dx.isolate_range(p, start, end) if start is not None else None
    if runs:
        parent = runs[0].getparent()
        first_idx = parent.index(runs[0])
        last_idx = parent.index(runs[-1])
    else:  # whole paragraph: after pPr, to the end
        parent = p
        ppr = p.find("w:pPr", dx.NS)
        first_idx = (p.index(ppr) + 1) if ppr is not None else 0
        last_idx = len(p) - 1

    parent.insert(last_idx + 1, etree.Element(dx.w("commentRangeEnd"), {dx.w("id"): str(cid)}))
    ref_run = etree.Element(dx.w("r"))
    etree.SubElement(ref_run, dx.w("commentReference"), {dx.w("id"): str(cid)})
    parent.insert(last_idx + 2, ref_run)
    parent.insert(first_idx, etree.Element(dx.w("commentRangeStart"), {dx.w("id"): str(cid)}))

    c = etree.SubElement(comments, dx.w("comment"), attrs)
    for i, line in enumerate(text.split("\n")):
        cp = etree.SubElement(c, dx.w("p"))
        if i == 0:
            r0 = etree.SubElement(cp, dx.w("r"))
            etree.SubElement(r0, dx.w("annotationRef"))
        cp.append(dx.make_run(line, None))
    return cid


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--comment", required=True, help="comment text (\\n for a new paragraph)")
    ap.add_argument("--author", default="Zeraix")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--find", help="anchor to the first occurrence of this text")
    g.add_argument("--paragraph", type=int, help="anchor to the Nth non-empty body paragraph (0-based)")
    a = ap.parse_args()

    pkg = dx.DocxPackage(a.input)
    body = pkg.part("word/document.xml")
    paragraphs = [p for p in body.iter(dx.w("p")) if dx.paragraph_text(p).strip()]
    if a.find is not None:
        for p in paragraphs:
            hits = dx.find_all(dx.paragraph_text(p), a.find)
            if hits:
                cid = add_comment(pkg, p, hits[0][0], hits[0][1], a.comment, a.author)
                break
        else:
            print(f"text not found: {a.find!r}", file=sys.stderr)
            return 1
    else:
        if a.paragraph < 0 or a.paragraph >= len(paragraphs):
            print(f"paragraph index out of range (0..{len(paragraphs) - 1})", file=sys.stderr)
            return 1
        cid = add_comment(pkg, paragraphs[a.paragraph], None, None, a.comment, a.author)
    pkg.save(a.output)
    print(f"comment {cid} added; written to {a.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
