# Changelog

All notable changes to this project are documented here.

## Unreleased

## 0.0.3 - 2026-07-20

### Added

- Standalone local-audio handoff for common audio formats, normalized with ffmpeg and transcribed by local ASR into timestamped context.

### Removed

- `/dvision` legacy alias for `/sense`. The command has been removed from the registry and the README no longer advertises it. Use `/sense` directly.

## 0.0.2 - 2026-07-10

### Fixed

- Decoupled local-video handoff from the active model's image capability. Image-capable models that cannot process video now still receive local-video descriptions when `/sense video on` is configured.

## 0.0.1 - 2026-07-10

First public release of `pi-sense`.

### Added

- Image handoff for active Pi models without image input.
- Local video handoff with two routes:
  - MiniMax-M3 native video understanding for content questions.
  - ffmpeg frame extraction plus local ASR for temporal questions.
- `/sense` command set for model selection, video routing, ASR selection, frame budget, and handoff status.
- Reproducible verification scripts for path detection, native MiniMax video understanding, and frames + ASR processing.

### Notes

- The native video adapter is validated for `minimax-cn/MiniMax-M3`.
- MiniMax-M3 is the native-video provider in this release; Gemini and Grok use the frames + ASR route.
- Local video paths are supported; remote URLs and screen capture are out of scope.
