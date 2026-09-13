/*
 * bili-bridge.js — B站登录态桥接（活会话）：playwright 常驻 profile + 页面内 fetch 代理
 * 端口 8766。首次运行 HEADED=1 打开可见窗口完成一次登录，之后无头运行。
 * 浏览器意外关闭时自动重启（最多 10 次），保证服务持续可用。
 * 端点：GET /ping ｜ GET /login-status ｜ POST /req {url,method,body,contentType}
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8766);
const PROFILE = path.join(process.env.LOCALAPPDATA || "", "BiliVaultBridge", "login-profile");
const INSTALLER = process.env.DOUYIN_SYNC_INSTALLER || "D:/douyin-sync-installer/bridge";
const HEADED = process.env.HEADED === "1";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

let ctx = null, page = null, closing = false;
let restartCount = 0;
const MAX_RESTARTS = 10;

function findChrome() {
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return "chrome";
}

async function launch() {
  const { chromium } = require(INSTALLER + "/node_modules/playwright-core");
  fs.mkdirSync(PROFILE, { recursive: true });
  ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: findChrome(),
    headless: !HEADED,
    userAgent: UA,
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run"],
  });
  page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto("https://www.bilibili.com/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  ctx.on("close", () => {
    // 浏览器关闭时自动重启（而非退出进程），保证桥接服务持续可用
    if (closing) return;
    if (restartCount < MAX_RESTARTS) {
      restartCount++;
      console.log(`[bili-bridge] browser closed, auto-relaunching (${restartCount}/${MAX_RESTARTS})...`);
      setTimeout(launch, 3000);
    } else {
      console.error("[bili-bridge] max restarts reached, exiting");
      process.exit(1);
    }
  });
  console.log("[bili-bridge] browser ready");
}

async function isLogin() {
  try {
    if (!page) return { isLogin: false, mid: 0, uname: "" };
    return await page.evaluate(async () => {
      const r = await fetch("https://api.bilibili.com/x/web-interface/nav", { credentials: "include" });
      const d = await r.json();
      return { isLogin: !!(d.data && d.data.isLogin), mid: d.data ? d.data.mid : 0, uname: d.data ? d.data.uname : "" };
    });
  } catch { return { isLogin: false, mid: 0, uname: "" }; }
}

function send(res, code, obj) {
  const body = typeof obj === "string" ? obj : JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const u = req.url.split("?")[0];
  if (req.method === "GET" && u === "/ping") return send(res, 200, { ok: true, ready: !!page, headed: HEADED });
  if (req.method === "GET" && u === "/login-status") {
    (async () => send(res, 200, await isLogin()))();
    return;
  }
  if (req.method === "POST" && u === "/req") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let payload;
      try { payload = JSON.parse(raw); } catch { return send(res, 400, { error: "bad json" }); }
      (async () => {
        try {
          if (!page) { send(res, 200, { status: -1, text: "browser not ready" }); return; }
          const out = await page.evaluate(async (p) => {
            const r = await fetch(p.url, {
              method: p.method || "GET",
              credentials: "include",
              headers: p.contentType ? { "Content-Type": p.contentType } : undefined,
              body: p.body,
            });
            return { status: r.status, text: await r.text() };
          }, payload);
          send(res, 200, out);
        } catch (e) {
          send(res, 200, { status: -1, text: String(e).slice(0, 200) });
        }
      })();
    });
    return;
  }
  send(res, 404, { error: "not found" });
});

(async () => {
  await launch();
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[bili-bridge] listening on http://127.0.0.1:${PORT} (headed=${HEADED})`);
    console.log(`[bili-bridge] profile: ${PROFILE}`);
  });
})();
