/**
 * asr.ts — local audio transcription for pi-sense.
 *
 * Priority: whisper-cli (whisper.cpp) → faster-whisper venv → error.
 * No API keys. No bundled models. Only orchestrates external CLIs/envs.
 *
 * Output contract: { segments: [{start, end, text}], text } where start/end
 * are seconds. Callers merge this with frame descriptions into one video block.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { writeFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AsrSegment {
	start: number; // seconds
	end: number; // seconds
	text: string;
}

export interface AsrResult {
	segments: AsrSegment[];
	text: string;
	/** which provider produced this */
	provider: "whisper-cli" | "faster-whisper";
}

export type AsrProviderKind = "whisper-cli" | "faster-whisper" | null;

export interface AsrProviders {
	whisperCli: string | null; // binary path
	fasterWhisper: string | null; // venv python path
}

export class AsrError extends Error {
	constructor(
		message: string,
		public readonly providersTried: string[],
	) {
		super(message);
		this.name = "AsrError";
	}
}

// ─── Provider discovery (#15) ───────────────────────────────────────────────

/** Locate whisper-cli on PATH. */
export async function findWhisperCli(): Promise<string | null> {
	try {
		await execFileAsync("whisper-cli", ["-h"], { encoding: "utf-8", timeout: 10_000 });
		return "whisper-cli";
	} catch (err) {
		// whisper-cli -h exits non-zero on some builds but still runs; treat ENOENT as missing.
		const code = (err as NodeJS.ErrnoException).code;
		return code === "ENOENT" ? null : "whisper-cli";
	}
}

/** Locate the faster-whisper venv python at ~/.venvs/video-asr/bin/python. */
export function findFasterWhisper(): string | null {
	const p = join(homedir(), ".venvs", "video-asr", "bin", "python");
	return existsSync(p) ? p : null;
}

export async function detectAsrProviders(): Promise<AsrProviders> {
	const whisperCli = await findWhisperCli();
	const fasterWhisper = findFasterWhisper();
	return { whisperCli, fasterWhisper };
}

/**
 * Find a whisper.cpp ggml model. Prefers higher quality (larger) models over
 * tiny. Search order: explicit candidate, then known model dirs.
 */
export function findWhisperModel(explicit?: string | null): string | null {
	if (explicit && existsSync(explicit)) return explicit;

	const dirs = [
		"/opt/homebrew/share/whisper-cpp/models",
		join(homedir(), ".cache", "whisper"),
		join(homedir(), ".cache", "whisper.cpp"),
		"models",
	];

	let best: { path: string; size: number; rank: number } | null = null;
	// quality ranking by name keyword (bigger = better)
	const rank = (name: string): number => {
		const n = name.toLowerCase();
		if (n.includes("large")) return 5;
		if (n.includes("medium")) return 4;
		if (n.includes("small")) return 3;
		if (n.includes("base")) return 2;
		if (n.includes("tiny")) return 1;
		return 0;
	};

	for (const dir of dirs) {
		let names: string[] = [];
		try {
			names = readdirSync(dir).filter((n) => /^ggml-.*\.bin$/i.test(n));
		} catch {
			continue;
		}
		for (const name of names) {
			const path = join(dir, name);
			try {
				const size = statSync(path).size;
				const r = rank(name);
				// pick highest rank; within same rank, largest file
				if (!best || r > best.rank || (r === best.rank && size > best.size)) {
					best = { path, size, rank: r };
				}
			} catch {
				// skip unreadable
			}
		}
	}
	return best?.path ?? null;
}

// ─── whisper-cli transcription (#16) ────────────────────────────────────────

interface WhisperCliJson {
	transcription?: Array<{ timestamps?: { from?: string; to?: string }; text?: string }>;
}

function parseTimestampToSeconds(ts: string): number {
	// "00:00:05.000" or "00:05" → seconds
	const parts = ts.replace(",", ".").split(":").map(Number);
	if (parts.some((n) => !Number.isFinite(n))) return 0;
	if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
	if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
	return parts[0] ?? 0;
}

/**
 * Transcribe with whisper-cli. Writes JSON output to a temp file and parses it.
 * Throws on non-zero exit or empty result (caller falls back).
 *
 * Note: whisper-cli's Metal backend crashes at exit on some Apple Silicon
 * (SIGABRT in ggml_metal_device_free during cleanup). The JSON file is usually
 * written before the crash, so we read the output file regardless of exit code.
 */
export async function transcribeWithWhisperCli(
	wavPath: string,
	opts: { modelPath: string; whisperCliPath?: string; language?: string; noGpu?: boolean },
	signal?: AbortSignal,
): Promise<AsrResult> {
	const outDir = await mkdtemp(join(tmpdir(), "pi-sense-asr-"));
	const outBase = join(outDir, "out");
	try {
		if (signal?.aborted) throw new Error("aborted");
		const args = [
			"-m", opts.modelPath,
			"-f", wavPath,
			"-l", opts.language ?? "auto",
			"-oj",
			"-of", outBase,
			"--no-prints",
		];
		if (opts.noGpu) args.push("-ng");
		// swallow errors — we read the output file regardless (Metal exit crash)
		try {
			await execFileAsync(opts.whisperCliPath ?? "whisper-cli", args, { encoding: "utf-8", timeout: 300_000 });
		} catch {
			// exit crash is common; continue to parse the output file
		}

		const jsonPath = `${outBase}.json`;
		if (!existsSync(jsonPath)) throw new Error("whisper-cli produced no output file");
		const raw = await readFile(jsonPath, "utf-8");
		const data = JSON.parse(raw) as WhisperCliJson;
		const segs: AsrSegment[] = (data.transcription ?? [])
			.filter((t) => t.text && t.text.trim())
			.map((t) => ({
				start: parseTimestampToSeconds(t.timestamps?.from ?? "0"),
				end: parseTimestampToSeconds(t.timestamps?.to ?? t.timestamps?.from ?? "0"),
				text: t.text!.trim(),
			}));
		if (segs.length === 0) throw new Error("whisper-cli produced no transcription segments");
		return {
			segments: segs,
			text: segs.map((s) => s.text).join(" "),
			provider: "whisper-cli",
		};
	} finally {
		await rm(outDir, { recursive: true, force: true }).catch(() => {});
	}
}

// ─── faster-whisper fallback (#17) ──────────────────────────────────────────

const FASTER_WHISPER_SCRIPT = `
import sys, json
from faster_whisper import WhisperModel

audio_path = sys.argv[1]
model_name = sys.argv[2]
language = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != "auto" else None

model = WhisperModel(model_name, device="cpu", compute_type="int8")
segments, info = model.transcribe(audio_path, language=language)

out = []
for s in segments:
    t = (s.text or "").strip()
    if t:
        out.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": t})
print(json.dumps({"segments": out}))
`;

/**
 * Transcribe with faster-whisper via the venv python. Writes the inline helper
 * script to a temp file and runs it. Default model: "base".
 */
export async function transcribeWithFasterWhisper(
	wavPath: string,
	opts: { venvPython: string; model?: string; language?: string },
	signal?: AbortSignal,
): Promise<AsrResult> {
	const scriptDir = await mkdtemp(join(tmpdir(), "pi-sense-fw-"));
	const scriptPath = join(scriptDir, "asr.py");
	await writeFile(scriptPath, FASTER_WHISPER_SCRIPT, "utf-8");
	try {
		if (signal?.aborted) throw new Error("aborted");
		const { stdout } = await execFileAsync(
			opts.venvPython,
			[scriptPath, wavPath, opts.model ?? "base", opts.language ?? "auto"],
			{ encoding: "utf-8", timeout: 600_000, maxBuffer: 32 * 1024 * 1024 },
		);
		const data = JSON.parse(stdout) as { segments: AsrSegment[] };
		const segs = (data.segments ?? []).filter((s) => s.text && s.text.trim());
		if (segs.length === 0) throw new Error("faster-whisper produced no segments");
		return {
			segments: segs,
			text: segs.map((s) => s.text).join(" "),
			provider: "faster-whisper",
		};
	} finally {
		await rm(scriptDir, { recursive: true, force: true }).catch(() => {});
	}
}

// ─── Unified entry + degradation (#18) ──────────────────────────────────────

export interface TranscribeOptions {
	/** "auto" (default) picks whisper-cli first, then faster-whisper */
	asrProvider?: string;
	/** explicit whisper-cli binary path override */
	whisperCliPath?: string | null;
	/** explicit faster-whisper venv python path override */
	fasterWhisperPython?: string | null;
	/** explicit whisper-cli model path override */
	whisperModel?: string | null;
	/** explicit faster-whisper model name (default "base") */
	fasterWhisperModel?: string;
	language?: string;
	/** disable GPU for whisper-cli (workaround for Metal exit crash) */
	noGpu?: boolean;
}

/**
 * Transcribe a WAV file. Priority:
 *   1. whisper-cli (if binary + model found, unless config forces venv)
 *   2. faster-whisper venv (fallback)
 *   3. AsrError with install guidance
 *
 * A provider is only "tried" if it can run; a runtime failure of whisper-cli
 * degrades to faster-whisper without surfacing the crash to the agent.
 */
export async function transcribe(
	wavPath: string,
	opts: TranscribeOptions = {},
	signal?: AbortSignal,
): Promise<AsrResult> {
	const providers = await detectAsrProviders();
	const tried: string[] = [];
	const providerPrefRaw = opts.asrProvider ?? "auto";
	const providerPref = providerPrefRaw.toLowerCase();

	const customPath = providerPrefRaw !== "auto" && existsSync(providerPrefRaw) ? providerPrefRaw : null;
	const forcedFasterWhisper = opts.fasterWhisperPython ?? (customPath && (providerPref.includes("venv") || providerPref.includes("python")) ? customPath : null);
	const forcedWhisperCli = opts.whisperCliPath ?? (customPath && !forcedFasterWhisper ? customPath : null);

	const resolvedWhisperCli = forcedWhisperCli ?? providers.whisperCli;
	const resolvedFasterWhisper = forcedFasterWhisper ?? providers.fasterWhisper;
	const preferFasterWhisper = providerPref !== "auto" && (providerPref.includes("venv") || providerPref.includes("python"));
	const whisperOnly = providerPref !== "auto" && !!forcedWhisperCli;
	const tryWhisperFirst = !preferFasterWhisper && resolvedWhisperCli !== null;

	if (tryWhisperFirst) {
		const modelPath = opts.whisperModel ?? findWhisperModel();
		if (modelPath) {
			tried.push("whisper-cli");
			try {
				return await transcribeWithWhisperCli(
					wavPath,
					{ modelPath, language: opts.language, noGpu: opts.noGpu, whisperCliPath: resolvedWhisperCli },
					signal,
				);
			} catch {
				// degrade to faster-whisper unless the user explicitly forced whisper-cli
				if (whisperOnly) throw new AsrError("Forced whisper-cli path failed.", tried);
			}
		}
	}

	if (resolvedFasterWhisper) {
		tried.push("faster-whisper");
		try {
			return await transcribeWithFasterWhisper(
				wavPath,
				{
					venvPython: resolvedFasterWhisper,
					model: opts.fasterWhisperModel,
					language: opts.language,
				},
				signal,
			);
		} catch {
			// fall through to error
		}
	}

	// Nothing worked — give the user actionable guidance.
	const hints: string[] = [];
	if (!providers.whisperCli && !providers.fasterWhisper) {
		hints.push(
			"No local ASR tool found. Install one of:",
			"  whisper-cli:  brew install whisper-cpp   (then download a model, e.g. ggml-base.bin)",
			"  faster-whisper: create ~/.venvs/video-asr and `pip install faster-whisper`",
		);
	} else if (providers.whisperCli && !providers.fasterWhisper) {
		hints.push(
			"whisper-cli failed and no faster-whisper fallback was found.",
			"Consider installing faster-whisper as a fallback: create ~/.venvs/video-asr and `pip install faster-whisper`.",
		);
	} else if (providers.fasterWhisper && !providers.whisperCli) {
		hints.push("faster-whisper failed. Check the venv at ~/.venvs/video-asr is healthy.");
	} else {
		hints.push("Both whisper-cli and faster-whisper failed. See /sense status and verify models/venv.");
	}

	throw new AsrError(
		`Local ASR failed (tried: ${tried.join(", ") || "none"}). ${hints.join(" ")}`,
		tried,
	);
}
