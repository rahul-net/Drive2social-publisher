import { z } from "zod";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import type {
  Destination,
  DuplicateInfo,
  JobError,
  PublishHistory,
  PublishJob,
} from "@drive2social/shared";
import { getDb } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { HttpError } from "../middleware/errorHandler.js";
import { FirebaseNotConfiguredError } from "../lib/firebaseAdmin.js";
import { DRIVE_FILE_ID_PATTERN } from "../routes/drive.js";
import { getDriveVideoMeta } from "../lib/driveVideoMeta.js";
import { getOwnYouTubeChannel } from "./youtube.js";
import {
  uploadVideoToYouTube,
} from "./youtubeUpload.js";
import {
  FACEBOOK_MAX_FILE_SIZE,
  uploadVideoToFacebook,
} from "./facebookUpload.js";
import {
  FacebookPageNotAuthorizedError,
  getMetaTokenDoc,
  getPageToken,
  MetaNotConnectedError,
} from "../lib/metaOAuth.js";

// ============================================================
// Upload queue worker — Phase 7.
//
// Firestore (`publishJobs`) is the source of truth. An in-memory
// worker processes ONE job per user at a time: a Set of active uids
// plus a 2s interval loop that picks the oldest PENDING job for each
// inactive user (also kicked immediately on enqueue / retry).
//
// NOTE (single-process): claiming a job is done synchronously inside
// the tick loop, so no two dispatches can double-claim within this
// process. A multi-instance deployment would need a Firestore
// transaction claim instead — out of scope here; documented, not
// faked.
//
// Cancellation: a best-effort in-memory Set of cancelled jobIds.
// The YouTube/Facebook engines check isJobCancelled() BETWEEN chunks
// (see the chunk loops in youtubeUpload.ts / facebookUpload.ts) and
// settle the job to CANCELLED when they see the flag. Cancellation
// is therefore honest best-effort: a job can still complete between
// the cancel request and the next chunk boundary.
//
// Circular imports (uploadQueue ↔ youtubeUpload/facebookUpload) are
// deliberate and safe: every cross-module reference is a hoisted
// function declaration invoked only at runtime, never at module
// evaluation time.
// ============================================================

// --- zod input -----------------------------------------------------

const destinationSchema = z.enum(["youtube", "facebook"]);

export const enqueuePublishInputSchema = z
  .object({
    driveFileId: z.string().regex(DRIVE_FILE_ID_PATTERN, "Invalid Drive file id"),
    destinations: z
      .array(destinationSchema)
      .min(1, "Choose at least one destination.")
      .max(2)
      .refine((d) => new Set(d).size === d.length, {
        message: "Duplicate destinations.",
      }),
    metadata: z.object({
      title: z.string().trim().min(1).max(255),
      description: z.string().max(5000).default(""),
      tags: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
      caption: z.string().max(63206).default(""),
      hashtags: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
    }),
    settings: z.object({
      privacyStatus: z.enum(["public", "unlisted", "private"]),
      categoryId: z.string().trim().max(16).default(""),
      madeForKids: z.boolean(),
      notifySubscribers: z.boolean(),
      /** Facebook Page id; defaults to the account's selected Page. */
      pageId: z.string().min(1).max(256).optional(),
    }),
    /**
     * Skip the duplicate-publish check. Only ever true after the user
     * explicitly confirmed "publish anyway" on a 409 DUPLICATE_PUBLISH.
     */
    confirmDuplicate: z.boolean().default(false),
  })
  .superRefine((input, ctx) => {
    if (!input.destinations.includes("youtube")) return;
    if (!input.settings.categoryId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["settings", "categoryId"],
        message: "A YouTube category is required when publishing to YouTube.",
      });
    }
    if (input.metadata.title.length > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["metadata", "title"],
        message: "YouTube titles are limited to 100 characters.",
      });
    }
    const total = input.metadata.tags.reduce((n, t) => n + t.length, 0);
    if (total > 500) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["metadata", "tags"],
        message: `Tags exceed YouTube's 500-character total limit (${total} characters).`,
      });
    }
  });

export type EnqueuePublishInput = z.infer<typeof enqueuePublishInputSchema>;

export type EnqueuePublishResult =
  | { ok: true; jobs: PublishJob[] }
  | { ok: false; duplicate: DuplicateInfo };

// --- cancellation flags (best-effort, between chunks) -----------------

const cancelledJobs = new Set<string>();

/**
 * Checked by the upload engines between chunks. True when the user
 * asked to cancel this job while it was actively uploading.
 */
export function isJobCancelled(jobId: string): boolean {
  return cancelledJobs.has(jobId);
}

/** Clear the flag once the engine has settled the job (or the worker releases it). */
export function clearJobCancelled(jobId: string): void {
  cancelledJobs.delete(jobId);
}

/** Called by POST /api/jobs/:jobId/cancel for PROCESSING/UPLOADING jobs. */
export function requestJobCancellation(jobId: string): void {
  cancelledJobs.add(jobId);
}

// --- enqueue -----------------------------------------------------------

interface ResolvedDestination {
  destination: Destination;
  accountId: string;
  accountName: string;
}

/**
 * Look for an existing PUBLISHED history row for the same
 * (user, file, destination, destination account). Single equality
 * filter on driveFileId (automatic single-field index — no composite
 * index needed); the remaining matching happens in memory because a
 * driveFileId is unique per file, so the result set is tiny.
 */
async function findDuplicatePublish(
  db: Firestore,
  uid: string,
  driveFileId: string,
  resolved: ResolvedDestination[],
): Promise<DuplicateInfo | null> {
  const snap = await db
    .collection("publishHistory")
    .where("driveFileId", "==", driveFileId)
    .get();
  for (const doc of snap.docs) {
    const h = doc.data() as PublishHistory;
    if (h.userId !== uid || h.status !== "PUBLISHED") continue;
    const match = resolved.find(
      (r) =>
        r.destination === h.destination &&
        r.accountId === h.destinationAccountId,
    );
    if (match) {
      return {
        destination: h.destination,
        destinationAccountId: h.destinationAccountId,
        destinationAccountName: h.destinationAccountName,
        destinationUrl: h.destinationUrl,
        publishedAt: h.publishedAt,
      };
    }
  }
  return null;
}

/**
 * Validate once, resolve destination accounts, run duplicate
 * protection, create one PENDING publishJobs doc per destination, and
 * kick the worker. Never throws for a duplicate — it returns
 * { ok: false, duplicate } and creates NOTHING (the route layer turns
 * that into HTTP 409). Zod / HttpError throws become 400s via the
 * central error handler.
 */
export async function enqueuePublish(
  uid: string,
  rawInput: unknown,
): Promise<EnqueuePublishResult> {
  const input = enqueuePublishInputSchema.parse(rawInput);

  // Validate the Drive file ONCE for all destinations (supported
  // video, usable byte size).
  const file = await getDriveVideoMeta(uid, input.driveFileId);
  const fileSize = file.size ? Number.parseInt(file.size, 10) : NaN;
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    throw new HttpError(
      400,
      "INVALID_FILE_SIZE",
      "Drive did not report a usable file size for this video. " +
        "Google Workspace documents (Docs/Sheets/Slides) cannot be uploaded.",
    );
  }
  if (
    input.destinations.includes("facebook") &&
    fileSize > FACEBOOK_MAX_FILE_SIZE
  ) {
    throw new HttpError(
      400,
      "FILE_TOO_LARGE",
      "This video is larger than Facebook's 2GB resumable-upload limit.",
    );
  }

  // Resolve the destination account for every destination BEFORE any
  // duplicate check or job creation — fail fast on a missing channel
  // or an unauthorized Page, exactly like the old per-provider routes.
  const resolved: ResolvedDestination[] = [];
  for (const destination of input.destinations) {
    if (destination === "youtube") {
      const channel = await getOwnYouTubeChannel(uid);
      resolved.push({
        destination,
        accountId: channel.channelId,
        accountName: channel.title,
      });
    } else {
      const metaDoc = await getMetaTokenDoc(uid);
      if (!metaDoc) throw new MetaNotConnectedError();
      const pageId = input.settings.pageId ?? metaDoc.selectedPageId;
      if (!pageId) {
        throw new HttpError(
          400,
          "NO_PAGE_SELECTED",
          "No Facebook Page selected. Choose a default Page on the Accounts page, or pass pageId.",
        );
      }
      let pageName: string;
      try {
        pageName = (await getPageToken(uid, pageId)).pageName;
      } catch (err) {
        if (err instanceof FacebookPageNotAuthorizedError) {
          throw new HttpError(403, err.code, err.message);
        }
        throw err;
      }
      resolved.push({ destination, accountId: pageId, accountName: pageName });
    }
  }

  const db = getDb();

  // Duplicate protection (skipped only after explicit user confirm).
  if (!input.confirmDuplicate) {
    const duplicate = await findDuplicatePublish(
      db,
      uid,
      input.driveFileId,
      resolved,
    );
    if (duplicate) {
      logger.info(
        { uid, driveFileId: input.driveFileId, duplicate },
        "enqueuePublish blocked by duplicate protection",
      );
      return { ok: false, duplicate };
    }
  }

  const now = new Date().toISOString();
  const jobs: PublishJob[] = [];
  for (const r of resolved) {
    const job: PublishJob = {
      userId: uid,
      driveFileId: input.driveFileId,
      fileName: file.name,
      fileSize,
      mimeType: file.mimeType,
      destination: r.destination,
      destinationAccountId: r.accountId,
      destinationAccountName: r.accountName,
      metadata: {
        title: input.metadata.title,
        description: input.metadata.description,
        tags: [...input.metadata.tags],
        caption: input.metadata.caption,
        hashtags: [...input.metadata.hashtags],
      },
      settings: {
        privacyStatus: input.settings.privacyStatus,
        categoryId: input.settings.categoryId,
        madeForKids: input.settings.madeForKids,
        notifySubscribers: input.settings.notifySubscribers,
      },
      status: "PENDING",
      progress: 0,
      bytesUploaded: 0,
      bytesTotal: fileSize,
      createdAt: now,
      updatedAt: now,
      retryable: false,
      duplicateConfirmed: input.confirmDuplicate,
    };
    const ref = await db.collection("publishJobs").add(job);
    jobs.push({ ...job, id: ref.id });
    logger.info(
      { uid, jobId: ref.id, destination: r.destination },
      "Publish job enqueued",
    );
  }

  // Kick the worker immediately instead of waiting for the next 2s tick.
  kickWorker();
  return { ok: true, jobs };
}

// --- failed-history writer -----------------------------------------------

/**
 * The engines write PUBLISHED history rows themselves on success, but
 * they only touch the job doc on failure. The worker completes the
 * record: every FAILED terminal state gets a publishHistory row, so
 * GET /api/history is the full story of every attempt. A retried job
 * may legitimately produce more than one FAILED row (one per
 * attempt); `jobId` traces each row back to its job.
 */
async function writeFailedHistory(
  db: Firestore,
  job: PublishJob & { id: string },
  error: JobError,
): Promise<void> {
  const history: PublishHistory = {
    userId: job.userId,
    driveFileId: job.driveFileId,
    fileName: job.fileName,
    destination: job.destination,
    destinationAccountId: job.destinationAccountId,
    destinationAccountName: job.destinationAccountName,
    destinationId: job.destinationId ?? "",
    destinationUrl: job.destinationUrl ?? "",
    status: "FAILED",
    publishedAt: new Date().toISOString(),
    error,
    jobId: job.id,
  };
  await db.collection("publishHistory").add(history);
}

// --- worker --------------------------------------------------------------

const activeUsers = new Set<string>();
const WORKER_INTERVAL_MS = 2000;
/** Upper bound of PENDING docs scanned per tick (sorted in memory). */
const WORKER_SCAN_LIMIT = 100;

let workerDb: Firestore | null = null;
let workerTimer: NodeJS.Timeout | null = null;
/**
 * Phase 8: consecutive tick failures. The first failure logs at
 * warn; repeats log at debug so a persistent Firestore outage does
 * not spam the logs every 2s. Reset to 0 on the next successful tick.
 */
let consecutiveTickFailures = 0;

/**
 * Mark jobs left in PROCESSING/UPLOADING by a previous process as
 * FAILED (retryable). Session URIs are KEPT on the doc so a retry
 * resumes instead of restarting. A FAILED history row is written so
 * the interruption shows up in history too.
 */
async function recoverInterruptedJobs(db: Firestore): Promise<void> {
  // Single-field `in` filter → automatic single-field index.
  const snap = await db
    .collection("publishJobs")
    .where("status", "in", ["PROCESSING", "UPLOADING"])
    .get();
  if (snap.empty) {
    logger.info("Upload queue recovery: no interrupted jobs");
    return;
  }
  const now = new Date().toISOString();
  const error: JobError = {
    code: "SERVER_RESTARTED",
    message: "Server restarted during upload",
  };
  for (const doc of snap.docs) {
    const job = doc.data() as PublishJob;
    try {
      await doc.ref.update({
        status: "FAILED",
        completedAt: now,
        error,
        retryable: true,
        updatedAt: now,
      });
      await writeFailedHistory(db, { ...job, id: doc.id }, error);
      logger.info(
        { jobId: doc.id, userId: job.userId, status: job.status },
        "Upload queue recovery: interrupted job marked FAILED (retryable; session kept for resume)",
      );
    } catch (err) {
      logger.error(
        {
          jobId: doc.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "Upload queue recovery: could not mark interrupted job FAILED",
      );
    }
  }
}

/**
 * Dispatch one claimed job. The engines own the
 * PENDING→PROCESSING→UPLOADING→PUBLISHED/FAILED transitions and the
 * success-history writes; this function only flips PENDING→PROCESSING
 * up front and audits the terminal state afterwards.
 */
async function processJob(jobId: string, uid: string): Promise<void> {
  const db = workerDb;
  if (!db) {
    activeUsers.delete(uid);
    return;
  }
  const jobRef = db.doc(`publishJobs/${jobId}`);
  try {
    const snap = await jobRef.get();
    if (!snap.exists) {
      logger.warn({ jobId }, "Queue worker: job doc vanished; skipping");
      return;
    }
    const job = snap.data() as PublishJob;
    if (job.userId !== uid) {
      logger.error({ jobId }, "Queue worker: uid mismatch; skipping");
      return;
    }
    if (job.status !== "PENDING") {
      // Cancelled (or otherwise moved) between claim and dispatch.
      logger.info(
        { jobId, status: job.status },
        "Queue worker: job no longer PENDING; skipping",
      );
      return;
    }

    const now = new Date().toISOString();
    await jobRef.update({
      status: "PROCESSING",
      startedAt: job.startedAt ?? now,
      updatedAt: now,
      error: FieldValue.delete(),
      retryable: false,
    });

    if (job.destination === "youtube") {
      await uploadVideoToYouTube({
        uid,
        jobId,
        driveFileId: job.driveFileId,
        fileName: job.fileName,
        fileSize: job.fileSize,
        mimeType: job.mimeType,
        metadata: {
          title: job.metadata.title,
          description: job.metadata.description,
          tags: job.metadata.tags,
        },
        settings: {
          privacyStatus: job.settings.privacyStatus,
          categoryId: job.settings.categoryId,
          madeForKids: job.settings.madeForKids,
          notifySubscribers: job.settings.notifySubscribers,
        },
      });
    } else {
      // exactOptionalPropertyTypes: only pass title when non-empty.
      const fbInput: {
        uid: string;
        jobId: string;
        driveFileId: string;
        fileName: string;
        fileSize: number;
        mimeType: string;
        caption: string;
        pageId: string;
        title?: string;
      } = {
        uid,
        jobId,
        driveFileId: job.driveFileId,
        fileName: job.fileName,
        fileSize: job.fileSize,
        mimeType: job.mimeType,
        caption: job.metadata.caption,
        pageId: job.destinationAccountId,
      };
      if (job.metadata.title) fbInput.title = job.metadata.title;
      await uploadVideoToFacebook(fbInput);
    }

    // Post-dispatch audit. The engines always settle the doc to a
    // terminal state before their promise resolves (their promises
    // never reject with a job failure by design). If the doc is NOT
    // terminal here, something unexpected happened (invalid options,
    // vanished doc, Firestore write failure inside the engine) — mark
    // FAILED retryable rather than leaving the job stuck forever, and
    // record it in history.
    const after = await jobRef.get();
    if (!after.exists) {
      logger.error({ jobId }, "Queue worker: job doc vanished after dispatch");
      return;
    }
    const state = (after.data() as PublishJob).status;
    if (state === "FAILED") {
      const failed = after.data() as PublishJob;
      await writeFailedHistory(
        db,
        { ...failed, id: jobId },
        failed.error ?? {
          code: "UPLOAD_FAILED",
          message: "The upload failed.",
        },
      );
    } else if (state !== "PUBLISHED" && state !== "CANCELLED") {
      const failure: JobError = {
        code: "ENGINE_STATE_UNKNOWN",
        message:
          "The upload engine stopped without recording an outcome. " +
          "It can be retried — a retry resumes from the saved session when one exists.",
      };
      const ts = new Date().toISOString();
      await jobRef.update({
        status: "FAILED",
        completedAt: ts,
        error: failure,
        retryable: true,
        updatedAt: ts,
      });
      const refetched = await jobRef.get();
      if (refetched.exists) {
        await writeFailedHistory(
          db,
          { ...(refetched.data() as PublishJob), id: jobId },
          failure,
        );
      }
    }
  } catch (err) {
    // Safety net only — the engines record their own job failures on
    // the doc. This catches worker-level surprises (e.g. Firestore
    // dying mid-dispatch).
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ jobId, err: message }, "Queue worker: unexpected dispatch failure");
    try {
      const failure: JobError = {
        code: "QUEUE_WORKER_ERROR",
        message: `The queue worker hit an unexpected error: ${message}. It can be retried.`,
      };
      const ts = new Date().toISOString();
      await jobRef.update({
        status: "FAILED",
        completedAt: ts,
        error: failure,
        retryable: true,
        updatedAt: ts,
      });
      const refetched = await jobRef.get();
      if (refetched.exists) {
        await writeFailedHistory(
          db,
          { ...(refetched.data() as PublishJob), id: jobId },
          failure,
        );
      }
    } catch (persistErr) {
      logger.error(
        {
          jobId,
          err:
            persistErr instanceof Error ? persistErr.message : String(persistErr),
        },
        "Queue worker: could not persist failure",
      );
    }
  } finally {
    activeUsers.delete(uid);
    clearJobCancelled(jobId);
    // Look for this user's next job immediately instead of waiting
    // for the next 2s tick.
    void tick();
  }
}

/**
 * One loop pass: pick the oldest PENDING job for each inactive user.
 * Single equality filter (automatic index); ordering happens in
 * memory, oldest first. The claim (activeUsers.add) is synchronous
 * inside the loop, so no double-dispatch within this process.
 */
async function tick(): Promise<void> {
  const db = workerDb;
  if (!db) return;
  try {
    const snap = await db
      .collection("publishJobs")
      .where("status", "==", "PENDING")
      .limit(WORKER_SCAN_LIMIT)
      .get();
    const pending = snap.docs
      .map((d) => ({ ...(d.data() as PublishJob), id: d.id }))
      .filter((j) => !activeUsers.has(j.userId))
      .sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
      );
    for (const job of pending) {
      if (activeUsers.has(job.userId)) continue;
      activeUsers.add(job.userId);
      void processJob(job.id, job.userId);
    }
    consecutiveTickFailures = 0;
  } catch (err) {
    // Phase 8: don't spam the logs when Firestore is down — warn
    // once, then debug for repeats.
    consecutiveTickFailures += 1;
    const detail = {
      err: err instanceof Error ? err.message : String(err),
    };
    if (consecutiveTickFailures === 1) {
      logger.warn(
        detail,
        "Upload queue tick failed (further failures logged at debug)",
      );
    } else {
      logger.debug(detail, "Upload queue tick failed");
    }
  }
}

// --- lifecycle -------------------------------------------------------------

/**
 * Start the worker: run boot recovery, then the 2s loop. Never throws
 * when Firebase isn't configured — logs a warning and stays idle
 * (auth-protected routes answer 503 AUTH_NOT_CONFIGURED in that
 * state; boot must not crash).
 */
export function startUploadQueueWorker(): void {
  try {
    workerDb = getDb();
  } catch (err) {
    if (err instanceof FirebaseNotConfiguredError) {
      logger.warn(
        "Upload queue worker not started: Firebase Admin is not configured. " +
          "Boot continues; the worker stays idle until credentials exist.",
      );
      return;
    }
    throw err;
  }
  recoverInterruptedJobs(workerDb).catch((err: unknown) => {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Upload queue recovery failed",
    );
  });
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    void tick();
  }, WORKER_INTERVAL_MS);
  void tick();
  logger.info(
    { intervalMs: WORKER_INTERVAL_MS },
    "Upload queue worker started (one job per user at a time)",
  );
}

/** Stop the 2s loop. In-flight uploads keep running to their next chunk boundary. */
export function stopUploadQueueWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
    logger.info("Upload queue worker stopped");
  }
  workerDb = null;
}

/**
 * Wake the loop immediately (called after enqueue / retry). No-op
 * when the worker isn't running.
 */
export function kickWorker(): void {
  if (workerDb && workerTimer) {
    void tick();
  }
}
