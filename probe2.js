// probe2 — 访问个人主页并点击「收藏」标签，抓全部 aweme/v1/web API 流量
const { chromium } = require((process.env.DOUYIN_SYNC_INSTALLER || "D:/douyin-sync-installer/bridge") + "/node_modules/playwright-core");
const common = require((process.env.DOUYIN_SYNC_INSTALLER || "D:/douyin-sync-installer/bridge") + "/bridge-common.js");

(async () => {
  const found = common.findChrome();
  const ctx = await chromium.launchPersistentContext(common.resolveProfile(), {
    executablePath: found.exe, headless: true, userAgent: common.UA,
    args: ["--disable-blink-features=AutomationControlled", ...common.kernelArgs(found.source)],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const apis = new Map();
  page.on("request", (r) => {
    const u = r.url();
    const m = u.match(/aweme\/v1\/web\/[a-z_/]+/i);
    if (m) apis.set(m[0] + " [" + r.method() + "]", u);
  });
  await page.goto("https://www.douyin.com/user/self", { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e) => console.log("goto fail", String(e).slice(0, 80)));
  await page.waitForTimeout(6000);
  for (const label of ["\u6536\u85cf", "\u6536\u85cf\u5939"]) {
    try {
      const loc = page.locator(`text="${label}"`).last();
      await loc.click({ timeout: 5000 });
      console.log("clicked:", label);
      await page.waitForTimeout(6000);
    } catch (e) {
      console.log("click fail:", label, String(e).slice(0, 70));
    }
  }
  console.log("---- aweme APIs seen ----");
  for (const [k, u] of apis) console.log(k, "|", u.slice(0, 260));
  await ctx.close();
})();
