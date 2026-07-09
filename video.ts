/**
 * video.ts — local video preprocessing pipeline for pi-sense.
 *
 * Responsibilities:
 *   - detect video file paths (in read tool results, user prompt text)
 *   - compute the frame budget (≤1min 0.5s/frame, >1min capped at maxFrames)
 *   - extract frames with ffmpeg to a temp dir
 *   - extract audio with ffmpeg (16kHz mono WAV)
 *
 * This module only orchestrates external CLIs (ffmpeg / ffprobe / whisper). It
 * does NOT bundle models or native addons. ASR lives in asr.ts.
 *
 * Frame budget rule (locked in grill alignment):
 *   - duration ≤ 60s → interval 0.5s (so a 60s clip yields 120 frames)
 *   - duration > 60s → interval = duration / maxFrames (covers full length)
 *   - hard cap: maxFrames (default 120, configurable up to 600)
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, open, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ─── Video path / block detection ───────────────────────────────────────────

export const VIDEO_EXTENSIONS = [
	".mp4", ".mov", ".webm", ".mkv", ".avi", ".flv", ".wmv", ".m4v",
	".mpg", ".mpeg", ".3gp", ".ogv", ".mts", ".m2ts",
] as const;

const VIDEO_MIME_PREFIX = "video/";

/** Is this extension a recognized video container? */
export function isVideoExtension(ext: string): boolean {
	return (VIDEO_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

/**
 * Scan text for local video file paths. Matches:
 *   - absolute paths /home/x/vid.mp4, /Users/x/vid.mp4, C:\\x\\vid.mp4
 *   - relative paths ./vid.mp4, ../vid.mp4, vid.mp4 (with a known video ext)
 * Returns absolute-looking or relative candidate strings (deduped, order preserved).
 */
export function extractVideoPathsFromText(text: string): string[] {
	if (!text) return [];
	const seen = new Set<string>();
	const out: string[] = [];

	const extGroup = (VIDEO_EXTENSIONS as readonly string[]).map((e) => e.replace(/\./g, "\\.")).join("|");
	const boundary = String.raw`(?=$|[\s)\]>'"\x60，。！？、,.!?:;])`;
	const patterns = [
		new RegExp(String.raw`file://[^\n"'\x60]+?(${extGroup})${boundary}`, "gi"),
		new RegExp(String.raw`(?<!file:)(?:~\/|\.\.\/|\.\/|\/|[A-Za-z]:\\)[^\n"'\x60]+?(${extGroup})${boundary}`, "gi"),
		new RegExp(String.raw`(?:^|[\s("'\x60])([\w.\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\-]+(${extGroup}))${boundary}`, "gi"),
	];

	for (const re of patterns) {
		let m: RegExpExecArray | null;
		while ((m = re.exec(text)) !== null) {
			let candidate = m[0]
			.replace(/^[\s("'`]+/u, "")
			.replace(/[)\]>'"，。！？、,.!?:;]+$/u, "");
			if (candidate.startsWith("file://")) {
				candidate = decodeURI(candidate.slice("file://".length));
			}
			if (candidate.startsWith("//") && !candidate.startsWith("///")) continue;
			candidate = candidate.replace(/^["'`]+|["'`]+$/g, "");
			const ext = candidate.slice(candidate.lastIndexOf(".")).toLowerCase();
			if (!isVideoExtension(ext)) continue;
			if (seen.has(candidate)) continue;
			seen.add(candidate);
			out.push(candidate);
		}
	}
	// Remove candidates that are suffixes of longer candidates (e.g. "file.mp4" when "/path/file.mp4" or "my file.mp4" exists)
	return out.filter((c) => !out.some((other) => other !== c && other.length > c.length && other.endsWith(c) && /[\s\/]/.test(other[other.length - c.length - 1] ?? "")));
}

// ─── ffprobe / ffmpeg helpers ───────────────────────────────────────────────

/** Check that a binary is on PATH. */
export async function hasBinary(name: string): Promise<boolean> {
	try {
		// execFile defaults to capturing stderr/stdout (pipe); "-version" rarely prints.
		await execFileAsync(name, ["-version"], { encoding: "utf-8", timeout: 10_000 });
		return true;
	} catch {
		return false;
	}
}

/** Get video duration in seconds via ffprobe. Throws on failure. */
export async function getVideoDuration(videoPath: string): Promise<number> {
	const { stdout } = await execFileAsync(
		"ffprobe",
		["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", videoPath],
		{ encoding: "utf-8", timeout: 15_000 },
	);
	const n = Number.parseFloat(stdout.trim());
	if (!Number.isFinite(n) || n <= 0) throw new Error(`ffprobe returned invalid duration: "${stdout.trim()}"`);
	return n;
}

// ─── Frame budget ───────────────────────────────────────────────────────────

export interface FramePlan {
	/** seconds between sampled frames */
	interval: number;
	/** explicit timestamps (seconds) at which to grab a frame */
	timestamps: number[];
	/** total frame count */
	count: number;
	/** source duration in seconds */
	duration: number;
}

/**
 * Compute the sampling plan.
 *   ≤1min → 0.5s/frame
 *   >1min → duration / maxFrames, covering the full length
 * Hard cap = maxFrames. Always at least 1 frame.
 */
export function computeFramePlan(durationSec: number, maxFrames: number): FramePlan {
	const max = Math.max(1, Math.trunc(maxFrames));
	const SHORT_THRESHOLD = 60; // seconds
	let interval: number;
	let count: number;
	if (durationSec <= SHORT_THRESHOLD) {
		interval = 0.5;
		count = Math.min(max, Math.max(1, Math.floor(durationSec / interval) + 1));
	} else {
		count = max;
		interval = durationSec / count;
	}
	// Build timestamps at interval spacing, clamped to [0, duration].
	const timestamps: number[] = [];
	for (let i = 0; i < count; i++) {
		const t = i * interval;
		if (t > durationSec) break;
		timestamps.push(Number(t.toFixed(3)));
	}
	if (timestamps.length === 0) timestamps.push(0);
	return { interval, timestamps, count: timestamps.length, duration: durationSec };
}

// ─── Frame + audio extraction ───────────────────────────────────────────────

export interface ExtractedFrames {
	/** temp dir holding frame_NNNN.jpg files; caller must rm it */
	dir: string;
	/** absolute paths to extracted frames, in order */
	files: string[];
	/** actual sample timestamps aligned one-to-one with files */
	timestamps: number[];
	plan: FramePlan;
}

export interface AudioFile {
	path: string;
}

export interface VideoProcessError {
	error: string;
	stage: "ffmpeg-missing" | "duration" | "frames" | "audio";
}

function stripAnsi(stderr: string): string {
	// crude: drop ANSI escapes so error messages stay readable
	return stderr.replace(/\x1b\[[0-9;]*m/g, "").trim();
}

/**
 * Extract frames at the planned timestamps using ffmpeg's select filter.
 * Writes JPEGs into a fresh temp dir. Returns the dir + file list.
 */
export async function extractFrames(
	videoPath: string,
	plan: FramePlan,
	signal?: AbortSignal,
): Promise<ExtractedFrames> {
	const dir = await mkdtemp(join(tmpdir(), "pi-sense-frames-"));
	const files: string[] = [];
	const timestamps: number[] = [];

	// Build a select expression that grabs the frame nearest each timestamp.
	// We run one ffmpeg pass per timestamp for predictability (select with many
	// pts is fiddly across ffmpeg versions). For >40 frames we switch to a
	// single fps-based pass over the whole file for speed.
	try {
		if (plan.timestamps.length <= 40) {
			// Per-timestamp extraction. A single timestamp at the exact video end
			// (t >= duration) can make ffmpeg emit no frames; treat that frame as
			// best-effort — skip it without failing the whole extraction.
			let failures = 0;
			for (let i = 0; i < plan.timestamps.length; i++) {
				if (signal?.aborted) throw new Error("aborted");
				const t = plan.timestamps[i];
				const out = join(dir, `frame_${String(i).padStart(4, "0")}.jpg`);
				try {
					await execFileAsync(
						"ffmpeg",
						[
							"-y", "-ss", String(t), "-i", videoPath,
							"-frames:v", "1",
							"-vf", "scale=512:-1",
							"-pix_fmt", "yuvj420p",
							"-q:v", "5",
							out,
						],
						{ timeout: 30_000, encoding: "utf-8" },
					);
					files.push(out);
					timestamps.push(t);
				} catch {
					// boundary / transient frame failure — skip, continue with the rest
					failures++;
				}
			}
			if (files.length === 0 && failures > 0) {
				throw new Error(`all ${plan.timestamps.length} per-timestamp extractions failed`);
			}
		} else {
			// single-pass: fps = count/duration, scene-independent uniform sample
			const fps = (plan.count / plan.duration).toFixed(4);
			const pattern = join(dir, "frame_%04d.jpg");
			const { stderr } = await execFileAsync(
				"ffmpeg",
				["-y", "-i", videoPath, "-vf", `fps=${fps},showinfo,scale=512:-1`, "-pix_fmt", "yuvj420p", "-q:v", "5", pattern],
				{ timeout: 120_000, encoding: "utf-8" },
			);
			// showinfo reports the output frame PTS. Do not infer time from the
			// requested plan: ffmpeg may drop or duplicate frames while decoding.
			const actualTimestamps = [...stderr.matchAll(/pts_time:([\d.-]+)/g)]
				.map((match) => Number.parseFloat(match[1]))
				.filter((timestamp) => Number.isFinite(timestamp));
			const names = (await readdir(dir)).filter((name) => name.startsWith("frame_") && name.endsWith(".jpg")).sort();
			if (actualTimestamps.length !== names.length) {
				throw new Error(`ffmpeg reported ${actualTimestamps.length} frame timestamps for ${names.length} frame files`);
			}
			for (let index = 0; index < names.length; index++) {
				files.push(join(dir, names[index]));
				timestamps.push(actualTimestamps[index]);
			}
		}
	} catch (err) {
		// best-effort cleanup
		await rm(dir, { recursive: true, force: true }).catch(() => {});
		const stderr = (err as { stderr?: string }).stderr;
		const msg = stderr ? stripAnsi(stderr) : err instanceof Error ? err.message : String(err);
		throw { error: `frame extraction failed: ${msg.slice(0, 300)}`, stage: "frames" } as VideoProcessError;
	}

	if (files.length === 0) {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
		throw { error: "frame extraction produced no frames", stage: "frames" } as VideoProcessError;
	}

	return { dir, files, timestamps, plan };
}

/**
 * Extract audio as 16kHz mono WAV (whisper-friendly). Throws VideoProcessError on failure.
 */
export async function extractAudio(videoPath: string, outDir: string, signal?: AbortSignal): Promise<AudioFile> {
	const path = join(outDir, "audio.wav");
	try {
		if (signal?.aborted) throw new Error("aborted");
		await execFileAsync(
			"ffmpeg",
			["-y", "-i", videoPath, "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", path],
			{ timeout: 120_000, encoding: "utf-8" },
		);
		return { path };
	} catch (err) {
		const stderr = (err as { stderr?: string }).stderr;
		const msg = stderr ? stripAnsi(stderr) : err instanceof Error ? err.message : String(err);
		// audio extraction can legitimately fail for silent/mux-less videos; surface as soft error
		throw { error: `audio extraction failed: ${msg.slice(0, 300)}`, stage: "audio" } as VideoProcessError;
	}
}

// ─── Temp workspace ─────────────────────────────────────────────────────────

/** Create a fresh temp working dir for one video's artifacts. */
export async function makeWorkDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pi-sense-"));
}

/** Hash a file's first 64KB + total size for caching/dedup. Only reads the
 *  head of the file (never loads a full video into memory). */
export async function hashVideoFile(videoPath: string): Promise<string> {
	const HEAD = 64 * 1024;
	const fh = await open(videoPath, "r");
	try {
		const { size } = await fh.stat();
		const len = Math.min(HEAD, size);
		const buf = Buffer.alloc(len);
		if (len > 0) await fh.read(buf, 0, len, 0);
		return createHash("sha256").update(buf).update(`:${size}`).digest("hex").slice(0, 16);
	} finally {
		await fh.close();
	}
}
