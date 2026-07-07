# Changelog

## 0.1.0 - 2026-07-08

### Added
- Initial `pi-dvision` release.
- Give text-only pi models vision: describe images with a vision model you pick via `/dvision model <provider/id>`, then feed the text description to non-vision models.
- Two-stage injection pipeline: `tool_result` (read) as primary + `context` as fallback.
- Per-image independent parallel vision calls with a simple in-memory cache (keyed by image hash).
- `/dvision` command matrix: `model`, `status`, `enable`, `disable`, `auto`, `clear`, `help`.
