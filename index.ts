/**
 * pi-dvision — give text-only models vision by describing images with a
 * vision-capable model of the user's choice.
 *
 * Pipeline (two-stage injection):
 *   tool_result (read) → PRIMARY: describe each image block in a read result,
 *     await the descriptions, and strip pi's non-vision note. The image block
 *     stays in storage (kitty renders it inline); the description lands as text
 *     before the agent's next turn.
 *   context            → FALLBACK: swap any remaining image blocks for their
 *     cached text description on the cloned LLM-bound payload.
 *
 * Each image gets one independent completeSimple() call (parallel). Results
 * are cached per image hash.
 *
 * Config: ~/.pi/agent/pi-dvision.json (flat, like pi-autoname / pi-tinyfish).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { getAgentDir, resizeImage, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Api, ImageContent, Message, Model, TextContent } from "@earendil-works/pi-ai";

// ─── Config ──────────────────────────────────────────────────────────────────

interface DvisionConfig {
  enabled: boolean;
  visionModel: string | null;
  autoHandoff: boolean;
}

const DEFAULT_CONFIG: DvisionConfig = {
  enabled: true,
  visionModel: null,
  autoHandoff: true,
};

const CONFIG_FILENAME = "pi-dvision.json";

function getConfigPath(): string {
  return join(getAgentDir(), CONFIG_FILENAME);
}

function normalizeConfig(raw: unknown): DvisionConfig {
  const base: DvisionConfig = { ...DEFAULT_CONFIG };
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.enabled === "boolean") base.enabled = obj.enabled;
  if (typeof obj.visionModel === "string" && obj.visionModel.includes("/")) {
    base.visionModel = obj.visionModel.trim();
  } else if (obj.visionModel === null) {
    base.visionModel = null;
  }
  if (typeof obj.autoHandoff === "boolean") base.autoHandoff = obj.autoHandoff;
  return base;
}

function readConfig(): DvisionConfig {
  const path = getConfigPath();
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  try {
    return normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfig(config: DvisionConfig): string {
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

function isVisionModel(model: { input?: ("text" | "image")[] } | undefined | null): boolean {
  return !!model && Array.isArray(model.input) && model.input.includes("image");
}

function isConfigured(): boolean {
  return config.enabled && !!config.visionModel;
}

/** Whether a given model should receive handoff (image → text). */
function isHandoffTarget(
  model: { provider?: string; id?: string; input?: ("text" | "image")[] } | undefined | null,
): boolean {
  if (!model || !model.provider || !model.id) return false;
  const ref = formatModelRef(model.provider, model.id);
  // handoffModels list not needed in minimal version — autoHandoff covers it.
  if (config.autoHandoff && !isVisionModel(model)) return true;
  return false;
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

/** Simple per-hash cache: a described image is never described twice. */
const descriptionCache = new Map<string, Promise<string>>();

/** Resolve the configured vision model against the registry. */
function resolveVisionModel(
  modelRegistry: { find: (provider: string, id: string) => Model<Api> | undefined },
): Model<Api> | null {
  if (!config.visionModel) return null;
  const parsed = parseModelRef(config.visionModel);
  if (!parsed) return null;
  return modelRegistry.find(parsed.provider, parsed.id) ?? null;
}

/** Describe one image via completeSimple(). Cached per hash. */
async function describeImage(
  img: ExtractedImage,
  modelRegistry: { find: (provider: string, id: string) => Model<Api> | undefined; getApiKeyAndHeaders: (model: Model<Api>) => Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }> },
  signal?: AbortSignal,
): Promise<string> {
  const hash = imageHash(img.mimeType, img.data);
  const cached = descriptionCache.get(hash);
  if (cached) return cached;

  const promise = (async (): Promise<string> => {
    const visionModel = resolveVisionModel(modelRegistry);
    if (!visionModel) return UNAVAILABLE;

    const auth = await modelRegistry.getApiKeyAndHeaders(visionModel);
    if (!auth.ok || !auth.apiKey) return UNAVAILABLE;

    // Resize if oversized — matches pi core's read tool pipeline.
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

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120_000);
      if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

      const response = await completeSimple(
        visionModel,
        { systemPrompt: VISION_SYSTEM_PROMPT, messages: [userMessage] },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          signal: controller.signal,
          maxTokens: visionModel.maxTokens > 0 ? visionModel.maxTokens : undefined,
        },
      );
      clearTimeout(timer);

      if (response.stopReason === "aborted" || response.stopReason === "error") {
        return UNAVAILABLE;
      }

      const text = response.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c: TextContent) => c.text)
        .join("\n")
        .trim();

      if (!text) return UNAVAILABLE;
      return `${IMAGE_PLACEHOLDER_PREFIX}${text}${IMAGE_PLACEHOLDER_SUFFIX}`;
    } catch {
      return UNAVAILABLE;
    }
  })();

  // FIFO eviction (oldest entry evicted when cache is full)
  if (descriptionCache.size >= CACHE_MAX) {
    const firstKey = descriptionCache.keys().next().value;
    if (firstKey !== undefined) descriptionCache.delete(firstKey);
  }
  descriptionCache.set(hash, promise);
  return promise;
}

/** Describe multiple images in parallel. */
async function describeImages(
  imgs: ExtractedImage[],
  ctx: { modelRegistry: ExtensionCommandContext["modelRegistry"]; signal?: AbortSignal },
): Promise<string[]> {
  return Promise.all(imgs.map((img) => describeImage(img, ctx.modelRegistry, ctx.signal)));
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  config = readConfig();

  pi.on("session_start", () => {
    config = readConfig();
    descriptionCache.clear();
  });

  // PRIMARY injection: read tool's tool_result.
  pi.on("tool_result", async (event, ctx) => {
    if (!isConfigured()) return;
    if (event.toolName !== "read") return;
    const content = event.content;
    if (!Array.isArray(content)) return;

    const imgs: ExtractedImage[] = [];
    for (const block of content) {
      const img = extractImageFromBlock(block);
      if (img) imgs.push(img);
    }
    if (imgs.length === 0) return;
    if (!isHandoffTarget(ctx.model)) return;

    const descs = await describeImages(imgs, ctx);
    if (ctx.signal?.aborted) return;

    // Strip pi's non-vision note + swap image blocks for descriptions.
    const next = content.slice();
    let changed = false;
    let descIdx = 0;
    for (let i = 0; i < next.length; i++) {
      const block = next[i];
      if (extractImageFromBlock(block)) {
        next[i] = { type: "text", text: descs[descIdx++] ?? UNAVAILABLE } satisfies TextContent;
        changed = true;
      } else if (
        typeof block === "object" &&
        (block as { type: string }).type === "text" &&
        typeof (block as { text: string }).text === "string" &&
        (block as { text: string }).text.includes(NON_VISION_IMAGE_NOTE)
      ) {
        next[i] = { type: "text", text: stripNonVisionImageNote((block as { text: string }).text) } satisfies TextContent;
        changed = true;
      }
    }
    if (changed) return { content: next as (TextContent | ImageContent)[] };
  });

  // FALLBACK injection: context event (catches user-attached, pasted images).
  pi.on("context", async (event, ctx) => {
    if (!isConfigured()) return;
    const messages = event.messages as unknown as Array<Record<string, unknown>>;
    if (!Array.isArray(messages)) return;

    const byHash = new Map<string, ExtractedImage>();
    let anyImage = false;
    for (const msg of messages) {
      const content = msg.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const img = extractImageFromBlock(block);
        if (img) {
          anyImage = true;
          byHash.set(imageHash(img.mimeType, img.data), img);
        }
      }
    }
    if (!anyImage) return;
    if (!isHandoffTarget(ctx.model)) return;

    const imgs = [...byHash.values()];
    const descArr = await describeImages(imgs, ctx);
    const descs = new Map<string, string>();
    for (let i = 0; i < imgs.length; i++) {
      descs.set(imageHash(imgs[i].mimeType, imgs[i].data), descArr[i]);
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
        if (img) {
          next.push({ type: "text", text: descs.get(imageHash(img.mimeType, img.data)) ?? UNAVAILABLE });
          touched = true;
        } else {
          next.push(block);
        }
      }
      if (touched) {
        msg.content = next;
        changed = true;
      }
    }
    if (changed) return { messages: event.messages };
  });

  // Notify when switching to a non-vision model that handoff is active.
  pi.on("model_select", (_event, ctx) => {
    if (!ctx.hasUI) return;
    if (!isConfigured()) return;
    const model = ctx.model;
    if (!model) return;
    if (isHandoffTarget(model) && !isVisionModel(model)) {
      ctx.ui.notify(`pi-dvision: active — images will be described by ${config.visionModel}`, "info");
    }
  });

  pi.registerCommand("dvision", {
    description: "Configure vision handoff — pick a vision model to describe images for text-only models",
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
        "pi-dvision commands:",
        "  /dvision                       Show status",
        "  /dvision status               Same as /dvision",
        "  /dvision model <provider/id>   Set the vision model",
        "  /dvision enable                Enable vision handoff",
        "  /dvision disable               Disable vision handoff",
        "  /dvision auto <on|off>         Toggle auto handoff for non-vision models",
        "  /dvision clear                 Clear the configured vision model",
        "  /dvision help                  This message",
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
      ctx.ui.notify("Usage: /dvision auto <on|off>", "warning");
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
      ctx.ui.notify("Usage: /dvision model <provider/id>", "warning");
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

  ctx.ui.notify(`Unknown subcommand: "${sub}". Use /dvision help for usage.`, "warning");
}

function updateConfig(
  ctx: ExtensionCommandContext,
  transform: (c: DvisionConfig) => DvisionConfig,
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
  lines.push(`Vision model: ${config.visionModel ?? "(none — set with /dvision model)"}`);
  lines.push(`Auto handoff: ${config.autoHandoff ? "on" : "off"}`);
  const model = ctx.model;
  const active = isConfigured() && model ? isHandoffTarget(model) : false;
  lines.push(
    `Active for current model (${model ? formatModelRef(model.provider, model.id) : "none"}): ${active ? "yes" : "no"}`,
  );
  ctx.ui.notify(lines.join("\n"), "info");
}
