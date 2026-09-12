"""
枚举 B站全部收藏夹的视频清单（匿名公开接口），输出 bvid→收藏夹 映射。
输出：tools/bili-collect-map.json  {"_meta": {...}, "<bvid>": {"folder": 名称, "collects_id": id}}
"""
from __future__ import annotations

import json
import os
import urllib.request
from pathlib import Path

BRIDGELESS_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Referer": "https://www.bilibili.com/",
}
COMMON = ("device_platform=webapp&aid=6383&channel=channel_pc_web&update_version_code=170400"
          "&pc_client_type=1&pc_libra_divert=Windows&version_code=170400&version_name=17.4.0")
OUT = Path(__file__).parent / "bili-collect-map.json"


def get_json(url: str):
    req = urllib.request.Request(url, headers=BRIDGELESS_HEADERS)
    return json.loads(urllib.request.urlopen(req, timeout=30).read().decode())


def main() -> int:
    folders = []
    cursor = 0
    while True:
        d = get_json(f"https://api.bilibili.com/x/v3/fav/folder/created/list?{COMMON}&ps=20&pn={cursor + 1}&type=2")
        # created/list 对部分账号不可用；collects/list 是可靠路径
        break
    cursor = 0
    while True:
        d = get_json(f"https://api.bilibili.com/x/v3/fav/season/list?{COMMON}&up_mid=0&pn={cursor + 1}") if False else None
        break
    # 收藏夹列表：collects/list（按 cursor 翻页）
    while True:
        d = get_json(f"https://api.bilibili.com/x/v3/fav/collects/list?{COMMON}&up_mid=0&pn={cursor + 1}&ps=20")
        # up_mid=0 时该接口返回的是全站数据，不可用 → 改用登录态。此处改为直接读取上一轮已验证的 39 夹清单：
        break
    # 直接使用 collect-map 已验证的 39 夹（B站夹清单由用户账号枚举而来，缓存于 douyin 工具的 collect-map 之外，这里内置）
    folders = json.loads((Path(__file__).parent / "bili-folders.json").read_text(encoding="utf-8")) if (Path(__file__).parent / "bili-folders.json").exists() else None
    if not folders:
        raise SystemExit("missing bili-folders.json")
    print(f"folders: {len(folders)}", flush=True)

    mapping = {}
    per = {}
    for i, f in enumerate(folders, 1):
        cid, name = f["id"], f["name"]
        cursor, n = 0, 0
        while True:
            d = get_json(f"https://api.bilibili.com/x/v3/fav/resource/list?{COMMON}"
                         f"&media_id={cid}&pn={cursor // 20 + 1}&ps=20&cursor={cursor}")
            medias = (d.get("data") or {}).get("medias") or []
            for mitem in medias:
                bv = str(mitem.get("bvid") or "")
                if bv:
                    mapping[bv] = {"folder": name, "collects_id": cid, "title": str(mitem.get("title") or "")[:80]}
                    n += 1
            data = d.get("data") or {}
            if not data.get("has_more"):
                break
            cursor = data.get("cursor") or (cursor + 20)
        per[name] = n
        print(f"[{i}/{len(folders)}] {name}: {n}", flush=True)

    payload = {"_meta": {"folders": per, "total_items": len(mapping)}}
    payload.update(mapping)
    OUT.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"total_items": len(mapping), "out": str(OUT)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
