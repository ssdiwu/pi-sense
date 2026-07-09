/**
 * Reproducible checks for local video path extraction and automatic route selection.
 *
 * Run from a source checkout after `npm install`:
 *   node scripts/verify-paths.mjs
 */
import { pathToFileURL } from "node:url";
import { prepareVerifyBuild } from "./prepare-verify-build.mjs";

const outDir = await prepareVerifyBuild();
const { extractVideoPathsFromText } = await import(pathToFileURL(`${outDir}/video.js`).href);
const { hasTemporalIntent } = await import(pathToFileURL(`${outDir}/index.js`).href);

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL: ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

console.log("== extractVideoPathsFromText ==");
check("bare filename", extractVideoPathsFromText("demo.mp4"), ["demo.mp4"]);
check("bare CJK", extractVideoPathsFromText("请看 视频.mp4 这个"), ["视频.mp4"]);
check("CJK absolute", extractVideoPathsFromText("/tmp/录屏.mov"), ["/tmp/录屏.mov"]);
check("absolute + space", extractVideoPathsFromText("/Users/x/my video file.mp4"), ["/Users/x/my video file.mp4"]);
check("absolute + CJK + space", extractVideoPathsFromText("/Users/diwu/Movies/9router 竖屏.mp4"), ["/Users/diwu/Movies/9router 竖屏.mp4"]);
check("file URL", extractVideoPathsFromText("file:///tmp/%E8%A7%86%E9%A2%91.mp4"), ["/tmp/视频.mp4"]);
check("relative", extractVideoPathsFromText("./vid.mp4"), ["./vid.mp4"]);
check("home", extractVideoPathsFromText("~/Movies/demo.mp4"), ["~/Movies/demo.mp4"]);
check("TypeScript source", extractVideoPathsFromText("index.ts /tmp/video.ts"), []);
check("plain text", extractVideoPathsFromText("请描述这个视频"), []);

console.log("\n== hasTemporalIntent ==");
for (const text of [
  "第3秒说了什么？", "第5秒发生了什么", "视频第10秒处", "3秒的时候",
  "1分30秒说了什么", "第几秒出现", "1:30发生了什么", "2 seconds ago",
  "at 1:30 what happens", "what time does the user scroll",
]) check(`temporal: ${text}`, hasTemporalIntent(text), true);
for (const text of [
  "请描述这个视频", "总结一下视频", "describe this video",
  "then the user clicks the button", "first, describe what happens",
  "describe what happens after the intro", "what is this video about", "视频里用户做了什么操作",
]) check(`content: ${text}`, hasTemporalIntent(text), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
