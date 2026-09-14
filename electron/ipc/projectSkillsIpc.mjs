/**
 * Project-level skill discovery IPC: renderer window.projectSkills.* -> main process.
 *
 * Scan skill files in directories like .claude/.cursor/.zeraix, read/write the user's "add / ignore" decisions in
 * .zeraix/config.json, and read individual skill content (for "view content") and enabled skill bodies (for feeding the agent).
 */
import { ipcMain } from "electron";
import {
  discoverProjectSkills,
  setProjectSkillDecision,
  readProjectSkillFile,
  loadEnabledProjectSkills,
} from "../tools/projectSkills.mjs";

export function registerProjectSkills() {
  ipcMain.handle("project-skills:discover", () => discoverProjectSkills());
  ipcMain.handle("project-skills:decide", (_e, { path: p, enabled }) => setProjectSkillDecision(p, enabled));
  ipcMain.handle("project-skills:read", (_e, relPath) => readProjectSkillFile(relPath));
  ipcMain.handle("project-skills:load-enabled", () => loadEnabledProjectSkills());
}
