// ============================================================
// Gemini metadata — mounted at /api/gemini.
//
// POST /api/gemini/generate-metadata
//   1. Loads the Drive file's metadata with the user's own token
//      (same withDrive helper as routes/drive.ts — token ownership
//      identical). 404 → DRIVE_FILE_NOT_FOUND. Non-video → 400
//      NOT_A_VIDEO; unsupported container → 400 UNSUPPORTED_VIDEO.
//   2. Extracts up to 8 frames from a bounded 64MB prefix sample via
//      ffmpeg (services/videoFrames). Falls back to metadata-only
//      analysis when ffmpeg is missing or extraction yields 0 frames.
//      Reports `analysisMode` + `framesUsed` honestly.
//   3. Calls Gemini generateContent (x-goog-api-key, server-side only)
//      with responseMimeType=application/json + responseSchema, then
//      zod-validates the result. API/schema failures → 502
//      GEMINI_FAILED with a safe message.
//
// GET /api/gemini/status — capability state for the UI:
//   { configured, model, ffmpegAvailable }.
//
// No mocks: when the Gemini key is unconfigured, generate-metadata
// answers 503 GEMINI_NOT_CONFIGURED and status reports
// configured:false. ffmpeg absence only degrades analysisMode.
// ============================================================

import { Router } from "express";
import { z } from "zod";
import { geminiGenerateLimiter } from "../lib/rateLimit.js";
import type {
  ApiResponse,
  GeminiMetadataResult,
  GeminiStatus,
} from "@drive2social/shared";
import {
  requireAuth,
  type AuthenticatedRequest,
} from "../middleware/requireAuth.js";
import { HttpError } from "../middleware/errorHandler.js";
import { requireUid } from "../lib/authRequest.js";
import { logger } from "../lib/logger.js";
import { getValidAccessToken } from "../lib/googleOAuth.js";
import {
  DRIVE_FILE_ID_PATTERN,
  assessVideoSupport,
  isVideoMimeType,
  withDrive,
} from "./drive.js";
import {
  extractVideoFrames,
  isFfmpegAvailable,
} from "../services/videoFrames.js";
import {
  buildMetadataPrompt,
  generateGeminiMetadata,
  isGeminiConfigured,
  resolveGeminiModel,
} from "../services/gemini.js";
import { getStoredSettings } from "./settings.js";

export const geminiRouter = Router();

const generateBodySchema = z.object({
  driveFileId: z.string().regex(DRIVE_FILE_ID_PATTERN, "Invalid Drive file id"),
  topic: z.string().trim().max(2000).optional(),
  transcript: z.string().trim().max(20000).optional(),
  language: z.string().trim().min(2).max(20).default("en"),
});

/**
 * GET /api/gemini/status — honest capability state.
 * requireAuth, never crashes when unconfigured.
 *
 * Phase 8: `model` is the EFFECTIVE model for this caller — their
 * per-user override (settings/{uid}.geminiModel) when set, otherwise
 * the server default (GEMINI_MODEL).
 */
geminiRouter.get(
  "/status",
  requireAuth,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const uid = requireUid(req);
      const stored = await getStoredSettings(uid);
      const payload: GeminiStatus = {
        configured: isGeminiConfigured(),
        model: resolveGeminiModel(stored),
        ffmpegAvailable: await isFfmpegAvailable(),
      };
      const body: ApiResponse<GeminiStatus> = { ok: true, data: payload };
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/gemini/generate-metadata — AI-suggested post metadata.
 * Rate-limited to 30/hour per user (geminiGenerateLimiter, applied
 * after requireAuth so the key is the Firebase uid — see
 * lib/rateLimit.ts).
 */
geminiRouter.post(
  "/generate-metadata",
  requireAuth,
  geminiGenerateLimiter,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const uid = requireUid(req);
      const { driveFileId, topic, transcript, language } =
        generateBodySchema.parse(req.body);

      // 1. Drive file metadata, with the user's own token.
      // mapGoogleError (inside withDrive) turns a missing file into
      // 404 DRIVE_FILE_NOT_FOUND.
      const file = await withDrive(uid, (drive) =>
        drive.files
          .get({
            fileId: driveFileId,
            fields: "id,name,mimeType,size,videoMediaMetadata",
          })
          .then((r) => r.data),
      );
      const name = file.name ?? "Untitled";
      const mimeType = file.mimeType ?? "";
      if (!isVideoMimeType(mimeType)) {
        throw new HttpError(
          400,
          "NOT_A_VIDEO",
          "The selected file is not a video.",
        );
      }
      const { supported, supportReason } = assessVideoSupport(name, mimeType);
      if (!supported) {
        throw new HttpError(
          400,
          "UNSUPPORTED_VIDEO",
          supportReason ?? "This video format is not supported.",
        );
      }

      const sizeBytes = file.size ? Number.parseInt(file.size, 10) : 0;
      const meta = file.videoMediaMetadata;
      const parsedDuration = meta?.durationMillis
        ? Number.parseInt(meta.durationMillis, 10)
        : NaN;
      const durationMillis = Number.isFinite(parsedDuration)
        ? parsedDuration
        : undefined;

      // 2. Frame extraction (bounded sample; degrades to metadata mode).
      // Token-ownership: the user's own access token, same as Drive routes.
      const accessToken = await getValidAccessToken(uid);
      // exactOptionalPropertyTypes: only set optional fields when present.
      const frameOpts: {
        accessToken: string;
        fileId: string;
        fileName: string;
        durationMillis?: number;
      } = { accessToken, fileId: driveFileId, fileName: name };
      if (durationMillis !== undefined)
        frameOpts.durationMillis = durationMillis;
      const extraction = await extractVideoFrames(frameOpts);

      // 3. Gemini call.
      // Phase 8: the user's per-user model override (settings/{uid})
      // wins when set; missing doc → server default. Best-effort: a
      // read failure never blocks generation.
      const storedSettings = await getStoredSettings(uid);
      const model = resolveGeminiModel(storedSettings);

      const promptInput: {
        fileName: string;
        mimeType: string;
        sizeBytes: number;
        language: string;
        framesUsed: number;
        durationMillis?: number;
        width?: number;
        height?: number;
        topic?: string;
        transcript?: string;
      } = {
        fileName: name,
        mimeType,
        sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : 0,
        language,
        framesUsed: extraction.framesUsed,
      };
      if (durationMillis !== undefined)
        promptInput.durationMillis = durationMillis;
      if (typeof meta?.width === "number") promptInput.width = meta.width;
      if (typeof meta?.height === "number") promptInput.height = meta.height;
      if (topic !== undefined) promptInput.topic = topic;
      if (transcript !== undefined) promptInput.transcript = transcript;
      const promptText = buildMetadataPrompt(promptInput);

      const metadata = await generateGeminiMetadata({
        promptText,
        frames: extraction.frames,
        model,
      });

      logger.info(
        {
          uid,
          fileId: driveFileId,
          analysisMode: extraction.analysisMode,
          framesUsed: extraction.framesUsed,
          model,
        },
        "Gemini metadata generated",
      );

      const payload: GeminiMetadataResult = {
        ...metadata,
        analysisMode: extraction.analysisMode,
        framesUsed: extraction.framesUsed,
      };
      const body: ApiResponse<GeminiMetadataResult> = {
        ok: true,
        data: payload,
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);
