"""Inspect and fill PDF forms (AcroForm fields) with pypdf.

    python forms.py list form.pdf                       # every field: name, type, current value, options, page, rect
    python forms.py list form.pdf --out fields.json
    python forms.py fill form.pdf values.json filled.pdf            # values.json = {"Name": "Ada", "Agree": true, "Plan": "Pro"}
    python forms.py fill form.pdf values.json filled.pdf --flatten  # bake values in so they can no longer be edited

Checkboxes accept true/false (or the exact on-state name). Radio groups and dropdowns take the export value
shown under "options". A PDF with no fields prints an empty list — fill such a form by drawing text at
coordinates instead (see the pdf skill).
"""
from __future__ import annotations

import argparse
import json
import sys

from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject


def field_name(annot) -> str:
    parts = []
    node = annot
    while node is not None:
        t = node.get("/T")
        if t is not None:
            parts.append(str(t))
        parent = node.get("/Parent")
        node = parent.get_object() if parent is not None else None
    return ".".join(reversed(parts))


def on_states(annot) -> list[str]:
    ap = annot.get("/AP")
    if ap is None:
        return []
    n = ap.get_object().get("/N")
    if n is None:
        return []
    return [k for k in n.get_object().keys() if k != "/Off"]


def list_fields(reader: PdfReader) -> list[dict]:
    fields = reader.get_fields() or {}
    out: dict[str, dict] = {}
    for name, f in fields.items():
        ft = str(f.get("/FT", ""))
        kind = {"/Tx": "text", "/Btn": "button", "/Ch": "choice", "/Sig": "signature"}.get(ft, ft or "unknown")
        flags = int(f.get("/Ff", 0) or 0)
        if kind == "button":
            kind = "radio" if flags & (1 << 15) else ("pushbutton" if flags & (1 << 16) else "checkbox")
        if kind == "choice":
            kind = "dropdown" if flags & (1 << 17) else "listbox"
        entry = {"name": name, "type": kind, "value": None if f.get("/V") is None else str(f.get("/V")),
                 "options": [], "page": None, "rect": None}
        opt = f.get("/Opt")
        if opt is not None:
            entry["options"] = [str(o[0] if isinstance(o, list) else o) for o in opt]
        states = f.get("/_States_")
        if states:
            entry["options"] = [str(s) for s in states if str(s) != "/Off"]
        out[name] = entry
    for page_no, page in enumerate(reader.pages, start=1):
        for a in page.get("/Annots") or []:
            a = a.get_object()
            if a.get("/Subtype") != "/Widget":
                continue
            name = field_name(a)
            entry = out.get(name)
            if entry is None:
                continue
            if entry["page"] is None:
                entry["page"] = page_no
                entry["rect"] = [round(float(x), 1) for x in a.get("/Rect", [])]
            if not entry["options"] and entry["type"] in ("checkbox", "radio"):
                entry["options"] = on_states(a)
    return list(out.values())


def fill(reader: PdfReader, values: dict, out_path: str, flatten: bool) -> int:
    known = {f["name"]: f for f in list_fields(reader)}
    unknown = [k for k in values if k not in known]
    if unknown:
        print(f"warning: not in the form, ignored: {', '.join(unknown)}", file=sys.stderr)
    writer = PdfWriter(clone_from=reader)
    count = 0
    for page in writer.pages:
        page_values = {}
        for a in page.get("/Annots") or []:
            a = a.get_object()
            if a.get("/Subtype") != "/Widget":
                continue
            name = field_name(a)
            if name not in values or name not in known:
                continue
            v = values[name]
            if known[name]["type"] in ("checkbox", "radio"):
                states = known[name]["options"] or on_states(a) or ["/Yes"]
                if isinstance(v, bool):
                    v = states[0] if v else "/Off"
                elif isinstance(v, str) and not v.startswith("/"):
                    v = "/" + v
                page_values[name] = NameObject(v)
            else:
                page_values[name] = "" if v is None else str(v)
        if page_values:
            writer.update_page_form_field_values(page, page_values, auto_regenerate=False)
            count += len(page_values)
    writer.set_need_appearances_writer(True)
    writer.write(out_path)
    if flatten:
        try:
            import fitz

            doc = fitz.open(out_path)
            if hasattr(doc, "bake"):
                doc.bake()
                doc.save(out_path + ".flat", garbage=3, deflate=True)
                doc.close()
                import os

                os.replace(out_path + ".flat", out_path)
            else:
                print("warning: this PyMuPDF has no Document.bake(); not flattened", file=sys.stderr)
        except ImportError:
            print("warning: PyMuPDF not available; not flattened", file=sys.stderr)
    return count


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    l = sub.add_parser("list")
    l.add_argument("pdf")
    l.add_argument("--out", help="write the JSON here instead of stdout")
    f = sub.add_parser("fill")
    f.add_argument("pdf")
    f.add_argument("values", help="JSON file mapping field name -> value")
    f.add_argument("output")
    f.add_argument("--flatten", action="store_true")
    a = ap.parse_args()

    reader = PdfReader(a.pdf)
    if reader.is_encrypted:
        reader.decrypt("")
    if a.cmd == "list":
        data = json.dumps(list_fields(reader), ensure_ascii=False, indent=2)
        if a.out:
            open(a.out, "w", encoding="utf-8").write(data)
            print(f"{len(json.loads(data))} field(s) written to {a.out}")
        else:
            print(data)
        return 0
    with open(a.values, encoding="utf-8") as fh:
        values = json.load(fh)
    n = fill(reader, values, a.output, a.flatten)
    print(f"{n} field(s) filled; written to {a.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
