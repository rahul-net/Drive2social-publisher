import { Router } from "express";
import { z } from "zod";
import type { ApiResponse, PublishJob } from "@drive2social/shared";
import {
  requireAuth,
  type AuthenticatedRequest,
} from "../middleware/requireAuth.js";
import { HttpError } from "../middleware/errorHandler.js";
import { requireUid } from "../lib/authRequest.js";
import { getDb } from "../lib/db.js";
import { sanitizeJob } from "../lib/sanitizeJob.js";
import { enqueuePublish } from "../services/uploadQueue.js";
import {
  getOwnYouTubeChannel,
  listVideoCategories,
  type YouTubeChannelInfo,
  type YouTubeVideoCategory,
} from "../services/youtube.js";
import {
  youtubeMetadataSchema,
  youtubeSettingsSchema,
} from "../services/youtubeUpload.js";
import { DRIVE_FILE_ID_PATTERN } from "./drive.js";

// Phase 7: getDriveVideoMeta moved to lib/driveVideoMeta.ts so the
// queue worker can share it without a route↔service import cycle.
// Re-exported here so existing importers (routes/facebook.ts) keep
// working unchanged.
export { getDriveVideoMeta } from "../lib/driveVideoMeta.js";
export type { DriveVideoMeta } from "../lib/driveVideoMeta.js";

// ============================================================
// YouTube routes — mounted at /api/youtube.
//
// Token ownership: every call resolves the access token from
// `connectedAccounts/{uid}_google` for req.user.uid — a user can only
// ever touch their own channel and their own jobs.
//
//   GET  /channel                 — own channel info (card data)
//   GET  /categories?regionCode=  — assignable video categories
//   POST /upload                  — enqueue via the Phase 7 queue worker
//                                    (single destination; 202)
//   GET  /jobs/:jobId             — poll one job (the frontend's
//                                    useJobsLive hook tries Firestore
//                                    onSnapshot first and falls back to
//                                    polling; this route serves both the
//                                    fallback and single-job views)
//
// Job responses are SANITIZED: the server-only uploadSessionUri never
// leaves the backend.
// ============================================================

export const youtubeRouter = Router();

// Job responses are SANITIZED via lib/sanitizeJob: the server-only
// uploadSessionUri never leaves the backend.

// --- GET /api/youtube/channel -------------------------------------------

/**
 * The user's own YouTube channel.
 * 403 YOUTUBE_NOT_CONNECTED when the YouTube scopes were never granted
 * (reconnect hint included); 404 NO_YOUTUBE_CHANNEL when the Google
 * account has no channel.
 */
youtubeRouter.get(
  "/channel",
  requireAuth,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const uid = requireUid(req);
      const channel = await getOwnYouTubeChannel(uid);
      const body: ApiResponse<YouTubeChannelInfo> = { ok: true, data: channel };
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);

// --- GET /api/youtube/categories ------------------------------------------

const categoriesQuerySchema = z.object({
  regionCode: z
    .string()
    .regex(/^[A-Za-z]{2}$/, "regionCode must be a 2-letter country code")
    .default("US"),
});

/** Assignable YouTube video categories for a region (default US). */
youtubeRouter.get(
  "/categories",
  requireAuth,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const uid = requireUid(req);
      const { regionCode } = categoriesQuerySchema.parse(req.query);
      const categories = await listVideoCategories(
        uid,
        regionCode.toUpperCase(),
      );
      const body: ApiResponse<YouTubeVideoCategory[]> = {
        ok: true,
        data: categories,
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);

// --- POST /api/youtube/upload -----------------------------------------------

const uploadBodySchema = z.object({
  driveFileId: z.string().regex(DRIVE_FILE_ID_PATTERN, "Invalid Drive file id"),
  metadata: youtubeMetadataSchema,
  settings: youtubeSettingsSchema,
});

/**
 * Start a YouTube upload (single destination). Phase 7 replaced the
 * old fire-and-forget background start with the unified queue worker:
 * this route now funnels through enqueuePublish, gaining duplicate
 * protection (409), the 2s worker loop, retry, and cancellation.
 * The response contract is unchanged: 202 with the PENDING job.
 */
youtubeRouter.post(
  "/upload",
  requireAuth,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const uid = requireUid(req);
      const { driveFileId, metadata, settings } = uploadBodySchema.parse(
        req.body,
      );

      const result = await enqueuePublish(uid, {
        driveFileId,
        destinations: ["youtube"],
        metadata: {
          title: metadata.title,
          description: metadata.description,
          tags: metadata.tags,
          caption: "",
          hashtags: [],
        },
        settings: {
          privacyStatus: settings.privacyStatus,
          categoryId: settings.categoryId,
          madeForKids: settings.madeForKids,
          notifySubscribers: settings.notifySubscribers,
        },
      });

      if (!result.ok) {
        res.status(409).json({
          ok: false,
          error: {
            code: "DUPLICATE_PUBLISH",
            message: "This video has already been published to YouTube.",
            duplicate: result.duplicate,
          },
        });
        return;
      }

      const body: ApiResponse<PublishJob> = {
        ok: true,
        data: sanitizeJob(result.jobs[0]),
      };
      res.status(202).json(body);
    } catch (err) {
      next(err);
    }
  },
);

// --- GET /api/youtube/jobs/:jobId --------------------------------------------

const jobIdParamSchema = z.object({
  jobId: z.string().min(1).max(256),
});

/**
 * One publish job for progress polling (the Phase 7 onSnapshot live
 * updates replace this as the primary mechanism; this stays as the
 * fallback). Token-ownership: a user can only read their own jobs —
 * another user's jobId answers 404, never 403, to avoid leaking
 * existence.
 */
youtubeRouter.get(
  "/jobs/:jobId",
  requireAuth,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const uid = requireUid(req);
      const { jobId } = jobIdParamSchema.parse(req.params);
      const snap = await getDb().doc(`publishJobs/${jobId}`).get();
      if (!snap.exists) {
        throw new HttpError(404, "JOB_NOT_FOUND", "Publish job not found.");
      }
      const data = snap.data() as PublishJob;
      if (data.userId !== uid) {
        throw new HttpError(404, "JOB_NOT_FOUND", "Publish job not found.");
      }
      const body: ApiResponse<PublishJob> = {
        ok: true,
        data: sanitizeJob({ id: jobId, ...data }),
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);
