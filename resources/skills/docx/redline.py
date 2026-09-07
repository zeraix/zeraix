"""Replace text in a .docx as a TRACKED CHANGE (Word shows the old text struck through and the new text inserted).

    python redline.py in.docx out.docx --find "30 days" --replace "45 days" --author "Legal"
    python redline.py in.docx out.docx --find "Acme" --replace "Acme Ltd" --first     # only the first occurrence
    python redline.py in.docx out.docx --find "draft" --replace "" --dry-run          # list matches, write nothing

Matches are found across run boundaries; formatting of the surrounding text is preserved (the inserted run
copies the formatting of the text it replaces). A match that touches a tab, line break, field or picture is
skipped and reported — edit that one by hand after unpack.py.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lxml import etree  # noqa: E402

import _docxml as dx  # noqa: E402


def redline_paragraph(pkg: dx.DocxPackage, p, find: str, replace: str, author: str, date: str,
                      first_only: bool, dry: bool, report: list[str]) -> int:
    text = dx.paragraph_text(p)
    hits = dx.find_all(text, find)
    if not hits:
        return 0
    if first_only:
        hits = hits[:1]
    done = 0
    for start, end in reversed(hits):  # right to left so earlier offsets stay valid
        if dry:
            report.append(f"match: {dx.snippet(text, start)}")
            done += 1
            continue
        runs = dx.isolate_range(p, start, end)
        if not runs:
            report.append(f"skipped (non-text content in range): {dx.snippet(text, start)}")
            continue
        parent = runs[0].getparent()
        idx = parent.index(runs[0])
        rid = pkg.next_id()
        dele = etree.Element(dx.w("del"), {dx.w("id"): str(rid), dx.w("author"): author, dx.w("date"): date})
        for r in runs:
            for t in r.findall("w:t", dx.NS):
                t.tag = dx.w("delText")
            r.getparent().remove(r)
            dele.append(r)
        parent.insert(idx, dele)
        if replace:
            ins = etree.Element(dx.w("ins"), {dx.w("id"): str(rid + 1), dx.w("author"): author, dx.w("date"): date})
            ins.append(dx.make_run(replace, runs[0]))
            parent.insert(idx + 1, ins)
        done += 1
    return done


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--find", required=True, help="exact text to replace (case-sensitive)")
    ap.add_argument("--replace", default="", help="replacement text (empty = tracked deletion)")
    ap.add_argument("--author", default="Zeraix")
    ap.add_argument("--first", action="store_true", help="only the first occurrence in the document")
    ap.add_argument("--dry-run", action="store_true", help="report matches without writing")
    a = ap.parse_args()

    pkg = dx.DocxPackage(a.input)
    date = dx.now_iso()
    total = 0
    report: list[str] = []
    for name in pkg.text_parts():
        root = pkg.part(name)
        for p in list(root.iter(dx.w("p"))):
            n = redline_paragraph(pkg, p, a.find, a.replace, a.author, date, a.first and total == 0, a.dry_run, report)
            total += n
            if a.first and total:
                break
        if a.first and total:
            break
    for line in report:
        print(line)
    if a.dry_run:
        print(f"{total} match(es); nothing written")
        return 0
    if total == 0:
        print("no matches; output not written", file=sys.stderr)
        return 1
    pkg.save(a.output)
    print(f"{total} tracked replacement(s) written to {a.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
