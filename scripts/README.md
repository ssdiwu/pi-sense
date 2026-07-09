# 验证脚本

这些脚本用于从**源码 checkout（检出副本）**复核 pi-sense 的关键行为。先执行 `npm install`，脚本会自行编译临时 `.verify-build/`，无需保留构建产物。

| 脚本 | 验证内容 | 前置条件 |
|---|---|---|
| `verify-paths.mjs` | 本地视频路径识别与时间意图分流 | `npm install` |
| `verify-native-chain.mjs` | MiniMax-M3 Files API 原生视频路线 | 有效的 `~/.pi/agent/auth.json`、`models.json` 与本地测试视频 |
| `verify-frames-chain.mjs` | ffmpeg 抽帧、真实帧时间戳与本地 ASR | `ffmpeg`/`ffprobe`、本地 ASR、带音频的测试视频 |

```bash
node scripts/verify-paths.mjs
node scripts/verify-native-chain.mjs /path/to/video.mp4
node scripts/verify-frames-chain.mjs /path/to/video.mp4
```

`prepare-verify-build.mjs` 是三个脚本共用的内部构建辅助文件，不需要单独运行。
