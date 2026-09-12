"""
构建 抖音视频ID → 收藏夹 映射（真值来源）：遍历全部收藏夹的分页视频清单，缓存为 JSON。
输出：tools/collect-map.json  { "aweme_id": {"folder": "夹名", "collects_id": "id"} , ... , "_meta": {...} }
"""
from __future__ import annotations

import json
import os
import urllib.request
from pathlib import Path

BRIDGE = os.environ.get("DOUYIN_VIDEO_BRIDGE") or "http://127.0.0.1:8765"
COMMON = ("device_platform=webapp&aid=6383&channel=channel_pc_web&update_version_code=170400"
          "&pc_client_type=1&pc_libra_divert=Windows&version_code=170400&version_name=17.4.0")
OUT = Path(__file__).parent / "collect-map.json"


def bridge_req(url: str):
    req = urllib.request.Request(BRIDGE + "/req", data=json.dumps({"url": url, "method": "GET"}).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    return json.loads(urllib.request.urlopen(req, timeout=60).read().decode())


def main() -> int:
    folders = []
    cursor = 0
    while True:
        d = json.loads(bridge_req(f"https://www.douyin.com/aweme/v1/web/collects/list/?{COMMON}&cursor={cursor}&count=20").get("text") or "{}")
        for c in d.get("collects_list") or []:
            folders.append({"id": str(c.get("collects_id_str") or c.get("collects_id")), "name": c.get("collects_name") or ""})
        if not d.get("has_more"):
            break
        cursor = d.get("cursor") or (cursor + 20)
    print(f"folders: {len(folders)}", flush=True)

    mapping: dict[str, dict] = {}
    per_folder: dict[str, int] = {}
    for i, f in enumerate(folders, 1):
        cursor = 0
        n = 0
        while True:
            d = json.loads(bridge_req(f"https://www.douyin.com/aweme/v1/web/collects/video/list/?{COMMON}"
                                      f"&collects_id={f['id']}&cursor={cursor}&count=20").get("text") or "{}")
            for a in d.get("aweme_list") or []:
                aid = str(a.get("aweme_id") or "")
                if aid:
                    mapping[aid] = {"folder": f["name"], "collects_id": f["id"]}
                    n += 1
            if not d.get("has_more"):
                break
            cursor = d.get("cursor") or (cursor + 20)
        per_folder[f["name"]] = n
        print(f"[{i}/{len(folders)}] {f['name']}: {n}", flush=True)

    import datetime as _dt
    payload = {"_meta": {"folders": per_folder, "total_items": len(mapping),
                         "generated": _dt.datetime.now(_dt.timezone.utc).isoformat()}}
    payload.update(mapping)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=0), encoding="utf-8")
    print(json.dumps({"total_items": len(mapping), "out": str(OUT)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
