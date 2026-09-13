"""
GPU 归档流水线接力器：等抖音全量批跑完成 → 确保抖音桥接在线 → 补跑抖音失败项 → 自动启动 B站全量深度归档。
由 PowerShell Start-Process 分离启动，独立于任何会话；所有步骤断点续跑，可安全重启接力器。
日志：D:\\NOTE\\outputs\\chain-runner.log（本器）+ 各批处理自己的日志。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

TOOLS = Path(__file__).parent
VAULT = r"D:\NOTE"
OUT = Path(VAULT) / "outputs"
DOUYIN_LOG = OUT / "batch-deep-archive-20260914.log"
DOUYIN_RETRY_LOG = OUT / "batch-deep-archive-retry-20260914.log"
BILI_LOG = OUT / "bili-batch-deep-archive-20260914.log"
CHAIN_LOG = OUT / "chain-runner.log"

ENGINE_PY = Path(os.path.expanduser(
    "~/.agents/skills/bilibili-video-learning/.venv-gpu/Scripts/python.exe"))
PLUGIN_DIR = Path(VAULT) / ".obsidian" / "plugins" / "douyin-vault-link"

DOUYIN_PID = int(os.environ.get("DOUYIN_BATCH_PID") or 25752)  # 首轮抖音批处理进程
STALL_SECONDS = 3 * 3600  # 日志 3 小时无更新视为挂死


def bridge_cfg() -> tuple[str, str]:
    """桥接 node 与 node_modules：读 douyin-vault-link 设置（单一真源），避免机器路径硬编码。"""
    try:
        d = json.loads((PLUGIN_DIR / "data.json").read_text(encoding="utf-8"))
        s = d.get("settings") or {}
        return (s.get("bridgeNodePath") or "node"), (s.get("bridgeNodeModules") or "")
    except Exception:
        return "node", ""


def log(msg: str) -> None:
    line = f"[{datetime.now().strftime('%m-%d %H:%M:%S')}] {msg}"
    print(line, flush=True)
    try:
        with open(CHAIN_LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def pid_alive(pid: int) -> bool:
    try:
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                             capture_output=True, text=True, timeout=15).stdout
        return "python.exe" in out
    except Exception:
        return False


def log_done(log_path: Path) -> bool:
    """批处理日志末行是否为完成 JSON（{"ok": true, ...}）。"""
    try:
        lines = [l for l in log_path.read_text(encoding="utf-8", errors="replace").splitlines() if l.strip()]
        return bool(lines) and lines[-1].startswith('{"ok"')
    except OSError:
        return False


def wait_douyin_batch() -> None:
    log(f"等待抖音批处理 PID {DOUYIN_PID} 完成…")
    while True:
        if log_done(DOUYIN_LOG):
            log("抖音批处理日志出现完成标记")
            return
        if not pid_alive(DOUYIN_PID):
            # 进程没了但日志未完成：可能是中断/重启；观察两轮（20 分钟）确认不再推进
            for _ in range(2):
                time.sleep(600)
                if pid_alive(DOUYIN_PID):
                    break
            else:
                log("抖音批处理进程已退出且日志无完成标记（中断/重启）——转入补跑（断点续跑）")
                return
        # 挂死保护：日志长时间无更新则结束进程
        try:
            mtime = DOUYIN_LOG.stat().st_mtime
            if time.time() - mtime > STALL_SECONDS:
                log(f"日志 {STALL_SECONDS//3600} 小时无更新，判定挂死，taskkill 后转入补跑")
                subprocess.run(["taskkill", "/PID", str(DOUYIN_PID), "/F"], capture_output=True)
                return
        except OSError:
            pass
        time.sleep(600)


def ensure_bridge() -> bool:
    import urllib.request
    try:
        urllib.request.urlopen("http://127.0.0.1:8765/ping", timeout=3)
        log("抖音桥接 8765 在线")
        return True
    except Exception:
        pass
    log("抖音桥接不在线，尝试拉起…")
    node, node_modules = bridge_cfg()
    env = {**os.environ}
    if node_modules:
        env["NODE_PATH"] = node_modules
    subprocess.Popen([node, str(PLUGIN_DIR / "douyin-bridge.js"), "8765"],
                     env=env, cwd=str(PLUGIN_DIR),
                     creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    import urllib.request
    for _ in range(30):
        time.sleep(2)
        try:
            urllib.request.urlopen("http://127.0.0.1:8765/ping", timeout=3)
            log("抖音桥接已拉起")
            return True
        except Exception:
            continue
    log("桥接拉起失败——补跑将全数失败，请人工检查后重跑补跑命令")
    return False


def run_step(name: str, script: Path, log_path: Path) -> None:
    log(f"启动 {name}：{script.name}（日志 {log_path.name}）")
    with open(log_path, "w", encoding="utf-8") as out, open(str(log_path) + ".err", "w", encoding="utf-8") as err:
        proc = subprocess.run(
            [str(ENGINE_PY), str(script), "--vault", VAULT],
            stdout=out, stderr=err, cwd=str(TOOLS))
    log(f"{name} 退出码 {proc.returncode}")


def main() -> int:
    log("=== 接力器启动 ===")
    wait_douyin_batch()

    log("--- 阶段 2：抖音失败项补跑 ---")
    if ensure_bridge():
        run_step("抖音补跑", TOOLS / "batch-deep-archive.py", DOUYIN_RETRY_LOG)
    else:
        log("跳过抖音补跑（桥接不可用）")

    log("--- 阶段 3：B站全量深度归档（600 条，无需桥接） ---")
    run_step("B站批跑", Path(TOOLS.parent.parent, "bilibili-vault-link", "tools", "bili-batch-deep-archive.py"), BILI_LOG)

    log("=== 接力器全部完成 ===")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
