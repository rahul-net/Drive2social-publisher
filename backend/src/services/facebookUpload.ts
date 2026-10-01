import { z } from "zod";
import { FieldValue } from "firebase-admin/firestore";
import type { PublishHistory, PublishJob } from "@drive2social/shared";
import { config } from "../config.js";
import { getDb } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { HttpError } from "../middleware/errorHandler.js";
import { getValidAccessToken } from "../lib/googleOAuth.js";
import {
  extractMetaError,
  getMetaTokenDoc,
  getPageToken,
  FacebookPageNotAuthorizedError,
  MetaNotConnectedError,
} from "../lib/metaOAuth.js";
import { isJobCancelled, clearJobCancelled } from "./uploadQueue.js";

// ============================================================
// Facebook Page video upload engine — Phase 5.
//
// Exported entry point for Phase 7's queue worker:
//   uploadVideoToFacebook(opts) -> Promise<void>
// The outcome is ALWAYS recorded on the publishJobs/{jobId} doc
// (PUBLISHED or FAILED); the promise itself never rejects with a
// job failure, so fire-and-forget callers are safe.
//
// Upload protocol — VERIFIED 2026-10-01 against Meta's current docs:
//   Video API publishing guide:
//     https://developers.facebook.com/docs/video-api/guides/publishing/
//   Page Videos reference (upload_phase {start,transfer,finish,cancel},
//   title + description params, CREATE_CONTENT task + pages_show_list /
//   pages_read_engagement / pages_manage_posts):
//     https://developers.facebook.com/docs/graph-api/reference/page/videos/
//   Resumable-upload phase details (mirror of the Meta docs):
//     https://github.com/restfb/restfb.github.io/blob/HEAD/_includes/documentation/publishing-big-video.md
//   Graph API versions (v22.0 supported until 2027-05-20; latest
//   stable v26.0):
//     https://developers.facebook.com/docs/graph-api/changelog/
//
//   1. POST https://graph-video.facebook.com/v<VER>/{page-id}/videos
//      form fields: upload_phase=start, file_size (+ access_token)
//      → {video_id, upload_session_id, start_offset, end_offset}.
//      (Meta's own publishing guide sample curl uses the
//      graph-video.facebook.com host; one third-party writeup claims
//      it is deprecated, but Meta's current official docs still use
//      it, so we follow the official docs.)
//   2. POST same URL, multipart: upload_phase=transfer,
//      upload_session_id, start_offset, video_file_chunk (+ token).
//      The server answers with the next {start_offset, end_offset} —
//      the loop always follows the SERVER's offsets, never its own
//      arithmetic. Sequential chunks only.
//   3. POST same URL: upload_phase=finish, upload_session_id, title,
//      description (+ token). THE FINISH PHASE IS THE PUBLISH STEP:
//      per the Page Videos reference, title/description are params of
//      the /{page-id}/videos edge and finish commits (publishes) the
//      video. There is no separate "publish" call for Page videos.
//   4. Poll GET https://graph.facebook.com/v<VER>/{video-id}
//      ?fields=status until status.publishing_phase.status is
//      "complete" / "error" or ~5 minutes pass.
//
// Bytes stream from Drive via
//   GET https://www.googleapis.com/drive/v3/files/{id}?alt=media
// with Range headers (the user's Google access token) — the whole
// file is never in memory.
//
// Resume: (uploadSessionId, videoId) are persisted on the job doc as
// facebookUploadSessionId / facebookVideoId. Meta documents NO
// session-status probe (unlike YouTube's 308 probe), so resume is
// best-effort: a retry continues the transfer loop from bytesUploaded
// with the stored session; if the FIRST resumed transfer fails for
// any reason the session is treated as dead and a fresh session
// starts from byte 0. This never corrupts: the server drives offsets.
//
// Progress on the job doc (bytesUploaded/bytesTotal/progress) always
// reflects ACTUAL bytes the server confirmed via returned offsets.
//
// Tokens and session ids are never logged (they are never
// interpolated into log fields).
// ============================================================

/** 8MB chunks — Meta's published default for resumable uploads. */
export const FACEBOOK_UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;

/** Facebook post text limit (docs: 63,206 characters per post). */
const MAX_CAPTION_LEN = 63206;
/** No documented max for Page video titles; 255 is a sane, honest cap. */
const MAX_TITLE_LEN = 255;
/** Resumable uploads support "about 2GB" per the mirrored Meta docs. Exported for Phase 7's queue worker, which rejects oversized files at enqueue time instead of letting the job get stuck. */
export const FACEBOOK_MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;

const POLL_INTERVAL_MS = 15_000;
/** ~5 minutes of processing wait, per the phase spec. */
const POLL_TIMEOUT_MS = 5 * 60_000;

// --- zod validation -------------------------------------------------

export const facebookUploadOptionsSchema = z.object({
  uid: z.string().min(1),
  jobId: z.string().min(1),
  driveFileId: z.string().min(1),
  fileName: z.string().min(1),
  fileSize: z.number().int().positive().max(FACEBOOK_MAX_FILE_SIZE),
  mimeType: z.string().min(1),
  caption: z.string().max(MAX_CAPTION_LEN),
  title: z.string().trim().min(1).max(MAX_TITLE_LEN).optional(),
  pageId: z.string().min(1),
});

export type FacebookUploadOptions = z.infer<typeof facebookUploadOptionsSchema>;

// --- small pure helpers ----------------------------------------------

/** progress 0–100 from actual streamed bytes. */
function uploadProgress(bytesUploaded: number, bytesTotal: number): number {
  if (
    !Number.isFinite(bytesUploaded) ||
    !Number.isFinite(bytesTotal) ||
    bytesTotal <= 0
  ) {
    return 0;
  }
  return Math.max(
    0,
    Math.min(100, Math.floor((bytesUploaded / bytesTotal) * 100)),
  );
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Default title when the caller omits one: file name without extension. */
function defaultTitle(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "").trim();
  return base.slice(0, MAX_TITLE_LEN) || "Untitled video";
}

function graphVideoBase(): string {
  return `https://graph-video.facebook.com/${config.META_GRAPH_VERSION}`;
}

function graphBase(): string {
  return `https://graph.facebook.com/${config.META_GRAPH_VERSION}`;
}

// --- failure classification --------------------------------------------

export interface ClassifiedFailure {
  code: string;
  message: string;
  retryable: boolean;
}

/** Job-level failure carrying the bookkeeping decision. */
export class JobFailureError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(failure: ClassifiedFailure) {
    super(failure.message);
    this.name = "JobFailureError";
    this.code = failure.code;
    this.retryable = failure.retryable;
  }
}

function networkFailure(what: string, err: unknown): ClassifiedFailure {
  return {
    code: "FACEBOOK_NETWORK_ERROR",
    message: `${what}: network error contacting the server (${err instanceof Error ? err.message : "unknown"}). The upload can be retried — it will resume from the saved session.`,
    retryable: true,
  };
}

/**
 * Map a Meta Graph API error to a job decision.
 *   - OAuthException code 190 (bad/expired/invalid token) →
 *     FACEBOOK_REAUTH_REQUIRED, retryable=false (retries can't fix
 *     auth; the user must reconnect).
 *   - Permission errors (code 200 "Permissions error", code 10 "API
 *     permission denied") → FACEBOOK_PERMISSION_DENIED naming the
 *     missing permission/task, retryable=false.
 *   - Rate limits (code 4 "API Too Many Calls", 17 "User request limit
 *     reached", 32 "Page request limit reached") →
 *     FACEBOOK_RATE_LIMITED, retryable=true.
 *   - 5xx → retryable=true. Other 4xx → retryable=false.
 */
function classifyMetaFailure(
  httpStatus: number,
  meta: { code: number | undefined; type: string | undefined; message: string },
  what: string,
): ClassifiedFailure {
  const code = meta.code;
  if (code === 190) {
    return {
      code: "FACEBOOK_REAUTH_REQUIRED",
      message:
        "The Facebook connection expired or was revoked. Reconnect Facebook on the Accounts page — retrying will not help.",
      retryable: false,
    };
  }
  if (code === 200 || code === 10) {
    return {
      code: "FACEBOOK_PERMISSION_DENIED",
      message:
        `${what}: Meta refused the request (${meta.message}). ` +
        "Page video publishing needs the pages_manage_posts permission and the CREATE_CONTENT task on the Page. " +
        "Check the app's granted permissions and the Page's task assignments, then reconnect if needed. Retrying will not help.",
      retryable: false,
    };
  }
  if (code === 4 || code === 17 || code === 32) {
    return {
      code: "FACEBOOK_RATE_LIMITED",
      message: `${what}: Meta rate-limited the request (${meta.message}). The upload can be retried later — it will resume from the saved session.`,
      retryable: true,
    };
  }
  if (httpStatus >= 500) {
    return {
      code: "FACEBOOK_API_ERROR",
      message: `${what}: Meta returned HTTP ${httpStatus} (${meta.message}). The upload can be retried — it will resume from the saved session.`,
      retryable: true,
    };
  }
  return {
    code: "FACEBOOK_API_ERROR",
    message: `${what}: Meta returned HTTP ${httpStatus} (${meta.message}). This looks like a request problem, not a transient one — retrying will not help.`,
    retryable: false,
  };
}

/** Normalize any throw into a job-bookkeeping decision. */
function toJobFailure(err: unknown): ClassifiedFailure {
  if (err instanceof JobFailureError) {
    return { code: err.code, message: err.message, retryable: err.retryable };
  }
  if (
    err instanceof FacebookPageNotAuthorizedError ||
    err instanceof MetaNotConnectedError
  ) {
    return { code: err.code, message: err.message, retryable: false };
  }
  if (err instanceof HttpError) {
    return {
      code: err.code,
      message: err.message,
      retryable: err.status === 429 || err.status >= 500,
    };
  }
  return {
    code: "UPLOAD_INTERNAL_ERROR",
    message:
      "The upload failed unexpectedly. It can be retried — it will resume from the saved session.",
    retryable: true,
  };
}

/**
 * Retry a chunk operation up to 3 times with exponential backoff, but
 * ONLY when the failure is classified retryable (network / 5xx /
 * rate-limit). Non-retryable failures (reauth, permission, bad
 * request) throw immediately — never a blind retry loop.
 */
async function withChunkRetries<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      const retryable = err instanceof JobFailureError && err.retryable;
      if (!retryable || attempt >= 3) throw err;
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
}

// --- Drive chunk streaming -----------------------------------------------

/**
 * Fetch one byte range from Drive — streamed, never the whole file.
 * Uses the user's Google access token (Drive is a Google connection;
 * Facebook publishing still sources bytes from Drive).
 */
async function fetchDriveChunk(
  googleToken: string,
  driveFileId: string,
  start: number,
  end: number,
): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveFileId)}?alt=media`,
      {
        headers: {
          Authorization: `Bearer ${googleToken}`,
          Range: `bytes=${start}-${end}`,
        },
      },
    );
  } catch (err) {
    throw new JobFailureError(networkFailure("Drive chunk download", err));
  }
  if (res.status !== 206 && res.status !== 200) {
    const code: ClassifiedFailure =
      res.status === 404
        ? {
            code: "FACEBOOK_DRIVE_FILE_MISSING",
            message:
              "The Drive file is gone or no longer accessible. Pick the video again — retrying will not help.",
            retryable: false,
          }
        : res.status === 401 || res.status === 403
          ? {
              code: "FACEBOOK_DRIVE_ACCESS_DENIED",
              message:
                "Drive refused access to this file (HTTP " +
                `${res.status}). Reconnect Google Drive — retrying will not help.`,
              retryable: false,
            }
          : {
              code: "FACEBOOK_DRIVE_ERROR",
              message: `Drive returned HTTP ${res.status} while fetching the video. The upload can be retried — it will resume from the saved session.`,
              retryable: true,
            };
    throw new JobFailureError(code);
  }
  const ab = await res.arrayBuffer();
  if (ab.byteLength === 0) {
    throw new JobFailureError({
      code: "FACEBOOK_NETWORK_ERROR",
      message:
        "Drive returned an empty chunk. The upload can be retried — it will resume from the saved session.",
      retryable: true,
    });
  }
  return ab;
}

// --- resumable session (Meta) --------------------------------------------

// Meta returns these ids/offsets as numeric strings; accept both.
const idLike = z.union([z.string(), z.number()]).transform((v) => String(v));
const offsetLike = z
  .union([z.string(), z.number()])
  .transform((v) => Number(v))
  .refine((n) => Number.isFinite(n) && n >= 0, "invalid offset");

const startResponseSchema = z.object({
  video_id: idLike,
  upload_session_id: idLike,
  start_offset: offsetLike,
  end_offset: offsetLike,
});

const transferResponseSchema = z.object({
  start_offset: offsetLike,
  end_offset: offsetLike,
});

const finishResponseSchema = z.object({
  success: z.boolean().optional(),
  id: idLike.optional(),
  video_id: idLike.optional(),
});

interface ResumableSession {
  videoId: string;
  uploadSessionId: string;
}

async function postVideoEdge(
  pageId: string,
  body: URLSearchParams | FormData,
  what: string,
): Promise<Response> {
  const url = `${graphVideoBase()}/${encodeURIComponent(pageId)}/videos`;
  try {
    return await fetch(url, { method: "POST", body });
  } catch (err) {
    throw new JobFailureError(networkFailure(what, err));
  }
}

function throwMetaFailure(
  res: Response,
  body: unknown,
  what: string,
): never {
  throw new JobFailureError(
    classifyMetaFailure(res.status, extractMetaError(res, body), what),
  );
}

function form(params: Record<string, string>): URLSearchParams {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) sp.set(k, v);
  return sp;
}

/**
 * Phase 1 — start: tell Meta the file size, get
 * {video_id, upload_session_id, start_offset, end_offset}.
 */
async function startUploadSession(
  pageId: string,
  pageToken: string,
  fileSize: number,
): Promise<ResumableSession & { startOffset: number; endOffset: number }> {
  const res = await postVideoEdge(
    pageId,
    form({
      upload_phase: "start",
      file_size: String(fileSize),
      access_token: pageToken,
    }),
    "Upload session start",
  );
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throwMetaFailure(res, body, "Upload session start");
  const parsed = startResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new JobFailureError({
      code: "FACEBOOK_API_ERROR",
      message:
        "Meta did not return an upload session. The upload can be retried.",
      retryable: true,
    });
  }
  return {
    videoId: parsed.data.video_id,
    uploadSessionId: parsed.data.upload_session_id,
    startOffset: parsed.data.start_offset,
    endOffset: parsed.data.end_offset,
  };
}

/**
 * Phase 2 — transfer: POST one multipart chunk. The response's
 * offsets are the server's truth for the next chunk.
 */
async function transferChunk(
  pageId: string,
  pageToken: string,
  session: ResumableSession,
  startOffset: number,
  chunk: ArrayBuffer,
  fileName: string,
): Promise<{ startOffset: number; endOffset: number }> {
  const fd = new FormData();
  fd.set("upload_phase", "transfer");
  fd.set("upload_session_id", session.uploadSessionId);
  fd.set("start_offset", String(startOffset));
  fd.set("access_token", pageToken);
  fd.set("video_file_chunk", new Blob([chunk]), fileName);
  const res = await postVideoEdge(pageId, fd, "Upload chunk transfer");
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throwMetaFailure(res, body, "Upload chunk transfer");
  const parsed = transferResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new JobFailureError({
      code: "FACEBOOK_API_ERROR",
      message:
        "Meta returned an unexpected response for the uploaded chunk. The upload can be retried — it will resume from the saved session.",
      retryable: true,
    });
  }
  return { startOffset: parsed.data.start_offset, endOffset: parsed.data.end_offset };
}

/**
 * Phase 3 — finish (THE PUBLISH STEP): commits the upload and
 * publishes the video to the Page with its title/description. There
 * is no separate publish call for Page videos — per the Page Videos
 * reference, title/description are params of this edge and finish
 * publishes.
 */
async function finishUpload(
  pageId: string,
  pageToken: string,
  session: ResumableSession,
  title: string,
  description: string,
): Promise<void> {
  const res = await postVideoEdge(
    pageId,
    form({
      upload_phase: "finish",
      upload_session_id: session.uploadSessionId,
      title,
      description,
      access_token: pageToken,
    }),
    "Upload finish (publish)",
  );
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throwMetaFailure(res, body, "Upload finish (publish)");
  const parsed = finishResponseSchema.safeParse(body);
  if (!parsed.success || parsed.data.success === false) {
    throw new JobFailureError({
      code: "FACEBOOK_API_ERROR",
      message:
        "Meta did not confirm the video publish. The upload can be retried — it will resume from the saved session.",
      retryable: true,
    });
  }
}

// --- post-upload status polling --------------------------------------------

const videoStatusSchema = z.object({
  status: z
    .object({
      publishing_phase: z
        .object({
          status: z.string().optional(),
          error_reason: z.string().optional(),
        })
        .optional(),
      processing_phase: z
        .object({
          status: z.string().optional(),
          error_reason: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

/**
 * Poll GET /{video-id}?fields=status until the video is ready or
 * failed, or ~5 minutes pass. Returns "ready" | "error" | "timeout".
 * A timeout is NOT a failure of the publish itself: finish already
 * committed the video (the destination exists), Meta is just still
 * processing. The caller marks the job PUBLISHED on timeout so a
 * retry never creates a duplicate video.
 */
async function pollVideoStatus(
  videoId: string,
  pageToken: string,
  jobId: string,
): Promise<"ready" | "error" | "timeout"> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const url = new URL(`${graphBase()}/${encodeURIComponent(videoId)}`);
    url.searchParams.set("fields", "status");
    url.searchParams.set("access_token", pageToken);
    let res: Response;
    try {
      res = await fetch(url.toString());
    } catch (err) {
      // A network blip during polling must not fail the job — the
      // video is already published; just wait and try again.
      logger.warn(
        { jobId, err: err instanceof Error ? err.message : String(err) },
        "Facebook status poll network error; retrying",
      );
      if (Date.now() >= deadline) return "timeout";
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const meta = extractMetaError(res, body);
      // Auth/permission errors while polling are terminal for the
      // poll, but the video itself was published — surface as timeout
      // semantics (job still PUBLISHED) rather than FAILED.
      logger.warn(
        { jobId, httpStatus: res.status, metaCode: meta.code },
        "Facebook status poll failed; treating as still-processing",
      );
      if (Date.now() >= deadline) return "timeout";
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    const parsed = videoStatusSchema.safeParse(body);
    const status = parsed.success ? parsed.data.status : undefined;
    const phase = status?.publishing_phase;
    const phaseStatus = phase?.status?.toLowerCase();
    if (phaseStatus === "complete") return "ready";
    if (phaseStatus === "error") {
      const reason =
        phase?.error_reason ??
        status?.processing_phase?.error_reason ??
        "unknown processing error";
      throw new JobFailureError({
        code: "FACEBOOK_PROCESSING_FAILED",
        message: `Meta failed to process the video: ${reason}. The video may need to be re-uploaded.`,
        retryable: false,
      });
    }
    if (Date.now() >= deadline) return "timeout";
    await sleep(POLL_INTERVAL_MS);
  }
}

const permalinkSchema = z.object({ permalink_url: z.string().url().optional() });

/**
 * Read back the video's canonical URL. Falls back to the constructed
 * Page video URL when the API doesn't return one.
 */
async function resolveDestinationUrl(
  videoId: string,
  pageId: string,
  pageToken: string,
): Promise<string> {
  const fallback = `https://www.facebook.com/${pageId}/videos/${videoId}`;
  try {
    const url = new URL(`${graphBase()}/${encodeURIComponent(videoId)}`);
    url.searchParams.set("fields", "permalink_url");
    url.searchParams.set("access_token", pageToken);
    const res = await fetch(url.toString());
    if (!res.ok) return fallback;
    const body: unknown = await res.json().catch(() => null);
    const parsed = permalinkSchema.safeParse(body);
    if (!parsed.success) return fallback;
    return parsed.data.permalink_url ?? fallback;
  } catch {
    return fallback;
  }
}

// --- job bookkeeping -----------------------------------------------------

async function failJob(jobId: string, failure: ClassifiedFailure): Promise<void> {
  await getDb()
    .doc(`publishJobs/${jobId}`)
    .update({
      status: "FAILED",
      completedAt: new Date().toISOString(),
      error: { code: failure.code, message: failure.message },
      retryable: failure.retryable,
      updatedAt: new Date().toISOString(),
    });
}

async function finalizeSuccess(
  opts: FacebookUploadOptions,
  pageName: string,
  videoId: string,
  destinationUrl: string,
  processingNote: string | undefined,
  touch: (patch: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  const patch: Record<string, unknown> = {
    status: "PUBLISHED",
    progress: 100,
    bytesUploaded: opts.fileSize,
    bytesTotal: opts.fileSize,
    completedAt: new Date().toISOString(),
    destinationId: videoId,
    destinationUrl,
    destinationAccountId: opts.pageId,
    destinationAccountName: pageName,
    error: FieldValue.delete(),
    retryable: false,
  };
  await touch(patch);
  if (processingNote !== undefined) {
    logger.warn({ jobId: opts.jobId, videoId }, processingNote);
  }

  const history: PublishHistory = {
    userId: opts.uid,
    driveFileId: opts.driveFileId,
    fileName: opts.fileName,
    destination: "facebook",
    destinationAccountId: opts.pageId,
    destinationAccountName: pageName,
    destinationId: videoId,
    destinationUrl,
    status: "PUBLISHED",
    publishedAt: new Date().toISOString(),
  };
  await getDb().collection("publishHistory").add(history);
  logger.info({ jobId: opts.jobId, videoId }, "Facebook upload published");
}

// --- main engine ---------------------------------------------------------

async function runUpload(opts: FacebookUploadOptions): Promise<void> {
  const jobRef = getDb().doc(`publishJobs/${opts.jobId}`);
  const snap = await jobRef.get();
  if (!snap.exists) {
    logger.error(
      { jobId: opts.jobId },
      "uploadVideoToFacebook: job doc missing; aborting",
    );
    return;
  }
  const existing = snap.data() as PublishJob;
  if (existing.userId !== opts.uid) {
    logger.error(
      { jobId: opts.jobId },
      "uploadVideoToFacebook: uid mismatch on job doc; aborting",
    );
    return;
  }
  if (existing.status === "PUBLISHED" || existing.status === "CANCELLED") {
    logger.info(
      { jobId: opts.jobId, status: existing.status },
      "uploadVideoToFacebook: job already terminal; skipping",
    );
    return;
  }

  const touch = (patch: Record<string, unknown>): Promise<unknown> =>
    jobRef.update({ ...patch, updatedAt: new Date().toISOString() });

  // Token-ownership + CREATE_CONTENT guard. Throws
  // META_NOT_CONNECTED / FACEBOOK_PAGE_NOT_AUTHORIZED (retryable=false).
  const metaDoc = await getMetaTokenDoc(opts.uid);
  if (!metaDoc) {
    throw new MetaNotConnectedError();
  }
  const resolved = await getPageToken(opts.uid, opts.pageId);
  const pageToken = resolved.pageToken;
  const pageName = resolved.pageName;

  // Google access token for the Drive byte stream (401 → single
  // refresh inside getValidAccessToken).
  const googleToken = await getValidAccessToken(opts.uid, "drive");

  const now = new Date().toISOString();
  await touch({
    status: "PROCESSING",
    startedAt: existing.startedAt ?? now,
    bytesTotal: opts.fileSize,
    bytesUploaded: existing.bytesUploaded ?? 0,
    progress: uploadProgress(existing.bytesUploaded ?? 0, opts.fileSize),
    destinationAccountId: opts.pageId,
    destinationAccountName: pageName,
    error: FieldValue.delete(),
    retryable: false,
  });

  // --- resumable session: resume the stored one or start fresh ---
  let session: ResumableSession;
  let offset = existing.bytesUploaded ?? 0;
  let resumedSession = false;
  if (existing.facebookUploadSessionId && existing.facebookVideoId) {
    session = {
      videoId: existing.facebookVideoId,
      uploadSessionId: existing.facebookUploadSessionId,
    };
    resumedSession = true;
    logger.info(
      { jobId: opts.jobId, offset },
      "Resuming Facebook upload with stored session",
    );
  } else {
    const started = await startUploadSession(opts.pageId, pageToken, opts.fileSize);
    session = { videoId: started.videoId, uploadSessionId: started.uploadSessionId };
    offset = 0;
    await touch({
      facebookUploadSessionId: session.uploadSessionId,
      facebookVideoId: session.videoId,
      bytesUploaded: 0,
      progress: 0,
    });
  }
  await touch({ status: "UPLOADING" });

  // --- chunk loop: Drive Range fetch → transfer, server drives offsets ---
  // The server's returned offsets are the truth; a stall counter
  // bounds the loop in case the server ever stops advancing (instead
  // of trusting it blindly forever or rejecting a legitimate
  // re-send request outright).
  let firstTransfer = resumedSession;
  let stalledTransfers = 0;
  while (offset < opts.fileSize) {
    // Best-effort cancellation: the queue worker sets the flag via
    // POST /api/jobs/:jobId/cancel; we check between chunks (never
    // mid-chunk) and settle the job to CANCELLED.
    if (isJobCancelled(opts.jobId)) {
      const ts = new Date().toISOString();
      await touch({
        status: "CANCELLED",
        completedAt: ts,
        error: FieldValue.delete(),
        retryable: false,
      });
      logger.info(
        { jobId: opts.jobId },
        "Facebook upload cancelled by user (between chunks)",
      );
      clearJobCancelled(opts.jobId);
      return;
    }
    const end = Math.min(offset + FACEBOOK_UPLOAD_CHUNK_SIZE, opts.fileSize) - 1;
    try {
      const chunk = await withChunkRetries(() =>
        fetchDriveChunk(googleToken, opts.driveFileId, offset, end),
      );
      const result = await withChunkRetries(() =>
        transferChunk(opts.pageId, pageToken, session, offset, chunk, opts.fileName),
      );
      if (result.startOffset <= offset) {
        stalledTransfers += 1;
        if (stalledTransfers >= 3) {
          throw new JobFailureError({
            code: "FACEBOOK_API_ERROR",
            message:
              "Meta stopped advancing the upload offset after repeated chunks. The upload can be retried — it will resume from the saved session.",
            retryable: true,
          });
        }
      } else {
        stalledTransfers = 0;
        offset = result.startOffset;
      }
      firstTransfer = false;
    } catch (err) {
      if (firstTransfer && resumedSession) {
        // Meta documents no session-status probe, so a resume attempt
        // that fails on its first transfer is treated as a dead
        // session: start a fresh session from byte 0. This is the only
        // place resume falls back — later chunks use withChunkRetries
        // and real failure classification instead.
        logger.warn(
          { jobId: opts.jobId },
          "Stored Facebook upload session is dead; starting a fresh session",
        );
        const started = await startUploadSession(opts.pageId, pageToken, opts.fileSize);
        session = {
          videoId: started.videoId,
          uploadSessionId: started.uploadSessionId,
        };
        offset = 0;
        resumedSession = false;
        firstTransfer = false;
        await touch({
          facebookUploadSessionId: session.uploadSessionId,
          facebookVideoId: session.videoId,
          bytesUploaded: 0,
          progress: 0,
        });
        continue;
      }
      throw err;
    }
    await touch({
      bytesUploaded: offset,
      progress: uploadProgress(offset, opts.fileSize),
    });
  }

  // --- finish = publish (title/description), then poll processing ---
  const title = opts.title ?? defaultTitle(opts.fileName);
  await finishUpload(opts.pageId, pageToken, session, title, opts.caption);

  const pollResult = await pollVideoStatus(session.videoId, pageToken, opts.jobId);
  const processingNote =
    pollResult === "timeout"
      ? "Facebook accepted and published the video, but processing was still incomplete after ~5 minutes of polling; marked PUBLISHED (the destination exists) so a retry never duplicates it."
      : undefined;

  const destinationUrl = await resolveDestinationUrl(
    session.videoId,
    opts.pageId,
    pageToken,
  );
  await finalizeSuccess(opts, pageName, session.videoId, destinationUrl, processingNote, touch);
}

// --- public entry point --------------------------------------------------

/**
 * Upload a Drive video to a Facebook Page (resumable, 8MB chunks,
 * best-effort resume on retry). The job doc carries the full
 * lifecycle: PENDING → PROCESSING → UPLOADING → PUBLISHED/FAILED,
 * with progress from actual confirmed bytes, plus destinationId /
 * destinationUrl / destinationAccountId / destinationAccountName,
 * error {code,message}, retryable.
 *
 * The promise never rejects with a job failure — the failure is
 * recorded on the job doc — so fire-and-forget callers are safe.
 * Called exclusively by Phase 7's queue worker
 * (services/uploadQueue.ts), which is the single dispatcher and owns
 * the in-process "one job per user" guard (the old activeUploads set
 * was removed here for that reason).
 */
export async function uploadVideoToFacebook(input: unknown): Promise<void> {
  const parsed = facebookUploadOptionsSchema.safeParse(input);
  if (!parsed.success) {
    logger.error(
      { issues: parsed.error.issues.map((i) => i.message).join("; ") },
      "uploadVideoToFacebook called with invalid options",
    );
    return;
  }
  const opts = parsed.data;
  try {
    await runUpload(opts);
  } catch (err) {
    const failure = toJobFailure(err);
    logger.error(
      { jobId: opts.jobId, code: failure.code },
      "Facebook upload failed",
    );
    try {
      await failJob(opts.jobId, failure);
    } catch (persistErr) {
      logger.error(
        {
          jobId: opts.jobId,
          err:
            persistErr instanceof Error ? persistErr.message : String(persistErr),
        },
        "Could not persist Facebook job failure",
      );
    }
  } finally {
    clearJobCancelled(opts.jobId);
  }
}
