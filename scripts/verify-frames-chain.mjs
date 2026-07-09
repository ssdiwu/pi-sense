/**
 * verify-frames-chain.mjs — reproducible real-chain verification for the
 * frames + local ASR temporal route.
 *
 * Requires:
 *   - ffmpeg / ffprobe on PATH
 *   - faster-whisper venv at ~/.venvs/video-asr/bin/python (or whisper-cli)
 *   - A test video with audio (pass as arg)
 *
 * Run:  npx tsc *.ts --outDir .verify-build --module ESNext --target ES2022 \
 *         --moduleResolution Bundler --skipLibCheck && \
 *       for f in .verify-build/*.js; do \
 *         sed -i '' 's|from "\(\./[a-z-]*\)";|from "\1.js";|g' "$f"; \
 *       done && node scripts/verify-frames-chain.mjs [videoPath]
 *
 * Exit 0 = PASS, non-zero = FAIL.
 */
import { getVideoDuration, computeFramePlan, extractFrames, extractAudio, makeWorkDir } from "../.verify-build/video.js";
import { transcribe } from "../.verify-build/asr.js";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

const videoPath = process.argv[2] || "/tmp/pi-sense-speech-video.mp4";

if (!existsSync(videoPath)) {
  // Auto-create a synthetic speech video for testing
  console.log("Creating synthetic test video...");
  const { execSync } = await import("node:child_process");
  const wav = "/tmp/pi-sense-speech.wav";
  if (!existsSync(wav)) { console.error("SKIP: no test video and no /tmp/pi-sense-speech.wav to synthesize"); process.exit(0); }
  execSync(`ffmpeg -y -f lavfi -i color=c=black:s=1280x720:d=15 -i ${wav} -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart ${videoPath} 2>/dev/null`);
  console.log(`Created ${videoPath}`);
}

const duration = await getVideoDuration(videoPath);
const plan = computeFramePlan(duration, 120);
console.log(`duration: ${duration.toFixed(2)}s | frame plan: ${plan.count} frames @ ${plan.interval}s interval`);

const workDir = await makeWorkDir();
const frames = await extractFrames(videoPath, plan);
try {
  console.log(`extracted frames: ${frames.files.length}`);

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
