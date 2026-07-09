/**
 * verify-frames-chain.mjs — reproducible real-chain verification for the
 * frames + local ASR temporal route.
 *
 * Requires:
 *   - ffmpeg / ffprobe on PATH
 *   - faster-whisper venv at ~/.venvs/video-asr/bin/python (or whisper-cli)
 *   - A test video with audio (pass as arg)
 *
 * Run from a source checkout after `npm install`:
 *   node scripts/verify-frames-chain.mjs [videoPath]
 *
 * Exit 0 = PASS, non-zero = FAIL.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { prepareVerifyBuild } from "./prepare-verify-build.mjs";

const outDir = await prepareVerifyBuild();
const { getVideoDuration, computeFramePlan, extractFrames, extractAudio, makeWorkDir } = await import(pathToFileURL(`${outDir}/video.js`).href);
const { transcribe } = await import(pathToFileURL(`${outDir}/asr.js`).href);

const videoPath = process.argv[2] || "/tmp/pi-sense-speech-video.mp4";

if (!existsSync(videoPath)) {
  // Auto-create a synthetic speech video for testing
  console.log("Creating synthetic test video...");
  const wav = "/tmp/pi-sense-speech.wav";
  if (!existsSync(wav)) { console.error("FAIL: no test video and no /tmp/pi-sense-speech.wav to synthesize one"); process.exit(1); }
  execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=black:s=1280x720:d=15", "-i", wav, "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", videoPath], { stdio: "ignore" });
  console.log(`Created ${videoPath}`);
}

const duration = await getVideoDuration(videoPath);
const plan = computeFramePlan(duration, 120);
console.log(`duration: ${duration.toFixed(2)}s | frame plan: ${plan.count} frames @ ${plan.interval}s interval`);

const workDir = await makeWorkDir();
const frames = await extractFrames(videoPath, plan);
try {
  console.log(`extracted frames: ${frames.files.length}`);
  if (frames.files.length !== frames.timestamps.length) {
    console.error(`FAIL: ${frames.files.length} files but ${frames.timestamps.length} timestamps`);
    process.exit(1);
  }
  if (frames.timestamps.some((timestamp, index) => !Number.isFinite(timestamp) || (index > 0 && timestamp < frames.timestamps[index - 1]))) {
    console.error("FAIL: frame timestamps are not finite and monotonic");
    process.exit(1);
  }

  const audio = await extractAudio(videoPath, workDir);
  const asr = await transcribe(audio.path, { asrProvider: "auto" });
  console.log(`ASR provider: ${asr.provider} | segments: ${asr.segments.length}`);

  if (asr.segments.length === 0) { console.error("FAIL: no ASR segments"); process.exit(1); }

  console.log("\nTranscript timeline (temporal-verified):");
  for (const seg of asr.segments) {
    console.log(`  ${seg.start.toFixed(1)}s-${seg.end.toFixed(1)}s: ${seg.text}`);
  }
  console.log("\n=== frames+ASR route real-chain: PASS ===");
} finally {
  if (frames?.dir) await rm(frames.dir, { recursive: true, force: true }).catch(() => {});
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
}
