"""Repack a folder produced by unpack.py into an Office Open XML file, then sanity-check it.

    python pack.py unpacked/ output.docx

Checks before writing: every .xml/.rels part is well-formed, [Content_Types].xml and _rels/.rels exist.
Entries are written in the original order (recorded by unpack.py in .zip-order) with [Content_Types].xml
first, deflate-compressed.
"""
from __future__ import annotations

import argparse
import sys
import zipfile
from pathlib import Path

XML_SUFFIXES = {".xml", ".rels", ".vml"}


def check_xml(path: Path) -> str | None:
    from lxml import etree

    try:
        etree.parse(str(path), etree.XMLParser(resolve_entities=False, huge_tree=True))
        return None
    except Exception as e:
        return str(e)


def collect(src: Path) -> list[str]:
    files = [p for p in src.rglob("*") if p.is_file() and p.name != ".zip-order"]
    rel = [p.relative_to(src).as_posix() for p in files]
    order_file = src / ".zip-order"
    if order_file.exists():
        wanted = [l.strip() for l in order_file.read_text(encoding="utf-8").splitlines() if l.strip()]
        ordered = [n for n in wanted if n in rel] + sorted(n for n in rel if n not in wanted)
    else:
        ordered = sorted(rel)
    ordered.sort(key=lambda n: 0 if n == "[Content_Types].xml" else 1)
    return ordered


def pack(src: Path, out: Path) -> list[str]:
    names = collect(src)
    problems = []
    for required in ("[Content_Types].xml", "_rels/.rels"):
        if required not in names:
            problems.append(f"missing required part {required}")
    for n in names:
        p = src / n
        if p.suffix.lower() in XML_SUFFIXES:
            err = check_xml(p)
            if err:
                problems.append(f"{n}: {err}")
    if problems:
        raise SystemExit("not packed — fix these first:\n  " + "\n  ".join(problems))
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(out.suffix + ".tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
        for n in names:
            zf.write(src / n, n)
    tmp.replace(out)
    return names


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", help="folder produced by unpack.py")
    ap.add_argument("output", help="output .docx / .pptx / .xlsx")
    a = ap.parse_args()
    names = pack(Path(a.folder), Path(a.output))
    print(f"packed {len(names)} parts into {a.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
