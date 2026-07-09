# pi-sense 文档入口

## 当前范围

`pi-sense` 当前已交付：

1. **图像 handoff**：当 active model（当前模型）不支持图片输入时，自动用一个用户指定的 vision model（视觉模型）描述图片，把文字描述喂给纯文本模型。

`pi-sense` 当前视频设计为双路径，并已完成真实链路验收：

2. **本地视频 handoff**：当出现本地视频文件路径时，按问题类型分流：普通内容理解优先走原生视频模型；涉及时间点、顺序、拖动方向等时序问题走 ffmpeg 抽帧 + 本地 ASR + 帧描述路线。第一版只支持本地视频文件路径（read 工具读取、用户粘贴、用户手打统一处理）。设计依据见 `doc/决策档案/0001-视频理解双路线-原生内容理解与抽帧时间感知分流.md`。

## 当前设计

### 共通
- 注入管线：`tool_result`（主）+ `context`（兜底），两段，图像和视频共用。
- 缓存：图像按 image hash 缓存；视频按 file hash + request hash + 路由参数缓存，同一媒体的同一问题不重复描述，不同问题不会串答案。
- 配置：`~/.pi/agent/pi-sense.json`（平铺，与 pi-autoname / pi-tinyfish 一致）。

### 图像
- vision 调用：每张图片独立 1 次 `completeSimple()` 调用，并行执行。

### 视频
- 原生路线（what）：复用 pi 的 `ModelRegistry` 解析出的真实模型配置；当前只有 MiniMax 原生 adapter 真正接通，走 `Files API` 上传 + `mm_file://` + `/anthropic` `type:"video"` 块，经 `onPayload` 改写注入。上传前显式检查 512MB Files API 上限，并仅对当前本地支持的容器集合（`mp4/m4v/mov/webm/mkv/avi/flv/wmv/mpg/mpeg/3gp/ogv/mts/m2ts`）映射对应 MIME，避免把超大或容器信息错误的本地视频直接推给 provider。
- 抽帧路线（when）：`ffmpeg` 按 ≤1 分钟 0.5s/帧、>1 分钟按 120 帧上限均匀重算间隔。
- 音频：`ffmpeg` 抽 16kHz mono WAV。
- ASR：`whisper-cli`（whisper.cpp）优先，fallback 到 `~/.venvs/video-asr/bin/python` 的 faster-whisper。
- 帧描述：每帧独立调用 video model（默认复用 vision model），并行执行。
- 合并：按时序合并帧描述与带时间戳转录文本，生成 `[Video: ...]` 块。

## 为什么不做（grill 对齐结果）

- 不做 TUI 交互选择器：vision model 低频且基本固定，命令行 `/sense model` 即可。
- 不做 prewarm 粘贴预热：opt-in 默认关的优化，砍了不影响核心功能。
- 不做 usage/energy 记录：只写不读，零消费方。
- 不做 error-log 文件日志：`ctx.ui.notify` 报错足够。
- 不做 DataLoader 批量合并：实际场景 N ≤ 3，每图/每帧独立调用更简单更健壮。
- 不做 `before_agent_start` 预热段：`tool_result` + `context` 两段已覆盖主路径和兜底。
- 不做 YouTube URL：第一版只支持本地视频文件路径。
- 不做实时/屏幕录制视频捕获。
- 不把原生视频模型结果当时间 ground truth；时间点、顺序、拖动方向等 `when` 问题必须落到抽帧+ASR 路线。
- 不引入 npm native addon 或自带模型；pi-sense 只编排，调用外部已安装 CLI/环境。
- 不在本轮要求 Grok/Gemini 全部完成真实联调；MiniMax 原生链路打通为硬门槛，其它 provider 先保留适配接缝。
- 不做自适应局部补帧的完整实现：第一版预留开关，默认关闭。
