import { Router } from "express";
import { z } from "zod";
import { FieldValue, type DocumentReference } from "firebase-admin/firestore";
import type {
  ApiResponse,
  CancelJobResponse,
  JobsListResponse,
  PublishJob,
} from "@drive2social/shared";
import {
  requireAuth,
  type AuthenticatedRequest,
} from "../middleware/requireAuth.js";
import { HttpError } from "../middleware/errorHandler.js";
import { requireUid } from "../lib/authRequest.js";
import { getDb } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { sanitizeJob } from "../lib/sanitizeJob.js";
import {
  paginate,
  paginationQuerySchema,
} from "../lib/pagination.js";
import {
  clearJobCancelled,
  kickWorker,
  requestJobCancellation,
} from "../services/uploadQueue.js";

// ============================================================
// Publish-job queue API — mounted at /api/jobs (Phase 7).
//
//   GET  /                    — paginated jobs, newest first
//   GET  /:jobId              — one job
//   POST /:jobId/retry        — FAILED+retryable → PENDING (resume)
//   POST /:jobId/cancel       — PENDING → CANCELLED now; active
//                               uploads get a best-effort cancel flag
//
// Token ownership everywhere: a user can only see/touch their own
// jobs — another user's jobId answers 404, never 403, to avoid
// leaking existence. All job payloads are SANITIZED (server-only
// resumable-session fields stripped).
// ============================================================

export const jobsRouter = Router();

const jobIdParamSchema = z.object({
  jobId: z.string().min(1).max(256),
});

/** Fetch a job doc with ownership check; 404 when missing or foreign. */
async function getOwnedJob(
  uid: string,
  jobId: string,
): Promise<{ ref: DocumentReference; job: PublishJob }> {
  const ref = getDb().doc(`publishJobs/${jobId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpError(404, "JOB_NOT_FOUND", "Publish job not found.");
  }
  const job = snap.data() as PublishJob;
  if (job.userId !== uid) {
    throw new HttpError(404, "JOB_NOT_FOUND", "Publish job not found.");
  }
  return { ref, job };
}

// --- GET /api/jobs ------------------------------------------------------------

jobsRouter.get(
  "/",
  requireAuth,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const uid = requireUid(req);
      const query = paginationQuerySchema.parse(req.query);
      // Single equality filter (automatic index); newest-first
      // ordering happens in memory. See lib/pagination.ts.
      const snap = await getDb()
        .collection("publishJobs")
        .where("userId", "==", uid)
        .get();
      const sorted = snap.docs
        .map((d) => ({ ...(d.data() as PublishJob), id: d.id }))
        .sort((a, b) =>
          a.createdAt > b.createdAt
            ? -1
            : a.createdAt < b.createdAt
              ? 1
              : a.id < b.id
                ? -1
                : 1,
        );
      const page = paginate(sorted, (j) => j.id, query);
      const body: ApiResponse<JobsListResponse> = {
        ok: true,
        data: {
          jobs: page.items.map((j) => sanitizeJob(j)),
          nextCursor: page.nextCursor,
        },
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);

// --- GET /api/jobs/:jobId -----------------------------------------------------

jobsRouter.get(
  "/:jobId",
  requireAuth,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const uid = requireUid(req);
      const { jobId } = jobIdParamSchema.parse(req.params);
      const { job } = await getOwnedJob(uid, jobId);
      const body: ApiResponse<PublishJob> = {
        ok: true,
        data: sanitizeJob({ ...job, id: jobId }),
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);

// --- POST /api/jobs/:jobId/retry ----------------------------------------------

/**
 * Retry a failed job. Only FAILED jobs marked retryable can be
 * retried — auth/permission failures are retryable=false and are
 * rejected here server-side (400 NOT_RETRYABLE), so a retry can never
 * spin on credentials the user must fix by reconnecting. The reset
 * keeps the stored session URIs so the retry RESUMES instead of
 * restarting from byte 0, then kicks the worker.
 */
jobsRouter.post(
  "/:jobId/retry",
  requireAuth,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const uid = requireUid(req);
      const { jobId } = jobIdParamSchema.parse(req.params);
      const { ref, job } = await getOwnedJob(uid, jobId);
      if (job.status !== "FAILED" || job.retryable !== true) {
        throw new HttpError(
          400,
          "NOT_RETRYABLE",
          "This job cannot be retried. Only failed jobs marked retryable " +
            "can be retried — reconnect the account for auth/permission failures.",
        );
      }
      const now = new Date().toISOString();
      await ref.update({
        status: "PENDING",
        error: FieldValue.delete(),
        completedAt: FieldValue.delete(),
        retryable: false,
        updatedAt: now,
      });
      logger.info({ uid, jobId }, "Publish job queued for retry");
      kickWorker();
      const snap = await ref.get();
      const body: ApiResponse<PublishJob> = {
        ok: true,
        data: sanitizeJob({ ...((snap.data() as PublishJob) ?? job), id: jobId }),
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);

// --- POST /api/jobs/:jobId/cancel --------------------------------------------

/**
 * Cancel a job. PENDING → CANCELLED immediately. PROCESSING/UPLOADING
 * → best-effort: a cancellation flag is set and the upload engine
 * settles the job to CANCELLED at its next chunk boundary (see
 * services/uploadQueue.ts). Already-terminal jobs → 400.
 */
jobsRouter.post(
  "/:jobId/cancel",
  requireAuth,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const uid = requireUid(req);
      const { jobId } = jobIdParamSchema.parse(req.params);
      const { ref, job } = await getOwnedJob(uid, jobId);
      const now = new Date().toISOString();

      if (job.status === "PENDING") {
        await ref.update({
          status: "CANCELLED",
          completedAt: now,
          error: FieldValue.delete(),
          updatedAt: now,
        });
        clearJobCancelled(jobId);
        logger.info({ uid, jobId }, "Pending publish job cancelled");
        const body: ApiResponse<CancelJobResponse> = {
          ok: true,
          data: {
            job: sanitizeJob({ ...job, id: jobId, status: "CANCELLED", completedAt: now }),
            cancellationRequested: false,
          },
        };
        res.json(body);
        return;
      }

      if (job.status === "PROCESSING" || job.status === "UPLOADING") {
        // Best-effort: the engine checks the flag between chunks.
        requestJobCancellation(jobId);
        logger.info(
          { uid, jobId, status: job.status },
          "Cancellation requested for active upload (best-effort, between chunks)",
        );
        const body: ApiResponse<CancelJobResponse> = {
          ok: true,
          data: {
            job: sanitizeJob({ ...job, id: jobId }),
            cancellationRequested: true,
          },
        };
        res.json(body);
        return;
      }

      throw new HttpError(
        400,
        "JOB_NOT_CANCELLABLE",
        `This job is already ${job.status.toLowerCase()} and cannot be cancelled.`,
      );
    } catch (err) {
      next(err);
    }
  },
);
