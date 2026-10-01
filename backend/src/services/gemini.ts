// ============================================================
// gemini — Gemini REST client for AI metadata generation (Phase 6).
//
//   POST https://generativelanguage.googleapis.com/v1beta/models/
//        {model}:generateContent
//   Auth: `x-goog-api-key` header — SERVER-SIDE ONLY. The key never
//   leaves this module's fetch call: never logged, never returned,
//   never sent to the frontend.
//
// Structured JSON output via generationConfig.responseMimeType +
// responseSchema, then zod-validated against the shared
// GeminiMetadata shape. Any mismatch or API failure becomes a 502
// GEMINI_FAILED with a safe user-facing message; technical detail is
// logged server-side only.
// ============================================================

import { z } from "zod";
import {
  GEMINI_MODEL_ALLOWLIST,
  type GeminiMetadata,
} from "@drive2social/shared";
import { config } from "../config.js";
import { HttpError } from "../middleware/errorHandler.js";
import { logger } from "../lib/logger.js";
import type { ExtractedFrame } from "./videoFrames.js";

/** "placeholder" (the config default) means: not configured. */
export function isGeminiConfigured(): boolean {
  const key = config.GEMINI_API_KEY;
  return key !== "" && key !== "placeholder";
}

/** Server default model (GEMINI_MODEL env). */
export function geminiModel(): string {
  return config.GEMINI_MODEL;
}

/**
 * Phase 8: resolve the model for one generate-metadata call. The
 * user's per-user override (settings/{uid}.geminiModel) wins when it
 * is set AND on the shared GEMINI_MODEL_ALLOWLIST; anything else
 * falls back to the server default. Never throws.
 */
export function resolveGeminiModel(settings?: {
  geminiModel?: string;
} | null): string {
  const override = settings?.geminiModel;
  if (
    typeof override === "string" &&
    (GEMINI_MODEL_ALLOWLIST as readonly string[]).includes(override)
  ) {
    return override;
  }
  return config.GEMINI_MODEL;
}

/** Zod mirror of the shared GeminiMetadata type (validated on parse). */
const geminiMetadataSchema = z.object({
  youtube_title: z.string().min(1),
  youtube_description: z.string(),
  youtube_tags: z.array(z.string()),
  facebook_caption: z.string(),
  hashtags: z.array(z.string()),
});

export interface MetadataPromptInput {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  durationMillis?: number;
  width?: number;
  height?: number;
  topic?: string;
  transcript?: string;
  language: string;
  framesUsed: number;
}

const SYSTEM_INSTRUCTION = `You are a social-media copywriter generating post metadata for a video the user is about to publish.
Rules you must follow:
- Write natural, specific, non-clickbait titles and descriptions. No ALL-CAPS hype, no "YOU WON'T BELIEVE".
- DO NOT invent facts about people, places, events, products, or brands that are not evidenced by the provided context (file name, video frames, topic, transcript). When unsure, stay generic.
- Respect platform limits: YouTube title at most 100 characters, YouTube description at most 5000 characters, the combined text of all tags at most 500 characters, Facebook caption concise (at most ~300 characters).
- youtube_tags: short keyword phrases, no duplicates, no "#" prefix. hashtags: relevant single words without spaces or "#", at most 10.
- Respond with ONLY the JSON object matching the required schema.`;

function formatDuration(millis: number | undefined): string {
  if (millis === undefined || millis <= 0) return "unknown";
  const s = Math.round(millis / 1000);
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return m > 0 ? `${m}m ${rest}s` : `${rest}s`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v.toFixed(1)} ${units[u]}`;
}

/** Build the user prompt from file facts, context, and frame count. */
export function buildMetadataPrompt(input: MetadataPromptInput): string {
  const lines: string[] = [
    `File name: ${input.fileName}`,
    `Format: ${input.mimeType || "unknown"} (${formatBytes(input.sizeBytes)})`,
    `Duration: ${formatDuration(input.durationMillis)}`,
  ];
  if (input.width !== undefined && input.height !== undefined) {
    lines.push(`Resolution: ${input.width}x${input.height}`);
  }
  lines.push(
    input.framesUsed > 0
      ? `The attached ${input.framesUsed} still frames are sampled evenly from the start of the video — describe what you actually see.`
      : `No video frames are available; base the metadata on the file name and the context below only.`,
  );
  if (input.topic) {
    lines.push(`User context about the video:\n${input.topic}`);
  }
  if (input.transcript) {
    lines.push(`Transcript / subtitles provided by the user:\n${input.transcript}`);
  }
  lines.push(
    `Write the metadata in language: ${input.language}. ` +
      `Return exactly the fields youtube_title, youtube_description, youtube_tags, facebook_caption, hashtags.`,
  );
  return lines.join("\n\n");
}

// --- Gemini REST response shape ------------------------------------------

const textPartSchema = z.object({ text: z.string().optional() });
const candidateSchema = z.object({
  content: z.object({ parts: z.array(textPartSchema).optional() }).optional(),
  finishReason: z.string().optional(),
});
const geminiResponseSchema = z.object({
  candidates: z.array(candidateSchema).optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
});

const GEMINI_TIMEOUT_MS = 90_000;

export interface GenerateGeminiMetadataOptions {
  promptText: string;
  frames: ExtractedFrame[];
  /**
   * Phase 8: per-user model override (resolved via resolveGeminiModel
   * from the caller's settings/{uid} doc). Defaults to the server
   * GEMINI_MODEL when unset.
   */
  model?: string;
}

/**
 * Call Gemini generateContent and return validated metadata.
 * Throws HttpError (502 GEMINI_FAILED / 503 GEMINI_NOT_CONFIGURED)
 * with safe messages; the API key is never logged or exposed.
 */
export async function generateGeminiMetadata(
  opts: GenerateGeminiMetadataOptions,
): Promise<GeminiMetadata> {
  if (!isGeminiConfigured()) {
    throw new HttpError(
      503,
      "GEMINI_NOT_CONFIGURED",
      "AI metadata generation is not configured on this server. Set GEMINI_API_KEY.",
    );
  }

  const model = opts.model ?? geminiModel();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const parts: Array<Record<string, unknown>> = [{ text: opts.promptText }];
  for (const frame of opts.frames) {
    parts.push({
      inlineData: {
        mimeType: frame.mimeType,
        data: frame.data.toString("base64"),
      },
    });
  }

  const requestBody = {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 2048,
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: {
          youtube_title: {
            type: "string",
            description: "YouTube video title, at most 100 characters",
          },
          youtube_description: {
            type: "string",
            description: "YouTube video description, at most 5000 characters",
          },
          youtube_tags: {
            type: "array",
            items: { type: "string" },
            description: "YouTube tags: short keyword phrases",
          },
          facebook_caption: {
            type: "string",
            description: "Facebook post caption, concise",
          },
          hashtags: {
            type: "array",
            items: { type: "string" },
            description: "Hashtags without spaces or #, at most 10",
          },
        },
        required: [
          "youtube_title",
          "youtube_description",
          "youtube_tags",
          "facebook_caption",
          "hashtags",
        ],
        additionalProperties: false,
      },
    },
  };

  let res: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // SERVER-SIDE ONLY — the single place the key is ever used.
        "x-goog-api-key": config.GEMINI_API_KEY,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch (err) {
    const timedOut =
      err instanceof Error && err.name === "AbortError";
    logger.error(
      { err, model, framesUsed: opts.frames.length },
      "Gemini request failed",
    );
    throw new HttpError(
      502,
      "GEMINI_FAILED",
      timedOut
        ? "The AI metadata service timed out. Please retry."
        : "Could not reach the AI metadata service. Please retry.",
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    // Log technical detail server-side; keep the client message safe.
    const detail = await res
      .text()
      .then((t) => t.slice(0, 500))
      .catch(() => "");
    logger.error(
      { status: res.status, model, detail },
      "Gemini API returned an error",
    );
    const hint =
      res.status === 429
        ? " The service is rate-limited; please retry shortly."
        : res.status === 400
          ? " The request was rejected; please retry."
          : "";
    throw new HttpError(
      502,
      "GEMINI_FAILED",
      `The AI metadata service failed.${hint}`.trim(),
    );
  }

  const parsed = geminiResponseSchema.safeParse(
    await res.json().catch(() => null),
  );
  if (!parsed.success) {
    logger.error("Gemini response had an unexpected shape");
    throw new HttpError(
      502,
      "GEMINI_FAILED",
      "The AI service returned an unexpected response. Please retry.",
    );
  }

  const { promptFeedback, candidates } = parsed.data;
  if (promptFeedback?.blockReason) {
    logger.warn(
      { blockReason: promptFeedback.blockReason },
      "Gemini blocked the prompt",
    );
    throw new HttpError(
      502,
      "GEMINI_FAILED",
      "The AI service declined to generate metadata for this video.",
    );
  }

  const text = (candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim()
    // Defensive: strip markdown fences even though responseMimeType
    // should already return raw JSON.
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  if (!text) {
    logger.warn("Gemini returned no text content");
    throw new HttpError(
      502,
      "GEMINI_FAILED",
      "The AI service returned an empty response. Please retry.",
    );
  }

  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  const metadata = geminiMetadataSchema.safeParse(json);
  if (!metadata.success) {
    logger.error(
      { issues: metadata.error.issues.map((i) => i.path.join(".")) },
      "Gemini JSON failed schema validation",
    );
    throw new HttpError(
      502,
      "GEMINI_FAILED",
      "The AI service returned metadata in an unexpected format. Please retry.",
    );
  }

  // Clamp to platform limits even if the model overruns them.
  const clampTags = metadata.data.youtube_tags
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const totalTagChars = clampTags.join("").length;
  const tags =
    totalTagChars > 500
      ? clampTags.slice(
          0,
          Math.max(1, Math.floor((clampTags.length * 500) / totalTagChars)),
        )
      : clampTags;

  return {
    youtube_title: metadata.data.youtube_title.slice(0, 100),
    youtube_description: metadata.data.youtube_description.slice(0, 5000),
    youtube_tags: tags,
    facebook_caption: metadata.data.facebook_caption,
    hashtags: metadata.data.hashtags
      .map((h) => h.replace(/^#+/, "").trim().replace(/\s+/g, ""))
      .filter((h) => h.length > 0)
      .slice(0, 10),
  };
}
