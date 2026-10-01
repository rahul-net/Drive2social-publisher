import { Router } from "express";
import type {
  ApiResponse,
  DuplicatePublishErrorBody,
  PublishEnqueueResponse,
} from "@drive2social/shared";
import {
  requireAuth,
  type AuthenticatedRequest,
} from "../middleware/requireAuth.js";
import { requireUid } from "../lib/authRequest.js";
import { sanitizeJob } from "../lib/sanitizeJob.js";
import { publishLimiter } from "../lib/rateLimit.js";
import { enqueuePublish } from "../services/uploadQueue.js";

// ============================================================
// Unified publish endpoint — mounted at /api/publish (Phase 7).
//
//   POST / — validate → duplicate-protect → enqueue one job per
//             destination → 202 with the PENDING jobs.
//             Rate-limited to 30/hour per user (publishLimiter, applied
//             after requireAuth so the key is the Firebase uid).
//
// Duplicate: HTTP 409 with the documented DUPLICATE_PUBLISH shape
// (the `duplicate` object nested inside `error`), including the URL
// of the already-published post so the UI can link to it.
// ============================================================

export const publishRouter = Router();

type PublishErrorBody = {
  code: string;
  message: string;
  duplicate?: DuplicatePublishErrorBody["duplicate"];
};

publishRouter.post(
  "/",
  requireAuth,
  publishLimiter,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const uid = requireUid(req);
      const result = await enqueuePublish(uid, req.body);

      if (!result.ok) {
        const label =
          result.duplicate.destination === "youtube" ? "YouTube" : "Facebook";
        const body: { ok: false; error: PublishErrorBody } = {
          ok: false,
          error: {
            code: "DUPLICATE_PUBLISH",
            message: `This video has already been published to ${label}.`,
            duplicate: result.duplicate,
          },
        };
        res.status(409).json(body);
        return;
      }

      const data: PublishEnqueueResponse = {
        jobs: result.jobs.map((j) => sanitizeJob(j)),
      };
      const body: ApiResponse<PublishEnqueueResponse> = { ok: true, data };
      res.status(202).json(body);
    } catch (err) {
      next(err);
    }
  },
);
