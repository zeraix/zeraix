// electron-builder afterAllArtifactBuild hook: also sign + notarize + staple the DMG itself.
//
// Background: electron-builder only notarizes the .app (before the DMG is generated), so the resulting DMG is
// "unsigned, un-notarized", and Gatekeeper blocks a downloaded DMG with "no usable signature". Apple's
// distribution requirement is:
//   the DMG must also be codesign(Developer ID) → notarytool notarize → stapler staple.
// This adds those three steps after all artifacts are built. It only runs when: macOS + a Developer ID is found +
// notarization credentials are provided; if any one is missing it skips gracefully (matching the behavior of
// mac.notarize:true, so a local build without credentials is not blocked).
//
// Note: this app does not use auto-update (no electron-updater / publish config), so re-writing the DMG during
// stapling does not affect the .blockmap.
const { execFileSync } = require("node:child_process");

/** Find the SHA-1 of the Developer ID Application identity in the keychain (not hard-coded, so cert rotation is unaffected). */
function findDeveloperIdHash() {
  try {
    const out = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
    const m = out.match(/([0-9A-F]{40})\s+"Developer ID Application:/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

exports.default = async function afterAllArtifactBuild(buildResult) {
  if (process.platform !== "darwin") return [];
  const dmgs = (buildResult.artifactPaths || []).filter((p) => p.toLowerCase().endsWith(".dmg"));
  if (dmgs.length === 0) return [];

  const hash = findDeveloperIdHash();
  if (!hash) {
    console.warn("[dmg] no Developer ID Application identity in keychain — skipping DMG sign/notarize/staple");
    return [];
  }

  const env = process.env;
  const idCreds = env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID;
  const apiCreds = env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER;

  for (const dmg of dmgs) {
    // 1) Sign (Developer ID + secure timestamp) — before notarization the DMG must carry a usable signature, or Gatekeeper won't recognize it.
    console.log(`[dmg] codesign ${dmg}`);
    execFileSync("codesign", ["--force", "--timestamp", "--sign", hash, dmg], { stdio: "inherit" });

    if (!idCreds && !apiCreds) {
      console.warn("[dmg] no notarization creds (APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID or APPLE_API_KEY/_ID/_ISSUER) — signed but NOT notarized/stapled");
      continue;
    }
    // 2) Notarize (upload + wait).
    const submit = apiCreds
      ? ["notarytool", "submit", dmg, "--key", env.APPLE_API_KEY, "--key-id", env.APPLE_API_KEY_ID, "--issuer", env.APPLE_API_ISSUER, "--wait"]
      : ["notarytool", "submit", dmg, "--apple-id", env.APPLE_ID, "--password", env.APPLE_APP_SPECIFIC_PASSWORD, "--team-id", env.APPLE_TEAM_ID, "--wait"];
    console.log(`[dmg] notarytool submit ${dmg}`);
    execFileSync("xcrun", submit, { stdio: "inherit" });
    // 3) Staple (so it can be verified offline too).
    console.log(`[dmg] stapler staple ${dmg}`);
    execFileSync("xcrun", ["stapler", "staple", dmg], { stdio: "inherit" });
  }
  return [];
};
