"""Shared LibreOffice helpers for the built-in document skills.

Runs soffice headless with a private user profile so that
  * concurrent conversions never fight over the default profile lock, and
  * spreadsheets are ALWAYS recalculated on load (needed to compute formulas written by openpyxl).

Import from a sibling skill script:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "office")); import lo
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

PROFILE_XCU = """<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="ODFRecalcMode" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="FirstRun" oor:op="fuse"><value>false</value></prop></item>
</oor:items>
"""

WINDOWS_CANDIDATES = [
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
]
MAC_CANDIDATES = ["/Applications/LibreOffice.app/Contents/MacOS/soffice"]


def find_soffice() -> str:
    """Path of the soffice executable, or raise FileNotFoundError with a helpful message."""
    for name in ("soffice", "libreoffice"):
        found = shutil.which(name)
        if found:
            return found
    candidates = WINDOWS_CANDIDATES if os.name == "nt" else MAC_CANDIDATES
    for c in candidates:
        if Path(c).exists():
            return c
    raise FileNotFoundError(
        "LibreOffice (soffice) is not installed here. In the Linux sandbox it is preinstalled; "
        "on the host it must be installed by the user."
    )


def profile_dir() -> Path:
    """A private LibreOffice profile with 'always recalculate on load' baked in. Created on first use."""
    base = Path(os.environ.get("ZERAIX_LO_PROFILE") or Path(tempfile.gettempdir()) / "zeraix-lo-profile")
    user = base / "user"
    user.mkdir(parents=True, exist_ok=True)
    xcu = user / "registrymodifications.xcu"
    if not xcu.exists():
        xcu.write_text(PROFILE_XCU, encoding="utf-8")
    return base


def run_soffice(args: list[str], timeout: int = 180) -> subprocess.CompletedProcess:
    """Run soffice headless with the private profile. Raises RuntimeError on a non-zero exit."""
    exe = find_soffice()
    cmd = [
        exe,
        f"-env:UserInstallation={profile_dir().as_uri()}",
        "--headless", "--norestore", "--nologo", "--nodefault", "--nolockcheck",
        *args,
    ]
    env = dict(os.environ)
    env.setdefault("SAL_USE_VCLPLUGIN", "svp")  # never try to open a display
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
    if proc.returncode != 0:
        raise RuntimeError(f"soffice exited {proc.returncode}: {proc.stderr.strip() or proc.stdout.strip()}")
    return proc


def convert(src: str | os.PathLike, fmt: str, outdir: str | os.PathLike | None = None,
            timeout: int = 180) -> Path:
    """Convert `src` to `fmt` ("pdf", "docx", "xlsx", "pptx", "png", "html", "pdf:writer_pdf_Export" ...).

    Returns the produced file. LibreOffice names it <stem>.<ext> inside `outdir` (default: next to src).
    """
    src = Path(src).resolve()
    if not src.exists():
        raise FileNotFoundError(src)
    outdir = Path(outdir).resolve() if outdir else src.parent
    outdir.mkdir(parents=True, exist_ok=True)
    run_soffice(["--convert-to", fmt, "--outdir", str(outdir), str(src)], timeout=timeout)
    ext = fmt.split(":", 1)[0]
    out = outdir / f"{src.stem}.{ext}"
    if not out.exists():
        raise RuntimeError(f"soffice reported success but {out} was not written")
    return out


def to_pdf(src: str | os.PathLike, outdir: str | os.PathLike | None = None, timeout: int = 180) -> Path:
    """Office document -> PDF (a real rendering: what Word / PowerPoint / Excel would print)."""
    return convert(src, "pdf", outdir, timeout=timeout)


def pdf_to_pngs(pdf: str | os.PathLike, outdir: str | os.PathLike, dpi: int = 60,
                prefix: str = "page", first: int | None = None, last: int | None = None) -> list[Path]:
    """Rasterise PDF pages to PNG. Uses poppler's pdftoppm; falls back to PyMuPDF. Returns paths in page order."""
    pdf = Path(pdf).resolve()
    outdir = Path(outdir).resolve()
    outdir.mkdir(parents=True, exist_ok=True)
    if shutil.which("pdftoppm"):
        cmd = ["pdftoppm", "-r", str(dpi), "-png"]
        if first:
            cmd += ["-f", str(first)]
        if last:
            cmd += ["-l", str(last)]
        cmd += [str(pdf), str(outdir / prefix)]
        subprocess.run(cmd, check=True, capture_output=True)
        return sorted(outdir.glob(f"{prefix}-*.png"), key=lambda p: int(p.stem.rsplit("-", 1)[1]))
    import fitz  # PyMuPDF

    out: list[Path] = []
    doc = fitz.open(str(pdf))
    lo = (first or 1) - 1
    hi = min(last or doc.page_count, doc.page_count)
    width = len(str(doc.page_count))
    for i in range(lo, hi):
        pix = doc[i].get_pixmap(dpi=dpi)
        p = outdir / f"{prefix}-{i + 1:0{width}d}.png"
        pix.save(str(p))
        out.append(p)
    doc.close()
    return out


if __name__ == "__main__":  # `python lo.py file.docx pdf [outdir]` — quick manual conversion
    if len(sys.argv) < 3:
        print("usage: lo.py <file> <format> [outdir]", file=sys.stderr)
        sys.exit(2)
    print(convert(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None))
