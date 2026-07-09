# pi-sense

A `pi` extension that gives text-only models media understanding: when the active model doesn't support image input, `pi-sense` describes images directly and expands local video paths into text via the same non-vision handoff target.

> **Status**: Image handoff is shipped and working. Video handoff is wired as a dual path and validated on real chains: native video understanding for content questions (`what`), and frame extraction + local ASR for temporal questions (`when`). The design basis is documented in `doc/决策档案/0001-视频理解双路线-原生内容理解与抽帧时间感知分流.md` and `doc/20-能力参考/01-视频理解扩展调研参考.md`.

## What it does (current)

When the active model lacks image input, `pi-sense` intercepts media in two places:

1. **`tool_result` (read)** — Primary injection: image blocks are described immediately; local video reads are marked with their resolved file path so the next stage can route them correctly.
2. **`context`** — Fallback / routing stage: remaining image blocks are swapped for cached text descriptions, and local video paths are expanded into `[Video: ...]` text using either the native route or the frames+ASR route.

Image descriptions are cached per image hash. Video descriptions are cached per file hash + request hash + route/model parameters, so the same video question is not reprocessed every turn while different questions still get different answers.

## Install

### From local path

```bash
pi install /absolute/path/to/pi-sense
```

Or add to `~/.pi/agent/settings.json` `packages` array.

> **不要把 `index.ts` 拷贝到 `~/.pi/agent/extensions/` 下作为加载方式。** 通过 `pi install` 或 `settings.json` 的 `packages` 注册加载。

## Configure

### Set the vision model

```bash
/sense model minimax-cn/MiniMax-M3
```

### Check status

```bash
/sense status
```

### Commands

```
/sense                                 Show status
/sense status                          Same as /sense
/sense model <provider/id>             Set the vision model
/sense video <on|off>                  Toggle video handoff
/sense video-model <provider/id>       Set the video model (blank to reuse vision model)
/sense route <auto|native|frames>      Set video route selection
/sense fps <0.2-5>                     Set native-video sampling fps (current native adapter: MiniMax)
/sense thinking <on|off>               Toggle native-video thinking (current native adapter: MiniMax)
/sense asr <auto|path>                 Set the ASR tool (`whisper-cli` binary path or faster-whisper `venv`/`python` path)
/sense frames <n>                      Set the max frame count (default 120)
/sense adaptive <on|off>               Toggle adaptive local re-sampling (reserved, default off)
/sense enable                          Enable handoff
/sense disable                         Disable handoff
/sense auto <on|off>                   Toggle auto handoff for non-vision models
/sense clear                           Clear the configured vision model
/sense help                            Show usage
(legacy: /dvision ... still works as an alias)
```

## Config file

Config lives at `~/.pi/agent/pi-sense.json`:

```json
{
  "enabled": true,
  "visionModel": "minimax-cn/MiniMax-M3",
  "autoHandoff": true,
  "videoEnabled": true,
  "videoModel": null,
  "asrProvider": "auto",
  "maxVideoFrames": 120,
  "enableAdaptiveSampling": false,
  "videoRoute": "auto",
  "videoFps": 1,
  "videoThinking": false
}
```

> `videoModel` of `null` means the video pipeline reuses `visionModel`. `videoRoute=auto` chooses native for content questions and frames+ASR for temporal questions. Current native adapter coverage is MiniMax only; other providers still fall back to frames+ASR. MiniMax native upload uses the Files API with a 512MB limit, and preserves the source container MIME (`mp4/mov/webm/mkv/...`) when uploading.

## How it works

```
agent reads image file / mentions local video path
  │
  ▼
tool_result (read)  ── image block → vision model → text description
  │                    local video read → path marker for the routing stage
  ▼
context             ── remaining images → cached text description
  │                    local video path → native route (what) OR frames+ASR route (when)
  ▼
text-only model receives text, not image/video
```

## Development

```bash
npm run typecheck
```

## Changelog

See `CHANGELOG.md`.

## License

MIT
