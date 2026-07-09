# Changelog

All notable changes to this project are documented here.

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
- Gemini and Grok retain adapter seams but are not validated native-video providers in this release.
- Local video paths are supported; remote URLs and screen capture are out of scope.
