/**
 * <webview> 自动化代理（运行于独立 utilityProcess，与主线程 / 渲染线程隔离）。
 *
 * 经 CDP 远程调试端口用 puppeteer-core 连接到 Electron，挂载到内置 <webview> 的页面 target
 * （按 type==="webview" 识别，跨导航保持），既被动监视搜索导航并回传触发事件，也接受
 * 渲染层（经主进程）下发的 action 指令，对页面执行 读取 / 列链接 / 点击 / 输入 / 跳转，
 * 把结果回传——即 AI 经 CDP「接管」浏览器。
 *
 * 与主进程的通信：process.parentPort（utilityProcess 消息通道）。
 */
// puppeteer-core 为 ESM-only（package "type":"module"），不能用 require —— 用动态 import 懒加载。
let puppeteer = null;
async function loadPuppeteer() {
  if (puppeteer) return puppeteer;
  const mod = await import("puppeteer-core");
  puppeteer = mod.default ?? mod;
  return puppeteer;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (msg) => {
  try {
    process.parentPort.postMessage(msg);
  } catch {
    /* 通道未就绪时忽略 */
  }
};

let browser = null;
let config = null;
let port = 0;
let stopped = false;
let connecting = false;
let lastError = "";
let attachedPage = null; // 已挂载的 webview 页面（puppeteer Page）
let attachedTargetId = null;
let lastTrigger = "";
let activeUrl = ""; // 渲染层告知的当前活动标签 URL（多标签时用于定位活动 webview）

process.parentPort.on("message", (e) => {
  const msg = e?.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "start") void start(msg.config);
  else if (msg.type === "stop") void stop();
  else if (msg.type === "action") void handleAction(msg);
  else if (msg.type === "active-url") {
    const u = String(msg.url || "");
    if (u && u !== activeUrl) {
      activeUrl = u;
      // 活动标签变了 → 重新挂载到新的活动页。
      attachedPage = null;
      attachedTargetId = null;
      void attachAndWatch();
    }
  }
});

async function connectWithRetry(p, tries = 20) {
  let err;
  for (let i = 0; i < tries; i++) {
    if (stopped) throw new Error("stopped");
    try {
      return await puppeteer.connect({ browserURL: `http://127.0.0.1:${p}`, defaultViewport: null });
    } catch (e) {
      err = e;
      await delay(500);
    }
  }
  throw new Error(`无法连接到 CDP 端口 ${p}：${String(err?.message || err)}`);
}

/** 幂等连接：start 与 action 都用它，缺连接时按需（重）连。 */
async function ensureConnected() {
  if (browser) return browser;
  if (!port) {
    lastError = "尚未启动（start 未调用 / 缺少端口）";
    return null;
  }
  if (connecting) {
    for (let i = 0; i < 40 && connecting; i++) await delay(300);
    return browser;
  }
  connecting = true;
  send({ type: "status", state: "connecting" });
  try {
    await loadPuppeteer();
    browser = await connectWithRetry(port);
    lastError = "";
    send({ type: "status", state: "connected" });
    browser.on("targetcreated", () => void attachAndWatch());
    browser.on("targetchanged", () => void attachAndWatch());
  } catch (err) {
    lastError = String(err?.message || err);
    send({ type: "error", message: lastError });
  } finally {
    connecting = false;
  }
  return browser;
}

async function start(cfg) {
  if (!cfg) return;
  config = cfg;
  port = cfg.port || port;
  stopped = false;
  attachedPage = null;
  attachedTargetId = null;
  lastTrigger = "";
  const b = await ensureConnected();
  if (!b) return;
  for (let i = 0; i < 30 && !stopped && !attachedPage; i++) {
    await attachAndWatch();
    if (attachedPage) break;
    await delay(500);
  }
}

/** 该 URL 是否为应用自身的外壳 / 调试页（需排除，剩下的 page 即内置 <webview>）。 */
function isAppShell(u) {
  return (
    !u ||
    u === "about:blank" ||
    u.startsWith("devtools://") ||
    u.startsWith("chrome://") ||
    u.startsWith("app://") ||
    u.includes("localhost:3000")
  );
}

/** 找到要操作的 <webview>：多标签时优先匹配活动标签 URL；否则取首个 webview / 非外壳 page。 */
function findWebviewTarget() {
  const webviews = browser.targets().filter((x) => x.type() === "webview");
  if (webviews.length > 1 && activeUrl) {
    const exact = webviews.find((x) => x.url() === activeUrl);
    if (exact) return exact;
    const incl = webviews.find((x) => {
      const u = x.url() || "";
      return u && (activeUrl.includes(u) || u.includes(activeUrl));
    });
    if (incl) return incl;
  }
  if (webviews.length) return webviews[0];
  return browser.targets().find((x) => x.type() === "page" && !isAppShell(x.url() || "")) || null;
}

async function attachAndWatch() {
  if (stopped || !browser) return;
  const target = findWebviewTarget();
  if (!target) return;

  const tid = `${target.type()}:${target.url()}`;
  if (tid === attachedTargetId && attachedPage) return;

  let page;
  try {
    page = await target.page();
  } catch {
    return;
  }
  if (!page) return;
  attachedPage = page;
  attachedTargetId = tid;
  send({ type: "status", state: "attached", url: page.url() });

  const re = config && config.searchPattern ? new RegExp(config.searchPattern) : null;
  const fire = (url, source) => {
    if (stopped || !re || !re.test(url) || url === lastTrigger) return;
    lastTrigger = url;
    let query = "";
    try {
      query = new URL(url).searchParams.get((config && config.queryParam) || "q") || "";
    } catch {
      /* 非标准 URL */
    }
    send({ type: "trigger", url, query, source });
  };
  // 仅监听主框架导航来检测搜索——不监听每个网络请求（避免 Network 事件洪流拖慢页面）。
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) fire(frame.url(), "navigate");
  });
  fire(page.url(), "initial");
}

/** 确保已挂载页面（必要时等待 webview 出现）。 */
async function getPage() {
  for (let i = 0; i < 20 && !attachedPage && !stopped; i++) {
    await attachAndWatch();
    if (attachedPage) break;
    await delay(300);
  }
  return attachedPage;
}

/** 执行 AI 下发的页面操作，并回传结果（按 id 关联）。 */
async function handleAction({ id, action, params = {} }) {
  const reply = (ok, result, error) => send({ type: "action-result", id, ok, result, error });
  await ensureConnected(); // 缺连接时按需重连
  const page = await getPage();
  if (!page) {
    const list = browser
      ? browser.targets().map((t) => `${t.type()}|${t.url()}`).join(" ; ") || "(无)"
      : "(未连接)";
    return reply(
      false,
      null,
      `内置浏览器未就绪。port=${port || "?"} 已启动=${!!config} 连接错误=${lastError || "无"} targets=[${list}]`,
    );
  }
  try {
    switch (action) {
      case "navigate": {
        const raw = String(params.url || "").trim();
        if (!raw) return reply(false, null, "navigate 缺少 url");
        const u = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
        await page.goto(u, { waitUntil: "domcontentloaded", timeout: 30000 });
        return reply(true, `已导航到 ${page.url()}`);
      }
      case "read": {
        const text = await page.evaluate(() => (document.body ? document.body.innerText : ""));
        return reply(true, String(text).replace(/\n{3,}/g, "\n\n").trim().slice(0, 4000));
      }
      case "links": {
        const max = Number(params.max) || 40;
        const links = await page.evaluate((m) => {
          const out = [];
          const seen = new Set();
          document.querySelectorAll("a[href]").forEach((a) => {
            const text = (a.innerText || a.textContent || "").trim().replace(/\s+/g, " ");
            const href = a.href;
            if (!text || !href || href.startsWith("javascript:") || seen.has(href)) return;
            seen.add(href);
            out.push({ i: out.length + 1, text: text.slice(0, 120), href });
          });
          return out.slice(0, m);
        }, max);
        return reply(true, links);
      }
      case "click": {
        if (params.selector) {
          await page.click(String(params.selector));
          return reply(true, `已点击 ${params.selector}`);
        }
        if (params.text) {
          const clicked = await page.evaluate((t) => {
            const els = [...document.querySelectorAll("a, button, [role=button], [role=link]")];
            const el = els.find((e) => ((e.innerText || e.textContent || "").trim()).includes(t));
            if (!el) return null;
            el.click();
            return (el.innerText || el.textContent || "").trim().slice(0, 120);
          }, String(params.text));
          return clicked
            ? reply(true, `已点击：${clicked}`)
            : reply(false, null, `未找到包含「${params.text}」的可点击元素`);
        }
        return reply(false, null, "click 需要 selector 或 text");
      }
      case "type": {
        const sel = String(params.selector || "");
        if (!sel) return reply(false, null, "type 需要 selector");
        if (params.clear) {
          // 先清空输入框（全选删除）再输入
          await page.click(sel, { clickCount: 3 }).catch(() => page.click(sel).catch(() => {}));
        } else {
          await page.click(sel).catch(() => {});
        }
        await page.type(sel, String(params.text || ""));
        if (params.submit || params.enter) await page.keyboard.press("Enter");
        return reply(true, `已在 ${sel} 输入${params.submit || params.enter ? "并回车提交" : ""}`);
      }
      case "eval": {
        const expr = String(params.expr || params.js || "").trim();
        if (!expr) return reply(false, null, "eval 缺少 expr");
        const val = await page.evaluate(expr); // puppeteer 把字符串当表达式在页面上下文求值
        const s = typeof val === "string" ? val : JSON.stringify(val);
        return reply(true, (s ?? "undefined").slice(0, 4000));
      }
      case "a11y": {
        const opts = { interestingOnly: !params.full };
        if (params.root) {
          const h = await page.$(String(params.root)).catch(() => null);
          if (h) opts.root = h;
        }
        const tree = await page.accessibility.snapshot(opts);
        const s = JSON.stringify(tree);
        // 树可能很大：超长则截断为字符串回传，避免撑爆上下文。
        return reply(true, s.length > 6000 ? `${s.slice(0, 6000)}…(已截断)` : tree);
      }
      case "list": {
        const out = browser
          .targets()
          .filter((t) => t.type() === "page" || t.type() === "webview")
          .map((t) => ({ type: t.type(), url: t.url() }));
        return reply(true, out);
      }
      case "shot": {
        const os = require("os");
        const path = require("path");
        const file = String(params.path || "").trim() || path.join(os.tmpdir(), `cdp-shot-${id}.png`);
        await page.screenshot({ path: file, fullPage: !!params.full });
        return reply(true, `已截图: ${file}`);
      }
      default:
        return reply(false, null, `未知动作：${action}`);
    }
  } catch (err) {
    return reply(false, null, String(err?.message || err));
  }
}

async function stop() {
  stopped = true;
  attachedPage = null;
  attachedTargetId = null;
  try {
    if (browser) await browser.disconnect();
  } catch {
    /* ignore */
  }
  browser = null;
  send({ type: "status", state: "stopped" });
}
