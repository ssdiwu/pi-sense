/**
 * verify-audio-chain.mjs — reproducible real-chain verification for standalone
 * local-audio normalization and ASR.
 *
 * Requires ffmpeg and whisper-cli or the faster-whisper venv. Pass an audio
 * path, or provide /tmp/pi-sense-speech.wav created by the local test setup.
 */
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { prepareVerifyBuild } from "./prepare-verify-build.mjs";

const outDir = await prepareVerifyBuild();
const { makeWorkDir, normalizeAudio } = await import(pathToFileURL(`${outDir}/video.js`).href);
const { transcribe } = await import(pathToFileURL(`${outDir}/asr.js`).href);
const audioPath = process.argv[2] || "/tmp/pi-sense-speech.wav";

if (!existsSync(audioPath)) {
  console.error(`FAIL: audio file not found: ${audioPath}`);
  console.error("Pass a local audio file, for example: node scripts/verify-audio-chain.mjs /path/to/sample.m4a");
  process.exit(1);
}

const workDir = await makeWorkDir();
try {
  const normalized = await normalizeAudio(audioPath, workDir);
  if (!existsSync(normalized.path)) throw new Error("ffmpeg produced no normalized WAV");

  const asr = await transcribe(normalized.path, { asrProvider: "auto" });
  if (asr.segments.length === 0) throw new Error("ASR produced no transcript segments");

  console.log(`ASR provider: ${asr.provider} | segments: ${asr.segments.length}`);
  for (const segment of asr.segments) console.log(`  ${segment.start.toFixed(1)}s-${segment.end.toFixed(1)}s: ${segment.text}`);
  console.log("\n=== standalone audio route real-chain: PASS ===");
} finally {
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
}
