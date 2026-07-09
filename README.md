# pi-sense

A [pi coding agent](https://github.com/earendil-works/pi-coding-agent) extension that gives text-only models media understanding — images **and** local videos.

When the active model doesn't support image/video input, `pi-sense` automatically describes the media with a vision-capable model you pick, then feeds the text description to the active model. For videos, it uses a **dual-path strategy**:

- **Content questions** ("what happens in this video?") → native video model (MiniMax-M3)
- **Temporal questions** ("what happens at 0:03?") → local frame extraction + ASR

## Quick Start

```bash
# 1. Install
pi install pi-sense

# 2. Configure a vision/video model
/sense model minimax-cn/MiniMax-M3

# 3. Enable video handoff
/sense video on
```

That's it. Now when you ask pi about an image or local video file, it will describe the media and feed the text to the active model — even if that model doesn't support images or videos.

## How It Works

```
agent reads image / mentions video path
  │
  ▼
tool_result ── image → vision model → text description
  │            video → path marker for routing
  ▼
context     ── remaining images → cached text
  │            video path → native (what) or frames+ASR (when)
  ▼
text-only model receives text, not raw media
```

## Commands

```
/sense                                 Show status
/sense status                          Same as /sense
/sense model <provider/id>             Set the vision/video model
/sense video <on|off>                  Toggle video handoff
/sense video-model <provider/id>       Set a separate video model (blank = reuse vision model)
/sense route <auto|native|frames>      Set video route selection
/sense fps <0.2-5>                     Set native-video sampling fps
/sense thinking <on|off>               Toggle native-video thinking mode
/sense asr <auto|path>                 Set ASR tool (auto, or path to whisper-cli / venv python)
/sense frames <n>                      Set max frame count (1–600; default 120)
/sense adaptive <on|off>               Set the reserved adaptive-sampling preference
/sense enable                          Enable handoff
/sense disable                         Disable handoff
/sense auto <on|off>                   Toggle auto handoff for non-vision models
/sense clear                           Clear the configured model
/sense help                            Show usage
```

Legacy alias: `/dvision` still works and delegates to `/sense`.

## Configuration

Config lives at `~/.pi/agent/pi-sense.json`:

```json
{
  "enabled": true,
  "visionModel": "minimax-cn/MiniMax-M3",
  "autoHandoff": true,
  "videoEnabled": true,
  "videoModel": null,
  "videoRoute": "auto",
  "videoFps": 1,
  "videoThinking": false,
  "asrProvider": "auto",
  "maxVideoFrames": 120,
  "enableAdaptiveSampling": false
}
```

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Master switch for media handoff |
| `visionModel` | `null` | Model used to describe images and video frames |
| `autoHandoff` | `true` | Only inject into active models that lack image input |
| `videoEnabled` | `true` | Enable local-video handoff |
| `videoModel` | `null` | Separate model for video; `null` = reuse `visionModel` |
| `videoRoute` | `auto` | `auto` = detect temporal intent, `native` = force native, `frames` = force frames+ASR |
| `videoFps` | `1` | Sampling fps for native video route (0.2–5) |
| `videoThinking` | `false` | Enable MiniMax adaptive thinking for native route |
| `asrProvider` | `auto` | `auto` = whisper-cli → faster-whisper, or explicit path |
| `maxVideoFrames` | `120` | Frame-route budget (1–600) |
| `enableAdaptiveSampling` | `false` | Reserved preference; not consumed by the 0.0.1 pipeline |

## Video Understanding

### Native Route (Content / "what")

When you ask "describe this video" or "what is this video about", pi-sense uploads the video to MiniMax's Files API and asks the model directly:

- **Supported provider**: MiniMax-M3 (via `minimax-cn/MiniMax-M3`)
- Gemini and Grok retain provider adapter seams; in 0.0.1 they use the frames route
- Upload limit: 512 MB
- Supported containers: mp4, mov, webm, mkv, avi, flv, wmv, m4v, mpg, mpeg, 3gp, ogv, mts, m2ts

### Frames + ASR Route (Temporal / "when")

When you ask "what happens at 0:03?" or "what's the timeline?", pi-sense does it locally:

1. **Frame extraction** — ffmpeg samples frames (≤1 min: 0.5s interval; >1 min: evenly within the configured budget, 120 by default and 600 maximum)
2. **Audio extraction** — ffmpeg extracts 16 kHz mono WAV
3. **ASR** — whisper-cli (preferred) or faster-whisper (fallback) transcribes with timestamps
4. **Frame description** — each frame is described by the configured vision model
5. **Timeline merge** — frame descriptions + ASR segments are combined into a temporal timeline

This route provides **deterministic, verifiable** time-content mapping — unlike native video models whose timestamps drift from real duration.

### Auto Routing

`videoRoute: auto` (default) detects temporal intent from the user's question:

- **Triggers frames route**: "第3秒", "1:30", "timeline", "at what time", "timestamp", "先后顺序"
- **Triggers native route**: "描述视频", "describe this video", "what is this about"

## External Dependencies

| Tool | Required for | How to install |
|---|---|---|
| `ffmpeg` / `ffprobe` | Frame + audio extraction | `brew install ffmpeg` |
| `whisper-cli` | ASR (preferred) | `brew install whisper-cpp` + download a ggml model |
| faster-whisper | ASR (fallback) | `pip install faster-whisper` in a venv at `~/.venvs/video-asr` |

You only need ffmpeg for the frames route. The native route works without any local tools.

## Install

### From npm

```bash
pi install pi-sense
```

### From source

```bash
git clone https://github.com/ssdiwu/pi-sense.git
pi install /path/to/pi-sense
```

## Development

```bash
git clone https://github.com/ssdiwu/pi-sense.git
cd pi-sense
npm install
npm run typecheck
```

### Verification Scripts

```bash
# Unit checks for path detection + temporal intent (no API key needed)
node scripts/verify-paths.mjs

# Native route real-chain (needs minimax-cn API key in ~/.pi/agent/auth.json)
node scripts/verify-native-chain.mjs

# Frames + ASR real-chain (needs ffmpeg + whisper)
node scripts/verify-frames-chain.mjs
```

## Limitations

- Video input is **local files only** — no YouTube URLs or screen capture
- Native video is available through **MiniMax-M3**; Gemini and Grok use the frames + ASR route in 0.0.1
- Native model timestamps are **not reliable** — use the frames route for temporal accuracy
- Adaptive sampling is a **reserved setting**; the 0.0.1 local pipeline does not consume it

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
