# Built-in document skill helpers

Helper scripts for the built-in `docx`, `xlsx`, `pptx` and `pdf` skills (`src/skills/builtin/*.md`).
They are original to this project and depend only on the toolchain already baked into the sandbox
image (`sandbox/qemu/requirements.txt` + Dockerfile): python-docx, openpyxl, python-pptx, pypdf,
PyMuPDF, lxml, Pillow, LibreOffice, poppler, ImageMagick, RapidOCR.

How they reach the model:

- **Sandbox:** `electron/tools/sandbox/qemu.mjs` binds this folder read-only at `/mnt/skills`
  inside every sandboxed command (see `GUEST_SKILLS_DIR` in `electron/tools/builtinSkills.mjs`).
- **Host:** the folder lives at `<resources>/skills` in a packaged app (electron-builder
  `extraResources`) and at `resources/skills` in the repo during development.
- The skill text refers to it as `{{SKILLS_DIR}}`; `load_skill` substitutes the path that is
  valid for the environment the commands are currently running in.

Every script is a standalone CLI (`python <script> --help`). `office/lo.py` is the shared
LibreOffice runner; `docx/_docxml.py` is the shared WordprocessingML helper.
