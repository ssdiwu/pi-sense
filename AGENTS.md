# pi-sense — Agent 规范

## 项目一句话定位

Pi 扩展：当 active model（当前模型）不支持图片输入时，用一个用户指定的模型描述媒体，把文字描述喂给纯文本模型。图像直接描述；本地视频也复用同一 non-vision handoff 目标判定，并按双路径分流：普通内容理解优先走原生视频模型，涉及时间点、顺序、拖动方向等时序问题走抽帧 + 本地 ASR + 帧描述路线。

## 先读文档顺序
1. 本文件
2. `README.md`
3. `doc/README.md`
4. `doc/术语表.md`
5. `doc/20-能力参考/01-视频理解扩展调研参考.md`

## 技术栈
- TypeScript Pi extension
- 无运行时依赖（peerDependency: @earendil-works/pi-coding-agent、@earendil-works/pi-ai）
- 视频处理调用外部 CLI：`ffmpeg`（抽帧/抽音频）、`whisper-cli`（ASR 优先）、`~/.venvs/video-asr/bin/python` 的 faster-whisper（ASR fallback）
- 不引入 npm native addon，不自带模型；pi-sense 只编排。

## 验证方式
- `/sense model minimax-cn/MiniMax-M3` 配置 vision model
- 在不支持图片的 active model 下，让 agent `read` 一张图片，检查 agent 收到的是文字描述而非 image block
- 原生视频验证：复用 pi 的 `auth.json` / `models.json`，验证 `minimax-cn/MiniMax-M3` 的 Files API 上传、`mm_file://` 引用和 `/anthropic` 内容理解输出
- 时间感知验证：用本地测试视频跑 `ffprobe`/`ffmpeg` 抽帧、抽音频、本地 ASR，并检查 `[Video: ...]` 输出里的时间-内容对应是否可信

## 文档沉淀出口
- `README.md`：用户安装、配置、验证
- `doc/README.md`：设计边界、已知限制、为什么不做某些功能
- `doc/术语表.md`：项目术语
- `doc/决策档案/`：难逆转 + 无上下文会困惑 + 有真实权衡 的决策
- `doc/20-能力参考/`：外部参考调研

## 工程纪律
- 保持最小实现，不为跨 provider 兼容提前做复杂抽象
- 改行为时先验证 vision 调用链路（`completeSimple` → 描述 → 注入），再改扩展代码
- 配置走平铺 `~/.pi/agent/pi-sense.json`，不进 `~/.pi/agent/extensions/`（那是扩展代码自动发现目录）
- 不做批量合并：每图/每帧独立调用，简单缓存，除非有证据证明 N > 3 是常见场景
- 视频只支持本地文件路径；YouTube URL 与实时/屏幕录制不在第一版范围
- 不把原生视频模型结果当时间 ground truth；原生路线只负责 `what`，`when` 必须走抽帧+ASR
- 抽帧上限固定 120 帧；≤1min 0.5s/帧，>1min 按 duration/120 均匀覆盖
- ASR 本地优先、无需 API key；`whisper-cli` 优先，faster-whisper venv fallback
