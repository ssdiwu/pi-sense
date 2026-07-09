/**
 * pi-sense — give text-only models media understanding by describing images
 * and local videos with a model of the user's choice.
 *
 * Pipeline (two-stage injection):
 *   tool_result (read) → PRIMARY: describe each image block in a read result,
 *     await the descriptions, strip pi's non-vision note, and expose local
 *     video reads as file-path markers for the routing stage.
 *   context            → FALLBACK / ROUTING: swap any remaining image blocks
 *     for their cached text description, and expand local video paths into
 *     `[Video: ...]` text via the native route (what) or frames+ASR route
 *     (when) on the cloned LLM-bound payload.
 *
 * Image descriptions are cached per hash. Video descriptions are cached per
 * file hash + route/model settings.
 *
 * Config: ~/.pi/agent/pi-sense.json (flat, like pi-autoname / pi-tinyfish).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { getAgentDir, resizeImage, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Api, ImageContent, Message, Model, TextContent } from "@earendil-works/pi-ai";
import { transcribe, type AsrResult } from "./asr";
import { classifyProvider, describeVideoNatively } from "./native-video";
import {
  computeFramePlan,
  extractAudio,
  extractFrames,
  extractVideoPathsFromText,
  getVideoDuration,
  hashVideoFile,
  isVideoExtension,
  makeWorkDir,
} from "./video";

// ─── Config ──────────────────────────────────────────────────────────────────

interface SenseConfig {
  enabled: boolean;
  visionModel: string | null;
  autoHandoff: boolean;
  // Video handoff fields
  videoEnabled: boolean;
  videoModel: string | null; // null → reuse visionModel
  asrProvider: "auto" | string; // "auto" or explicit path to a whisper binary/venv python
  maxVideoFrames: number; // frames-route cap (抽帧路线)
  enableAdaptiveSampling: boolean;
  // Native video route (decision 0001: content understanding / what)
  videoRoute: "auto" | "native" | "frames"; // auto = detect temporal-intent, native = force native model, frames = force frame+ASR
  videoFps: number; // native-route sampling fps, 0.2-5 (MiniMax/Gemini), default 1
  videoThinking: boolean; // native-route thinking switch (MiniMax adaptive)
}

const MAX_VIDEO_FRAMES_DEFAULT = 120;
const MAX_VIDEO_FRAMES_LIMIT = 600;
const VIDEO_FPS_DEFAULT = 1;
const VIDEO_FPS_MIN = 0.2;
const VIDEO_FPS_MAX = 5;

const DEFAULT_CONFIG: SenseConfig = {
  enabled: true,
  visionModel: null,
  autoHandoff: true,
  videoEnabled: true,
  videoModel: null,
  asrProvider: "auto",
  maxVideoFrames: MAX_VIDEO_FRAMES_DEFAULT,
  enableAdaptiveSampling: false,
  videoRoute: "auto",
  videoFps: VIDEO_FPS_DEFAULT,
  videoThinking: false,
};

const CONFIG_FILENAME = "pi-sense.json";

function getConfigPath(): string {
  return join(getAgentDir(), CONFIG_FILENAME);
}

function normalizeConfig(raw: unknown): SenseConfig {
  const base: SenseConfig = { ...DEFAULT_CONFIG };
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.enabled === "boolean") base.enabled = obj.enabled;
  if (typeof obj.visionModel === "string" && obj.visionModel.includes("/")) {
    base.visionModel = obj.visionModel.trim();
  } else if (obj.visionModel === null) {
    base.visionModel = null;
  }
  if (typeof obj.autoHandoff === "boolean") base.autoHandoff = obj.autoHandoff;
  // Video fields
  if (typeof obj.videoEnabled === "boolean") base.videoEnabled = obj.videoEnabled;
  if (typeof obj.videoModel === "string" && obj.videoModel.includes("/")) {
    base.videoModel = obj.videoModel.trim();
  } else if (obj.videoModel === null) {
    base.videoModel = null;
  }
  if (typeof obj.asrProvider === "string" && obj.asrProvider.trim()) {
    base.asrProvider = obj.asrProvider.trim();
  }
  if (typeof obj.maxVideoFrames === "number" && Number.isFinite(obj.maxVideoFrames)) {
    const clamped = Math.max(1, Math.min(Math.trunc(obj.maxVideoFrames), MAX_VIDEO_FRAMES_LIMIT));
    base.maxVideoFrames = clamped;
  }
  if (typeof obj.enableAdaptiveSampling === "boolean") base.enableAdaptiveSampling = obj.enableAdaptiveSampling;
  // Native video route fields — decision 0001
  if (obj.videoRoute === "auto" || obj.videoRoute === "native" || obj.videoRoute === "frames") {
    base.videoRoute = obj.videoRoute;
  }
  if (typeof obj.videoFps === "number" && Number.isFinite(obj.videoFps)) {
    base.videoFps = Math.max(VIDEO_FPS_MIN, Math.min(obj.videoFps, VIDEO_FPS_MAX));
  }
  if (typeof obj.videoThinking === "boolean") base.videoThinking = obj.videoThinking;
  return base;
}

function readConfig(): SenseConfig {
  const path = getConfigPath();
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  try {
    return normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfig(config: SenseConfig): string {
  const path = getConfigPath();
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
  return path;
}

let config = readConfig();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** "provider/id" → { provider, id }, or null if malformed. */
function parseModelRef(ref: string): { provider: string; id: string } | null {
  const i = ref.indexOf("/");
  if (i <= 0) return null;
  const provider = ref.slice(0, i);
  const id = ref.slice(i + 1);
  return provider && id ? { provider, id } : null;
}

function formatModelRef(provider: string, id: string): string {
  return `${provider}/${id}`;
}

type ActiveModel = { provider?: string; id?: string; input?: ("text" | "image")[] };

function isVisionModel(model: ActiveModel | undefined | null): boolean {
  return !!model && Array.isArray(model.input) && model.input.includes("image");
}

/** Image handoff is only needed when the active model cannot accept images. */
export function shouldHandoffImage(autoHandoff: boolean, model: ActiveModel | undefined | null): boolean {
  return !!model?.provider && !!model.id && autoHandoff && !isVisionModel(model);
}

/**
 * Video handoff is deliberately independent of the active model's image input.
 * Pi's current model metadata only advertises text/image capability, so it
 * cannot reliably express native-video support. Users with native-video models
 * can opt out explicitly with `/sense video off`.
 */
export function shouldHandoffVideo(videoEnabled: boolean, videoModel: string | null): boolean {
  return videoEnabled && !!videoModel;
}

function isImageConfigured(): boolean {
  return config.enabled && !!config.visionModel;
}

function isConfigured(): boolean {
  return isImageConfigured() || isVideoConfigured();
}

/** Effective model for video frame description: videoModel if set, else visionModel. */
function effectiveVideoModel(): string | null {
  return config.videoModel ?? config.visionModel;
}

/** Whether video handoff is ready to run. */
function isVideoConfigured(): boolean {
  return config.enabled && shouldHandoffVideo(config.videoEnabled, effectiveVideoModel());
}

/** Whether a given model should receive image handoff. */
function isImageHandoffTarget(model: ActiveModel | undefined | null): boolean {
  return shouldHandoffImage(config.autoHandoff, model);
}

/** SHA-256 hash of image data, for cache key + dedup. */
function imageHash(mimeType: string, data: string): string {
  return createHash("sha256").update(mimeType).update(":").update(data).digest("hex").slice(0, 16);
}

interface ExtractedImage {
  data: string;
  mimeType: string;
}

/**
 * Detect an image block by shape across the formats pi uses:
 *   pi-ai internal: { type: "image", data: "<base64>", mimeType }
 *   openai-completions: { type: "image_url", image_url: { url: "data:..." } }
 *   openai-responses: { type: "input_image", image_url: "data:..." | { url } }
 *   anthropic-messages: { type: "image", source: { type: "base64", media_type, data } }
 */
function extractImageFromBlock(block: unknown): ExtractedImage | null {
  if (!block || typeof block !== "object") return null;
  const b = block as Record<string, any>;

  // pi-ai internal (read tool emits this)
  if (b.type === "image" && typeof b.data === "string" && b.mimeType) {
    return { data: b.data, mimeType: b.mimeType };
  }

  // openai-completions
  if (b.type === "image_url" && typeof b.image_url?.url === "string") {
    return parseDataUrl(b.image_url.url);
  }

  // openai-responses
  if (b.type === "input_image") {
    const url = typeof b.image_url === "string" ? b.image_url : b.image_url?.url;
    if (typeof url === "string") return parseDataUrl(url);
  }

  // anthropic-messages
  if (b.type === "image" && b.source?.type === "base64" && typeof b.source.data === "string") {
    return { data: b.source.data, mimeType: b.source.media_type || "image/png" };
  }

  return null;
}

function parseDataUrl(url: string): ExtractedImage | null {
  const m = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(url);
  if (!m) return null;
  return { mimeType: m[1] || "image/png", data: m[2] };
}

type ModelRegistryLike = {
  find: (provider: string, id: string) => Model<Api> | undefined;
  getApiKeyAndHeaders: (model: Model<Api>) => Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
};

interface VideoCandidate {
  original: string;
  resolved: string;
  requestText: string;
}

type VideoRoute = "native" | "frames";

const VIDEO_PLACEHOLDER_PREFIX = "[Video: ";
const VIDEO_PLACEHOLDER_SUFFIX = "]";
const VIDEO_UNAVAILABLE = `${VIDEO_PLACEHOLDER_PREFIX}description unavailable${VIDEO_PLACEHOLDER_SUFFIX}`;
const VIDEO_PATH_MARKER_PREFIX = "[Local video file: ";
const VIDEO_PATH_MARKER_SUFFIX = "]";

function resolveConfiguredModel(modelRegistry: ModelRegistryLike, ref: string | null): Model<Api> | null {
  if (!ref) return null;
  const parsed = parseModelRef(ref);
  if (!parsed) return null;
  return modelRegistry.find(parsed.provider, parsed.id) ?? null;
}

function resolveVideoModel(modelRegistry: ModelRegistryLike): Model<Api> | null {
  return resolveConfiguredModel(modelRegistry, effectiveVideoModel());
}

function makeImageCacheKey(model: Model<Api>, mimeType: string, data: string): string {
  return `${formatModelRef(model.provider, model.id)}:${imageHash(mimeType, data)}`;
}

function makeVideoPathMarker(videoPath: string): string {
  return `${VIDEO_PATH_MARKER_PREFIX}${videoPath}${VIDEO_PATH_MARKER_SUFFIX}`;
}

function extractVideoPathMarker(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(VIDEO_PATH_MARKER_PREFIX) || !trimmed.endsWith(VIDEO_PATH_MARKER_SUFFIX)) return null;
  const path = trimmed.slice(VIDEO_PATH_MARKER_PREFIX.length, -VIDEO_PATH_MARKER_SUFFIX.length).trim();
  return path || null;
}

function stripImageFence(text: string): string {
  if (!text.startsWith(IMAGE_PLACEHOLDER_PREFIX) || !text.endsWith(IMAGE_PLACEHOLDER_SUFFIX)) return text;
  return text.slice(IMAGE_PLACEHOLDER_PREFIX.length, -IMAGE_PLACEHOLDER_SUFFIX.length).trim();
}

function resolveLocalVideoPath(candidate: string, cwd: string): string | null {
  if (!candidate) return null;
  const expanded = candidate.startsWith("~/") ? join(homedir(), candidate.slice(2)) : candidate;
  const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  if (!existsSync(absolute)) return null;
  if (!isVideoExtension(extname(absolute))) return null;
  return absolute;
}

function collectVideoCandidatesFromText(text: string, cwd: string, requestText: string = text): VideoCandidate[] {
  const seen = new Set<string>();
  const out: VideoCandidate[] = [];
  for (const candidate of extractVideoPathsFromText(text)) {
    const resolved = resolveLocalVideoPath(candidate, cwd);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    out.push({ original: candidate, resolved, requestText });
  }
  return out;
}

function rememberRecentText(recentTexts: string[], text: string): void {
  const trimmed = text.trim();
  if (!trimmed || extractVideoPathMarker(trimmed)) return;
  recentTexts.push(trimmed);
  while (recentTexts.length > 4) recentTexts.shift();
}

function requestTextForMarker(recentTexts: string[]): string {
  return recentTexts.slice(-2).join("\n").trim();
}

export function hasTemporalIntent(text: string): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase();
  const directPatterns = [
    /\b\d{1,2}:\d{2}(?::\d{2})?\b/,
    /第\d+[秒分]|第几秒|哪一秒|几分几秒|\d+分\d+秒|在\d+秒|\d+秒(的时候|处|时)|时间点|时间线|时间戳|时序|先后|顺序|什么时候/,
    /拖向哪个方向|向左拖|向右拖|左滑|右滑|拖动方向/,
    /timestamp|timeline|temporal|when did|what time|at \d|drag direction|left or right|before \d|after \d|\d+ seconds? (in|ago|later)|at what time/,
  ];
  return directPatterns.some((pattern) => pattern.test(normalized));
}

function chooseVideoRoute(text: string): VideoRoute {
  if (config.videoRoute === "native" || config.videoRoute === "frames") return config.videoRoute;
  return hasTemporalIntent(text) ? "frames" : "native";
}

function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0.0s";
  return `${seconds.toFixed(1)}s`;
}

function buildNativeVideoFence(description: string, model: Model<Api>): string {
  const ref = formatModelRef(model.provider, model.id);
  return `${VIDEO_PLACEHOLDER_PREFIX}route=native; model=${ref}; fps=${config.videoFps}; thinking=${config.videoThinking ? "on" : "off"}\n${description}${VIDEO_PLACEHOLDER_SUFFIX}`;
}

function buildFramesVideoFence(
  model: Model<Api>,
  durationSec: number,
  frameLines: string[],
  asr: AsrResult | null,
): string {
  const ref = formatModelRef(model.provider, model.id);
  const lines: string[] = [];
  lines.push(`route=frames; model=${ref}; duration=${formatSeconds(durationSec)}; frames=${frameLines.length}; asr=${asr?.provider ?? "none"}`);
  lines.push("Visual timeline:");
  lines.push(...frameLines);
  if (asr && asr.segments.length > 0) {
    lines.push("Transcript timeline:");
    for (const segment of asr.segments) {
      lines.push(`- ${formatSeconds(segment.start)}-${formatSeconds(segment.end)} ${segment.text}`);
    }
  } else {
    lines.push("Transcript timeline:");
    lines.push("- unavailable");
  }
  return `${VIDEO_PLACEHOLDER_PREFIX}${lines.join("\n")}${VIDEO_PLACEHOLDER_SUFFIX}`;
}

function summarizeFrameTimeline(timestamps: number[], descriptions: string[]): string[] {
  const lines: string[] = [];
  let last = "";
  for (let i = 0; i < descriptions.length; i++) {
    const text = stripImageFence(descriptions[i] ?? "").trim();
    if (!text || text === last) continue;
    lines.push(`- ${formatSeconds(timestamps[i] ?? 0)} ${text}`);
    last = text;
  }
  return lines.length > 0 ? lines : ["- 0.0s unavailable"];
}

async function describeVideoViaFrames(
  videoPath: string,
  model: Model<Api>,
  modelRegistry: ModelRegistryLike,
  signal?: AbortSignal,
): Promise<string> {
  const durationSec = await getVideoDuration(videoPath);
  const plan = computeFramePlan(durationSec, config.maxVideoFrames);
  const workDir = await makeWorkDir();
  let framesDir: string | null = null;
  try {
    const frames = await extractFrames(videoPath, plan, signal);
    framesDir = frames.dir;
    const frameImages = await Promise.all(
      frames.files.map(async (file) => ({
        mimeType: "image/jpeg",
        data: (await readFile(file)).toString("base64"),
      })),
    );
    const descriptions = await describeImagesWithModel(frameImages, model, { modelRegistry, signal });

    let asr: AsrResult | null = null;
    try {
      const audio = await extractAudio(videoPath, workDir, signal);
      asr = await transcribe(audio.path, { asrProvider: config.asrProvider }, signal);
    } catch {
      asr = null;
    }

    return buildFramesVideoFence(model, durationSec, summarizeFrameTimeline(frames.timestamps, descriptions), asr);
  } finally {
    if (framesDir) await rm(framesDir, { recursive: true, force: true }).catch(() => {});
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// The note pi core's read tool appends for non-vision models. Once we insert a
// description, it's misleading — strip it.
const NON_VISION_IMAGE_NOTE =
  "[Current model does not support images. The image will be omitted from this request.]";

function stripNonVisionImageNote(text: string): string {
  if (!text.includes(NON_VISION_IMAGE_NOTE)) return text;
  return text.split(NON_VISION_IMAGE_NOTE).join("").replace(/\n+$/, "");
}

// ─── Describer ───────────────────────────────────────────────────────────────

const VISION_SYSTEM_PROMPT =
  "You are a vision assistant for a coding agent. Describe this image exhaustively. Cover: all visible text (verbatim if possible), code snippets, UI layout and widgets, diagrams and flow arrows, error messages and stack traces, file trees, terminal output, color and style details, spatial relationships between elements, and anything else a developer would need to act on this image. Do not summarize — be exhaustive.";

const IMAGE_PLACEHOLDER_PREFIX = "[Image: ";
const IMAGE_PLACEHOLDER_SUFFIX = "]";
const UNAVAILABLE = `${IMAGE_PLACEHOLDER_PREFIX}description unavailable${IMAGE_PLACEHOLDER_SUFFIX}`;
const CACHE_MAX = 50;

/** Simple per-hash cache: a described media item is never described twice per model/route key. */
const descriptionCache = new Map<string, Promise<string>>();
const videoDescriptionCache = new Map<string, Promise<string>>();

function resolveVisionModel(modelRegistry: ModelRegistryLike): Model<Api> | null {
  return resolveConfiguredModel(modelRegistry, config.visionModel);
}

async function describeImageWithModel(
  img: ExtractedImage,
  model: Model<Api>,
  modelRegistry: ModelRegistryLike,
  signal?: AbortSignal,
): Promise<string> {
  const cacheKey = makeImageCacheKey(model, img.mimeType, img.data);
  const cached = descriptionCache.get(cacheKey);
  if (cached) return cached;

  if (descriptionCache.size >= CACHE_MAX) {
    const firstKey = descriptionCache.keys().next().value;
    if (firstKey !== undefined) descriptionCache.delete(firstKey);
  }

  const promise = (async (): Promise<string> => {
    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) return UNAVAILABLE;

    let data = img.data;
    let mimeType = img.mimeType;
    try {
      const buf = Buffer.from(img.data, "base64");
      const resized = await resizeImage(buf, img.mimeType);
      if (resized) {
        data = resized.data;
        mimeType = resized.mimeType;
      }
    } catch {
      // resize failure — use original
    }

    const userMessage: Message = {
      role: "user",
      content: [
        { type: "text", text: "Describe this image." },
        { type: "image", data, mimeType } satisfies ImageContent,
      ],
      timestamp: Date.now(),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await completeSimple(
        model,
        { systemPrompt: VISION_SYSTEM_PROMPT, messages: [userMessage] },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          signal: controller.signal,
          maxTokens: model.maxTokens > 0 ? model.maxTokens : undefined,
        },
      );
      if (response.stopReason === "aborted" || response.stopReason === "error") return UNAVAILABLE;

      const text = response.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c: TextContent) => c.text)
        .join("\n")
        .trim();
      if (!text) return UNAVAILABLE;
      return `${IMAGE_PLACEHOLDER_PREFIX}${text}${IMAGE_PLACEHOLDER_SUFFIX}`;
    } catch {
      return UNAVAILABLE;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  })();

  descriptionCache.set(cacheKey, promise);
  promise.then((result) => {
    if (result === UNAVAILABLE) descriptionCache.delete(cacheKey);
  });
  return promise;
}

async function describeImage(
  img: ExtractedImage,
  modelRegistry: ModelRegistryLike,
  signal?: AbortSignal,
): Promise<string> {
  const visionModel = resolveVisionModel(modelRegistry);
  if (!visionModel) return UNAVAILABLE;
  return describeImageWithModel(img, visionModel, modelRegistry, signal);
}

async function describeImagesWithModel(
  imgs: ExtractedImage[],
  model: Model<Api>,
  ctx: { modelRegistry: ModelRegistryLike; signal?: AbortSignal },
): Promise<string[]> {
  return Promise.all(imgs.map((img) => describeImageWithModel(img, model, ctx.modelRegistry, ctx.signal)));
}

/** Describe multiple images in parallel. */
async function describeImages(
  imgs: ExtractedImage[],
  ctx: { modelRegistry: ModelRegistryLike; signal?: AbortSignal },
): Promise<string[]> {
  return Promise.all(imgs.map((img) => describeImage(img, ctx.modelRegistry, ctx.signal)));
}

async function describeVideo(
  videoPath: string,
  requestText: string,
  ctx: { modelRegistry: ModelRegistryLike; signal?: AbortSignal },
): Promise<string> {
  const model = resolveVideoModel(ctx.modelRegistry);
  if (!model) return VIDEO_UNAVAILABLE;

  const route = chooseVideoRoute(requestText);
  const videoHash = await hashVideoFile(videoPath).catch(() => `path:${videoPath}`);
  const requestHash = createHash("sha256").update(requestText.trim()).digest("hex").slice(0, 12);
  const cacheKey = [
    route,
    formatModelRef(model.provider, model.id),
    videoHash,
    requestHash,
    config.videoFps,
    config.videoThinking ? "thinking" : "plain",
    config.maxVideoFrames,
    config.asrProvider,
  ].join(":");
  const cached = videoDescriptionCache.get(cacheKey);
  if (cached) return cached;

  if (videoDescriptionCache.size >= CACHE_MAX) {
    const firstKey = videoDescriptionCache.keys().next().value;
    if (firstKey !== undefined) videoDescriptionCache.delete(firstKey);
  }

  const promise = (async (): Promise<string> => {
    if (route === "native") {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (auth.ok && auth.apiKey) {
        const provider = classifyProvider(model.provider);
        if (provider) {
          try {
            const result = await describeVideoNatively(
              videoPath,
              provider,
              model,
              auth.apiKey,
              auth.headers,
              { fps: config.videoFps, thinking: config.videoThinking, signal: ctx.signal },
              `User request context:\n${requestText.slice(0, 4000)}\n\nDescribe the video for this request. Avoid inventing timestamps or directional certainty you cannot verify.`,
            );
            return buildNativeVideoFence(result.description, model);
          } catch {
            // degrade to deterministic frames route for content-only requests
          }
        }
      }
    }

    if (!isVisionModel(model)) return VIDEO_UNAVAILABLE;
    try {
      return await describeVideoViaFrames(videoPath, model, ctx.modelRegistry, ctx.signal);
    } catch {
      return VIDEO_UNAVAILABLE;
    }
  })();

  videoDescriptionCache.set(cacheKey, promise);
  promise.then((result) => {
    if (result === VIDEO_UNAVAILABLE) videoDescriptionCache.delete(cacheKey);
  });
  return promise;
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  config = readConfig();

  pi.on("session_start", () => {
    config = readConfig();
    descriptionCache.clear();
    videoDescriptionCache.clear();
  });

  // PRIMARY injection: read tool's tool_result.
  pi.on("tool_result", async (event, ctx) => {
    if (!isConfigured()) return;
    if (event.toolName !== "read") return;
    const content = event.content;
    if (!Array.isArray(content)) return;
    const imageTarget = isImageHandoffTarget(ctx.model);
    const videoTarget = isVideoConfigured();
    if (!imageTarget && !videoTarget) return;

    const imgs: ExtractedImage[] = [];
    if (imageTarget) {
      for (const block of content) {
        const img = extractImageFromBlock(block);
        if (img) imgs.push(img);
      }
    }

    const readPath = typeof event.input?.path === "string" ? event.input.path : null;
    const videoPath = readPath ? resolveLocalVideoPath(readPath, ctx.cwd) : null;

    let descs: string[] = [];
    if (imgs.length > 0 && isImageConfigured()) {
      descs = await describeImages(imgs, ctx);
      if (ctx.signal?.aborted) return;
    }

    const next: (TextContent | ImageContent)[] = [];
    let changed = false;
    let descIdx = 0;
    for (const block of content) {
      if (imageTarget && extractImageFromBlock(block) && isImageConfigured()) {
        next.push({
          type: "text",
          text: descs[descIdx++] ?? UNAVAILABLE,
        } satisfies TextContent);
        next.push(block as ImageContent);
        changed = true;
      } else if (
        imageTarget &&
        typeof block === "object" &&
        (block as { type: string }).type === "text" &&
        typeof (block as { text: string }).text === "string" &&
        (block as { text: string }).text.includes(NON_VISION_IMAGE_NOTE)
      ) {
        next.push({ type: "text", text: stripNonVisionImageNote((block as { text: string }).text) } satisfies TextContent);
        changed = true;
      } else {
        next.push(block as TextContent | ImageContent);
      }
    }

    if (videoPath && videoTarget) {
      next.push({ type: "text", text: makeVideoPathMarker(videoPath) } satisfies TextContent);
      changed = true;
    }

    if (changed) return { content: next };
  });

  // FALLBACK injection: context event (catches user-attached, pasted images and video paths).
  pi.on("context", async (event, ctx) => {
    if (!isConfigured()) return;
    const messages = event.messages as unknown as Array<Record<string, unknown>>;
    if (!Array.isArray(messages)) return;
    const imageTarget = isImageHandoffTarget(ctx.model);
    const videoTarget = isVideoConfigured();
    if (!imageTarget && !videoTarget) return;

    const byHash = new Map<string, ExtractedImage>();
    const byVideoPath = new Map<string, VideoCandidate>();
    let anyImage = false;
    const recentTexts: string[] = [];
    for (const msg of messages) {
      const content = msg.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const img = extractImageFromBlock(block);
        if (img) {
          if (imageTarget) {
            anyImage = true;
            byHash.set(imageHash(img.mimeType, img.data), img);
          }
          continue;
        }
        if (
          typeof block === "object" &&
          block !== null &&
          (block as { type?: string }).type === "text" &&
          typeof (block as { text?: string }).text === "string"
        ) {
          const text = (block as { text: string }).text;
          const markerPath = extractVideoPathMarker(text);
          if (markerPath) {
            const resolved = resolveLocalVideoPath(markerPath, ctx.cwd);
            if (resolved) {
              byVideoPath.set(resolved, {
                original: markerPath,
                resolved,
                requestText: requestTextForMarker(recentTexts) || markerPath,
              });
            }
          } else {
            for (const candidate of collectVideoCandidatesFromText(text, ctx.cwd, text)) {
              byVideoPath.set(candidate.resolved, candidate);
            }
          }
          rememberRecentText(recentTexts, text);
        }
      }
    }
    if (!anyImage && byVideoPath.size === 0) return;

    const descs = new Map<string, string>();
    if (anyImage && isImageConfigured()) {
      const imgs = [...byHash.values()];
      const descArr = await describeImages(imgs, ctx);
      for (let i = 0; i < imgs.length; i++) {
        descs.set(imageHash(imgs[i].mimeType, imgs[i].data), descArr[i]);
      }
    }

    const videoDescs = new Map<string, string>();
    if (byVideoPath.size > 0 && videoTarget) {
      for (const candidate of byVideoPath.values()) {
        videoDescs.set(candidate.resolved, await describeVideo(candidate.resolved, candidate.requestText, ctx));
      }
    }

    if (ctx.signal?.aborted) return;

    let changed = false;
    for (const msg of messages) {
      const content = msg.content;
      if (!Array.isArray(content)) continue;
      let touched = false;
      const next: unknown[] = [];
      for (const block of content) {
        const img = extractImageFromBlock(block);
        if (img && imageTarget && isImageConfigured()) {
          next.push({ type: "text", text: descs.get(imageHash(img.mimeType, img.data)) ?? UNAVAILABLE });
          touched = true;
          continue;
        }

        if (
          typeof block === "object" &&
          block !== null &&
          (block as { type?: string }).type === "text" &&
          typeof (block as { text?: string }).text === "string"
        ) {
          const text = (block as { text: string }).text;
          const markerPath = extractVideoPathMarker(text);
          const markerResolved = markerPath ? resolveLocalVideoPath(markerPath, ctx.cwd) : null;
          if (markerResolved && videoDescs.has(markerResolved)) {
            next.push({ type: "text", text: videoDescs.get(markerResolved) ?? VIDEO_UNAVAILABLE });
            touched = true;
            continue;
          }

          const candidates = collectVideoCandidatesFromText(text, ctx.cwd);
          if (candidates.length > 0) {
            const unique = [...new Set(candidates.map((candidate) => candidate.resolved))]
              .map((resolved) => videoDescs.get(resolved))
              .filter((value): value is string => !!value);
            if (unique.length > 0) {
              next.push({ type: "text", text: `${text}\n\n${unique.join("\n\n")}` });
              touched = true;
              continue;
            }
          }
        }

        next.push(block);
      }
      if (touched) {
        msg.content = next;
        changed = true;
      }
    }
    if (changed) return { messages: event.messages };
  });

  // Image and video handoff have independent activation rules.
  pi.on("model_select", (_event, ctx) => {
    if (!ctx.hasUI) return;
    if (!isConfigured()) return;
    const model = ctx.model;
    if (!model) return;
    const imageTarget = isImageHandoffTarget(model);
    const videoTarget = isVideoConfigured();
    if (imageTarget || videoTarget) {
      ctx.ui.notify(
        `pi-sense: active — image handoff=${imageTarget ? "on" : "off (active model supports images)"}; video handoff=${videoTarget ? "on" : "off"}; video model=${effectiveVideoModel() ?? "(none)"}`,
        "info",
      );
    }
  });

  pi.registerCommand("sense", {
    description: "Configure media handoff — pick a vision/video model to describe images and videos for text-only models",
    handler: async (args, ctx) => {
      await handleCommand(ctx, args.trim());
    },
  });

  // Legacy alias: /dvision still works, delegates to /sense.
  pi.registerCommand("dvision", {
    description: "(legacy alias for /sense) Configure media handoff",
    handler: async (args, ctx) => {
      await handleCommand(ctx, args.trim());
    },
  });
}

// ─── Command Handler ─────────────────────────────────────────────────────────

async function handleCommand(ctx: ExtensionCommandContext, args: string): Promise<void> {
  const parts = args.split(/\s+/);
  const sub = parts[0]?.toLowerCase() ?? "";
  const rest = parts.slice(1).join(" ");

  if (!sub || sub === "status") {
    showStatus(ctx);
    return;
  }

  if (sub === "help") {
    ctx.ui.notify(
      [
        "pi-sense commands:",
        "  /sense                       Show status",
        "  /sense status               Same as /sense",
        "  /sense model <provider/id>         Set the vision model",
        "  /sense video <on|off>               Toggle video handoff",
        "  /sense video-model <provider/id>    Set the video model (blank to reuse vision model)",
        "  /sense route <auto|native|frames>   Set video route selection",
        "  /sense fps <0.2-5>                  Set native-video sampling fps",
        "  /sense thinking <on|off>            Toggle native-video thinking",
        "  /sense asr <auto|path>              Set the ASR tool (auto detects whisper-cli then faster-whisper)",
        "  /sense frames <n>                   Set the max frame count (default 120)",
        "  /sense adaptive <on|off>            Toggle adaptive local re-sampling (reserved, default off)",
        "  /sense enable                       Enable handoff",
        "  /sense disable                      Disable handoff",
        "  /sense auto <on|off>                Toggle auto handoff for non-vision models",
        "  /sense clear                        Clear the configured vision model",
        "  /sense help                  This message",
        "",
        `Config: ${getConfigPath()}`,
      ].join("\n"),
      "info",
    );
    return;
  }

  if (sub === "enable") {
    updateConfig(ctx, (c) => ({ ...c, enabled: true }), "Vision handoff enabled.");
    return;
  }

  if (sub === "disable") {
    updateConfig(ctx, (c) => ({ ...c, enabled: false }), "Vision handoff disabled.");
    return;
  }

  if (sub === "auto") {
    const val = rest.toLowerCase();
    if (val !== "on" && val !== "off") {
      ctx.ui.notify("Usage: /sense auto <on|off>", "warning");
      return;
    }
    updateConfig(ctx, (c) => ({ ...c, autoHandoff: val === "on" }), `Auto handoff ${val}.`);
    return;
  }

  if (sub === "clear") {
    updateConfig(ctx, (c) => ({ ...c, visionModel: null }), "Vision model cleared.");
    return;
  }

  if (sub === "model") {
    if (!rest) {
      ctx.ui.notify("Usage: /sense model <provider/id>", "warning");
      return;
    }
    const parsed = parseModelRef(rest);
    if (!parsed) {
      ctx.ui.notify(`Invalid model reference: "${rest}". Use "provider/id".`, "error");
      return;
    }
    const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
    if (!model) {
      ctx.ui.notify(`Model not found: ${rest}.`, "error");
      return;
    }
    const ref = formatModelRef(parsed.provider, parsed.id);
    updateConfig(ctx, (c) => ({ ...c, visionModel: ref }), `Vision model set to ${ref}.`);
    if (!isVisionModel(model)) {
      ctx.ui.notify(`Note: ${ref} does not declare image input — it may not describe images well.`, "warning");
    }
    return;
  }

  if (sub === "video") {
    const val = rest.toLowerCase();
    if (val !== "on" && val !== "off") {
      ctx.ui.notify("Usage: /sense video <on|off>", "warning");
      return;
    }
    updateConfig(ctx, (c) => ({ ...c, videoEnabled: val === "on" }), `Video handoff ${val}.`);
    return;
  }

  if (sub === "route") {
    if (!rest) {
      ctx.ui.notify(`Video route: ${config.videoRoute}`, "info");
      return;
    }
    const val = rest.toLowerCase();
    if (val !== "auto" && val !== "native" && val !== "frames") {
      ctx.ui.notify("Usage: /sense route <auto|native|frames>", "warning");
      return;
    }
    updateConfig(ctx, (c) => ({ ...c, videoRoute: val }), `Video route set to ${val}.`);
    return;
  }

  if (sub === "fps") {
    if (!rest) {
      ctx.ui.notify(`Native video fps: ${config.videoFps}`, "info");
      return;
    }
    const n = Number.parseFloat(rest);
    if (!Number.isFinite(n) || n < VIDEO_FPS_MIN || n > VIDEO_FPS_MAX) {
      ctx.ui.notify(`Invalid fps: "${rest}". Use a number in [${VIDEO_FPS_MIN}, ${VIDEO_FPS_MAX}].`, "warning");
      return;
    }
    updateConfig(ctx, (c) => ({ ...c, videoFps: n }), `Native video fps set to ${n}.`);
    return;
  }

  if (sub === "thinking") {
    const val = rest.toLowerCase();
    if (val !== "on" && val !== "off") {
      ctx.ui.notify("Usage: /sense thinking <on|off>", "warning");
      return;
    }
    updateConfig(ctx, (c) => ({ ...c, videoThinking: val === "on" }), `Native video thinking ${val}.`);
    return;
  }

  if (sub === "video-model") {
    if (!rest) {
      // clear the override → fall back to visionModel
      updateConfig(ctx, (c) => ({ ...c, videoModel: null }), `Video model cleared — will reuse vision model.`);
      return;
    }
    const parsed = parseModelRef(rest);
    if (!parsed) {
      ctx.ui.notify(`Invalid model reference: "${rest}". Use "provider/id".`, "error");
      return;
    }
    const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
    if (!model) {
      ctx.ui.notify(`Model not found: ${rest}.`, "error");
      return;
    }
    const ref = formatModelRef(parsed.provider, parsed.id);
    updateConfig(ctx, (c) => ({ ...c, videoModel: ref }), `Video model set to ${ref}.`);
    if (!isVisionModel(model)) {
      ctx.ui.notify(`Note: ${ref} does not declare image input — it may not describe video frames well.`, "warning");
    }
    return;
  }

  if (sub === "asr") {
    if (!rest) {
      ctx.ui.notify(`ASR provider: ${config.asrProvider}`, "info");
      return;
    }
    const val = rest.trim();
    if (val.toLowerCase() === "auto") {
      updateConfig(ctx, (c) => ({ ...c, asrProvider: "auto" }), `ASR provider set to auto (whisper-cli → faster-whisper fallback).`);
      return;
    }
    updateConfig(ctx, (c) => ({ ...c, asrProvider: val }), `ASR provider set to ${val}.`);
    return;
  }

  if (sub === "frames") {
    if (!rest) {
      ctx.ui.notify(`Max video frames: ${config.maxVideoFrames} (limit ${MAX_VIDEO_FRAMES_LIMIT})`, "info");
      return;
    }
    const n = Number.parseFloat(rest);
    if (!Number.isFinite(n) || n < 1) {
      ctx.ui.notify(`Invalid frame count: "${rest}". Use a positive integer (max ${MAX_VIDEO_FRAMES_LIMIT}).`, "warning");
      return;
    }
    const clamped = Math.min(Math.trunc(n), MAX_VIDEO_FRAMES_LIMIT);
    updateConfig(ctx, (c) => ({ ...c, maxVideoFrames: clamped }), `Max video frames set to ${clamped}.`);
    return;
  }

  if (sub === "adaptive") {
    const val = rest.toLowerCase();
    if (val !== "on" && val !== "off") {
      ctx.ui.notify("Usage: /sense adaptive <on|off>", "warning");
      return;
    }
    updateConfig(ctx, (c) => ({ ...c, enableAdaptiveSampling: val === "on" }), `Adaptive local re-sampling ${val} (reserved — not yet implemented in the pipeline).`);
    return;
  }

  ctx.ui.notify(`Unknown subcommand: "${sub}". Use /sense help for usage.`, "warning");
}

function updateConfig(
  ctx: ExtensionCommandContext,
  transform: (c: SenseConfig) => SenseConfig,
  message: string,
): void {
  const next = transform(config);
  const path = writeConfig(next);
  config = next;
  ctx.ui.notify(`${message} (config: ${path})`, "info");
}

function showStatus(ctx: ExtensionCommandContext): void {
  const lines: string[] = [];
  lines.push(`Vision handoff: ${config.enabled ? "enabled" : "disabled"}`);
  lines.push(`Vision model: ${config.visionModel ?? "(none — set with /sense model)"}`);
  lines.push(`Auto handoff: ${config.autoHandoff ? "on" : "off"}`);
  lines.push(`Video handoff: ${config.videoEnabled ? "enabled" : "disabled"}`);
  lines.push(`Video model: ${effectiveVideoModel() ?? "(none)"}${config.videoModel ? " (explicit)" : " (reuses vision model)"}`);
  lines.push(`Video route: ${config.videoRoute}`);
  lines.push(`Native video fps: ${config.videoFps}`);
  lines.push(`Native video thinking: ${config.videoThinking ? "on" : "off"}`);
  lines.push(`ASR provider: ${config.asrProvider}`);
  lines.push(`Max video frames: ${config.maxVideoFrames}`);
  lines.push(`Adaptive sampling: ${config.enableAdaptiveSampling ? "on" : "off"} (reserved)`);
  const model = ctx.model;
  const imageActive = isImageConfigured() && isImageHandoffTarget(model);
  const videoActive = isVideoConfigured();
  lines.push(`Image handoff for current model (${model ? formatModelRef(model.provider, model.id) : "none"}): ${imageActive ? "yes" : "no"}`);
  lines.push(`Video handoff for local paths: ${videoActive ? "yes" : "no"} (independent of active-model image input)`);
  ctx.ui.notify(lines.join("\n"), "info");
}
