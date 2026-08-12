/**
 * What is actually installed inside the sandbox image, answered by asking the running guest.
 *
 * This exists so the model can find the document/media toolchain WITHOUT any of it being written into the
 * system prompt. The prompt is a cache prefix — every sentence added to it is paid on every request of
 * every conversation, including the overwhelming majority that never touch an image or a PDF — whereas a
 * tool result is paid only by the conversation that asked. So the catalogue lives here, in the result.
 *
 * It is PROBED, not recited. builtin.ts carries a hand-written copy of this list and its header asks whoever
 * changes the image to keep it in sync; that is exactly the kind of promise that quietly stops being true,
 * and when it does the model is told about tools that are not there. `command -v` and an import check cannot
 * drift: whatever the guest answers is what the guest has. The table below is only the candidate set and the
 * one-line explanations — presence always comes from the probe.
 */

/**
 * Language runtimes and their package managers, reported WITH the version the guest returns.
 *
 * Versions are printed for these and for nothing else: which release is installed decides whether code
 * the model is about to write will even run (JDK 17 vs 21 syntax, a package demanding Node >= 22), whereas
 * knowing ffmpeg's patch level changes nothing about how it is called. Nowhere in this repo states these
 * numbers — the suite in sandbox/qemu/Dockerfile picks them and the probe reads them back, so a suite bump
 * cannot leave a stale claim behind.
 */
const RUNTIMES = [
  ["python", "Python from /opt/venv, first on PATH, with network access", "python3 py"],
  ["pip", "install a Python package (a China mirror is preconfigured)", "pip3"],
  ["uv", "faster pip-compatible installer and venv manager", ""],
  ["node", "Node.js — run JavaScript/TypeScript", "nodejs js ecmascript deno bun"],
  ["npm", "install Node packages", "yarn pnpm npx"],
  ["java", "run a JVM program or a .jar", "jdk jre jvm openjdk kotlin scala"],
  ["javac", "compile Java sources (JAVA_HOME is set to /usr/lib/jvm/default-java for Maven/Gradle)", "jdk javase maven gradle"],
];

/** Command-line tools worth telling the model about, with what each is FOR (it has no other description of them). */
const BINARIES = [
  ["magick", "ImageMagick 7: resize, crop, rotate, annotate/watermark, composite, convert format, and draw gradients/shapes"],
  ["convert", "ImageMagick v6-compatible alias of `magick`, same syntax"],
  ["ffmpeg", "video/audio: transcode, trim, scale, extract a frame or the audio track, make a GIF"],
  ["ffprobe", "inspect a media file's streams, duration and codecs"],
  ["rsvg-convert", "SVG → PNG, crisper than ImageMagick for SVG"],
  ["pngquant", "lossy PNG compression (--quality=65-85)"],
  ["dot", "Graphviz: DOT source → PNG/SVG diagram"],
  ["pdftotext", "PDF → plain text (poppler; -layout preserves columns)"],
  ["pdftoppm", "PDF pages → images"],
  ["gs", "Ghostscript: compress or convert PDF versions"],
  ["qpdf", "repair, encrypt or linearise a PDF"],
  ["soffice", "LibreOffice headless: convert any Office document (--headless --convert-to pdf in.docx --outdir .)"],
  ["pandoc", "convert between md / html / docx / latex / epub"],
  ["markitdown", "any document → Markdown, 15+ formats (weak on PDFs — prefer pymupdf4llm there)"],
  ["unpaper", "clean up scanned pages before OCR"],
];

/** Python modules, checked by import rather than by package name (an import is what the model will actually write). */
const MODULES = [
  ["pymupdf4llm", "PDF → Markdown, the best option for multi-column layouts and tables"],
  ["fitz", "PyMuPDF: extract text/images, render pages"],
  ["pdfplumber", "extract tables from a PDF"],
  ["pypdf", "merge, split and rotate PDFs"],
  ["pikepdf", "repair and encrypt PDFs"],
  ["weasyprint", "HTML/CSS → PDF"],
  ["reportlab", "draw a PDF programmatically"],
  ["pdf2image", "PDF → PIL images"],
  ["docx", "python-docx: read/write Word"],
  ["openpyxl", "read/write Excel"],
  ["pptx", "python-pptx: read/write PowerPoint"],
  ["odf", "odfpy: OpenDocument"],
  ["pandas", "spreadsheets and CSV"],
  ["mammoth", "docx → clean HTML/Markdown"],
  ["trafilatura", "web page → Markdown body text"],
  ["rapidocr_v6_api", "offline OCR (PP-OCRv6), strong on mixed Chinese/English; exec_ocr plugs into pymupdf4llm"],
  ["PIL", "Pillow imaging"],
];

/**
 * One shell round trip for the whole inventory: a version query per runtime, `command -v` per binary, one python
 * process for every module.
 *
 * Versions are asked for only where the answer changes what the model writes — the runtimes, and ImageMagick
 * because 6-vs-7 changes what to type. Doing it for all 30-odd entries would be that many more process spawns
 * in the guest to tell the model a patch level it has no use for.
 */
function probeCommand() {
  const bins = BINARIES.map(([n]) => n).join(" ");
  const mods = MODULES.map(([n]) => `'${n}'`).join(",");
  const runs = RUNTIMES.map(([n]) => n).join(" ");
  return (
    // `command -v` first, so an absent runtime is skipped rather than reporting bash's "command not found"
    // as its version string. java/javac print their version to stderr and spell the flag `-version`.
    `for c in ${runs}; do command -v "$c" >/dev/null 2>&1 || continue; ` +
    `case "$c" in java|javac) v=$("$c" -version 2>&1 | head -1);; *) v=$("$c" --version 2>&1 | head -1);; esac; ` +
    `echo "R:$c $v"; done\n` +
    `for c in ${bins}; do command -v "$c" >/dev/null 2>&1 && echo "B:$c"; done\n` +
    `python -c "import importlib\n` +
    `for m in [${mods}]:\n` +
    `    try: importlib.import_module(m); print('P:'+m)\n` +
    `    except Exception: pass" 2>/dev/null\n` +
    `magick -version 2>/dev/null | head -1`
  );
}

/**
 * How to actually invoke any of this. Carried in the RESULT rather than the prompt for the reason in the
 * header — and it has to be stated, because nothing else tells the model that a host-default session can
 * still reach the guest one command at a time.
 */
const USAGE =
  "Running them: pass `sandbox: true` to run_command. That runs the one command inside this sandbox instead " +
  "of wherever commands go by default, so it is REQUIRED whenever the Command Execution Environment note says " +
  "commands run on the host, and harmless when they already run in the sandbox. The working directory is the " +
  "same either way (it is mounted in), so read your inputs and write your outputs at the usual relative paths, " +
  "and the file tools will see the results. Anything outside the working directory is lost when the sandbox " +
  "restarts. Use it for THIS toolchain only — builds, tests, check_project and git depend on the host's " +
  "environment and must run normally.\n\n" +
  "Do not install heavyweight ML alternatives (docling, marker-pdf, tesseract, paddleocr): there is ~4GB of " +
  "writable disk, their torch/CUDA dependencies run to several GB, and their model hosts are unreachable from " +
  "in here. What is listed above already covers the equivalent ground.";

let cache = null; // { engine, present: Set, versions: Map, imagemagick } — the guest cannot change without a restart

async function collect(engine) {
  if (cache?.engine === engine) return cache;
  const r = await engine.run(probeCommand(), { timeoutMs: 30_000, maxBuffer: 1 << 20 });
  const lines = String(r?.stdout ?? "").split("\n").map((l) => l.trim());
  const present = new Set(lines.filter((l) => l.startsWith("B:") || l.startsWith("P:")).map((l) => l.slice(2)));
  // "R:node v20.19.2" → name and whatever the tool called its version. Reported verbatim rather than
  // parsed to a number: every one of these formats it differently and the model reads prose fine.
  const versions = new Map();
  for (const l of lines) {
    if (!l.startsWith("R:")) continue;
    const sp = l.indexOf(" ");
    if (sp > 2) {
      versions.set(l.slice(2, sp), l.slice(sp + 1).trim());
      present.add(l.slice(2, sp));
    }
  }
  // An empty probe means the guest answered nothing sensible (agent not up yet, image broken). Report that
  // rather than an empty toolbox, which would read as "the sandbox has nothing" and send the model away.
  if (!present.size) return { engine, present: null, error: (r?.stderr || `exit ${r?.code ?? "?"}`).slice(0, 200) };
  cache = { engine, present, versions, imagemagick: lines.find((l) => /^Version: ImageMagick/.test(l)) ?? "" };
  return cache;
}

/** Render the inventory as the text the model reads. `query` narrows it to one job (e.g. "pdf", "image"). */
export async function sandboxInventory(engine, { query } = {}) {
  const { present, error, versions, imagemagick } = await collect(engine);
  // Punctuation-insensitive on BOTH sides, and each entry carries the other names people use for it (the
  // third column). Observed: a "nodejs" query missed an entry called `node` described as "Node.js", the
  // reply led with "Nothing in the sandbox matches", and the model reported Node.js as not installed. A
  // near-miss on a name has to behave like a near-miss, not like an absence.
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "");
  const q = norm(query);
  const hit = ([name, desc, alias = ""]) => !q || norm(`${name} ${desc} ${alias}`).includes(q);

  if (!present) {
    return (
      `Could not read the sandbox's tool list (${error}). The image is expected to contain: ` +
      `${[...RUNTIMES, ...BINARIES, ...MODULES].map(([n]) => n).join(", ")}. ` +
      `Check one before relying on it — run_command with sandbox:true and \`command -v <tool>\`.`
    );
  }

  const installed = [...RUNTIMES, ...BINARIES, ...MODULES].filter(([n]) => present.has(n));
  const runs = RUNTIMES.filter(([n]) => present.has(n)).filter(hit);
  const bins = BINARIES.filter(([n]) => present.has(n)).filter(hit);
  const mods = MODULES.filter(([n]) => present.has(n)).filter(hit);
  if (!runs.length && !bins.length && !mods.length) {
    // Deliberately not "the sandbox has no X". This branch means one substring search came up empty, which is
    // not the same claim, and stating it as absence is how a filter typo turns into "that is not installed".
    return (
      `No entry matched the filter "${query}" — that is a name search, not a check of what is installed. ` +
      `Read the full list before concluding anything is missing: ${installed.map(([n]) => n).join(", ")}.\n\n${USAGE}`
    );
  }

  const fmt = (rows) => rows.map(([n, d]) => `  ${n} — ${d}`).join("\n");
  const fmtRun = (rows) =>
    rows.map(([n, d]) => `  ${n}${versions.get(n) ? ` (${versions.get(n)})` : ""} — ${d}`).join("\n");
  const hidden = installed.length - (runs.length + bins.length + mods.length);
  return [
    `Installed in the Linux sandbox (Debian 13, bash, root)${q ? `, matching "${query}"` : ""} — probed just now, so this is what is really there:`,
    runs.length ? `\nLanguage runtimes\n${fmtRun(runs)}` : "",
    // The version line rides with magick/convert or not at all — 6-vs-7 is why it is here, so it is noise
    // next to a filtered list that does not include them.
    bins.length
      ? `\nCommand-line tools\n${fmt(bins)}` +
        (imagemagick && bins.some(([n]) => n === "magick" || n === "convert") ? `\n  (${imagemagick})` : "")
      : "",
    mods.length ? `\nPython modules — import them with python -c "..."\n${fmt(mods)}` : "",
    hidden > 0 ? `\n${hidden} more do not match the filter; call again without \`query\` to see everything.` : "",
    `\n${USAGE}`,
  ]
    .filter(Boolean)
    .join("\n");
}
