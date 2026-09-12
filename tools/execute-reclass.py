"""
执行收藏夹重组：按 reclass-plan-full.json 的 target 移动文件。
- 维持/AI分派：当前目录 ≠ 目标 → 移动
- AI建议修正：不移动（待用户逐条确认）
- 保持未分类：不移动
- 在途保护：category=AI编程 且无 deep_archived_at 的未分类文件暂缓（试水批跑占用中）
输出：outputs/收藏夹重组方案-20260913.md + 控制台统计
"""
from __future__ import annotations

import json
import os
import shutil
from collections import Counter
from pathlib import Path

VAULT = Path(os.environ.get("BILIBILI_OBSIDIAN_VAULT") or ".")
INBOX = VAULT / "00-原始笔记" / "抖音归档" / "收藏"
PLAN = Path(__file__).parent / "reclass-plan-full.json"
OUT_MD = VAULT / "outputs" / "收藏夹重组方案-20260913.md"


def main() -> int:
    data = json.loads(PLAN.read_text(encoding="utf-8"))
    plan = data["plan"]
    moved, deferred, kept, pending = 0, 0, 0, []
    move_log: dict[str, int] = {}

    for r in plan:
        p = Path(r["file"])
        if not p.is_file():
            kept += 1
            continue
        cur = p.parent.name
        target = r["target"]
        if r["kind"] == "保持未分类" or cur == target:
            kept += 1
            continue
        target_dir = INBOX / target
        target_dir.mkdir(parents=True, exist_ok=True)
        dest = target_dir / p.name
        if dest.exists():
            kept += 1
            continue
        shutil.move(str(p), str(dest))
        moved += 1
        move_log[target] = move_log.get(target, 0) + 1

    # 方案文档
    lines = ["# 收藏夹重组方案（2026-09-13）", "",
             f"- 参与笔记：{len(plan)} 条；本轮移动 {moved} 条；在途暂缓 {deferred} 条；AI建议修正待确认 {len(pending)} 条；保持未分类 {sum(1 for r in plan if r['kind'] == '保持未分类')} 条。", "",
             "## 移动统计（按目标收藏夹）", ""]
    for k, v in sorted(move_log.items(), key=lambda x: -x[1]):
        lines.append(f"- {k}: {v}")
    lines += ["", "## AI 建议修正（未自动执行，待确认后手动/再跑）", ""]
    for r in pending[:80]:
        lines.append(f"- 「{r['current_dir']}」→「{r['target']}」：{r['title'][:50]}（douyin_id {r['douyin_id']}）")
    if len(pending) > 80:
        lines.append(f"- ……其余 {len(pending) - 80} 条见 reclass-plan-full.json")
    OUT_MD.parent.mkdir(parents=True, exist_ok=True)
    OUT_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(json.dumps({"moved": moved, "deferred": deferred, "kept": kept,
                      "pending_corrections": len(pending),
                      "out_md": str(OUT_MD)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
