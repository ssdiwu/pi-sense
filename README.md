# pi-dvision

A `pi` extension that gives text-only models vision: when the active model doesn't support image input, `pi-dvision` uses a vision model you pick to describe images, then feeds the text description to the non-vision model.

## What it does

When the active model lacks image input, `pi-dvision` intercepts image blocks at two points:

1. **`tool_result` (read)** — Primary injection: when the agent reads an image file, the image block is sent to the configured vision model for a text description. The description replaces the image block before the agent's next turn.
2. **`context`** — Fallback injection: any remaining image blocks (user-attached, pasted) are swapped for their cached text description on the LLM-bound payload.

Each image gets one independent `completeSimple()` call (parallel). Descriptions are cached per image hash so the same image isn't described twice.

## Install

### From local path

```bash
pi install /absolute/path/to/pi-dvision
```

Or add to `~/.pi/agent/settings.json` `packages` array.

> **不要把 `index.ts` 拷贝到 `~/.pi/agent/extensions/` 下作为加载方式。** 通过 `pi install` 或 `settings.json` 的 `packages` 注册加载。

## Configure

### Set the vision model

```bash
/dvision model minimax-cn/MiniMax-M3
```

### Check status

```bash
/dvision status
```

### Commands

```
/dvision                    Show status
/dvision model <provider/id>  Set the vision model
/dvision status              Show current config
/dvision enable              Enable handoff
/dvision disable             Disable handoff
/dvision auto <on|off>       Toggle auto handoff for non-vision models
/dvision clear               Clear the configured vision model
/dvision help                Show usage
```

## Config file

Config lives at `~/.pi/agent/pi-dvision.json`:

```json
{
  "enabled": true,
  "visionModel": "minimax-cn/MiniMax-M3",
  "autoHandoff": true
}
```

## How it works

```
agent reads image file
  │
  ▼
tool_result (read)  ── image block → vision model → text description
  │                    description lands in tool result before agent's next turn
  ▼
context             ── any remaining image blocks → cached text description
  │                    (only on cloned LLM-bound payload)
  ▼
text-only model receives text, not image
```

## Development

```bash
npm run typecheck
```

## Changelog

See `CHANGELOG.md`.

## License

MIT
