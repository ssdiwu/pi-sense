/**
 * verify-native-chain.mjs — reproducible real-chain verification for the
 * MiniMax native video route.
 *
 * Requires:
 *   - ~/.pi/agent/auth.json with a valid minimax-cn API key
 *   - ~/.pi/agent/models.json with minimax-cn/MiniMax-M3
 *   - A test video (pass as arg, default: ~/Downloads test video)
 *
 * Run:  npx tsc *.ts --outDir .verify-build --module ESNext --target ES2022 \
 *         --moduleResolution Bundler --skipLibCheck && \
 *       for f in .verify-build/*.js; do \
 *         sed -i '' 's|from "\(\./[a-z-]*\)";|from "\1.js";|g' "$f"; \
 *       done && node scripts/verify-native-chain.mjs [videoPath]
 *
 * Exit 0 = PASS, non-zero = FAIL.
 */
import { AuthStorage } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import { ModelRegistry } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.js";
import { describeVideoNatively, classifyProvider } from "../.verify-build/native-video.js";
import { existsSync } from "node:fs";

const agentDir = `${process.env.HOME}/.pi/agent`;
const videoPath = process.argv[2] || `${process.env.HOME}/Downloads/762882080f1cf7806a44a3e2a8096470.mp4`;

if (!existsSync(videoPath)) {
  console.error(`SKIP: test video not found: ${videoPath}`);
  process.exit(0);
}

const authStorage = AuthStorage.create(`${agentDir}/auth.json`);
const modelRegistry = ModelRegistry.create(authStorage, `${agentDir}/models.json`);

const model = modelRegistry.find("minimax-cn", "MiniMax-M3");
if (!model) { console.error("FAIL: minimax-cn/MiniMax-M3 not found in registry"); process.exit(1); }

const auth = await modelRegistry.getApiKeyAndHeaders(model);
if (!auth.ok || !auth.apiKey) { console.error("FAIL: auth not resolved"); process.exit(1); }

console.log(`model: ${model.provider}/${model.id} | api: ${model.api} | baseUrl: ${model.baseUrl}`);
console.log(`auth resolved: ${auth.ok}`);

const result = await describeVideoNatively(
  videoPath,
  classifyProvider(model.provider),
  model,
  auth.apiKey,
  auth.headers,
  { fps: 5, thinking: true },
  "请用中文描述这个视频的内容，但不要编造时间点。",
);

if (!result.description || result.description.trim().length < 10) {
  console.error("FAIL: empty or too-short description");
  process.exit(1);
}

console.log(`\nprovider: ${result.provider}`);
console.log(`description (${result.description.length} chars): ${result.description.slice(0, 300)}...`);
console.log("\n=== native route real-chain: PASS ===");
