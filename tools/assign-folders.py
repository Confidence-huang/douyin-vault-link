"""
AI 归属分派：给全部收件箱笔记评估最合适的抖音收藏夹（39 选 1），产出完整分类方案。
- 真值优先：已在某收藏夹的笔记记录为「维持」；AI 建议不同的记为「建议修正」（仅方案，不移动文件）
- 无夹笔记（未分类主体）AI 直接分派；回退=维持 未分类
- 输出：tools/reclass-plan-full.json + outputs/收藏夹重组方案-<date>.md
调用示例：python assign-folders.py --vault "D:\\NOTE"
"""
from __future__ import annotations

import argparse
import json
import os
import re
import urllib.request
from pathlib import Path

DEFAULT_VAULT = os.environ.get("BILIBILI_OBSIDIAN_VAULT")
URL = os.environ.get("DOUYIN_VIDEO_VISION_URL") or "http://127.0.0.1:11434/v1"
MODEL = "qwen2.5:3b"


def clean_snippet(body: str, limit: int = 220) -> str:
    text = re.sub(r"!\[\[[^\]]*\]\]", " ", body)
    text = re.sub(r"^>.*$", " ", text, flags=re.M)
    text = re.sub(r"https?://\S+", " ", text)
    text = re.sub(r"^##?#?[^{]*.*$", " ", text, flags=re.M)  # 去标题行与 callout 头
    return re.sub(r"\s+", " ", text)[:limit]


def pick_folder(url: str, model: str, folders: list[str], title: str, snippet: str) -> str:
    prompt = ("以下是一个抖音视频的信息。从收藏夹列表中选择最合适的一个，只输出收藏夹名称本身，不要输出其他文字。\n"
              f"收藏夹列表：\n{'、'.join(folders)}\n\n标题：{title}\n内容摘要：{snippet}")
    payload = {"model": model, "max_tokens": 30, "temperature": 0,
               "messages": [{"role": "user", "content": prompt}]}
    req = urllib.request.Request(url.rstrip("/") + "/chat/completions",
                                 data=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=90) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    reply = str(data.get("choices", [{}])[0].get("message", {}).get("content", "")).strip()
    if reply in folders:
        return reply
    best, hit = None, -1
    for f in folders:
        if f and f in reply and len(f) > hit:
            best, hit = f, len(f)
    return best or "未分类"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--vault", default=DEFAULT_VAULT)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    vault = Path(args.vault)
    tools = Path(__file__).parent
    cmap = json.loads((tools / "collect-map.json").read_text(encoding="utf-8"))
    cmap.pop("_meta", None)
    folders = sorted({e["folder"] for e in cmap.values()})

    inbox = vault / "00-原始笔记" / "抖音归档" / "收藏"
    notes = [p for p in sorted(inbox.rglob("*.md")) if p.name != "00-说明.md" and "同步日志" not in p.name]
    if args.limit:
        notes = notes[: args.limit]

    results = []
    for i, p in enumerate(notes, 1):
        text = p.read_text(encoding="utf-8")
        m = re.search(r"^douyin_id: \"?(\d+)", text, re.M)
        mt = re.search(r'^title: "?([^"\n]*)', text, re.M)
        aid = m.group(1) if m else ""
        title = (mt.group(1) if mt else p.stem)
        cur = p.parent.name
        ent = cmap.get(aid)
        douyin_folder = ent["folder"] if ent else "未分类"
        try:
            ai = pick_folder(URL, MODEL, folders, title, clean_snippet(text.split("---", 2)[-1]))
        except Exception as e:
            ai = "未分类"
            print(f"[{i}/{len(notes)}] FAIL {p.name[:30]}: {str(e)[:60]}", flush=True)
        results.append({"file": str(p), "douyin_id": aid, "title": title[:60],
                        "current_dir": cur, "douyin_folder": douyin_folder, "ai_folder": ai})
        if i % 25 == 0 or i == len(notes):
            agree = sum(1 for r in results if r["ai_folder"] == (r["douyin_folder"] if r["douyin_folder"] != "未分类" else r["ai_folder"]))
            print(f"[{i}/{len(notes)}] processed={len(results)}", flush=True)

    plan = []
    corrections = []
    for r in results:
        if r["douyin_folder"] != "未分类":
            target = r["douyin_folder"]
            kind = "维持"
            if r["ai_folder"] not in ("未分类",) and r["ai_folder"] != target:
                kind = "AI建议修正"
                corrections.append({**r, "target": r["ai_folder"]})
        else:
            target = r["ai_folder"]
            kind = "AI分派" if target != "未分类" else "保持未分类"
        r["target"], r["kind"] = target, kind
        plan.append(r)

    summary = {}
    for r in plan:
        summary[r["target"]] = summary.get(r["target"], 0) + 1
    out_json = tools / "reclass-plan-full.json"
    out_json.write_text(json.dumps({"folders": folders, "summary": summary,
                                    "corrections": corrections, "plan": plan}, ensure_ascii=False, indent=1),
                        encoding="utf-8")
    print(json.dumps({"ok": True, "notes": len(plan), "summary": summary,
                      "ai_suggested_corrections": len(corrections), "out": str(out_json)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
