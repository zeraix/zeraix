"""Shared WordprocessingML helpers for the docx skill scripts (redline.py, comment.py, accept_changes.py).

A .docx is a zip of XML parts. This module loads the parts, lets scripts edit them with lxml, and writes
the zip back with every untouched part byte-identical. Text lives in <w:t> inside runs (<w:r>) inside
paragraphs (<w:p>); the helpers below find text across run boundaries and split runs so an exact range
can be wrapped in a tracked change or a comment anchor without disturbing the formatting around it.
"""
from __future__ import annotations

import copy
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from lxml import etree

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
XML_NS = "http://www.w3.org/XML/1998/namespace"
NS = {"w": W_NS}


def w(tag: str) -> str:
    return f"{{{W_NS}}}{tag}"


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class DocxPackage:
    """All parts of a .docx, with lazily parsed XML roots that are re-serialised on save."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        with zipfile.ZipFile(self.path) as zf:
            self.order = [i.filename for i in zf.infolist() if not i.is_dir()]
            self.raw: dict[str, bytes] = {n: zf.read(n) for n in self.order}
        self.roots: dict[str, etree._Element] = {}

    def has(self, name: str) -> bool:
        return name in self.raw or name in self.roots

    def part(self, name: str) -> etree._Element:
        if name not in self.roots:
            parser = etree.XMLParser(resolve_entities=False, huge_tree=True)
            self.roots[name] = etree.fromstring(self.raw[name], parser)
        return self.roots[name]

    def set_part(self, name: str, root: etree._Element) -> None:
        self.roots[name] = root
        if name not in self.raw:
            self.raw[name] = b""
            self.order.append(name)

    def remove_part(self, name: str) -> None:
        self.raw.pop(name, None)
        self.roots.pop(name, None)
        if name in self.order:
            self.order.remove(name)

    def text_parts(self) -> list[str]:
        """The parts that carry body text: document, headers, footers, footnotes, endnotes (those that exist)."""
        pat = re.compile(r"^word/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$")
        return [n for n in self.order if pat.match(n)]

    def save(self, out: str | Path) -> Path:
        out = Path(out)
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_suffix(out.suffix + ".tmp")
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
            for n in self.order:
                data = self.raw[n]
                if n in self.roots:
                    data = etree.tostring(self.roots[n], xml_declaration=True, encoding="UTF-8", standalone=True)
                zf.writestr(n, data)
        tmp.replace(out)
        return out

    # ── package plumbing ────────────────────────────────────────────────────────────────────────
    def add_relationship(self, rels_part: str, rel_type: str, target: str) -> str:
        """Add a relationship (if a same-type/target one is missing) and return its rId."""
        if not self.has(rels_part):
            root = etree.Element(f"{{{PKG_REL_NS}}}Relationships", nsmap={None: PKG_REL_NS})
            self.set_part(rels_part, root)
        root = self.part(rels_part)
        for rel in root:
            if rel.get("Type") == rel_type and rel.get("Target") == target:
                return rel.get("Id")
        ids = {rel.get("Id") for rel in root}
        n = 1
        while f"rId{n}" in ids:
            n += 1
        rid = f"rId{n}"
        etree.SubElement(root, f"{{{PKG_REL_NS}}}Relationship", Id=rid, Type=rel_type, Target=target)
        return rid

    def add_content_type(self, part_name: str, content_type: str) -> None:
        root = self.part("[Content_Types].xml")
        for o in root:
            if o.tag == f"{{{CT_NS}}}Override" and o.get("PartName") == part_name:
                return
        etree.SubElement(root, f"{{{CT_NS}}}Override", PartName=part_name, ContentType=content_type)

    def next_id(self) -> int:
        """1 + the largest numeric w:id used by any revision / comment / bookmark in any part."""
        best = 0
        for n in list(self.roots) + [p for p in self.order if p.endswith(".xml") and p not in self.roots]:
            try:
                root = self.part(n)
            except Exception:
                continue
            for el in root.iter():
                v = el.get(w("id"))
                if v and v.lstrip("-").isdigit():
                    best = max(best, int(v))
        return best + 1


# ── paragraphs and runs ─────────────────────────────────────────────────────────────────────────
def run_text(r: etree._Element) -> str:
    return "".join(t.text or "" for t in r.findall("w:t", NS))


def is_plain_text_run(r: etree._Element) -> bool:
    """A run whose only children are run properties and text — the kind that can be split safely."""
    return all(c.tag in (w("rPr"), w("t")) for c in r)


def paragraph_runs(p: etree._Element) -> list[tuple[etree._Element, str]]:
    """Runs in document order with their visible text. Runs inside <w:del> carry no <w:t>, so they read as ""."""
    return [(r, run_text(r)) for r in p.iter(w("r"))]


def paragraph_text(p: etree._Element) -> str:
    return "".join(t for _, t in paragraph_runs(p))


def make_run(text: str, rpr_source: etree._Element | None) -> etree._Element:
    r = etree.Element(w("r"))
    if rpr_source is not None:
        rpr = rpr_source.find("w:rPr", NS)
        if rpr is not None:
            r.append(copy.deepcopy(rpr))
    t = etree.SubElement(r, w("t"))
    t.text = text
    if text != text.strip():
        t.set(f"{{{XML_NS}}}space", "preserve")
    return r


def split_run(r: etree._Element, offsets: list[int]) -> list[etree._Element]:
    """Split a plain-text run at character offsets. Replaces it in the tree; returns the new runs in order."""
    text = run_text(r)
    cuts = sorted({o for o in offsets if 0 < o < len(text)})
    if not cuts:
        return [r]
    pieces = []
    prev = 0
    for c in cuts + [len(text)]:
        pieces.append(text[prev:c])
        prev = c
    parent = r.getparent()
    idx = parent.index(r)
    new_runs = [make_run(piece, r) for piece in pieces]
    parent.remove(r)
    for i, nr in enumerate(new_runs):
        parent.insert(idx + i, nr)
    return new_runs


def isolate_range(p: etree._Element, start: int, end: int) -> list[etree._Element] | None:
    """Return the runs that exactly cover paragraph text [start, end), splitting boundary runs.

    None when the range touches a run that holds something other than text (a tab, break, field, drawing,
    or a deleted run) — such a range must be edited by hand in the XML.
    """
    runs = paragraph_runs(p)
    pos = 0
    span: list[tuple[etree._Element, int]] = []  # (run, run start offset)
    for r, t in runs:
        r_start, r_end = pos, pos + len(t)
        pos = r_end
        if r_end <= start or r_start >= end:
            continue
        span.append((r, r_start))
    if not span:
        return None
    if any(not is_plain_text_run(r) for r, _ in span):
        return None
    out: list[etree._Element] = []
    for r, r_start in span:
        parts = split_run(r, [start - r_start, end - r_start])
        # keep only the piece(s) inside [start, end)
        cursor = r_start
        for piece in parts:
            length = len(run_text(piece))
            if cursor >= start and cursor + length <= end and length > 0:
                out.append(piece)
            cursor += length
    return out


def find_all(text: str, needle: str) -> list[tuple[int, int]]:
    """Non-overlapping occurrences of needle in text, left to right."""
    hits = []
    i = 0
    while needle:
        j = text.find(needle, i)
        if j < 0:
            break
        hits.append((j, j + len(needle)))
        i = j + len(needle)
    return hits


def snippet(text: str, at: int, width: int = 40) -> str:
    s = max(0, at - width // 2)
    return ("…" if s else "") + text[s:s + width].replace("\n", " ") + ("…" if s + width < len(text) else "")
