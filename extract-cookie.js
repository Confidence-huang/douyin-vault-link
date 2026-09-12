// extract-cookie.js — 从桥接登录 profile 读取 douyin.com 全量 Cookie（含 HttpOnly）写入 douyin-sync data.json
// 用与 bridge 相同的内核解析逻辑，保证 profile 兼容。运行完毕自动关闭浏览器。
const fs = require("fs");
const INSTALLER = process.env.DOUYIN_SYNC_INSTALLER || "D:/douyin-sync-installer/bridge";  // douyin-sync 安装器标准路径，可用环境变量覆盖
const { chromium } = require(INSTALLER + "/node_modules/playwright-core");
const common = require(INSTALLER + "/bridge-common.js");

(async () => {
  const PROFILE = common.resolveProfile();
  const found = common.findChrome();
  console.log("kernel:", found.source, "->", found.exe);
  console.log("profile:", PROFILE);
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: found.exe,
    headless: true,
    userAgent: common.UA,
    args: ["--disable-blink-features=AutomationControlled", ...common.kernelArgs(found.source)],
  });
  const cookies = await ctx.cookies("https://www.douyin.com");
  const str = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  await ctx.close();
  if (!/sessionid=/.test(str)) throw new Error("profile 中没有 sessionid（登录态缺失？）");
  const p = "D:/NOTE/.obsidian/plugins/douyin-sync/data.json";
  const d = JSON.parse(fs.readFileSync(p, "utf8"));
  d.settings.cookie = str;
  fs.writeFileSync(p, JSON.stringify(d, null, 2), "utf8");
  console.log("cookies:", cookies.length, "| cookie string len:", str.length, "| sessionid: yes");
  console.log("data.json written");
})().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(1);
});
