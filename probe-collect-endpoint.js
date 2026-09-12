// probe-collect-endpoint.js — 用桥接登录 profile 访问收藏相关页面，抓取真实的收藏夹 API 端点
// 与 extract-cookie.js 同款骨架：system-chrome 内核 + 登录 profile，无痕观察网络流量。
const fs = require("fs");
const { chromium } = require((process.env.DOUYIN_SYNC_INSTALLER || "D:/douyin-sync-installer/bridge") + "/node_modules/playwright-core");
const common = require((process.env.DOUYIN_SYNC_INSTALLER || "D:/douyin-sync-installer/bridge") + "/bridge-common.js");

(async () => {
  const PROFILE = common.resolveProfile();
  const found = common.findChrome();
  console.log("kernel:", found.source, "->", found.exe);
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: found.exe,
    headless: true,
    userAgent: common.UA,
    args: ["--disable-blink-features=AutomationControlled", ...common.kernelArgs(found.source)],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const hits = new Map();
  page.on("request", (r) => {
    const u = r.url();
    if (/collect/i.test(u) && !/\.(js|css|png|jpe?g|webp|gif|woff2?|ico)(\?|$)/i.test(u) && !/static|byteimg|douyinpic|zjcdn|p3-|p9-/.test(u)) {
      hits.set(r.method() + " " + u.split("&")[0] + (u.includes("&") ? "&…" : ""), r.method() + " " + u);
    }
  });
  const targets = [
    "https://www.douyin.com/",
    "https://www.douyin.com/user/self?showTab=favorite_collection",
    "https://www.douyin.com/user/self?showTab=like_collection",
    "https://www.douyin.com/collect/self",
  ];
  for (const url of targets) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch (e) {
      console.log("goto fail:", url, String(e).slice(0, 90));
    }
    await page.waitForTimeout(6000);
    console.log("== after", url, "=> captured", hits.size);
  }
  console.log("---- captured endpoints ----");
  for (const [k, full] of hits) console.log(full.slice(0, 300));
  await ctx.close();
})();
