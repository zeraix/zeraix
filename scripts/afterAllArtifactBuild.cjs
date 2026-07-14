// electron-builder afterAllArtifactBuild 钩子：把 DMG 本身也签名 + 公证 + 装订。
//
// 背景：electron-builder 只对 .app 做公证（在生成 DMG 之前），产出的 DMG 却是「未签名、未公证」的，
// Gatekeeper 打开下载来的 DMG 时会因「no usable signature」拦截。Apple 的分发要求是：
//   DMG 也要 codesign(Developer ID) → notarytool 公证 → stapler 装订。
// 这里在所有产物构建完成后补上这三步。仅当：macOS + 找到 Developer ID + 提供了公证凭据 时才执行；
// 缺任意一项则优雅跳过（与 mac.notarize:true 的行为一致，不阻断无凭据的本地构建）。
//
// 注：本应用不使用自动更新（无 electron-updater / publish 配置），故装订改写 DMG 不影响 .blockmap。
const { execFileSync } = require("node:child_process");

/** 从钥匙串里找 Developer ID Application 身份的 SHA-1（不写死，证书轮换也不受影响）。 */
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
    // 1) 签名（Developer ID + 安全时间戳）——公证前 DMG 必须自带可用签名，否则 Gatekeeper 认不出。
    console.log(`[dmg] codesign ${dmg}`);
    execFileSync("codesign", ["--force", "--timestamp", "--sign", hash, dmg], { stdio: "inherit" });

    if (!idCreds && !apiCreds) {
      console.warn("[dmg] no notarization creds (APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID or APPLE_API_KEY/_ID/_ISSUER) — signed but NOT notarized/stapled");
      continue;
    }
    // 2) 公证（上传 + 等待）。
    const submit = apiCreds
      ? ["notarytool", "submit", dmg, "--key", env.APPLE_API_KEY, "--key-id", env.APPLE_API_KEY_ID, "--issuer", env.APPLE_API_ISSUER, "--wait"]
      : ["notarytool", "submit", dmg, "--apple-id", env.APPLE_ID, "--password", env.APPLE_APP_SPECIFIC_PASSWORD, "--team-id", env.APPLE_TEAM_ID, "--wait"];
    console.log(`[dmg] notarytool submit ${dmg}`);
    execFileSync("xcrun", submit, { stdio: "inherit" });
    // 3) 装订（离线也能校验）。
    console.log(`[dmg] stapler staple ${dmg}`);
    execFileSync("xcrun", ["stapler", "staple", dmg], { stdio: "inherit" });
  }
  return [];
};
