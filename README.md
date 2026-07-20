# pi-sense

A [pi coding agent](https://github.com/earendil-works/pi-coding-agent) extension that gives text-only models media understanding — images, local audio, and local videos.

For images, when the active model doesn't support image input, `pi-sense` automatically describes the image with a vision-capable model you pick. For local audio, it transcribes speech with local ASR and injects a timestamped transcript. For local videos, video handoff is independent of the active model's image capability: when enabled, `pi-sense` describes the video and feeds the text result to the active model. Video understanding uses a **dual-path strategy**:

- **Audio input** (`.mp3`, `.m4a`, `.wav`, and more) → local ASR transcript
- **Content questions** ("what happens in this video?") → native video model (MiniMax-M3)
- **Temporal questions** ("what happens at 0:03?") → local frame extraction + ASR

## Quick Start

```bash
# 1. Install
pi install pi-sense

# 2. Configure a vision/video model when you need image or video understanding
/sense model minimax-cn/MiniMax-M3

# 3. Enable the media routes you want (audio is enabled by default)
/sense audio on
/sense video on
```

Now pi can inject a local-audio transcript, image description, or local-video description as text — even when the active model does not accept that media type.

## How It Works

```
agent reads image / local audio / mentions video path
  │
  ▼
tool_result ── image → vision model → text description
  │            audio → path marker for local ASR
  │            video → path marker for routing
  ▼
context     ── remaining images → cached text
  │            audio path → local ASR transcript
  │            video path → native (what) or frames+ASR (when)
  ▼
text-only model receives text, not raw media
```

## Commands

```
/sense                                 Show status
/sense status                          Same as /sense
/sense model <provider/id>             Set the vision/video model
/sense audio <on|off>                  Toggle local-audio transcription
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

## Configuration

Config lives at `~/.pi/agent/pi-sense.json`:

```json
{
  "enabled": true,
  "visionModel": "minimax-cn/MiniMax-M3",
  "autoHandoff": true,
  "audioEnabled": true,
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
| `autoHandoff` | `true` | Only inject **image** descriptions into active models that lack image input |
| `audioEnabled` | `true` | Enable local-audio transcription with the configured ASR tool |
| `videoEnabled` | `true` | Enable local-video handoff, independent of active-model image input |
| `videoModel` | `null` | Separate model for video; `null` = reuse `visionModel` |
| `videoRoute` | `auto` | `auto` = detect temporal intent, `native` = force native, `frames` = force frames+ASR |
| `videoFps` | `1` | Sampling fps for native video route (0.2–5) |
| `videoThinking` | `false` | Enable MiniMax adaptive thinking for native route |
| `asrProvider` | `auto` | `auto` = whisper-cli → faster-whisper, or explicit path |
| `maxVideoFrames` | `120` | Frame-route budget (1–600) |
| `enableAdaptiveSampling` | `false` | Reserved preference; not consumed by the 0.0.1 pipeline |

## Audio Input

`pi-sense` accepts local audio paths from a prompt or the `read` tool, including `mp3`, `wav`, `m4a`, `aac`, `flac`, `ogg`, `opus`, `wma`, `aif`, and `aiff`. It normalizes each file to 16 kHz mono WAV with `ffmpeg`, runs local ASR, and injects a timestamped `[Audio: ...]` transcript. This route needs no vision or video model; toggle it with `/sense audio on|off`.

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
| `ffmpeg` / `ffprobe` | Audio normalization; video frame/audio extraction | `brew install ffmpeg` |
| `whisper-cli` | Local ASR (audio input and video timeline, preferred) | `brew install whisper-cpp` + download a ggml model |
| faster-whisper | Local ASR fallback | `pip install faster-whisper` in a venv at `~/.venvs/video-asr` |

You need `ffmpeg` plus one ASR tool for standalone audio input and the video frames route. The native video route works without local tools.

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
# Unit checks for local video/audio path detection + temporal intent (no API key needed)
node scripts/verify-paths.mjs

# Standalone audio normalization + local ASR (needs ffmpeg + whisper; pass any speech audio file)
node scripts/verify-audio-chain.mjs /path/to/audio.m4a

# Native route real-chain (needs minimax-cn API key in ~/.pi/agent/auth.json)
node scripts/verify-native-chain.mjs

# Frames + ASR real-chain (needs ffmpeg + whisper)
node scripts/verify-frames-chain.mjs
```

## Limitations

- Audio and video input are **local files only** — no remote URLs, live audio, or screen capture
- Standalone audio is transcribed locally; it is not sent to a configured vision/video model
- Native video is available through **MiniMax-M3**; Gemini and Grok use the frames + ASR route in 0.0.1
- Video handoff is enabled for local paths even when the active model supports images; use `/sense video off` if the active model handles video directly
- Native model timestamps are **not reliable** — use the frames route for temporal accuracy
- Adaptive sampling is a **reserved setting**; the 0.0.1 local pipeline does not consume it

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
