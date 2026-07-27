/**
 * Built-in skills: not from the marketplace, not persisted to localStorage, and not shown in the
 * skills management panel; auto-equipped based on runtime conditions (e.g. when the sandbox is ready).
 * Like installed skills, they use load_skill progressive disclosure — the catalog takes only a
 * one-line description, and the full manifest is fed back only once the model judges the task a match,
 * so no first-turn tokens are wasted.
 *
 * The "Document / Media Processing Toolbox" corresponds one-to-one with the image's
 * sandbox/qemu/Dockerfile + requirements.txt (Debian 13 trixie); keep this file in sync whenever the
 * image adds or removes tools.
 */
import type { InstalledSkill } from "./types";

/** Document / Media Processing Toolbox (equipped only for sandbox execution; see runtimeSkills in page.tsx). */
export const SANDBOX_TOOLBOX_SKILL: InstalledSkill = {
  id: "doc-media-toolbox",
  name: "Document, Image & Media Toolbox",
  version: "2", // follows the image tag (v2)
  description:
    "Edit, convert, annotate and create images / graphics / audio / video, and process documents (PDF / Office / OCR). " +
    "Editing an existing image — resize, crop, rotate, add text or a watermark, overlay a logo, convert format, compress, SVG→PNG — is done HERE with the preinstalled imagemagick / ffmpeg / librsvg, no API or model needed; " +
    "so is generating graphics programmatically (charts, diagrams, banners, shapes, gradients). The sandbox ships a full toolchain (imagemagick, ffmpeg, librsvg, pngquant, graphviz, pymupdf4llm, markitdown, pandoc, LibreOffice, RapidOCR, etc.). " +
    "Load this skill whenever the user asks to work with an image, photo, picture, screenshot, icon, SVG, audio, video, PDF or Office file, then use the preinstalled tools directly; do not claim you cannot process images, and do not pip/apt install anything yourself.",
  author: "Built-in",
  tags: ["sandbox", "image", "media", "graphics", "video", "audio", "pdf", "office", "ocr"],
  allowedTools: ["run_command"],
  installedAt: 0,
  enabled: true,
  instructions: `This sandbox (Debian 13, root, bash) comes with a complete document / media toolchain preinstalled. Prefer using the tools below directly; do not reinstall them, and never install heavyweight ML alternatives such as docling / marker-pdf / tesseract / paddleocr — the sandbox has only ~4GB of writable disk, their torch/CUDA dependencies routinely run to several GB, and their models are hosted on sites unreachable from inside the sandbox, so installation is bound to fail (the built-in tools already cover the equivalent capabilities). If you genuinely must install a lightweight package temporarily, pip / uv already have a China mirror configured and are ready to use, but the sandbox is an ephemeral layer apart from the mounted working directory — installed packages and files outside the working directory are lost when the sandbox restarts, so always write every artifact into the working directory.

## Python 3.13
/opt/venv is already on PATH: python / pip / uv are directly usable, with network access.

## PDF → Markdown (preferred for LLM ingestion)
- pymupdf4llm (good with multi-column / tables):
  python -c "import pymupdf4llm; open('out.md','w').write(pymupdf4llm.to_markdown('in.pdf'))"
- Scanned documents (image-type PDF) plus OCR — RapidOCR (PP-OCRv6) is built in with models packaged offline, strong on mixed Chinese/English:
  python -c "import pymupdf4llm; from rapidocr_v6_api import exec_ocr; open('out.md','w').write(pymupdf4llm.to_markdown('in.pdf', ocr_function=exec_ocr, force_ocr=True))"
- markitdown: a universal front door to Markdown for any document (docx/pptx/xlsx/html/epub/images… 15+ formats): markitdown in.docx > out.md
  (note its PDF path is only pdfminer plain text, weak on layout/tables/scans — always prefer pymupdf4llm for PDFs)
- Plain text only: pdftotext -layout in.pdf out.txt (poppler-utils)

## PDF parsing / generation / transformation
- Parsing: pdfplumber (table extraction), PyMuPDF/fitz (text/image extraction, page rendering), pypdf (merge/split/rotate), pikepdf + qpdf (repair/encrypt/linearize)
- Generation: weasyprint (HTML/CSS → PDF), reportlab (programmatic drawing)
- PDF → images: pdf2image / pdftoppm; compress / convert version: ghostscript (gs)

## Office documents
- Read/write: python-docx / openpyxl / python-pptx / odfpy / pandas (excel/csv)
- Universal conversion: LibreOffice headless: soffice --headless --convert-to pdf in.docx --outdir . (use unoserver for batch / low latency)
- pandoc / pypandoc: convert between md / html / docx / latex / epub
- mammoth: docx → clean HTML/Markdown; trafilatura: web-page body text → Markdown

## Images / graphics (edit & create — no API/model needed)
You CAN edit and create images right here; never tell the user that image editing is out of scope. Editing an existing file is what the tools below are for; to generate a brand-new picture from a text description (AI text-to-image), use the image_generation tool instead when it is available. Always write outputs into the working directory. (ImageMagick 7 exposes the same commands as \`magick …\`; \`convert\` also works.)
- Inspect: identify in.png   (add -verbose for full metadata / EXIF)
- Resize: convert in.jpg -resize 800x600 out.jpg   (keeps aspect; 50% = percent; 800x600! = force exact; '800x600>' = only shrink if larger)
- Crop: convert in.jpg -crop 400x300+50+20 +repage out.jpg   (WxH+X+Y; +repage clears the virtual canvas so the geometry resets)
- Rotate / flip: convert in.jpg -rotate 90 out.jpg   (-flip = top-bottom, -flop = left-right)
- Convert format: convert in.png out.jpg   (also .webp / .gif / .tiff / .bmp / .ico; .heic reads when libheif is present)
- Compress: JPEG → convert in.jpg -quality 82 out.jpg ; PNG → pngquant --quality=65-85 -o out.png in.png
- Add text / watermark: convert in.jpg -gravity southeast -pointsize 36 -fill 'rgba(255,255,255,0.6)' -annotate +20+20 'Zeraix' out.jpg
- Overlay a logo: convert base.png logo.png -gravity northeast -geometry +10+10 -composite out.png
- Square thumbnail (crop to fill): convert in.jpg -thumbnail 400x400^ -gravity center -extent 400x400 out.jpg
- Flatten transparency onto a solid background: convert in.png -background white -flatten out.jpg
- Trim a surrounding border: convert in.png -trim +repage out.png
- Join: convert a.png b.png +append row.png   (side by side; -append = stack vertically)
- Create a canvas / gradient / shapes (deterministic graphics, no model): convert -size 1200x400 gradient:'#4f46e5'-'#a855f7' banner.png ; convert -size 400x400 xc:white -fill red -draw 'circle 200,200 200,100' dot.png
- SVG → PNG (crisper than imagemagick for SVG): rsvg-convert -w 1024 in.svg -o out.png
- Diagram from Graphviz DOT source: dot -Tpng graph.dot -o graph.png   (-Tsvg for vector)
Note: for PDF↔image go through poppler / pdf2image / ghostscript (see the PDF section) — ImageMagick's default policy.xml blocks the PDF/PS coders.

## Audio / video (ffmpeg)
- Extract a frame: ffmpeg -i in.mp4 -ss 00:00:03 -frames:v 1 frame.png
- Video → GIF: ffmpeg -i in.mp4 -vf "fps=12,scale=480:-1:flags=lanczos" out.gif
- Frames → video: ffmpeg -framerate 24 -i frame_%04d.png -c:v libx264 -pix_fmt yuv420p out.mp4
- Resize / transcode: ffmpeg -i in.mov -vf scale=1280:-2 -c:v libx264 -crf 23 out.mp4
- Trim without re-encoding: ffmpeg -ss 00:00:05 -i in.mp4 -t 10 -c copy out.mp4
- Extract audio: ffmpeg -i in.mp4 -vn -c:a copy out.m4a

Chinese fonts (Noto CJK) are installed, so image text / PDF / Office rendering won't produce tofu boxes. Also available: unpaper (scanned-page cleanup).

## Common CLI
rg, jq, git, curl, wget, 7z, zstd, unzip/zip, xz, make, tmux, bc, ss/lsof/htop, etc. are all available.

## Selection guide (choose by "task → tool", not by impression)
- PDF read → Markdown: pymupdf4llm (strong on multi-column / tables / structure; for scans add exec_ocr — note its bundled
  auto-OCR uses tesseract, which is not in the image, so be sure to use the exec_ocr adapter). Use it to do its best even on the
  most difficult PDFs (dense financial tables, complex multi-column academic layouts), and honestly explain to the user the possible fidelity loss
- docx / odt read → Markdown: pandoc (highest structural fidelity: tables, footnotes, nesting; mammoth as an alternative for clean semantic output)
- xlsx / pptx read → Markdown: markitdown (pandoc can't read xlsx / pptx)
- Markdown → docx / pptx (generate office): pandoc
- office → PDF and any office-to-office conversion (visual fidelity): LibreOffice (soffice --headless --convert-to pdf,
  a real rendering engine — PDFs generated by pandoc don't reproduce Word layout; use unoserver for batch / low latency)
- Compute spreadsheet formulas: LibreOffice's UNO/Calc engine (python3-uno + unoserver installed) — openpyxl only reads cached formula values, it won't recompute
- Simple structured edits (add a row, change a cell, replace a paragraph): python-docx / openpyxl, lighter, no need to involve LibreOffice
- Extract PDF text / tables (programmatic processing): PyMuPDF (fast) / pdfplumber (tables + layout); plain text only: pdftotext
- Web-page body text → Markdown: trafilatura
- Edit / convert / annotate an existing image (resize, crop, rotate, watermark, format, compress): imagemagick (convert); for SVG use rsvg-convert. This is local and needs no model — do it directly, do not refuse. To create a NEW picture from a text prompt (AI text-to-image) use the image_generation tool instead, not imagemagick.
- Do not install: docling / marker-pdf (torch/CUDA dependencies of several GB, exceeding sandbox disk and with unreachable model sites, bound to fail),
  tesseract / paddleocr (the built-in RapidOCR already covers OCR)`,
};
