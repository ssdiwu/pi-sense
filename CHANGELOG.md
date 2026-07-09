# Changelog

All notable changes to this project are documented here.

## Unreleased

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
