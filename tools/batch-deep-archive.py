"""
批量深度归档：按条件选收件箱视频笔记，逐条调引擎（可断点续跑，跳过已有 deep_archived_at 的）。
调用示例：python batch-deep-archive.py --category "AI编程" --limit 30
          python batch-deep-archive.py                # 全量剩余
          python batch-deep-archive.py --dry-run      # 只列出将处理哪些
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

DEFAULT_VAULT = os.environ.get("BILIBILI_OBSIDIAN_VAULT")
ENGINE_PY = os.environ.get("BVL_ENGINE_PYTHON") or os.path.expanduser(
    "~/.agents/skills/bilibili-video-learning/.venv-gpu/Scripts/python.exe")
ENGINE_SCRIPT = os.environ.get("BVL_ENGINE_SCRIPT") or os.path.expanduser(
    "~/.agents/skills/bilibili-video-learning/scripts/douyin_deep_archive.py")
BRIDGE = os.environ.get("DOUYIN_VIDEO_BRIDGE") or "http://127.0.0.1:8765"
VISION_URL = os.environ.get("DOUYIN_VIDEO_VISION_URL") or "http://127.0.0.1:11434/v1"
VISION_MODEL = "qwen2.5vl:3b"


def frontmatter(text: str) -> dict:
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    fm = {}
    if m:
        for line in m.group(1).split("\n"):
            mm = re.match(r"^([A-Za-z_][\w]*):\s*(.*)$", line)
            if mm:
                fm[mm.group(1)] = mm.group(2).strip().strip('"')
    return fm


def main() -> int:
    ap = argparse.ArgumentParser(description="批量深度归档（逐条调引擎，断点续跑）")
    ap.add_argument("--vault", default=DEFAULT_VAULT)
    ap.add_argument("--category", default=None, help="只处理该分类（对应 YAML category）")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--model", default="small")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    vault = Path(args.vault)
    inbox = vault / "00-原始笔记" / "抖音归档"
    todo = []
    for p in sorted(inbox.rglob("*.md")):
        if p.name == "00-说明.md" or "同步日志" in p.name:
            continue
        text = p.read_text(encoding="utf-8")
        fm = frontmatter(text)
        if not fm.get("douyin_id") or fm.get("type", "视频") != "视频":
            continue
        if "deep_archived_at" in fm:  # 已深度归档过 → 断点续跑的跳过依据
            continue
        if args.category and fm.get("category", "未分类") != args.category:
            continue
        todo.append((p, fm))
    if args.limit:
        todo = todo[: args.limit]

    print(json.dumps({"todo": len(todo), "category": args.category or "(全部)",
                      "sample": [p.name[:40] for p, _ in todo[:5]]}, ensure_ascii=False), flush=True)
    if args.dry_run:
        return 0

    ok = failed = 0
    for i, (p, fm) in enumerate(todo, 1):
        t0 = time.time()
        print(f"[{i}/{len(todo)}] START {fm.get('title', p.stem)[:40]}", flush=True)
        try:
            proc = subprocess.run(
                [sys.executable, ENGINE_SCRIPT, "--id", str(fm["douyin_id"]), "--note", str(p),
                 "--vault", str(vault), "--bridge", BRIDGE, "--ffmpeg", "ffmpeg",
                 "--max-frames", "24", "--model", args.model,
                 "--vision", "--vision-url", VISION_URL, "--vision-model", VISION_MODEL],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800)
            if proc.returncode != 0:
                raise RuntimeError(proc.stderr.strip().split("\n")[-1][:160])
            out = {}
            try:
                out = json.loads(proc.stdout.strip().split("\n").pop())
            except Exception:
                pass
            ok += 1
            print(f"[{i}/{len(todo)}] OK {out.get('frames', '?')}帧/{out.get('segments', '?')}句 "
                  f"{time.time() - t0:.0f}s", flush=True)
        except Exception as e:
            failed += 1
            print(f"[{i}/{len(todo)}] FAIL {p.name[:36]}: {str(e)[:130]}", flush=True)
        time.sleep(2)

    print(json.dumps({"ok": True, "done": ok, "failed": failed}, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
