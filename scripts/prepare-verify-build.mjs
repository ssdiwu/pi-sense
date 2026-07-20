/** Build TypeScript sources for the standalone verification scripts.
 * Requires `npm install` in a source checkout. Output is temporary and ignored.
 */
import { execFile } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, `.verify-build-${process.pid}`);

export async function prepareVerifyBuild() {
  await rm(outDir, { recursive: true, force: true });
  await execFileAsync(
    "npx",
    ["--no-install", "tsc", "index.ts", "video.ts", "asr.ts", "native-video.ts", "--outDir", outDir, "--module", "ESNext", "--target", "ES2022", "--moduleResolution", "Bundler", "--skipLibCheck"],
    { cwd: repoRoot, encoding: "utf8" },
  );

  for (const name of await readdir(outDir)) {
    if (!name.endsWith(".js")) continue;
    const path = join(outDir, name);
    const source = await readFile(path, "utf8");
    const rewritten = source.replace(/from "(\.\/[^"]+)"/g, (_match, specifier) => `from "${specifier}.js"`);
    await writeFile(path, rewritten);
  }
  return outDir;
}
