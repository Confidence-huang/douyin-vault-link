# Changelog

## 2.0.0 - 2026-09-14

- **吸收 douyin-sync 同步引擎**：原生实现收藏夹同步循环（collects/list + collects/video/list 按夹枚举，listcollection 扁平回退），翻页限速与「连续已同步提前停止」阈值与原引擎逐字对齐。
- **移除云端依赖**：删除四种云端 ASR 路径与云端 AI 分类/视觉；AI 分类（qwen2.5:3b）与图文 OCR（qwen2.5vl:3b）全部走本机 Ollama。
- **移除 douyin-sync 依赖**：设置改读本插件 data.json；首次启动从 douyin-sync data.json 一次性迁移 cookie/桥接配置/分类列表与 1470 条同步状态（processed 映射），此后独立运行。
- 桥接脚本（douyin-bridge.js + bridge-common.js）随插件分发，自动拉起不再依赖 douyin-sync 目录。
- 收藏同步产出笔记 schema 与 douyin-sync 兼容（folder/category/douyin_id…），并新增 vault_status/promoted_to 契约字段；同步完成后自动生成 4 个 Bases 画廊（已存在则跳过）。
- 同步命令更名为「同步抖音收藏（本地桥接）」；新增自动同步间隔设置（0=手动）。

## 1.3.3 - 2026-09-13

- 新增「同步后自动深度归档新增」开关（默认关）：同步/粘贴归档产生的新视频笔记自动跑深度归档引擎。
- 抽出 `runEngineOnce` 供手动命令、同步自动、粘贴自动三路复用。

## 1.3.2 - 2026-09-13

- 深度归档自动透传视觉图注参数（读取 douyin-sync 的 AI 配置：enableVision/aiBaseUrl/visionModel）。

## 1.3.1 - 2026-09-13

- 新增「粘贴链接归档」命令：弹窗粘贴，单条/多条，无需先建笔记；短链自动解析；单条完成自动打开新笔记。

## 1.3.0 - 2026-09-13

- 架构重构：深度归档改为单一引擎——本插件瘦身为 bilibili-video-learning 技能 `douyin_deep_archive.py` 的薄客户端，转写/抽帧/图注管线全部由引擎承担，插件与命令行共享同一实现。

## 1.2.0 - 2026-09-12

- 深度归档转写切换为本地 faster-whisper（GPU，调技能 CLI），无需云端 Key。

## 1.1.0 - 2026-09-12

- 新增深度归档命令：桥接取视频 → 场景打分自适应抽帧 → 转写对齐 → 图文对照节（幂等写回）。

## 1.0.0 - 2026-09-12

- 初始发布：同步委托、单链接归档、晋升为来源（04-来源 + 主题地图）、收件箱面板。
