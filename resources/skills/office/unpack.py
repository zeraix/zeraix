"""Unpack an Office Open XML file (.docx / .pptx / .xlsx) into a folder of readable, pretty-printed XML.

    python unpack.py document.docx unpacked/

Every XML part is re-indented so read_file / grep / diff work on it; whitespace between elements is
insignificant to Office, so the repacked file (pack.py) opens exactly as before. Binary parts (images,
fonts, embeddings) are copied byte-for-byte.
"""
from __future__ import annotations

import argparse
import sys
import zipfile
from pathlib import Path

XML_SUFFIXES = {".xml", ".rels", ".vml"}


def pretty(data: bytes) -> bytes:
    from lxml import etree

    parser = etree.XMLParser(remove_blank_text=False, resolve_entities=False, huge_tree=True)
    root = etree.fromstring(data, parser)
    etree.indent(root, space="  ")
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def unpack(src: Path, dest: Path, do_pretty: bool = True) -> list[str]:
    dest.mkdir(parents=True, exist_ok=True)
    names: list[str] = []
    with zipfile.ZipFile(src) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            target = dest / info.filename
            if not str(target.resolve()).startswith(str(dest.resolve())):
                raise ValueError(f"refusing to write outside {dest}: {info.filename}")
            target.parent.mkdir(parents=True, exist_ok=True)
            data = zf.read(info)
            if do_pretty and Path(info.filename).suffix.lower() in XML_SUFFIXES:
                try:
                    data = pretty(data)
                except Exception as e:  # keep the raw bytes if a part is not well-formed XML
                    print(f"warning: {info.filename} left as-is ({e})", file=sys.stderr)
            target.write_bytes(data)
            names.append(info.filename)
    # Preserve the original entry order so pack.py can reproduce it.
    (dest / ".zip-order").write_text("\n".join(names) + "\n", encoding="utf-8")
    return names


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", help=".docx / .pptx / .xlsx file")
    ap.add_argument("dest", help="output folder (created)")
    ap.add_argument("--raw", action="store_true", help="do not pretty-print XML parts")
    a = ap.parse_args()
    names = unpack(Path(a.file), Path(a.dest), do_pretty=not a.raw)
    print(f"unpacked {len(names)} parts into {a.dest}")
    for n in names:
        print("  " + n)
    return 0


if __name__ == "__main__":
    sys.exit(main())
