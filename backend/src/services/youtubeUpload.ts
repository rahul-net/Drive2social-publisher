import { z } from "zod";
import { FieldValue } from "firebase-admin/firestore";
import type { PublishHistory, PublishJob } from "@drive2social/shared";
import { getDb } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { HttpError } from "../middleware/errorHandler.js";
import {
  getValidAccessToken,
  GoogleNotConnectedError,
} from "../lib/googleOAuth.js";
import { isJobCancelled, clearJobCancelled } from "./uploadQueue.js";
import {
  classifyYouTubeFailure,
  extractYouTubeError,
  getOwnYouTubeChannel,
  networkFailure,
  requireYouTubeScope,
  type ClassifiedFailure,
  type YouTubeChannelInfo,
} from "./youtube.js";

// ============================================================
// YouTube resumable-upload engine — Phase 4.
//
// Exported entry point for Phase 7's queue worker:
//   uploadVideoToYouTube(opts) -> Promise<void>
// The outcome is ALWAYS recorded on the publishJobs/{jobId} doc
// (PUBLISHED or FAILED); the promise itself never rejects with a
// job failure, so fire-and-forget callers are safe.
//
// Upload protocol (verified against the YouTube Data API v3 docs):
//   1. POST https://www.googleapis.com/upload/youtube/v3/videos
//      ?uploadType=resumable&part=snippet,status
//      (&notifySubscribers=false when the user opts out)
//      with JSON metadata + X-Upload-Content-Length /
//      X-Upload-Content-Type → session URI from the Location header.
//   2. PUT 8MB chunks to the session URI with
//      Content-Range: bytes <start>-<end>/<total>.
//      308 = "resume incomplete" (Range header tells us the bytes
//      received); 200/201 = complete, body carries the video id.
//   3. Bytes stream from Drive via
//      GET https://www.googleapis.com/drive/v3/files/{id}?alt=media
//      with Range headers — the whole file is never in memory.
//
// Resume: the session URI is persisted on the job doc
// (uploadSessionUri). A retry of the same jobId probes the stored
// session (PUT, Content-Range: bytes */<total>, empty body):
//   - 308 → resume from the Range header's byte count;
//   - 200/201 → the previous attempt actually finished (finalize);
//   - 404/410 → session is dead, start a fresh one.
// Progress on the job doc (bytesUploaded/bytesTotal/progress)
// always reflects ACTUAL bytes the server confirmed.
//
// Privacy forcing: unverified OAuth apps get uploads forced to
// PRIVATE no matter the requested privacyStatus, and the API gives
// no verification-status signal. We detect it by comparing the
// requested privacyStatus with the returned status.privacyStatus and
// record privacyForced=true + an explanatory message on the job.
//
// Tokens and the session URI are never logged (logger redacts
// *uploadSessionUri; tokens are never interpolated into log fields).
// ============================================================

/** 8MB chunks — large enough for throughput, small enough for memory. */
export const YOUTUBE_UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;

const MAX_TITLE_LEN = 100;
const MAX_DESCRIPTION_LEN = 5000;
/** YouTube: at most 500 characters in total across all tags. */
const MAX_TAGS_TOTAL_LEN = 500;

// --- zod validation -------------------------------------------------

export const youtubeMetadataSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_TITLE_LEN),
    description: z.string().max(MAX_DESCRIPTION_LEN).default(""),
    tags: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  })
  .superRefine((meta, ctx) => {
    const total = meta.tags.reduce((n, t) => n + t.length, 0);
    if (total > MAX_TAGS_TOTAL_LEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tags"],
        message: `Tags exceed YouTube's 500-character total limit (${total} characters).`,
      });
    }
  });

export const youtubeSettingsSchema = z.object({
  privacyStatus: z.enum(["public", "unlisted", "private"]),
  categoryId: z.string().trim().min(1).max(16),
  madeForKids: z.boolean(),
  notifySubscribers: z.boolean(),
});

export const youtubeUploadOptionsSchema = z.object({
  uid: z.string().min(1),
  jobId: z.string().min(1),
  driveFileId: z.string().min(1),
  fileName: z.string().min(1),
  fileSize: z.number().int().positive(),
  mimeType: z.string().min(1),
  metadata: youtubeMetadataSchema,
  settings: youtubeSettingsSchema,
});

export type YouTubeUploadMetadata = z.infer<typeof youtubeMetadataSchema>;
export type YouTubeUploadSettings = z.infer<typeof youtubeSettingsSchema>;
export type YouTubeUploadOptions = z.infer<typeof youtubeUploadOptionsSchema>;

// --- pure, unit-testable helpers ---------------------------------------

/** Parse a resumable-upload `Range: bytes=0-<last>` header → bytes received. */
export function parseRangeHeader(value: string | null): number | null {
  if (!value) return null;
  const m = /^bytes=0-(\d+)$/.exec(value.trim());
  if (!m?.[1]) return null;
  const last = Number.parseInt(m[1], 10);
  return Number.isFinite(last) && last >= 0 ? last + 1 : null;
}

/** progress 0–100 from actual streamed bytes. */
export function uploadProgress(
  bytesUploaded: number,
  bytesTotal: number,
): number {
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

/** Normalize any throw into a job-bookkeeping decision. */
function toJobFailure(err: unknown): ClassifiedFailure {
  if (err instanceof JobFailureError) {
    return { code: err.code, message: err.message, retryable: err.retryable };
  }
  if (err instanceof GoogleNotConnectedError) {
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
    message: "The upload failed unexpectedly. It can be retried — it will resume from the saved session.",
    retryable: true,
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry a chunk operation up to 3 times with exponential backoff, but
 * ONLY when the failure is classified retryable (network / 5xx).
 * Non-retryable failures (quota, reauth, invalid request) throw
 * immediately — never a blind retry loop.
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

// --- authenticated fetch -----------------------------------------------

interface AuthState {
  uid: string;
  accessToken: string;
  /** Whether the one allowed mid-upload refresh has been used. */
  refreshed: boolean;
}

/**
 * fetch with the user's bearer token. On a 401, refreshes the token
 * ONCE (getValidAccessToken forceRefresh) and retries once; a second
 * 401 is returned to the caller, which classifies it as
 * YOUTUBE_REAUTH_REQUIRED. Never loops.
 */
async function fetchAsUser(
  auth: AuthState,
  url: string,
  init: RequestInit,
  kind: string,
): Promise<Response> {
  const attempt = (): Promise<Response> =>
    fetch(url, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${auth.accessToken}` },
    });
  let res: Response;
  try {
    res = await attempt();
  } catch (err) {
    throw new JobFailureError(networkFailure(kind, err));
  }
  if (res.status === 401 && !auth.refreshed) {
    auth.refreshed = true;
    auth.accessToken = await getValidAccessToken(auth.uid, "youtube", {
      forceRefresh: true,
    });
    try {
      res = await attempt();
    } catch (err) {
      throw new JobFailureError(networkFailure(kind, err));
    }
  }
  return res;
}

// --- resumable session ---------------------------------------------------

/**
 * Initiate a resumable upload session. Returns the session URI from
 * the Location header (persisted on the job doc by the caller).
 */
async function initiateResumableSession(
  auth: AuthState,
  opts: YouTubeUploadOptions,
): Promise<string> {
  const url = new URL("https://www.googleapis.com/upload/youtube/v3/videos");
  url.searchParams.set("uploadType", "resumable");
  url.searchParams.set("part", "snippet,status");
  url.searchParams.set(
    "notifySubscribers",
    opts.settings.notifySubscribers ? "true" : "false",
  );
  const metadata = {
    snippet: {
      title: opts.metadata.title,
      description: opts.metadata.description,
      tags: opts.metadata.tags,
      categoryId: opts.settings.categoryId,
    },
    status: {
      privacyStatus: opts.settings.privacyStatus,
      madeForKids: opts.settings.madeForKids,
      selfDeclaredMadeForKids: opts.settings.madeForKids,
    },
  };
  const res = await fetchAsUser(
    auth,
    url.toString(),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(opts.fileSize),
        "X-Upload-Content-Type": opts.mimeType,
      },
      body: JSON.stringify(metadata),
    },
    "Upload session initiation",
  );
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new JobFailureError(
      classifyYouTubeFailure(extractYouTubeError(res.status, body)),
    );
  }
  const location = res.headers.get("location");
  if (!location) {
    throw new JobFailureError({
      code: "YOUTUBE_API_ERROR",
      message:
        "YouTube did not return an upload session URL. The upload can be retried.",
      retryable: true,
    });
  }
  return location;
}

const videoResourceSchema = z.object({
  id: z.string().min(1),
  status: z.object({ privacyStatus: z.string().optional() }).optional(),
});

export interface CompletedVideo {
  videoId: string;
  returnedPrivacyStatus?: string;
}

/** Parse the video resource returned when an upload completes. */
async function parseVideoResource(res: Response): Promise<CompletedVideo> {
  const body: unknown = await res.json().catch(() => null);
  const parsed = videoResourceSchema.safeParse(body);
  if (!parsed.success) {
    throw new JobFailureError({
      code: "YOUTUBE_API_ERROR",
      message:
        "YouTube did not return a video id for the completed upload. The upload can be retried — it will resume from the saved session.",
      retryable: true,
    });
  }
  const video: CompletedVideo = { videoId: parsed.data.id };
  const returned = parsed.data.status?.privacyStatus;
  if (returned) video.returnedPrivacyStatus = returned;
  return video;
}

type ProbeResult =
  | { kind: "incomplete"; receivedBytes: number }
  | { kind: "complete"; video: CompletedVideo }
  | { kind: "dead" };

/**
 * Probe a stored session URI: PUT with a Content-Range of
 * "bytes star-slash <total>" and an empty body. 308 → incomplete
 * (Range header = bytes received); 200/201 → the previous attempt
 * actually finished; 404/410 → dead.
 */
async function probeSession(
  sessionUri: string,
  fileSize: number,
): Promise<ProbeResult> {
  let res: Response;
  try {
    res = await fetch(sessionUri, {
      method: "PUT",
      headers: {
        "Content-Length": "0",
        "Content-Range": `bytes */${fileSize}`,
      },
    });
  } catch (err) {
    throw new JobFailureError(networkFailure("Upload resume probe", err));
  }
  if (res.status === 308) {
    return {
      kind: "incomplete",
      receivedBytes: parseRangeHeader(res.headers.get("range")) ?? 0,
    };
  }
  if (res.status === 200 || res.status === 201) {
    return { kind: "complete", video: await parseVideoResource(res) };
  }
  if (res.status === 404 || res.status === 410) {
    return { kind: "dead" };
  }
  const body = await res.json().catch(() => null);
  throw new JobFailureError(
    classifyYouTubeFailure(extractYouTubeError(res.status, body)),
  );
}

// --- chunk streaming -----------------------------------------------------

/** Fetch one byte range from Drive — streamed, never the whole file. */
async function fetchDriveChunk(
  auth: AuthState,
  driveFileId: string,
  start: number,
  end: number,
): Promise<ArrayBuffer> {
  const res = await fetchAsUser(
    auth,
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveFileId)}?alt=media`,
    { headers: { Range: `bytes=${start}-${end}` } },
    "Drive chunk download",
  );
  if (res.status !== 206 && res.status !== 200) {
    const body = await res.json().catch(() => null);
    throw new JobFailureError(
      classifyYouTubeFailure(extractYouTubeError(res.status, body)),
    );
  }
  // Awaited as ArrayBuffer (a BodyInit the DOM-lib fetch accepts
  // without casts); 8MB per chunk, never the whole file.
  const ab = await res.arrayBuffer();
  if (ab.byteLength === 0) {
    throw new JobFailureError({
      code: "YOUTUBE_NETWORK_ERROR",
      message:
        "Drive returned an empty chunk. The upload can be retried — it will resume from the saved session.",
      retryable: true,
    });
  }
  return ab;
}

/** PUT one chunk to the resumable session URI. */
async function putChunk(
  sessionUri: string,
  mimeType: string,
  start: number,
  end: number,
  total: number,
  data: ArrayBuffer,
): Promise<Response> {
  try {
    return await fetch(sessionUri, {
      method: "PUT",
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(data.byteLength),
        "Content-Range": `bytes ${start}-${end}/${total}`,
      },
      body: data,
    });
  } catch (err) {
    throw new JobFailureError(networkFailure("Upload chunk", err));
  }
}

// --- job bookkeeping -----------------------------------------------------

async function failJob(
  jobId: string,
  failure: ClassifiedFailure,
): Promise<void> {
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
  opts: YouTubeUploadOptions,
  channel: YouTubeChannelInfo,
  video: CompletedVideo,
  touch: (patch: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  const destinationUrl = `https://www.youtube.com/watch?v=${video.videoId}`;
  const requested = opts.settings.privacyStatus;
  const returned = video.returnedPrivacyStatus;
  // Unverified OAuth apps get uploads forced to private; the API
  // exposes no verification signal, so detect it by comparison.
  const forced = returned !== undefined && returned !== requested;

  const patch: Record<string, unknown> = {
    status: "PUBLISHED",
    progress: 100,
    bytesUploaded: opts.fileSize,
    bytesTotal: opts.fileSize,
    completedAt: new Date().toISOString(),
    destinationId: video.videoId,
    destinationUrl,
    destinationAccountId: channel.channelId,
    destinationAccountName: channel.title,
    error: FieldValue.delete(),
    retryable: false,
  };
  if (forced) {
    patch["privacyForced"] = true;
    patch["privacyForcedMessage"] =
      `You requested "${requested}" but YouTube published the video as "${returned}". ` +
      "Uploads from unverified OAuth apps are forced to private by YouTube — " +
      "verify your OAuth consent screen in Google Cloud Console if you need public/unlisted uploads.";
  }
  await touch(patch);

  const history: PublishHistory = {
    userId: opts.uid,
    driveFileId: opts.driveFileId,
    fileName: opts.fileName,
    destination: "youtube",
    destinationAccountId: channel.channelId,
    destinationAccountName: channel.title,
    destinationId: video.videoId,
    destinationUrl,
    status: "PUBLISHED",
    publishedAt: new Date().toISOString(),
  };
  await getDb().collection("publishHistory").add(history);
  logger.info(
    { jobId: opts.jobId, videoId: video.videoId, privacyForced: forced },
    "YouTube upload published",
  );
}

// --- main engine ---------------------------------------------------------

async function runUpload(opts: YouTubeUploadOptions): Promise<void> {
  const jobRef = getDb().doc(`publishJobs/${opts.jobId}`);
  const snap = await jobRef.get();
  if (!snap.exists) {
    logger.error(
      { jobId: opts.jobId },
      "uploadVideoToYouTube: job doc missing; aborting",
    );
    return;
  }
  const existing = snap.data() as PublishJob;
  if (existing.userId !== opts.uid) {
    logger.error(
      { jobId: opts.jobId },
      "uploadVideoToYouTube: uid mismatch on job doc; aborting",
    );
    return;
  }
  if (existing.status === "PUBLISHED" || existing.status === "CANCELLED") {
    logger.info(
      { jobId: opts.jobId, status: existing.status },
      "uploadVideoToYouTube: job already terminal; skipping",
    );
    return;
  }

  const touch = (patch: Record<string, unknown>): Promise<unknown> =>
    jobRef.update({ ...patch, updatedAt: new Date().toISOString() });

  // Token-ownership + scope guard; throws YOUTUBE_NOT_CONNECTED /
  // GOOGLE_NOT_CONNECTED as job failures (retryable=false).
  await requireYouTubeScope(opts.uid);
  const auth: AuthState = {
    uid: opts.uid,
    accessToken: await getValidAccessToken(opts.uid, "youtube"),
    refreshed: false,
  };

  // Channel identity for destinationAccountId/Name (also fails fast
  // with NO_YOUTUBE_CHANNEL before any bytes move).
  const channel = await getOwnYouTubeChannel(opts.uid);

  const now = new Date().toISOString();
  await touch({
    status: "PROCESSING",
    startedAt: existing.startedAt ?? now,
    bytesTotal: opts.fileSize,
    bytesUploaded: existing.bytesUploaded ?? 0,
    progress: uploadProgress(existing.bytesUploaded ?? 0, opts.fileSize),
    destinationAccountId: channel.channelId,
    destinationAccountName: channel.title,
    error: FieldValue.delete(),
    retryable: false,
  });

  // --- resumable session: reuse the stored one or initiate a new one ---
  let sessionUri = existing.uploadSessionUri;
  let received = existing.bytesUploaded ?? 0;
  if (sessionUri) {
    const probe = await probeSession(sessionUri, opts.fileSize);
    if (probe.kind === "complete") {
      await finalizeSuccess(opts, channel, probe.video, touch);
      return;
    }
    if (probe.kind === "dead") {
      sessionUri = undefined;
      received = 0;
    } else {
      received = Math.max(received, probe.receivedBytes);
    }
  }
  if (!sessionUri) {
    sessionUri = await initiateResumableSession(auth, opts);
    received = 0;
    await touch({ uploadSessionUri: sessionUri, bytesUploaded: 0, progress: 0 });
  }
  await touch({ status: "UPLOADING" });

  // --- chunk loop: Drive Range fetch → session PUT, 8MB at a time ---
  while (received < opts.fileSize) {
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
        "YouTube upload cancelled by user (between chunks)",
      );
      clearJobCancelled(opts.jobId);
      return;
    }
    // Const copy: `sessionUri` is let-bound (the 404 branch below
    // re-initiates it), and TS does not narrow let-bound variables
    // inside closures. It is always a string here — the session is
    // established above and re-initiation assigns a string.
    const uri: string = sessionUri;
    const start = received;
    const end = Math.min(start + YOUTUBE_UPLOAD_CHUNK_SIZE, opts.fileSize) - 1;
    const chunk = await withChunkRetries(() =>
      fetchDriveChunk(auth, opts.driveFileId, start, end),
    );
    const putRes = await withChunkRetries(() =>
      putChunk(uri, opts.mimeType, start, end, opts.fileSize, chunk),
    );

    if (putRes.status === 308) {
      // Resume incomplete — trust the server's Range header, never
      // regress below what we already counted.
      received = Math.max(
        received,
        parseRangeHeader(putRes.headers.get("range")) ?? end + 1,
      );
    } else if (putRes.status === 200 || putRes.status === 201) {
      await finalizeSuccess(opts, channel, await parseVideoResource(putRes), touch);
      return;
    } else if (putRes.status === 404 || putRes.status === 410) {
      // Session died mid-upload — start fresh and restart from byte 0.
      logger.warn(
        { jobId: opts.jobId },
        "YouTube upload session expired mid-upload; re-initiating",
      );
      sessionUri = await initiateResumableSession(auth, opts);
      received = 0;
      await touch({ uploadSessionUri: sessionUri, bytesUploaded: 0, progress: 0 });
      continue;
    } else {
      const body = await putRes.json().catch(() => null);
      throw new JobFailureError(
        classifyYouTubeFailure(extractYouTubeError(putRes.status, body)),
      );
    }
    await touch({
      bytesUploaded: received,
      progress: uploadProgress(received, opts.fileSize),
    });
  }

  // The loop only exits when every byte was confirmed. If the final
  // chunk didn't return a terminal 200/201, probe once to settle it.
  const probe = await probeSession(sessionUri, opts.fileSize);
  if (probe.kind === "complete") {
    await finalizeSuccess(opts, channel, probe.video, touch);
    return;
  }
  throw new JobFailureError({
    code: "YOUTUBE_API_ERROR",
    message:
      "All bytes were sent but YouTube did not confirm the upload. The upload can be retried — it will resume from the saved session.",
    retryable: true,
  });
}

// --- public entry point --------------------------------------------------

/**
 * Upload a Drive video to YouTube (resumable, 8MB chunks, resume on
 * retry). The job doc carries the full lifecycle:
 * PENDING → PROCESSING → UPLOADING → PUBLISHED/FAILED, with progress
 * from actual confirmed bytes, plus destinationId/destinationUrl/
 * destinationAccountId/destinationAccountName, error {code,message},
 * retryable, and the privacyForced flag when YouTube overrides the
 * requested privacy.
 *
 * The promise never rejects with a job failure — the failure is
 * recorded on the job doc — so fire-and-forget callers are safe.
 * Called exclusively by Phase 7's queue worker
 * (services/uploadQueue.ts), which is the single dispatcher and owns
 * the in-process "one job per user" guard (the old activeUploads set
 * was removed here for that reason).
 */
export async function uploadVideoToYouTube(input: unknown): Promise<void> {
  const parsed = youtubeUploadOptionsSchema.safeParse(input);
  if (!parsed.success) {
    logger.error(
      { issues: parsed.error.issues.map((i) => i.message).join("; ") },
      "uploadVideoToYouTube called with invalid options",
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
      "YouTube upload failed",
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
        "Could not persist YouTube job failure",
      );
    }
  } finally {
    clearJobCancelled(opts.jobId);
  }
}
