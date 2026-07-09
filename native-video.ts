/**
 * native-video.ts — native video understanding route for pi-sense (decision 0001).
 *
 * When the configured video model natively understands video (MiniMax-M3 via
 * the /anthropic endpoint), pi-sense uploads the file via MiniMax's Files API
 * and asks the model to describe it directly — no local frame extraction, no
 * local ASR. This is the "content understanding / what" route: fast and
 * accurate for describing content, but the model's temporal awareness is
 * unreliable (timestamps drift from real duration).
 *
 * Implementation: the chat call goes through pi-ai's `complete()` so we reuse
 * pi's model registry / auth / headers. pi-ai has no VideoContent type, so the
 * video is carried as an ImageContent block with a `video/*` mimeType and an
 * `mm_file://` reference in the `data` field; an `onPayload` hook rewrites the
 * serialized Anthropic `{type:"image", source:{media_type:"video/..."}}` into
 * `{type:"video", source:{type:"url", url:"mm_file://..."}}` before sending.
 *
 * The upload itself uses fetch (MiniMax /v1/files/upload) because pi-ai cannot
 * upload files — it only sends chat payloads. To avoid reading a whole video
 * into memory, the upload path uses a filesystem-backed Blob and enforces the
 * documented 512MB Files API limit before sending.
 */

import { complete } from "@earendil-works/pi-ai/compat";
import type { Api, ImageContent, Message, Model } from "@earendil-works/pi-ai";
import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface NativeVideoResult {
	description: string;
	provider: string;
}

export class NativeVideoError extends Error {
	constructor(message: string, public readonly provider: string) {
		super(message);
		this.name = "NativeVideoError";
	}
}

export interface NativeVideoOptions {
	fps: number; // 0.2-5 (informational; MiniMax samples internally)
	thinking: boolean; // MiniMax adaptive thinking
	signal?: AbortSignal;
}

export type NativeVideoProvider = "minimax" | "gemini" | "grok" | null;

/** Classify a pi provider id into a native-video family. */
export function classifyProvider(providerId: string): NativeVideoProvider {
	const p = providerId.toLowerCase();
	if (p === "minimax" || p === "minimax-cn") return "minimax";
	if (p === "google" || p === "google-vertex") return "gemini";
	if (p === "xai") return "grok";
	return null;
}

// ─── MiniMax upload (Files API) ─────────────────────────────────────────────

const MINIMAX_OAI_BASE = "https://api.minimaxi.com/v1";
const MINIMAX_MAX_VIDEO_BYTES = 512 * 1024 * 1024;

function guessVideoMimeType(videoPath: string): string {
	const ext = extname(videoPath).toLowerCase();
	if (ext === ".mp4" || ext === ".m4v") return "video/mp4";
	if (ext === ".mov") return "video/quicktime";
	if (ext === ".webm") return "video/webm";
	if (ext === ".mkv") return "video/x-matroska";
	if (ext === ".avi") return "video/x-msvideo";
	if (ext === ".flv") return "video/x-flv";
	if (ext === ".wmv") return "video/x-ms-wmv";
	if (ext === ".mpeg" || ext === ".mpg") return "video/mpeg";
	if (ext === ".ogv") return "video/ogg";
	if (ext === ".mts" || ext === ".m2ts") return "video/mp2t";
	if (ext === ".3gp") return "video/3gpp";
	return "video/mp4";
}

/** Upload a video to MiniMax for video understanding. Returns mm_file:// ref. */
async function minimaxUpload(
	videoPath: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<{ ref: string; mimeType: string }> {
	const meta = await stat(videoPath);
	if (meta.size > MINIMAX_MAX_VIDEO_BYTES) {
		throw new NativeVideoError(
			`MiniMax upload limit exceeded: ${meta.size} bytes > ${MINIMAX_MAX_VIDEO_BYTES} bytes (512MB)`,
			"minimax",
		);
	}
	const mimeType = guessVideoMimeType(videoPath);
	const form = new FormData();
	form.append("purpose", "video_understanding");
	form.append("file", await openAsBlob(videoPath, { type: mimeType }), basename(videoPath));
	const res = await fetch(`${MINIMAX_OAI_BASE}/files/upload`, {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}` },
		body: form,
		signal,
	});
	if (!res.ok) {
		const t = await res.text().catch(() => "");
		throw new NativeVideoError(`MiniMax upload failed (${res.status}): ${t.slice(0, 200)}`, "minimax");
	}
	const data = (await res.json()) as { file?: { file_id?: string } };
	const id = data.file?.file_id;
	if (!id) throw new NativeVideoError("MiniMax upload returned no file_id", "minimax");
	return { ref: `mm_file://${id}`, mimeType };
}

// ─── onPayload: rewrite image carrier → video block (Anthropic format) ──────

/**
 * pi-ai's anthropic-messages provider serializes ImageContent as:
 *   { type: "image", source: { type: "base64", media_type, data } }
 * We carry a video as ImageContent with mimeType "video/*" and data =
 * "mm_file://<id>". Rewrite those into MiniMax's video block:
 *   { type: "video", source: { type: "url", url: "mm_file://<id>" } }
 *
 * For other APIs (openai-completions) pi-ai emits { type: "image_url",
 * image_url: { url: "data:video/...;base64,mm_file://..." } } — we rewrite
 * that to { type: "video_url", video_url: { url: "mm_file://..." } }.
 */
function rewriteVideoCarrier(payload: unknown, fps: number): unknown | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const p = payload as Record<string, unknown>;
	const messages = p.messages;
	if (!Array.isArray(messages)) return undefined;

	let modified = false;
	for (const msg of messages) {
		if (!msg || typeof msg !== "object") continue;
		const m = msg as Record<string, unknown>;
		const content = m.content;
		if (!Array.isArray(content)) continue;

		for (let i = 0; i < content.length; i++) {
			const block = content[i];
			if (!block || typeof block !== "object") continue;
			const b = block as Record<string, unknown>;

			// Anthropic: { type:"image", source:{ media_type:"video/*", data:"mm_file://..." } }
			if (b.type === "image" && b.source && typeof b.source === "object") {
				const src = b.source as Record<string, unknown>;
				const mediaType = typeof src.media_type === "string" ? src.media_type : "";
				const data = typeof src.data === "string" ? src.data : "";
				if (mediaType.startsWith("video/") && data.startsWith("mm_file://")) {
					content[i] = { type: "video", source: { type: "url", url: data, fps } };
					modified = true;
				}
			}

			// OpenAI-completions: { type:"image_url", image_url:{ url:"data:video/...;...,mm_file://..." } }
			if (b.type === "image_url" && b.image_url && typeof b.image_url === "object") {
				const iu = b.image_url as Record<string, unknown>;
				const url = typeof iu.url === "string" ? iu.url : "";
				const mMatch = url.match(/^data:(video\/[^;]+);/);
				if (mMatch && url.includes("mm_file://")) {
					const ref = url.slice(url.indexOf("mm_file://"));
					content[i] = { type: "video_url", video_url: { url: ref, fps } };
					modified = true;
				}
			}
		}
	}
	return modified ? p : undefined;
}

// ─── Unified entry ──────────────────────────────────────────────────────────

const DEFAULT_VIDEO_PROMPT =
	"Describe this video exhaustively: what is shown, the app/UI/context, the " +
	"operations the user performs, scene changes, on-screen text, and anything a " +
	"developer would need to act on it. Do not invent timestamps you cannot verify. " +
	"Respond in the same language as the user's original request where possible.";

/**
 * Describe a local video file using a natively video-capable model, via pi-ai's
 * complete() (reuses pi model registry auth). Upload is done with fetch.
 *
 * `model` is the resolved pi Model (from modelRegistry.find). `apiKey`/`headers`
 * come from modelRegistry.getApiKeyAndHeaders.
 */
export async function describeVideoNatively(
	videoPath: string,
	provider: NativeVideoProvider,
	model: Model<Api>,
	apiKey: string,
	headers: Record<string, string> | undefined,
	opts: NativeVideoOptions,
	prompt: string = DEFAULT_VIDEO_PROMPT,
): Promise<NativeVideoResult> {
	if (!apiKey) throw new NativeVideoError("no API key resolved", provider ?? "unknown");

	if (provider === "minimax") {
		const uploaded = await minimaxUpload(videoPath, apiKey, opts.signal);

		// Carry the video as an ImageContent block with the source container MIME
		// type + mm_file ref. onPayload rewrites it to MiniMax's video block.
		const carrier: ImageContent = {
			type: "image",
			data: uploaded.ref,
			mimeType: uploaded.mimeType,
		};
		const userMessage: Message = {
			role: "user",
			content: [
				{ type: "text", text: prompt },
				carrier,
			],
			timestamp: Date.now(),
		} as Message;

		// MiniMax-M3 thinking is controlled via the anthropic `thinking` field.
		// pi-ai doesn't expose this directly; for now we rely on the model default
		// (thinking off) unless opts.thinking is set — in which case we'd need a
		// provider-specific extra body. The /anthropic endpoint accepts thinking
		// at top level; we inject it via onPayload too.
		const wantThinking = opts.thinking;

		const response = await complete(
			model,
			{ messages: [userMessage] },
			{
				apiKey,
				headers,
				signal: opts.signal,
				onPayload: (payload) => {
					const rewritten = rewriteVideoCarrier(payload, opts.fps);
					if (rewritten && wantThinking) {
						// inject thinking: { type: "adaptive" } at top level for MiniMax /anthropic
						(rewritten as Record<string, unknown>).thinking = { type: "adaptive" };
					}
					return rewritten;
				},
			},
		);

		if (response.stopReason === "aborted" || response.stopReason === "error") {
			throw new NativeVideoError(
				`MiniMax video call ${response.stopReason}: ${response.errorMessage ?? "no detail"}`,
				"minimax",
			);
		}
		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();
		if (!text) throw new NativeVideoError("MiniMax returned empty content", "minimax");
		return { description: text, provider: "minimax" };
	}

	// Gemini and Grok adapters: TODO — wire their file APIs.
	throw new NativeVideoError(
		`native video understanding for provider "${provider}" is not yet implemented; falling back to frames+ASR`,
		provider ?? "unknown",
	);
}