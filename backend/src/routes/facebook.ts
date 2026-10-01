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
import { DRIVE_FILE_ID_PATTERN } from "./drive.js";

// ============================================================
// Facebook Page publishing — mounted at /api/facebook.
//
// Token ownership: every call resolves the Page access token from
// `connectedAccounts/{uid}_meta` for req.user.uid — a user can only
// ever publish to their own granted Pages, and only to Pages where
// they hold the CREATE_CONTENT task.
//
//   POST /upload        — enqueue via the Phase 7 queue worker
//                          (single destination; 202)
//   GET  /jobs/:jobId   — poll one job (the frontend's useJobsLive
//                          hook tries Firestore onSnapshot first and
//                          falls back to polling; this route serves
//                          both the fallback and single-job views)
//
// Job responses are SANITIZED via lib/sanitizeJob: the server-only
// resumable session fields never leave the backend.
// ============================================================

export const facebookRouter = Router();

const uploadBodySchema = z.object({
  driveFileId: z.string().regex(DRIVE_FILE_ID_PATTERN, "Invalid Drive file id"),
  /** Defaults to the account's selectedPageId. */
  pageId: z.string().min(1).max(256).optional(),
  /** Post text — sent as the Facebook video "description". */
  caption: z.string().max(63206),
  /** Optional; defaults to the Drive file name without extension. */
  title: z.string().trim().min(1).max(255).optional(),
});

/**
 * Start a Facebook Page upload (single destination). Phase 7 replaced
 * the old fire-and-forget background start with the unified queue
 * worker: this route now funnels through enqueuePublish, gaining
 * duplicate protection (409), the 2s worker loop, retry, and
 * cancellation. The response contract is unchanged: 202 with the
 * PENDING job.
 *
 * NOTE (Phase 7): the fire-and-forget code path below was replaced
 * by the queue worker (services/uploadQueue.ts).
 */
facebookRouter.post(
  "/upload",
  requireAuth,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const uid = requireUid(req);
      const parsed = uploadBodySchema.parse(req.body);

      const result = await enqueuePublish(uid, {
        driveFileId: parsed.driveFileId,
        destinations: ["facebook"],
        metadata: {
          // The raw upload carries only the Facebook fields the user
          // supplied; the wizard (Phase 7) sends the full metadata.
          title: parsed.title ?? "",
          description: parsed.caption,
          tags: [],
          caption: parsed.caption,
          hashtags: [],
        },
        settings: {
          // Facebook Page videos are public by default; the API
          // exposes no privacy setting for Page video uploads, so the
          // YouTube-oriented settings are inert placeholders here.
          privacyStatus: "public",
          categoryId: "",
          madeForKids: false,
          notifySubscribers: false,
          ...(parsed.pageId !== undefined ? { pageId: parsed.pageId } : {}),
        },
      });

      if (!result.ok) {
        res.status(409).json({
          ok: false,
          error: {
            code: "DUPLICATE_PUBLISH",
            message: "This video has already been published to Facebook.",
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

// --- GET /api/facebook/jobs/:jobId --------------------------------------------

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
facebookRouter.get(
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
