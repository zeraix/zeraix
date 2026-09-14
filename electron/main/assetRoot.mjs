/**
 * The asset boundary around the media library, re-pointed whenever the data storage location changes.
 */
import path from "node:path";
import { setAssetDir } from "../tools/aiToolkit.mjs";
import { setAssetHostDir } from "../tools/sandbox/qemu.mjs";
import { setMediaDir } from "../mediaStore.mjs";
import { getStorePath } from "../store/conversationStore.mjs";

/**
 * Point both halves of the asset boundary at the media library.
 *
 * The library lives under the DATA STORAGE location (Settings → General), so it survives switching projects
 * and is where the user already expects this app to keep its data. Two places have to be told: the host file
 * tools, which enforce read-only for `read_file`/`write_file` and friends, and the sandbox bind set, which
 * enforces it for `run_command`. Told separately because they are separate mechanisms — a rule applied to one
 * and not the other would leave a shell able to write what the file tools refuse.
 *
 * Called at startup and again whenever the storage location changes, since the library moves with it.
 */
export function syncAssetRoot() {
  try {
    const dir = path.join(getStorePath(), "media");
    setAssetDir(dir);      // host file tools: readable, never writable
    setAssetHostDir(dir);  // sandbox: --ro-bind
    setMediaDir(dir);      // the app's own writes, which the two guards above do not apply to
    return dir;
  } catch (e) {
    // Never fatal: an unset asset root simply means the tools behave as they did with one root.
    console.warn("[assets] could not resolve the media folder:", e?.message ?? e);
    return "";
  }
}
