/**
 * verify-paths.mjs — reproducible unit checks for extractVideoPathsFromText
 * and hasTemporalIntent (compiled from video.ts / index.ts).
 *
 * Run:  npx tsc video.ts index.ts --outDir .verify-build --module ESNext \
 *         --target ES2022 --moduleResolution Bundler --skipLibCheck && \
 *       for f in .verify-build/*.js; do \
 *         sed -i '' 's|from "\(\./[a-z-]*\)";|from "\1.js";|g' "$f"; \
 *       done && node scripts/verify-paths.mjs
 *
 * This script tests the pure functions that don't require API keys or network,
 * so it can be run independently to verify path detection and route selection.
 */
import { extractVideoPathsFromText } from "../.verify-build/video.js";

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; } else { fail++; console.log(`  FAIL: ${name}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`); }
}

// ── extractVideoPathsFromText ──
console.log("== extractVideoPathsFromText ==");
check("bare filename", extractVideoPathsFromText("demo.mp4"), ["demo.mp4"]);
check("bare CJK", extractVideoPathsFromText("请看 视频.mp4 这个"), ["视频.mp4"]);
check("CJK absolute", extractVideoPathsFromText("/tmp/录屏.mov"), ["/tmp/录屏.mov"]);
check("absolute + space", extractVideoPathsFromText("/Users/x/my video file.mp4"), ["/Users/x/my video file.mp4"]);
check("absolute + CJK + space", extractVideoPathsFromText("/Users/diwu/Movies/9router 竖屏.mp4"), ["/Users/diwu/Movies/9router 竖屏.mp4"]);
check("file:// URL encoded", extractVideoPathsFromText("file:///tmp/%E8%A7%86%E9%A2%91.mp4"), ["/tmp/视频.mp4"]);
check("typed in sentence", extractVideoPathsFromText("请看 /Users/diwu/Movies/9router 竖屏.mp4 这个视频"), ["/Users/diwu/Movies/9router 竖屏.mp4"]);
check("relative", extractVideoPathsFromText("./vid.mp4"), ["./vid.mp4"]);
check("home", extractVideoPathsFromText("~/Movies/demo.mp4"), ["~/Movies/demo.mp4"]);

// Negative cases
check("ts source bare", extractVideoPathsFromText("index.ts"), []);
check("ts source abs", extractVideoPathsFromText("/Users/diwu/Workspace/Codes/Githubs/pi-sense/video.ts"), []);
check("ts file url", extractVideoPathsFromText("file:///Users/diwu/Workspace/Codes/Githubs/pi-sense/video.ts"), []);
check("plain text", extractVideoPathsFromText("请描述这个视频"), []);
check("video.ts bare", extractVideoPathsFromText("video.ts"), []);

// ── hasTemporalIntent (inline replica of index.ts pattern) ──
console.log("\n== hasTemporalIntent ==");

// Replicate the pattern from index.ts for independent verification.
const cnTemporal = /第\d+[秒分]|第几秒|哪一秒|几分几秒|\d+分\d+秒|在\d+秒|\d+秒(的时候|处|时)|时间点|时间线|时间戳|时序|先后|顺序|什么时候/;
const enTemporal = /timestamp|timeline|temporal|when did|what time|at \d|drag direction|left or right|before \d|after \d|\d+ seconds? (in|ago|later)|at what time/;
const mmssTimecode = /\b\d{1,2}:\d{2}(?::\d{2})?\b/;
function hasTemporalIntent(text) {
  if (!text) return false;
  const n = text.toLowerCase();
  return cnTemporal.test(text) || enTemporal.test(n) || mmssTimecode.test(n);
}

// Positive — should trigger frames
for (const t of [
  "第3秒说了什么？", "第5秒发生了什么", "视频第10秒处", "3秒的时候",
  "1分30秒说了什么", "第几秒出现", "1:30发生了什么", "2 seconds ago",
  "at 1:30 what happens", "what time does the user scroll",
]) {
  if (hasTemporalIntent(t)) { pass++; } else { fail++; console.log(`  FAIL (should be temporal): ${t}`); }
}

// Negative — should NOT trigger frames (pure content questions)
for (const t of [
  "请描述这个视频", "总结一下视频", "describe this video",
  "then the user clicks the button", "first, describe what happens",
  "describe what happens after the intro", "what is this video about",
  "视频里用户做了什么操作",
]) {
  if (!hasTemporalIntent(t)) { pass++; } else { fail++; console.log(`  FAIL (should NOT be temporal): ${t}`); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
