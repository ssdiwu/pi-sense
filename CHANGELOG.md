# Changelog

## 0.2.0 - 2026-07-09 (in development)

### Changed
- Renamed from `pi-dvision` to `pi-sense` (including the project directory, package name, config file `pi-dvision.json` → `pi-sense.json`, command `/dvision` → `/sense`, and the internal `SenseConfig` type).
- `/dvision` is kept as a legacy alias that delegates to `/sense`.
- Repositioned as a media handoff extension with dual-path video understanding: native video for content questions (`what`), frames + local ASR for temporal questions (`when`).

### Notes
- MiniMax native-video integration reuses pi's real `auth.json` / `models.json` via `ModelRegistry`, uploads with Files API, and sends `mm_file://` through the `/anthropic` route.
- Temporal questions still use the deterministic frames + local ASR route because native video timestamps/order/direction are not treated as ground truth.

## 0.1.0 - 2026-07-08

### Added
- Initial `pi-dvision` release.
- Give text-only pi models vision: describe images with a vision model you pick via `/dvision model <provider/id>`, then feed the text description to non-vision models.
- Two-stage injection pipeline: `tool_result` (read) as primary + `context` as fallback.
- Per-image independent parallel vision calls with a simple in-memory cache (keyed by image hash).
- `/dvision` command matrix: `model`, `status`, `enable`, `disable`, `auto`, `clear`, `help`.
