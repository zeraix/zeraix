/**
 * Google Sign-In —— 主进程 OAuth 流程（设计文档 docs/google-signin-frontend.md）。
 *
 * 桌面客户端是「公开客户端」，Google 禁止在内嵌 webview 里跑登录（disallowed_useragent），
 * 因此走 RFC 8252 原生应用授权码流程：系统浏览器 + 环回地址回跳 + PKCE。
 *
 * 本模块只负责「拿到 Google 的 id_token」：
 *   1. 生成 PKCE code_verifier/code_challenge 与随机 state；
 *   2. 在 127.0.0.1:0 起一个一次性环回 http 服务，由分配到的端口推出 redirect_uri；
 *   3. shell.openExternal 打开 Google 同意页（scope: openid email profile）；
 *   4. 环回回调里校验 state、取 code，带 code_verifier 到 token 端点换取 id_token；
 *   5. 关闭环回服务，把 id_token 交回渲染层（渲染层再 POST /auth/google）。
 *
 * 安全：PKCE + 环回防本机授权码截获；state 防 CSRF；不在包体里放机密——桌面客户端本就公开，
 * 真正的保护是 PKCE 与后端对 id_token 的独立校验，而非「随包发出的 secret」。
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shell } from "electron";
import { getAppConfig } from "../appConfig.mjs";
import { DEEP_LINK_SCHEME } from "./deepLink.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 读取随包分发的 Google 凭据兜底 JSON（构建前由 scripts/gen-google-defaults.mjs 生成；缺失则空）。 */
function readBundledGoogleDefaults() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "google-defaults.json"), "utf8")) || {};
  } catch {
    return {}; // 文件不存在 / 解析失败：视为无兜底
  }
}

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SCOPE = "openid email profile";
/** 环回服务等待用户在浏览器里完成授权的上限，超时即拆除并按取消处理。 */
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Desktop 客户端凭据。客户端 id 仅用于构造授权 URL 与换取 code —— 不是机密（PKCE 才是保护，
 * 后端另行校验 id_token 的 aud），因此可安全放入随包分发的 app.config。
 *
 * 取值优先级：环境变量（dev 下经 loadEnv 从 .env* 灌入）> app.config 的 [google] 段 >
 * 随包兜底 JSON（google-defaults.json，构建时由本机 .env 生成——让打包版开箱即用）。
 * 前二者便于本地开发 / 用户覆盖；未配置 client_id 时抛错。
 *
 * client_secret：Google 的「Desktop app」客户端仍会签发 secret，且其 token 端点在换取
 * authorization code 时【要求】带上（即便配合 PKCE）。该 secret 对已分发的桌面客户端
 * 「不作机密处理」（无法真正保密，安全性由 PKCE + redirect 限制 + 后端校验 id_token 承担），
 * 故可随包放入 app.config。缺失时 token 交换会以 invalid_client 失败。
 */
function readClientConfig() {
  const google = getAppConfig()?.google || {};
  const bundled = readBundledGoogleDefaults();
  const clientId =
    process.env.GOOGLE_OAUTH_CLIENT_ID || google.client_id || bundled.client_id || "";
  const clientSecret =
    process.env.GOOGLE_OAUTH_CLIENT_SECRET || google.client_secret || bundled.client_secret || "";
  if (!clientId) {
    throw new Error(
      "未配置 Google OAuth 客户端 id（设置环境变量 GOOGLE_OAUTH_CLIENT_ID，或 app.config 的 [google] client_id）",
    );
  }
  return { clientId, clientSecret };
}

/** base64url 编码（无填充），PKCE / state 用。 */
function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 生成 PKCE 参数与随机 state。 */
function createPkce() {
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash("sha256").update(codeVerifier).digest());
  const state = base64url(crypto.randomBytes(16));
  return { codeVerifier, codeChallenge, state };
}

/** 回调页面：授权完成后浏览器里显示，提示用户回到应用。 */
function callbackHtml(ok) {
  const title = ok ? "Sign-in successful" : "Sign-in not completed";
  const tip = ok ? "You're all set! Return to the Zeraix app to continue." : "Authorization was not completed. Please return to the app and try again.";
  // 成功：品牌蓝绿色勾；失败：琥珀色感叹号。图标用内联 SVG，自包含无外链。
  const accent = ok ? "#34d3a6" : "#f5a524";
  const icon = ok
    ? `<path d="M5 13.5l4.5 4.5L19 8" fill="none" stroke="currentColor" stroke-width="2.4"
        stroke-linecap="round" stroke-linejoin="round"/>`
    : `<path d="M12 7.5v6" fill="none" stroke="currentColor" stroke-width="2.4"
        stroke-linecap="round"/><circle cx="12" cy="17" r="1.4" fill="currentColor"/>`;
  // 「打开应用」按钮指向自定义协议深链，点击由操作系统把 Zeraix 带到前台。
  // 浏览器多会拦截无用户手势的自动协议跳转，故以按钮为主要入口（不做 onload 自动跳转）。
  const btnLabel = ok ? "Open Zeraix" : "Return to Zeraix";
  const deepLink = `${DEEP_LINK_SCHEME}://auth-complete?ok=${ok ? "1" : "0"}`;
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Zeraix</title>
<style>
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{display:flex;align-items:center;justify-content:center;padding:24px;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
  color:#e7ecff;background:#0b1020;
  background-image:radial-gradient(1200px 600px at 50% -10%,rgba(52,211,166,.10),transparent 60%),
    radial-gradient(900px 500px at 50% 120%,rgba(99,102,241,.14),transparent 60%);
  -webkit-font-smoothing:antialiased}
.box{position:relative;text-align:center;padding:48px 44px 40px;border-radius:22px;max-width:380px;width:100%;
  background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.03));
  border:1px solid rgba(255,255,255,.09);
  box-shadow:0 24px 70px -24px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,.06);
  animation:rise .5s cubic-bezier(.2,.7,.2,1) both}
.badge{width:76px;height:76px;margin:0 auto 22px;border-radius:50%;display:flex;align-items:center;
  justify-content:center;color:${accent};
  background:radial-gradient(circle at 50% 40%,color-mix(in srgb,${accent} 22%,transparent),transparent 70%);
  box-shadow:0 0 0 1px color-mix(in srgb,${accent} 35%,transparent),
    0 0 44px -6px color-mix(in srgb,${accent} 60%,transparent);
  animation:pop .55s .12s cubic-bezier(.2,1.4,.3,1) both}
.badge svg{width:38px;height:38px}
h1{font-size:21px;font-weight:650;letter-spacing:.2px;margin:0 0 10px}
p{font-size:14px;line-height:1.6;opacity:.62;margin:0}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;margin-top:26px;
  padding:12px 26px;border-radius:12px;text-decoration:none;font-size:14px;font-weight:600;
  color:#04140e;background:linear-gradient(180deg,color-mix(in srgb,${accent} 92%,#fff),${accent});
  box-shadow:0 10px 26px -10px color-mix(in srgb,${accent} 70%,transparent);
  transition:transform .12s ease,box-shadow .12s ease}
.btn:hover{transform:translateY(-1px);box-shadow:0 14px 30px -10px color-mix(in srgb,${accent} 80%,transparent)}
.btn:active{transform:translateY(0)}
.brand{margin-top:24px;font-size:12px;letter-spacing:.16em;text-transform:uppercase;opacity:.34}
@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@keyframes pop{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.box,.badge{animation:none}}
</style>
</head><body><div class="box">
<div class="badge"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg></div>
<h1>${title}</h1><p>${tip}</p>
<a class="btn" href="${deepLink}">${btnLabel}</a>
<div class="brand">Zeraix</div>
</div></body></html>`;
}

/** 用 authorization code + code_verifier 到 Google token 端点换取 id_token。 */
async function exchangeCode({ code, codeVerifier, redirectUri, clientId, clientSecret }) {
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  // Desktop 客户端若签发了非机密 secret，token 交换需带上；未配置则省略。
  if (clientSecret) body.set("client_secret", clientSecret);

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id_token) {
    const detail = data.error_description || data.error || `HTTP ${res.status}`;
    throw new Error(`换取 id_token 失败：${detail}`);
  }
  return data.id_token;
}

// 单飞：同一时刻只允许一个 OAuth 流程（防止双击按钮起多个环回服务 / 多个浏览器窗口）。
let activeFlow = null;

/**
 * 运行一次 Google 登录流程，解析为 { idToken }。用户关闭浏览器 / 超时 / 拒绝授权时，
 * 解析为 { canceled:true }；配置缺失或换取失败时 reject（Error）。
 * 重复调用（已有流程在跑）时复用同一个 Promise。
 */
export function runGoogleSignIn() {
  if (activeFlow) return activeFlow;

  activeFlow = new Promise((resolve, reject) => {
    let clientId, clientSecret;
    try {
      ({ clientId, clientSecret } = readClientConfig());
    } catch (err) {
      // 配置缺失属早退失败：必须先解除单飞，否则后续调用会复用这个已拒绝的 Promise。
      activeFlow = null;
      reject(err);
      return;
    }

    const { codeVerifier, codeChallenge, state } = createPkce();
    let settled = false;
    let timer = null;

    const server = http.createServer(async (req, res) => {
      // 只处理带 code/state 的回调路径，忽略浏览器的 favicon 等杂项请求。
      const url = new URL(req.url, "http://127.0.0.1");
      if (!url.searchParams.has("code") && !url.searchParams.has("error")) {
        res.statusCode = 204;
        res.end();
        return;
      }

      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");

      // 用户在同意页取消 / 拒绝：Google 回跳带 error（如 access_denied）。
      if (error) {
        console.warn("[google-auth] Google 回跳错误：", error);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(callbackHtml(false));
        finish({ canceled: true });
        return;
      }
      // state 不匹配：疑似 CSRF，拒绝。
      if (!returnedState || returnedState !== state) {
        console.warn("[google-auth] state 校验失败：", { expected: state, got: returnedState });
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(callbackHtml(false));
        finishError(new Error("state 校验失败（可能的 CSRF）"));
        return;
      }

      try {
        const redirectUri = `http://127.0.0.1:${server.address().port}`;
        const idToken = await exchangeCode({
          code,
          codeVerifier,
          redirectUri,
          clientId,
          clientSecret,
        });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(callbackHtml(true));
        finish({ idToken });
      } catch (err) {
        // 换取 id_token 失败：把 Google 的具体错误打到主进程终端，便于定位
        // （最常见：Desktop 客户端未带 client_secret → invalid_client / client_secret is missing）。
        console.warn("[google-auth] 换取 id_token 失败：", err?.message || err);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(callbackHtml(false));
        finishError(err instanceof Error ? err : new Error(String(err)));
      }
    });

    // 清理：关闭环回服务、清超时、解除单飞。幂等。
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        server.close();
      } catch {
        /* 已关闭 */
      }
      activeFlow = null;
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    server.on("error", (err) => finishError(err));

    // 环回地址必须显式绑 127.0.0.1（不用 localhost，避免 IPv6/hosts 解析差异）。
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}`;
      const authUrl = `${AUTH_ENDPOINT}?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPE,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state,
        // 每次都让用户选账号，避免静默复用上一个 Google 会话。
        prompt: "select_account",
      }).toString()}`;

      // 超时兜底：用户迟迟不完成（关了浏览器 / 走开了）就拆除并按取消返回。
      timer = setTimeout(() => finish({ canceled: true }), FLOW_TIMEOUT_MS);

      // 在系统浏览器打开同意页；打开失败（无可用浏览器）按错误返回。
      shell.openExternal(authUrl).catch((err) => finishError(err));
    });
  });

  return activeFlow;
}

/** 是否有正在进行的登录流程（渲染层做按钮禁用等 UI 状态时可用）。 */
export function isGoogleSignInActive() {
  return activeFlow !== null;
}
