/**
 * Where the built-in document skills' helper scripts live — on the host, and inside the sandbox.
 *
 * The four built-in skills (docx / xlsx / pptx / pdf, `src/skills/builtin/*.md`) ship a folder of Python helper
 * scripts (`resources/skills/`). The skill text refers to that folder as `{{SKILLS_DIR}}`, and the renderer's
 * load_skill handler substitutes whichever path is valid for where commands are running right now:
 *
 *   - sandbox: qemu.mjs binds the host folder read-only at GUEST_SKILLS_DIR inside every sandboxed command, the
 *     same way it binds the asset library at /assets. A fixed mount point, so the skill text never carries a
 *     host path into the VM.
 *   - host:    the folder itself. Packaged, electron-builder's extraResources lays it at <resources>/skills;
 *     in dev it is the repo's resources/skills.
 *
 * Pure node on purpose (no electron import): qemu.mjs and main.mjs pass the app facts in, and the tests can
 * exercise the resolution without an Electron runtime.
 */
import fs from "node:fs";
import path from "node:path";

/** Mount point of the helper-script folder inside the sandbox (bwrap --ro-bind; see bwrapFlags in qemu.mjs). */
export const GUEST_SKILLS_DIR = "/mnt/skills";

/**
 * The host folder holding the helper scripts.
 *
 * @param {{ isPackaged: boolean, resourcesPath?: string, appPath: string }} app
 */
export function resolveSkillsHostDir({ isPackaged, resourcesPath, appPath }) {
  return isPackaged
    ? path.join(resourcesPath ?? "", "skills")
    : path.join(appPath, "resources", "skills");
}

/** True when the folder exists — a missing folder must skip the bind, or bwrap fails every sandbox command. */
export function skillsHostDirExists(dir) {
  try {
    return !!dir && fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
