/*
 * douyin-vault-link — Learning Vault 式 Obsidian 库 × douyin-sync 伴生桥接插件
 *
 * 职责（对应《抖音同步归档-与NOTE库整合方案》M2）：
 *   1. 统一入口：委托 douyin-sync 立即同步
 *   2. 归档当前笔记中的抖音链接 → 00-原始笔记/抖音归档/手动归档/（收件箱）
 *   3. 晋升收件箱笔记 → 04-来源（来源模板 + douyin_id + domain 标签）并挂 03-主题地图
 *   4. 打开收件箱
 *
 * 边界：本插件只写收件箱与 04-来源（晋升需确认弹窗）；不改 douyin-sync 源码；
 *       Cookie/Key 全部读 douyin-sync 的 data.json，不重复存储。
 */
"use strict";

const obsidian = require("obsidian");
const { Plugin, Notice, normalizePath, requestUrl, Setting, PluginSettingTab, Modal, Menu, TFolder } = obsidian;
const path = require("path");

const DEFAULT_SETTINGS = {
  inboxRoot: "00-原始笔记/抖音归档",
  mediaFolder: "附件/douyin-media",
  sourceFolder: "04-来源",
  mapsFolder: "03-主题地图",
  syncLogEnabled: true,
  syncLogPath: "00-原始笔记/抖音归档/同步日志.md",
  domainRegistry: "education\nhardware\nmath\nsoftware\nweb",
  confirmBeforeWrite: true,
  maxFrames: 24,
  sceneThreshold: 0.025,
  peakRelFactor: 0.08,
  minGapSec: 1.0,
  ffmpegPath: "ffmpeg",
  videoWorkRoot: "",
  autoDeepArchive: false,
  localAsrPython: "",
  localAsrModel: "small",
};

const SOURCE_KIND = { video: "视频", note: "图文" };
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const ARCHIVE_HEADING = "## 抖音归档";

/* ---------------- 小工具 ---------------- */

function sanitizeTitle(s, max = 60) {
  const t = String(s || "").replace(/[\\/:*?"<>|#^[\]%\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  return t ? (t.length > max ? t.slice(0, max).trim() : t) : "";
}

function pad2(n) { return String(n).padStart(2, "0"); }

function fmtDate(unixSec) {
  const d = unixSec > 0 ? new Date(unixSec * 1000) : new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function isoOf(unixSec) {
  return unixSec > 0 ? new Date(unixSec * 1000).toISOString() : "";
}

function nowStamp() {
  const d = new Date();
  return `${fmtDate(Math.floor(d.getTime() / 1000))} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function todayLocal() { return fmtDate(0); }

function fmStr(v) { return v == null ? '""' : JSON.stringify(String(v)); }

function fmtDuration(sec) {
  if (!sec || sec < 0) return "";
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}

function mmss(sec) {
  return `${pad2(Math.floor(sec / 60))}:${pad2(Math.floor(sec % 60))}`;
}

function imgExt(url, dflt = "jpg") {
  const m = String(url || "").match(/\.(jpe?g|png|webp|gif|heic)(?:\?|$)/i);
  return m ? m[1].toLowerCase() : dflt;
}

/* markdown 相对链接：编码空格与 []() 等，保留可读性 */
function mdLink(display, vaultPath) {
  const enc = vaultPath.split("/").map(encodeURIComponent).join("/");
  return `[${display}](${enc})`;
}

async function ensureFolder(vault, p) {
  const parts = normalizePath(p).split("/").filter(Boolean);
  let cur = "";
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    if (!vault.getAbstractFileByPath(cur)) {
      try { await vault.createFolder(cur); } catch {}
    }
  }
}

/* 解析笔记 frontmatter（扁平 key: value，够用于自己生成的 YAML） */
function parseFrontmatter(text) {
  if (!text.startsWith("---")) return { data: {}, body: text, fmEnd: 0 };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { data: {}, body: text, fmEnd: 0 };
  const block = text.slice(4, end);
  const data = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (/^".*"$/.test(v)) { try { v = JSON.parse(v); } catch {} }
    data[m[1]] = v;
  }
  return { data, body: text.slice(end + 4), fmEnd: end + 4 };
}

function updateFrontmatter(text, updates) {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return text;
  let block = text.slice(4, end);
  for (const [k, v] of Object.entries(updates)) {
    const re = new RegExp(`^${k}:.*$`, "m");
    const line = `${k}: ${typeof v === "string" && v.startsWith("[[") ? fmStr(v) : v}`;
    if (re.test(block)) block = block.replace(re, line);
    else block = `${block}\n${line}`;
  }
  return `---\n${block}\n---${text.slice(end + 4)}`;
}

/* ---------------- 主插件 ---------------- */

class DouyinVaultLinkPlugin extends Plugin {
  settings = { ...DEFAULT_SETTINGS };

  async onload() {
    await this.loadSettings();
    this.addRibbonIcon("link", "抖音 × 笔记库桥接", (evt) => this.showMenu(evt));
    this.addCommand({ id: "sync-now-delegated", name: "同步抖音（委托 douyin-sync）", callback: () => this.cmdSyncNow() });
    this.addCommand({ id: "archive-links-in-note", name: "归档当前笔记中的抖音链接", callback: () => this.cmdArchiveFromNote() });
    this.addCommand({ id: "archive-from-input", name: "粘贴链接归档（单条/多条，无需建笔记）", callback: () => this.cmdArchiveFromInput() });
    this.addCommand({ id: "deep-archive", name: "深度归档（逐帧提取 × 转写对照）", callback: () => this.cmdDeepArchive() });
    this.addCommand({ id: "promote-to-source", name: "晋升为来源笔记（收件箱 → 04-来源）", callback: () => this.cmdPromote() });
    this.addCommand({ id: "open-inbox", name: "打开抖音收件箱", callback: () => this.cmdOpenInbox() });
    this.addSettingTab(new VaultLinkSettingTab(this.app, this));
  }

  async loadSettings() {
    Object.assign(this.settings, await this.loadData() ?? {});
  }

  async saveSettings() { await this.saveData(this.settings); }

  showMenu(evt) {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("同步抖音（douyin-sync）").setIcon("refresh-cw").onClick(() => this.cmdSyncNow()));
    menu.addItem((i) => i.setTitle("归档当前笔记中的抖音链接").setIcon("download").onClick(() => this.cmdArchiveFromNote()));
    menu.addItem((i) => i.setTitle("粘贴链接归档").setIcon("clipboard").onClick(() => this.cmdArchiveFromInput()));
    menu.addItem((i) => i.setTitle("深度归档（逐帧 × 转写对照）").setIcon("film").onClick(() => this.cmdDeepArchive()));
    menu.addItem((i) => i.setTitle("晋升为来源笔记").setIcon("file-plus").onClick(() => this.cmdPromote()));
    menu.addItem((i) => i.setTitle("打开抖音收件箱").setIcon("folder-open").onClick(() => this.cmdOpenInbox()));
    menu.showAtMouseEvent(evt);
  }

  /* ---- douyin-sync 配置与桥接 ---- */

  dyPluginDir() { return normalizePath(".obsidian/plugins/douyin-sync"); }

  async dyConfig() {
    const raw = await this.app.vault.adapter.read(`${this.dyPluginDir()}/data.json`);
    const data = JSON.parse(raw);
    if (!data.settings || !data.settings.bridgeEnabled) throw new Error("douyin-sync 未启用本地桥接（请在 douyin-sync 设置中开启「经本地桥接请求抖音」）");
    return data;
  }

  async ensureBridge(cfg) {
    const base = cfg.settings.bridgeUrl;
    try {
      const r = await requestUrl({ url: `${base}/ping`, method: "GET", throw: false });
      if (r.status === 200) return base;
    } catch {}
    new Notice("抖音桥接未运行，正在拉起…");
    const port = base.split(":").pop() || "8765";
    const spawn = window.require("child_process").spawn;
    const node = (cfg.settings.bridgeNodePath || "").trim() || "node";
    const env = { ...process.env };
    const nm = (cfg.settings.bridgeNodeModules || "").trim();
    if (nm) env.NODE_PATH = nm;
    const child = spawn(node, [path.join(this.dyPluginDir(), "douyin-bridge.js"), port], {
      detached: true, stdio: "ignore", windowsHide: true, env,
      cwd: this.dyPluginDir(),
    });
    child.unref?.();
    for (let i = 0; i < 30; i++) {
      await new Promise((res) => setTimeout(res, 500));
      try {
        const r = await requestUrl({ url: `${base}/ping`, method: "GET", throw: false });
        if (r.status === 200) { new Notice("抖音桥接已就绪"); return base; }
      } catch {}
    }
    throw new Error("本地桥接启动超时（15s）。请先跑 2-扫码登录抖音.bat，再从 3-启动桥接控制台.bat 启动桥接。");
  }

  async bridgeReq(cfg, url, method = "GET", body, contentType) {
    const base = await this.ensureBridge(cfg);
    const r = await requestUrl({
      url: `${base}/req`, method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, method, body, contentType }), throw: false,
    });
    if (r.status !== 200) throw new Error(`桥接 HTTP ${r.status}: ${String(r.text).slice(0, 120)}`);
    let out;
    try { out = JSON.parse(r.text); } catch { throw new Error(`桥接响应异常: ${String(r.text).slice(0, 120)}`); }
    if (out.status === -1) throw new Error(String(out.text).slice(0, 200));
    return out;
  }

  async resolveShortLink(cfg, url) {
    const out = await this.bridgeReq(cfg, url, "GET");
    const m = String(out.text || "").match(/www\.douyin\.com\/(video|note)\/(\d{6,30})/);
    return m ? m[2] : null;
  }

  async fetchDetail(cfg, id) {
    const qs = `aweme_id=${id}&device_platform=webapp&aid=6383&channel=channel_pc_web&version_code=170400`;
    const out = await this.bridgeReq(cfg, `https://www.douyin.com/aweme/v1/web/aweme/detail/?${qs}`, "GET");
    let json = null;
    try { json = JSON.parse(out.text); } catch { throw new Error("详情响应非 JSON"); }
    const detail = json && json.aweme_detail;
    if (!detail) throw new Error(`未取到详情（status_code=${json && json.status_code}）——登录态可能失效，请重新扫码`);
    return detail;
  }

  /* douyin-sync 同款归一化，保证 schema 兼容 */
  normalizeItem(aw) {
    const id = String((aw && aw.aweme_id) ?? "");
    if (!/^\d{6,30}$/.test(id)) return null;
    const desc = String((aw && aw.desc) ?? "").trim();
    const images = [];
    const list = (aw && (aw.images || (aw.image_infos && aw.image_infos.images))) || [];
    for (const im of list) {
      const urls = (im && im.url_list) || [];
      const u = urls[urls.length - 1] || urls[0];
      if (u) images.push(u);
      if (images.length >= 10) break;
    }
    const type = images.length > 0 ? "note" : "video";
    const cover = ((aw && aw.video && aw.video.cover && aw.video.cover.url_list && aw.video.cover.url_list[0])
      || (aw && aw.video && aw.video.origin_cover && aw.video.origin_cover.url_list && aw.video.origin_cover.url_list[0])
      || images[0] || "");
    const play = ((aw && aw.video && aw.video.play_addr && aw.video.play_addr.url_list && aw.video.play_addr.url_list[0]) || "").replace("playwm", "play");
    return {
      id, type,
      title: desc.split("\n")[0].trim() || `抖音_${id}`,
      desc,
      author: String((aw && aw.author && aw.author.nickname) ?? "").trim(),
      createTime: Number((aw && aw.create_time) ?? 0),
      playUrl: play,
      coverUrl: cover,
      imageUrls: images,
      durationSec: Math.round(Number(aw && aw.video && aw.video.duration) / 1000),
      stats: {
        likes: Number(aw && aw.statistics && aw.statistics.digg_count) || 0,
        comments: Number(aw && aw.statistics && aw.statistics.comment_count) || 0,
        collects: Number(aw && aw.statistics && aw.statistics.collect_count) || 0,
        shares: Number(aw && aw.statistics && aw.statistics.share_count) || 0,
      },
    };
  }

  /* ---- 收件箱写入 ---- */

  archivedIdSet() {
    const set = new Set();
    const root = this.settings.inboxRoot;
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!f.path.startsWith(root + "/")) continue;
      const m = f.name.match(/\[(\d{6,30})\]\.md$/);
      if (m) set.add(m[1]);
    }
    return set;
  }

  inboxNotePath(item) {
    const date = fmtDate(item.createTime);
    const title = sanitizeTitle(item.title, item.id);
    return normalizePath(`${this.settings.inboxRoot}/手动归档/${date} ${title} [${item.id}].md`);
  }

  async saveCover(cfg, item) {
    if (!item.coverUrl) return "";
    try {
      const r = await requestUrl({
        url: item.coverUrl, method: "GET", throw: false,
        headers: { Referer: "https://www.douyin.com/", "User-Agent": UA },
      });
      if (r.status !== 200 || !r.arrayBuffer || r.arrayBuffer.byteLength === 0) return "";
      const ext = imgExt(item.coverUrl);
      const p = normalizePath(`${this.settings.mediaFolder}/cover/${item.id}.${ext}`);
      if (!this.app.vault.getAbstractFileByPath(p)) {
        await ensureFolder(this.app.vault, this.settings.mediaFolder + "/cover");
        await this.app.vault.createBinary(p, r.arrayBuffer);
      }
      return p;
    } catch { return ""; }
  }

  async saveImages(cfg, item) {
    const paths = [];
    for (let i = 0; i < Math.min(item.imageUrls.length, 10); i++) {
      try {
        const r = await requestUrl({
          url: item.imageUrls[i], method: "GET", throw: false,
          headers: { Referer: "https://www.douyin.com/", "User-Agent": UA },
        });
        if (r.status === 200 && r.arrayBuffer && r.arrayBuffer.byteLength > 0) {
          const p = normalizePath(`${this.settings.mediaFolder}/images/${item.id}/${i + 1}.${imgExt(item.imageUrls[i])}`);
          if (!this.app.vault.getAbstractFileByPath(p)) {
            await ensureFolder(this.app.vault, `${this.settings.mediaFolder}/images/${item.id}`);
            await this.app.vault.createBinary(p, r.arrayBuffer);
          }
          paths.push(p);
        }
      } catch {}
      await new Promise((res) => setTimeout(res, 200));
    }
    return paths;
  }

  renderArchiveNote(item, coverPath, imagePaths) {
    const kind = SOURCE_KIND[item.type];
    const url = item.type === "note" ? `https://www.douyin.com/note/${item.id}` : `https://www.douyin.com/video/${item.id}`;
    const lines = [];
    lines.push("---");
    lines.push(`douyin_id: ${fmStr(item.id)}`);
    lines.push(`title: ${fmStr(item.title)}`);
    lines.push(`type: ${fmStr(kind)}`);
    lines.push(`source: ${fmStr("手动归档")}`);
    lines.push(`author: ${fmStr(item.author)}`);
    lines.push(`published: ${fmStr(isoOf(item.createTime))}`);
    lines.push(`category: ${fmStr("")}`);
    lines.push(`url: ${fmStr(url)}`);
    if (item.durationSec > 0) lines.push(`duration: ${fmStr(fmtDuration(item.durationSec))}`);
    if (coverPath) lines.push(`cover: ${fmStr(coverPath)}`);
    lines.push(`likes: ${item.stats.likes}`);
    lines.push("stats:");
    lines.push(`  likes: ${item.stats.likes}`);
    lines.push(`  comments: ${item.stats.comments}`);
    lines.push(`  collects: ${item.stats.collects}`);
    lines.push(`  shares: ${item.stats.shares}`);
    lines.push("transcript_status: not_requested");
    lines.push("vault_status: 待整合");
    lines.push("promoted_to: \"\"");
    lines.push("tags:");
    lines.push("  - 抖音");
    lines.push("  - 手动归档");
    lines.push("---");
    lines.push("");
    lines.push(`# ${item.title}`);
    lines.push("");
    const meta = [];
    if (item.author) meta.push(`作者：**${item.author}**`);
    meta.push(`来源：手动归档`);
    meta.push(`[原视频链接](${url})`);
    lines.push(meta.join(" ｜ "));
    lines.push("");
    if (item.desc && item.desc !== item.title) { lines.push(item.desc); lines.push(""); }
    if (item.type === "note" && imagePaths.length > 0) {
      lines.push("## 图片");
      lines.push("");
      imagePaths.forEach((p, i) => {
        lines.push(`![[${p}]]`);
        lines.push(`（图 ${i + 1}：待补说明——晋升前按库规则补全）`);
        lines.push("");
      });
    }
    lines.push("> [!info]- 逐字稿");
    lines.push("> 手动归档不进 douyin-sync 转写队列。如需逐字稿：把该视频加入抖音收藏后执行一次 douyin-sync 同步（会按 douyin_id 去重补全转写），或在该笔记上配置云端 ASR 后手动处理。");
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push(`*归档于 ${nowStamp()} ｜ douyin-vault-link*`);
    lines.push("");
    return lines.join("\n");
  }

  async writeVaultFile(p, content) {
    await ensureFolder(this.app.vault, p.slice(0, p.lastIndexOf("/")));
    const existing = this.app.vault.getAbstractFileByPath(p);
    if (existing instanceof obsidian.TFile) {
      await this.app.vault.process(existing, () => content);
      return false;
    }
    await this.app.vault.create(p, content);
    return true;
  }

  async appendSyncLog(line) {
    if (!this.settings.syncLogEnabled) return;
    const p = normalizePath(this.settings.syncLogPath);
    const header = "# 抖音同步归档日志\n\n> 过程产物（不入图谱）。伴生插件自动追加。\n";
    const f = this.app.vault.getAbstractFileByPath(p);
    if (f instanceof obsidian.TFile) {
      const text = await this.app.vault.read(f);
      await this.app.vault.modify(f, `${text.replace(/\n*$/, "\n")}${line}\n`);
    } else {
      await ensureFolder(this.app.vault, this.settings.syncLogPath.slice(0, this.settings.syncLogPath.lastIndexOf("/")));
      await this.app.vault.create(p, `${header}\n${line}\n`);
    }
  }

  /* ---- 命令 1：委托同步 ---- */

  async cmdSyncNow() {
    const p = this.app.plugins.plugins["douyin-sync"];
    if (!p) { new Notice("douyin-sync 未安装或未启用"); return; }
    const before = new Set(Object.keys(p.engine?.state?.processed || {}));
    await p.runSync();
    if (this.settings.autoDeepArchive) {
      try { await this.autoDeepArchiveNew(before); }
      catch (e) { new Notice(`自动深度归档失败：${String(e.message || e).slice(0, 160)}`, 10000); }
    }
  }

  /* 同步后自动深度归档：对本次同步新增（processed 差集）的视频笔记逐条跑引擎 */
  async autoDeepArchiveNew(beforeIds) {
    const p = this.app.plugins.plugins["douyin-sync"];
    const added = Object.keys(p.engine?.state?.processed || {}).filter((id) => !beforeIds.has(id));
    if (added.length === 0) return;
    const addedSet = new Set(added);
    const targets = this.app.vault.getMarkdownFiles()
      .filter((f) => f.path.startsWith(this.settings.inboxRoot + "/"))
      .filter((f) => {
        const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
        return fm && fm.douyin_id && addedSet.has(String(fm.douyin_id)) && (!fm.type || fm.type === "视频");
      });
    if (targets.length === 0) return;
    new Notice(`自动深度归档：${targets.length} 条新增…`, 0);
    let ok = 0;
    for (const f of targets) {
      try {
        const text = await this.app.vault.read(f);
        const fm = parseFrontmatter(text);
        if (!fm.douyin_id) continue;
        await this.runEngineOnce(f, fm, (msg) => new Notice(`自动深度归档 ${ok + 1}/${targets.length}：${msg}`, 5000));
        ok++;
      } catch (e) {
        new Notice(`自动深度归档失败（${f.basename.slice(0, 30)}）：${String(e.message || e).slice(0, 120)}`, 10000);
      }
    }
    new Notice(`自动深度归档完成：${ok}/${targets.length}`, 8000);
    await this.appendSyncLog(`- ${nowStamp()} — 同步后自动深度归档：${ok}/${targets.length}`);
  }

  /* ---- 命令 2：归档当前笔记中的链接 ---- */

  cmdArchiveFromNote() {
    const view = this.app.workspace.getActiveViewOfType(obsidian.ItemView) || null;
    const md = this.app.workspace.activeEditor;
    if (!md || !md.editor || !md.file) { new Notice("请先打开一篇笔记"); return; }
    void this.archiveFromNote(md.file, md.editor);
  }

  async archiveFromNote(file, editor) {
    let cfg;
    try { cfg = await this.dyConfig(); } catch (e) { new Notice(String(e.message || e), 8000); return; }
    const text = await this.app.vault.read(file);
    const ids = [];
    const seen = new Set();
    const reFull = /https?:\/\/www\.douyin\.com\/(?:video|note)\/(\d{6,30})/g;
    const reShort = /https?:\/\/v\.douyin\.com\/[A-Za-z0-9]+/g;
    let m;
    while ((m = reFull.exec(text))) { if (!seen.has(m[1])) { seen.add(m[1]); ids.push(m[1]); } }
    const shorts = [];
    while ((m = reShort.exec(text))) shorts.push(m[0]);
    if (ids.length === 0 && shorts.length === 0) { new Notice("笔记中没有找到抖音链接"); return; }
    try {
      for (const s of shorts) {
        const id = await this.resolveShortLink(cfg, s);
        if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
      }
    } catch (e) { new Notice(`短链解析失败：${String(e.message || e).slice(0, 120)}`, 8000); }

    const { created, failed } = await this.archiveIds(cfg, ids);
    if (created.length === 0 && failed.length === 0) { new Notice(`共 ${ids.length} 条链接，均已在收件箱`); return; }

    if (created.length > 0 && editor) {
      const body = await this.app.vault.read(file);
      const insert = created.map((c) => `- ${mdLink(`${c.title} [${c.id}]`, c.path)}`).join("\n");
      let out;
      const lines = body.split("\n");
      const hIdx = lines.findIndex((l) => l.trim() === ARCHIVE_HEADING);
      if (hIdx >= 0) lines.splice(hIdx + 1, 0, insert);
      else out = `${body.replace(/\n*$/, "\n")}\n${ARCHIVE_HEADING}\n\n${insert}\n`;
      await this.app.vault.modify(file, out ?? lines.join("\n"));
    }

    const summary = `归档 ${created.length} 条` + (failed.length ? `，失败 ${failed.length}：${failed[0]}` : "");
    new Notice(summary, 8000);
    await this.appendSyncLog(`- ${nowStamp()} — 从「${file.basename}」${summary}${created.length ? `：${created.map((c) => c.title).join("、")}` : ""}`);
  }

  /* 公共归档核心：给一组视频 ID，按 douyin_id 去重后逐条取详情建收件箱笔记 */
  async archiveIds(cfg, ids) {
    const archived = this.archivedIdSet();
    const fresh = ids.filter((id) => !archived.has(id));
    if (fresh.length === 0) return { created: [], failed: [] };
    const created = [];
    const failed = [];
    for (const id of fresh) {
      try {
        const detail = await this.fetchDetail(cfg, id);
        const item = this.normalizeItem(detail);
        if (!item) { failed.push(`${id}（归一化失败）`); continue; }
        const coverPath = await this.saveCover(cfg, item);
        const imagePaths = item.type === "note" ? await this.saveImages(cfg, item) : [];
        const p = this.inboxNotePath(item);
        await this.writeVaultFile(p, this.renderArchiveNote(item, coverPath, imagePaths));
        created.push({ id, path: p, title: sanitizeTitle(item.title, 40) || item.id });
      } catch (e) {
        failed.push(`${id}（${String(e.message || e).slice(0, 80)}）`);
      }
      await new Promise((res) => setTimeout(res, 400));
    }
    return { created, failed };
  }

  /* 粘贴链接弹窗归档：不依赖任何已打开的笔记 */
  cmdArchiveFromInput() {
    new LinkInputModal(this.app, async (text) => {
      let cfg;
      try { cfg = await this.dyConfig(); } catch (e) { new Notice(String(e.message || e), 8000); return; }
      const ids = [];
      const seen = new Set();
      const reFull = /https?:\/\/www\.douyin\.com\/(?:video|note)\/(\d{6,30})/g;
      const reShort = /https?:\/\/v\.douyin\.com\/[A-Za-z0-9]+/g;
      let m;
      while ((m = reFull.exec(text))) { if (!seen.has(m[1])) { seen.add(m[1]); ids.push(m[1]); } }
      const shorts = [];
      while ((m = reShort.exec(text))) shorts.push(m[0]);
      if (ids.length === 0 && shorts.length === 0) { new Notice("没有识别到抖音链接（支持网页链接与 v.douyin.com 分享短链）"); return; }
      try {
        for (const s of shorts) {
          const id = await this.resolveShortLink(cfg, s);
          if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
        }
      } catch (e) { new Notice(`短链解析失败：${String(e.message || e).slice(0, 120)}`, 8000); }
      if (ids.length === 0) { new Notice("短链未解析出视频 ID"); return; }
      const notice = new Notice(`正在归档 ${ids.length} 条…`, 0);
      const { created, failed } = await this.archiveIds(cfg, ids);
      notice.hide();
      if (created.length === 0 && failed.length === 0) { new Notice(`共 ${ids.length} 条链接，均已在收件箱`); return; }
      const summary = `归档 ${created.length} 条` + (failed.length ? `，失败 ${failed.length}：${failed[0]}` : "");
      new Notice(summary + (created.length ? `：${created.map((c) => c.title).join("、").slice(0, 90)}` : ""), 8000);
      await this.appendSyncLog(`- ${nowStamp()} — 粘贴链接${summary}${created.length ? `：${created.map((c) => c.title).join("、")}` : ""}`);
      if (this.settings.autoDeepArchive && created.length > 0) {
        let ok2 = 0;
        new Notice(`自动深度归档：${created.length} 条新笔记…`, 0);
        for (const c of created) {
          const tf = this.app.vault.getAbstractFileByPath(c.path);
          if (!tf) continue;
          try {
            const text2 = await this.app.vault.read(tf);
            const fm2 = parseFrontmatter(text2);
            if (fm2.type && fm2.type !== "视频") continue;
            await this.runEngineOnce(tf, fm2, () => {});
            ok2++;
          } catch (e) { new Notice(`自动深度归档失败（${c.title.slice(0, 24)}）：${String(e.message || e).slice(0, 100)}`, 8000); }
        }
        if (ok2 > 0) new Notice(`自动深度归档完成：${ok2}/${created.length}`, 6000);
      }
      if (created.length === 1) { try { this.app.workspace.openLinkText(created[0].path, "", false); } catch {} }
    }).open();
  }

  /* ---- 命令 3：晋升 ---- */

  cmdPromote() {
    const md = this.app.workspace.activeEditor;
    if (!md || !md.file) { new Notice("请先打开收件箱里的抖音笔记"); return; }
    const f = md.file;
    if (!f.path.startsWith(this.settings.inboxRoot + "/")) { new Notice("当前笔记不在收件箱内"); return; }
    void (async () => {
      const text = await this.app.vault.read(f);
      const { data } = parseFrontmatter(text);
      if (!data.douyin_id) { new Notice("笔记缺少 douyin_id 属性，不是抖音归档笔记"); return; }
      if (data.vault_status === "已晋升") { new Notice(`该笔记已晋升：${data.promoted_to || ""}`); return; }
      new PromoteModal(this.app, this, f, data).open();
    })();
  }

  async promote(stagedFile, stagedData, plan) {
    const name = sanitizeTitle(plan.title, 80) || `抖音视频_${stagedData.douyin_id}`;
    const targetPath = normalizePath(`${this.settings.sourceFolder}/${name}.md`);
    if (this.app.vault.getAbstractFileByPath(targetPath)) { new Notice(`已存在 ${targetPath}，请换标题`); return false; }

    const domainTags = plan.domains.map((d) => `  - domain/${d}`);
    const content = [
      "---",
      "type: source",
      `source-kind: ${fmStr(SOURCE_KIND[stagedData.type] || "视频")}`,
      `author: ${fmStr(stagedData.author || "")}`,
      `url: ${fmStr(stagedData.url || "")}`,
      `created: ${fmStr(todayLocal())}`,
      `douyin_id: ${fmStr(stagedData.douyin_id)}`,
      stagedData.published ? `published: ${fmStr(stagedData.published)}` : null,
      "tags:",
      ...domainTags,
      "---",
      "",
      `# ${name}`,
      "",
      "## 来源信息",
      "",
      `- 作者：${stagedData.author || "（缺失，不猜测）"}`,
      `- 链接：${stagedData.url || "（缺失）"}（抖音${SOURCE_KIND[stagedData.type] || "视频"}${stagedData.published ? `，发布于 ${String(stagedData.published).slice(0, 10)}` : ""}）`,
      `- 收件箱：${mdLink(`${stagedFile.basename}`, stagedFile.path)}（逐字稿/图片文字全量在此；本页只留检索与结构）`,
      "",
      "## 为什么使用这个来源",
      "",
      plan.reason || "",
      "",
      "## 关键证据",
      "",
      "（待补：区分原文信息 / 自己的理解 / AI 辅助内容）",
      "",
      "## 关联问题与概念",
      "",
      "- [[ ]] —",
      "",
    ].filter((l) => l !== null).join("\n");

    await ensureFolder(this.app.vault, this.settings.sourceFolder);
    await this.app.vault.create(targetPath, content);

    if (plan.mapPath) {
      try {
        const mf = this.app.vault.getAbstractFileByPath(normalizePath(plan.mapPath));
        if (mf instanceof obsidian.TFile) {
          const mapText = await this.app.vault.read(mf);
          const linkLine = `- [[${name}]] — ${plan.reason || plan.group || "抖音来源"}`;
          const mapLines = mapText.split("\n");
          const gIdx = mapLines.findIndex((l) => l.trim() === `### ${plan.group}`);
          if (gIdx >= 0) mapLines.splice(gIdx + 1, 0, linkLine);
          else mapLines.push("", `### ${plan.group}`, "", linkLine, "");
          await this.app.vault.modify(mf, mapLines.join("\n"));
        }
      } catch (e) { new Notice(`挂地图失败：${String(e.message || e).slice(0, 100)}`); }
    }

    const stagedText = await this.app.vault.read(stagedFile);
    await this.app.vault.process(stagedFile, () => updateFrontmatter(stagedText, {
      vault_status: "已晋升",
      promoted_to: `[[${name}]]`,
    }));

    await this.appendSyncLog(`- ${nowStamp()} — 晋升「${stagedFile.basename}」→ 04-来源/${name}${plan.mapPath ? `（挂 ${plan.mapPath}）` : ""}`);
    new Notice(`已晋升：04-来源/${name}`);
    return true;
  }

  /* ---- 命令 3.5：深度归档（薄客户端：引擎 = bilibili-video-learning 技能 douyin_deep_archive.py，单一实现） ---- */

  /* 深度归档引擎定位：bilibili-video-learning 技能的 douyin_deep_archive.py（单一实现，本插件只做薄客户端） */
  enginePaths() {
    const os = window.require("os");
    const py = (this.settings.localAsrPython || "").trim() || path.join(os.homedir(), ".agents", "skills", "bilibili-video-learning", ".venv-gpu", "Scripts", "python.exe");
    return { py, script: path.resolve(path.dirname(py), "..", "..", "scripts", "douyin_deep_archive.py") };
  }

  async cmdDeepArchive() {
    const md = this.app.workspace.activeEditor;
    if (!md || !md.file) { new Notice("请先打开收件箱里的抖音视频笔记"); return; }
    const f = md.file;
    if (!f.path.startsWith(this.settings.inboxRoot + "/")) { new Notice("当前笔记不在收件箱内"); return; }
    void (async () => {
      try {
        const text = await this.app.vault.read(f);
        const { data } = parseFrontmatter(text);
        if (!data.douyin_id) { new Notice("笔记缺少 douyin_id 属性"); return; }
        if (data.type && data.type !== "视频") { new Notice("深度归档只适用于视频类笔记（图文笔记已有原图片）"); return; }
        const notice = new Notice("深度归档：引擎启动…", 0);
        const out = await this.runEngineOnce(f, data, (msg) => notice.setMessage(`深度归档：${msg}`));
        new Notice(`深度归档完成：${out ? `${out.frames} 帧 ｜ ${out.segments} 句` : "完成"}`, 8000);
        await this.appendSyncLog(`- ${nowStamp()} — 深度归档「${f.basename}」：${out ? `${out.frames} 帧/${out.segments} 句` : "完成"}`);
      } catch (e) {
        new Notice(`深度归档失败：${String(e.message || e).slice(0, 200)}`, 10000);
      }
    })();
  }

  /* 引擎单次执行：给目标笔记文件，组参 spawn，返回 JSON 结果；进度经 onProgress 回调 */
  async runEngineOnce(file, fm, onProgress) {
    const { py, script } = this.enginePaths();
    const fs = window.require("fs");
    if (!fs.existsSync(py)) throw new Error(`引擎 Python 不存在：${py}（请安装 bilibili-video-learning 技能或在本设置页填路径）`);
    if (!fs.existsSync(script)) throw new Error(`引擎脚本不存在：${script}（请把技能更新到 1.3.6+）`);
    const vaultRoot = this.app.vault.adapter.getBasePath();
    const bridge = ((await this.dyConfig()).settings.bridgeUrl) || "http://127.0.0.1:8765";
    const args = [script, "--id", String(fm.douyin_id), "--note", path.join(vaultRoot, file.path),
      "--vault", vaultRoot, "--bridge", bridge,
      "--ffmpeg", this.settings.ffmpegPath || "ffmpeg",
      "--max-frames", String(this.settings.maxFrames || 24),
      "--model", this.settings.localAsrModel || "small"];
    if (this.settings.videoWorkRoot) args.push("--workdir", this.settings.videoWorkRoot);
    try {
      const ai = (await this.dyConfig()).settings || {};
      if (ai.enableVision && ai.aiBaseUrl && ai.aiKey) {
        args.push("--vision", "--vision-url", String(ai.aiBaseUrl), "--vision-model", String(ai.visionModel || "qwen2.5vl:3b"));
      }
    } catch {}
    return await new Promise((resolve, reject) => {
      const cp = window.require("child_process").spawn(py, args, { windowsHide: true });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => { cp.kill(); reject(new Error("引擎超时（30 分钟）")); }, 30 * 60 * 1000);
      cp.stdout.on("data", (d) => { stdout += d; });
      cp.stderr.on("data", (d) => {
        stderr += d;
        const lines = String(d).match(/\[archive\][^\r\n]+/g);
        if (lines && onProgress) onProgress(lines[lines.length - 1].replace("[archive] ", ""));
      });
      cp.on("error", (e) => { clearTimeout(timer); reject(e); });
      cp.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          const tail = stderr.trim().split("\n").slice(-3).join(" ").slice(-300);
          reject(new Error(tail || `引擎退出码 ${code}`));
          return;
        }
        let out = null;
        try { out = JSON.parse(stdout.trim().split("\n").pop()); } catch {}
        resolve(out);
      });
    });
  }

  /* ---- 命令 4：收件箱 ---- */

  cmdOpenInbox() {
    const p = normalizePath(this.settings.inboxRoot);
    const folder = this.app.vault.getAbstractFileByPath(p);
    if (!(folder instanceof TFolder)) { new Notice(`收件箱不存在：${p}（同步或归档后会自动创建）`); return; }
    try {
      const fe = this.app.internalPlugins.getPluginById("file-explorer");
      fe.instance.revealInFolder(folder);
    } catch { new Notice(`收件箱：${p}`); }
  }
}

/* ---------------- 晋升确认弹窗 ---------------- */

class PromoteModal extends Modal {
  constructor(app, plugin, stagedFile, stagedData) {
    super(app);
    this.plugin = plugin;
    this.stagedFile = stagedFile;
    this.stagedData = stagedData;
    this.title = stagedData.title || stagedFile.basename.replace(/\s*\[\d+\]$/, "");
    this.domains = [];
    this.mapPath = "";
    this.group = "资料来源";
    this.reason = "";
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "晋升为来源笔记（写入 04-来源，需确认）" });
    contentEl.createEl("p", { text: `收件箱：${this.stagedFile.path}` });

    new Setting(contentEl).setName("来源标题（04-来源/标题.md）").addText((t) => {
      t.setValue(this.title).onChange((v) => { this.title = v.trim(); });
      t.inputEl.style.width = "100%";
    });

    const reg = this.plugin.settings.domainRegistry.split("\n").map((s) => s.trim()).filter(Boolean);
    const domSetting = new Setting(contentEl).setName("领域标签（1~2 个，domain/<slug>）");
    for (const slug of reg) {
      domSetting.addToggle((tg) => {
        tg.setValue(false).onChange((v) => {
          if (v) {
            if (this.domains.length >= 2) { tg.setValue(false); new Notice("最多 2 个标签"); return; }
            this.domains.push(slug);
          } else this.domains = this.domains.filter((d) => d !== slug);
        });
      });
    }

    const maps = this.app.vault.getMarkdownFiles()
      .filter((f) => f.path.startsWith(this.plugin.settings.mapsFolder + "/"))
      .sort((a, b) => a.basename.localeCompare(b.basename, "zh"));
    new Setting(contentEl).setName("挂到主题地图（可选）").addDropdown((dd) => {
      dd.addOption("", "不挂地图");
      for (const f of maps) dd.addOption(f.path, f.basename);
      dd.onChange((v) => { this.mapPath = v; });
    });
    new Setting(contentEl).setName("地图分组（### 标题，不存在则新建）").addText((t) => {
      t.setValue(this.group).onChange((v) => { this.group = v.trim(); });
    });
    new Setting(contentEl).setName("归属理由（一句；同时写入「为什么使用这个来源」）").addText((t) => {
      t.setValue("抖音收藏的参考材料").onChange((v) => { this.reason = v.trim(); });
      t.inputEl.style.width = "100%";
    });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText("取消").onClick(() => this.close()))
      .addButton((b) => b.setCta().setButtonText("确认晋升").onClick(() => {
        if (!this.title) { new Notice("标题不能为空"); return; }
        if (this.domains.length < 1) { new Notice("至少 1 个 domain 标签"); return; }
        this.close();
        void this.plugin.promote(this.stagedFile, this.stagedData, {
          title: this.title, domains: this.domains, mapPath: this.mapPath, group: this.group, reason: this.reason,
        });
      }));
  }

  onClose() { this.contentEl.empty(); }
}

/* ---------------- 设置页 ---------------- */

class VaultLinkSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    new Setting(containerEl).setName("路径").setHeading();
    new Setting(containerEl).setName("收件箱目录").setDesc("douyin-sync 与本插件共同写入的暂存区（默认隔离区）").addText((t) => t.setValue(s.inboxRoot).onChange(async (v) => { s.inboxRoot = v.trim() || DEFAULT_SETTINGS.inboxRoot; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("媒体目录").setDesc("封面与图文图片（封面已被 gitignore，不入库）").addText((t) => t.setValue(s.mediaFolder).onChange(async (v) => { s.mediaFolder = v.trim() || DEFAULT_SETTINGS.mediaFolder; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("来源目录").setDesc("晋升目标（04-来源）").addText((t) => t.setValue(s.sourceFolder).onChange(async (v) => { s.sourceFolder = v.trim() || DEFAULT_SETTINGS.sourceFolder; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("主题地图目录").addText((t) => t.setValue(s.mapsFolder).onChange(async (v) => { s.mapsFolder = v.trim() || DEFAULT_SETTINGS.mapsFolder; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("同步日志").setHeading();
    new Setting(containerEl).setName("启用同步日志").setDesc("每次归档/晋升追加一行到日志笔记（过程产物）").addToggle((t) => t.setValue(s.syncLogEnabled).onChange(async (v) => { s.syncLogEnabled = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("日志路径").addText((t) => t.setValue(s.syncLogPath).onChange(async (v) => { s.syncLogPath = v.trim() || DEFAULT_SETTINGS.syncLogPath; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("领域标签注册表").setDesc("每行一个 domain/<slug>；扩展注册表须说明边界（禁 domain/other）").addTextArea((t) => {
      t.setValue(s.domainRegistry).onChange(async (v) => { s.domainRegistry = v; await this.plugin.saveSettings(); });
      t.inputEl.rows = 5; t.inputEl.style.width = "100%";
    });

    new Setting(containerEl).setName("深度归档（逐帧 × 转写）").setHeading();
    new Setting(containerEl).setName("最多关键帧数").setDesc("场景切换检测选帧上限").addText((t) => t.setValue(String(s.maxFrames)).onChange(async (v) => { const n = parseInt(v, 10); s.maxFrames = Number.isFinite(n) && n >= 2 ? n : 24; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("场景切换分数下限").setDesc("峰值须高于 max(此值, 最高分×相对系数)；一般不动").addText((t) => t.setValue(String(s.sceneThreshold)).onChange(async (v) => { const n = parseFloat(v); s.sceneThreshold = Number.isFinite(n) && n > 0 && n < 1 ? n : 0.025; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("相对峰值系数").setDesc("相对最高分的比例下限（0~1），越小抓到越多软切换；默认 0.08").addText((t) => t.setValue(String(s.peakRelFactor)).onChange(async (v) => { const n = parseFloat(v); s.peakRelFactor = Number.isFinite(n) && n > 0 && n < 1 ? n : 0.08; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("最小帧间隔（秒）").addText((t) => t.setValue(String(s.minGapSec)).onChange(async (v) => { const n = parseFloat(v); s.minGapSec = Number.isFinite(n) && n > 0 ? n : 1.0; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("ffmpeg 路径").setDesc("留空则在 PATH 与 C:\\Users\\<用户>\\.codex\\bin 中自动探测").addText((t) => t.setValue(s.ffmpegPath).onChange(async (v) => { s.ffmpegPath = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("视频工作目录").setDesc("原视频临时存放处（不入库）；留空 = %LOCALAPPDATA%\\DouyinSyncBridge\\media-work").addText((t) => t.setValue(s.videoWorkRoot).onChange(async (v) => { s.videoWorkRoot = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("本地转写 Python").setDesc("深度归档引擎所用 Python；留空 = %USERPROFILE%\\.agents\\skills\\bilibili-video-learning\\.venv-gpu\\Scripts\\python.exe").addText((t) => t.setValue(s.localAsrPython || "").onChange(async (v) => { s.localAsrPython = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("本地转写模型").setDesc("引擎转写模型；small 已在 RTX 5070 实测 ≈9× 实时，large-v3-turbo 更准但吃显存").addDropdown((dd) => {
      for (const m of ["tiny", "base", "small", "medium", "large-v3-turbo"]) dd.addOption(m, m);
      dd.setValue(s.localAsrModel || "small");
      dd.onChange(async (v) => { s.localAsrModel = v; await this.plugin.saveSettings(); });
    });
    new Setting(containerEl).setName("同步后自动深度归档新增").setDesc("开启后：同步/粘贴归档产生的新视频笔记自动跑深度归档引擎（本地转写+抽帧+图注）；每条新增约 +1~2 分钟。默认关").addToggle((t) => t.setValue(s.autoDeepArchive || false).onChange(async (v) => { s.autoDeepArchive = v; await this.plugin.saveSettings(); }));
  }
}

/* 粘贴链接归档弹窗：一行或多行，网页链接或分享短链均可 */
class LinkInputModal extends Modal {
  constructor(app, onSubmit) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    this.titleEl.setText("粘贴抖音链接归档");
    this.contentEl.createEl("p", {
      text: "支持网页链接（douyin.com/video/…）与分享短链（v.douyin.com/…），一行一条，可一次多条。已归档过的自动跳过。",
      cls: "setting-item-description",
    });
    const area = this.contentEl.createEl("textarea", { attr: { rows: 5, style: "width:100%;resize:vertical" } });
    area.focus();
    const btns = this.contentEl.createDiv({ attr: { style: "display:flex;gap:8px;margin-top:10px;justify-content:flex-end" } });
    const cancel = btns.createEl("button", { text: "取消" });
    cancel.onclick = () => this.close();
    const ok = btns.createEl("button", { text: "归档", cls: "mod-cta" });
    ok.onclick = async () => {
      const text = String(area.value || "").trim();
      if (!text) { new Notice("请先粘贴链接"); return; }
      this.close();
      await this.onSubmit(text);
    };
  }

  onClose() { this.contentEl.empty(); }
}

module.exports = DouyinVaultLinkPlugin;
