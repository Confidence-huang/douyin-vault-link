# douyin-vault-link（抖音 × 笔记库桥接）

Obsidian 伴生插件：把 [douyin-sync](https://github.com/) 同步下来的抖音收藏接入「Learning Vault」式知识库工作流——同步委托、单链接归档、**深度归档**（逐帧 × 本地 GPU 转写对照）、晋升为来源笔记并挂主题地图。

深度归档采用**单一引擎**架构：本插件只做薄客户端，核心管线由 [bilibili-video-learning](https://github.com/Confidence-huang/bilibili-douyin-video-learning) 技能的 `douyin_deep_archive.py` 提供（登录态桥接取视频 → 场景打分自适应抽帧 → 本地 faster-whisper 转写 → 时间对齐 → 幂等写回笔记）。一份实现，两个入口（Obsidian 命令 / 命令行），永不漂移。

```text
Obsidian 命令（薄客户端）──┐
                           ├──> douyin_deep_archive.py（唯一引擎，本地 GPU）──> 收件箱笔记契约
命令行 --id/--url ─────────┘            （桥接取视频→抽帧→转写→图文对照）      douyin_id 定位 · 幂等整节替换
```

## 功能

- **同步委托**：一键调用 douyin-sync 的同步命令；
- **粘贴链接归档**：弹窗粘贴链接（单条/多条，网页链与 `v.douyin.com` 分享短链都认），无需先建笔记，已归档的自动跳过；
- **归档当前笔记中的链接**：扫描当前笔记里的全部抖音链接批量归档；
- **深度归档**：打开收件箱笔记执行 → 引擎产出「~24 帧关键帧 × 逐字稿」的图文对照节 + 本地视觉模型逐帧图注（自适应峰值选帧，本地 GPU 转写，无需任何云端 Key，RTX 5070 实测 ≈9× 实时）；幂等：重跑整节替换不堆叠；
- **新笔记自动深度归档**（开关，默认关）：同步/粘贴归档产生的新视频笔记自动跑引擎，全链路零操作；
- **晋升为来源**：收件箱笔记 → `04-来源`（带确认弹窗）并挂 `03-主题地图`；
- **收件箱面板**：ribbon 一键打开。

## 前置依赖

| 依赖 | 用途 |
| --- | --- |
| [douyin-sync](https://github.com/) 插件 + 本地桥接（`douyin-bridge.js`） | 抖音登录态 API 与视频下载通道 |
| [bilibili-video-learning](https://github.com/Confidence-huang/bilibili-douyin-video-learning) ≥ 1.3.6（含 `.venv-gpu`） | 深度归档引擎（本地 faster-whisper） |
| ffmpeg（PATH 或设置指定） | 场景检测与抽帧 |
| 可选：Ollama + 视觉模型 | 帧图注（引擎当前留「待补视觉说明」占位，接入在路线图） |

## 安装

拷贝 `main.js`、`manifest.json` 到 `<vault>/.obsidian/plugins/douyin-vault-link/`，在第三方插件中启用。桌面端专用（`isDesktopOnly`）。

## 设置

| 设置 | 说明 |
| --- | --- |
| 收件箱 / 媒体 / 来源 / 主题地图目录 | 与你的库结构对齐；默认 `00-原始笔记/抖音归档`、`附件/douyin-media` |
| 同步日志 | 每次归档/晋升追加一行过程记录 |
| 领域标签注册表 | `domain/<slug>` 白名单（禁 `domain/other`） |
| 深度归档参数 | 最多关键帧数、场景分数下限、相对峰值系数、最小帧间隔（一般不动） |
| 本地转写 Python / 模型 | 引擎所用解释器与 faster-whisper 模型（留空用技能默认 `.venv-gpu`） |
| ffmpeg 路径 / 视频工作目录 | 透传给引擎 |

## 命令行入口（与 Obsidian 命令同一引擎）

```bash
python scripts/douyin_deep_archive.py --id <视频ID> --vault <库根> \
  --bridge <桥接端点> --model small
```

## 对 douyin-sync 的两份小补丁（可选）

`docs/patches/` 收录两份最小 diff，按需 `git apply`：

- `douyin-bridge-ctx-request.patch`：桥接 `/download` 优先走 playwright `ctx.request`（共享登录 Cookie 的浏览器级网络栈）并带 Referer，绕过 CDN 对直链的拦截；
- `douyin-sync-local-whisper-option.patch`：douyin-sync 设置的 ASR 服务商下拉增加「本地 faster-whisper（GPU·深度归档）」选项，同步流程对该选项跳过云端转写。

douyin-sync 升级会覆盖被补丁文件，重放即可。原始完整文件不入库（版权与体积考虑）。

## 致谢与设计来源

- [BiliNote](https://github.com/JefferyHcool/BiliNote)：管道化视频笔记的设计参考（策略抽象、字幕优先、缓存与状态机）；
- [Learning-Vault-Skills](https://github.com/Serral828/Learning-Vault-Skills)：知识库工作流与授权边界（收件箱隔离、晋升需确认）；
- douyin-sync：登录态桥接基建。

## 管理 CLI 工具集（tools/）

随仓库附带的 Python 工具（依赖同款 `.venv-gpu` 环境与本机桥接，环境变量见各文件头）：

| 工具 | 用途 |
| --- | --- |
| `tools/classify-inbox.py` | 存量笔记批量 AI 分类（只改 YAML category，幂等可重跑） |
| `tools/batch-deep-archive.py` | 存量笔记批量深度归档（断点续跑，跳过已处理） |
| `tools/build-collect-map.py` | 拉取全部收藏夹构建 视频ID→收藏夹 真值映射 |
| `tools/assign-folders.py` | AI 评估每条笔记的目标收藏夹，产出重组方案 |
| `tools/execute-reclass.py` | 按方案执行文件移动（含在途保护与修正清单） |

## License

Apache-2.0
