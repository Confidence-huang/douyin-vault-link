"""
批量 AI 分类：给收件箱里已同步的抖音笔记补 category（douyin-sync 只对新笔记分类，存量需本工具）。
- 只改 frontmatter 里的 category: 一行，临时文件 + os.replace 原子写回；
  已分类（category 不是 未分类/空）的自动跳过，可安全重跑。
- 分类列表缺省读 douyin-sync data.json 的 aiCategories（与新笔记的分类口径一致）。
- 模型走本机 OpenAI 兼容端点（Ollama qwen2.5:3b），逐条调用，单条失败记入 failed 不中断。
调用示例：python classify-inbox.py --dry-run --limit 10
          python classify-inbox.py            # 全量
"""
from __future__ import annotations

import argparse
import json
import os
import re
import urllib.request
from pathlib import Path

DEFAULT_VAULT = os.environ.get("BILIBILI_OBSIDIAN_VAULT") or r"D:\NOTE"
INBOX_REL = os.path.join("00-原始笔记", "抖音归档")
UNCLASSIFIED = {"未分类", "", "-"}


def parse_frontmatter(text: str) -> dict:
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if not m:
        return {}
    fm = {}
    for line in m.group(1).split("\n"):
        mm = re.match(r"^([A-Za-z_][\w]*):\s*(.*)$", line)
        if mm:
            fm[mm.group(1)] = mm.group(2).strip().strip('"')
    return fm


def field_line_span(text: str, key: str):
    return re.search(rf"^{key}:.*$", text, re.M)  # 全文行锚定：span 即绝对偏移，避免组内换算出错


def classify_one(url: str, model: str, categories: list[str], title: str, snippet: str) -> str:
    prompt = ("从以下分类列表中选择最匹配的一个，只输出分类名本身，不要输出任何其他文字：\n"
              + "\n".join(categories)
              + f"\n\n标题：{title}\n内容摘要：{snippet}")
    payload = {"model": model, "max_tokens": 40, "temperature": 0,
               "messages": [{"role": "user", "content": prompt}]}
    req = urllib.request.Request(url.rstrip("/") + "/chat/completions",
                                 data=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=90) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    reply = str(data.get("choices", [{}])[0].get("message", {}).get("content", "")).strip()
    if reply in categories:
        return reply
    for c in categories:  # 模型多说了话时，取第一个出现的合法分类
        if c and c in reply:
            return c
    return "未分类"


def clean_snippet(body: str, limit: int = 180) -> str:
    text = re.sub(r"!\[\[[^\]]*\]\]", " ", body)        # 去嵌入图
    text = re.sub(r"^>.*$", " ", text, flags=re.M)      # 去引块
    text = re.sub(r"https?://\S+", " ", text)           # 去 URL
    return re.sub(r"\s+", " ", text)[:limit]


def main() -> int:
    ap = argparse.ArgumentParser(description="批量给已同步抖音笔记补 AI 分类（只改 category 一行）")
    ap.add_argument("--vault", default=DEFAULT_VAULT)
    ap.add_argument("--url", default=os.environ.get("DOUYIN_VIDEO_VISION_URL") or "http://127.0.0.1:11434/v1")
    ap.add_argument("--model", default="qwen2.5:3b")
    ap.add_argument("--limit", type=int, default=0, help="最多处理 N 条（0=不限）")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--retry-unclassified", action="store_true",
                    help="只处理 category=未分类 的顽固笔记：500 字摘要重试，兜底归入 其他（不好分类）")
    args = ap.parse_args()

    sync_path = Path(args.vault) / ".obsidian" / "plugins" / "douyin-sync" / "data.json"
    sync_data = json.loads(sync_path.read_text(encoding="utf-8"))
    categories = [x.strip() for x in re.split(r"[\n,，;；]", sync_data["settings"].get("aiCategories", "")) if x.strip()]
    if not categories:
        print(json.dumps({"error": "分类列表为空（douyin-sync aiCategories）"}, ensure_ascii=False))
        return 1

    inbox = Path(args.vault) / INBOX_REL
    notes = [p for p in sorted(inbox.rglob("*.md")) if p.name != "00-说明.md" and "同步日志" not in p.name]
    todo, skipped_done, skipped_noid = [], 0, 0
    for p in notes:
        text = p.read_text(encoding="utf-8")
        fm = parse_frontmatter(text)
        if "douyin_id" not in fm:
            skipped_noid += 1
            continue
        cat_now = fm.get("category", "未分类")
        if args.retry_unclassified:
            if cat_now != "未分类":
                skipped_done += 1
                continue
        elif cat_now not in UNCLASSIFIED:
            skipped_done += 1
            continue
        todo.append((p, text, fm))

    print(json.dumps({"notes_total": len(notes), "todo": len(todo),
                      "already_classified": skipped_done, "no_douyin_id": skipped_noid,
                      "categories": categories}, ensure_ascii=False), flush=True)
    if args.limit:
        todo = todo[: args.limit]

    done = failed = 0
    dist: dict[str, int] = {}
    for i, (p, text, fm) in enumerate(todo, 1):
        title = fm.get("title", p.stem)
        body = text.split("---", 2)[-1]
        try:
            cat = classify_one(args.url, args.model, categories, title, clean_snippet(body, 500 if args.retry_unclassified else 180))
            if args.retry_unclassified and cat == "未分类":
                cat = "其他（不好分类）"
        except Exception as e:
            failed += 1
            print(f"[{i}/{len(todo)}] FAIL {p.name[:36]}: {str(e)[:70]}", flush=True)
            continue
        if not args.dry_run:
            mline = field_line_span(text, "category")
            if not mline:
                continue
            new_fm_line = f"category: \"{cat}\""
            text = text[:mline.start()] + new_fm_line + text[mline.end():]
            tmp = p.with_suffix(".md.tmp")
            tmp.write_text(text, encoding="utf-8")
            os.replace(tmp, p)
        done += 1
        dist[cat] = dist.get(cat, 0) + 1
        if i % 25 == 0 or i == len(todo):
            print(f"[{i}/{len(todo)}] done={done} failed={failed} dist={json.dumps(dist, ensure_ascii=False)}", flush=True)

    print(json.dumps({"ok": True, "dry_run": args.dry_run, "classified": done, "failed": failed,
                      "distribution": dist}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
