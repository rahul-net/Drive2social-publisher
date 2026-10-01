// ============================================================
// Shared domain types for Drive2Social Publisher.
// These are pure types — no runtime secrets, no tokens.
// OAuth tokens are stored server-side only and are NEVER part of
// these types (see ConnectedAccount comment below).
// ============================================================

/** Lifecycle of a publish job. */
export type JobStatus =
  | "PENDING"
  | "PROCESSING"
  | "UPLOADING"
  | "PUBLISHED"
  | "FAILED"
  | "CANCELLED";

/** Where a job publishes to. */
export type Destination = "youtube" | "facebook";

/** Upload privacy setting. */
export type PrivacyStatus = "public" | "unlisted" | "private";

/** Gemini-generated (or user-edited) metadata for a publish job. */
export interface JobMetadata {
  title: string;
  description: string;
  tags: string[];
  caption: string;
  hashtags: string[];
}

/** Per-job publish settings. */
export interface JobSettings {
  privacyStatus: PrivacyStatus;
  categoryId: string;
  madeForKids: boolean;
  notifySubscribers: boolean;
}

/** Machine-readable failure info. */
export interface JobError {
  code: string;
  message: string;
}

/**
 * A publish job document (Firestore `publishJobs`).
 * `id` is the Firestore document id, set when read back.
 */
export interface PublishJob {
  id?: string;
  userId: string;
  driveFileId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  destination: Destination;
  destinationAccountId: string;
  destinationAccountName: string;
  metadata: JobMetadata;
  settings: JobSettings;
  status: JobStatus;
  progress: number; // 0–100
  bytesUploaded: number;
  bytesTotal: number;
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
  startedAt?: string; // ISO-8601
  completedAt?: string; // ISO-8601
  error?: JobError;
  retryable: boolean;
  destinationId?: string; // e.g. YouTube videoId / Facebook post id
  destinationUrl?: string;
  duplicateConfirmed: boolean;
  /**
   * Phase 4: resumable-upload session URI for the in-flight YouTube
   * upload. SERVER-ONLY — stripped from every API response before it
   * leaves the backend. A later retry of the same jobId reuses it to
   * resume instead of restarting the upload from byte 0.
   */
  uploadSessionUri?: string;
  /**
   * Phase 5 (Facebook): resumable-upload session id for the in-flight
   * Page-video upload. SERVER-ONLY — stripped from every API response
   * before it leaves the backend. A retry of the same jobId attempts to
   * continue the transfer loop from bytesUploaded with this session
   * (falling back to a fresh session when the old one is dead).
   */
  facebookUploadSessionId?: string;
  /**
   * Phase 5 (Facebook): the video id returned by the upload start phase.
   * SERVER-ONLY, stripped from API responses.
   */
  facebookVideoId?: string;
  /**
   * Phase 4: true when YouTube forced the video's privacyStatus to
   * "private" even though public/unlisted was requested. Happens when
   * the OAuth app is unverified — YouTube gives no API signal for
   * verification status, so this is detected by comparing the
   * requested privacyStatus with the returned status.privacyStatus.
   */
  privacyForced?: boolean;
  /** Human-readable explanation recorded when privacyForced is true. */
  privacyForcedMessage?: string;
}

/** A row in the publishing history (Firestore `publishHistory`). */
export interface PublishHistory {
  id?: string;
  userId: string;
  driveFileId: string;
  fileName: string;
  destination: Destination;
  destinationAccountId: string;
  destinationAccountName: string;
  destinationId: string;
  destinationUrl: string;
  status: "PUBLISHED" | "FAILED";
  publishedAt: string; // ISO-8601
  error?: JobError;
  /**
   * Phase 7: the publishJobs/{jobId} doc this entry was written for.
   * Lets the worker (and later phases) trace a history row back to its
   * job without guessing; a retried job may legitimately produce more
   * than one FAILED row.
   */
  jobId?: string;
}

/** Phase 7: an existing PUBLISHED record blocking a duplicate publish. */
export interface DuplicateInfo {
  destination: Destination;
  destinationAccountId: string;
  destinationAccountName: string;
  destinationUrl: string;
  publishedAt: string; // ISO-8601
}

/**
 * Phase 7: input for POST /api/publish.
 * `metadata`/`settings` mirror the wizard's step 4 + step 6 state;
 * the queue worker maps the per-destination subset into the YouTube /
 * Facebook upload engines.
 */
export interface PublishInput {
  driveFileId: string;
  destinations: Destination[];
  metadata: JobMetadata;
  settings: JobSettings & {
    /** Facebook Page id; defaults to the account's selected Page. */
    pageId?: string;
  };
  /**
   * Skip the duplicate-publish check. Only ever true after the user
   * explicitly confirmed "publish anyway" on a 409 DUPLICATE_PUBLISH.
   */
  confirmDuplicate?: boolean;
}

/** Phase 7: POST /api/publish success data. */
export interface PublishEnqueueResponse {
  jobs: PublishJob[];
}

/**
 * Phase 7: the error body for HTTP 409 from POST /api/publish (and
 * from the legacy /api/youtube/upload and /api/facebook/upload
 * routes, which now funnel through the same enqueue path). The
 * `duplicate` object is nested inside `error` exactly as documented.
 */
export interface DuplicatePublishErrorBody {
  code: "DUPLICATE_PUBLISH";
  message: string;
  duplicate: DuplicateInfo;
}

/** Phase 7: paginated GET /api/jobs response data. */
export interface JobsListResponse {
  jobs: PublishJob[];
  /** The job id to pass as `startAfter` for the next page; null at the end. */
  nextCursor: string | null;
}

/** Phase 7: paginated GET /api/history response data. */
export interface HistoryListResponse {
  entries: PublishHistory[];
  /** The entry id to pass as `startAfter` for the next page; null at the end. */
  nextCursor: string | null;
}

/** Phase 7: POST /api/jobs/:jobId/cancel response data. */
export interface CancelJobResponse {
  job: PublishJob;
  /**
   * True when the job was actively uploading: cancellation was
   * requested best-effort and the engine will settle the job to
   * CANCELLED between chunks. False when the job was PENDING and was
   * cancelled immediately.
   */
  cancellationRequested: boolean;
}

/**
 * A connected OAuth account (Firestore `connectedAccounts`).
 *
 * NOTE: OAuth access/refresh tokens are stored server-side only
 * (encrypted at rest) and are NEVER included in this type or sent
 * to the frontend. Only display-safe fields travel over the wire.
 */
export interface ConnectedAccount {
  id?: string;
  userId: string;
  provider: "google" | "meta";
  /**
   * For provider "google": which Google account this is — the Drive
   * account or the YouTube account. A user may connect Drive with one
   * Gmail and YouTube with a different one.
   */
  purpose?: "drive" | "youtube";
  scopes: string[];
  accountEmail?: string;
  accountName?: string;
  channelId?: string;
  channelTitle?: string;
  pageId?: string;
  pageName?: string;
  /**
   * Phase 5 (Meta): the Facebook Pages the user granted, publish
   * capability flagged. REDACTED — carries no tokens, only display-safe
   * fields. Populated for provider "meta" from GET /api/accounts and
   * GET /api/meta/pages.
   */
  metaPages?: MetaPage[];
  /** Phase 5 (Meta): the user's default Page for publishing. */
  selectedPageId?: string;
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
}

/**
 * Phase 5: a Facebook Page the user granted during Meta OAuth.
 * Publish-capable means the Page's tasks include CREATE_CONTENT (the
 * task Meta requires for Page video publishing). Redacted — never
 * carries the Page access token.
 */
export interface MetaPage {
  pageId: string;
  pageName: string;
  tasks: string[];
  canPublish: boolean;
}

/** POST /api/facebook/upload body (frontend → backend). */
export interface FacebookUploadInput {
  driveFileId: string;
  /** Defaults to the account's selectedPageId. */
  pageId?: string;
  /** Post text — sent as the Facebook video "description". */
  caption: string;
  /** Optional; defaults to the Drive file name without extension. */
  title?: string;
}

/** Gemini-generated metadata suggestion for a video. */
export interface GeminiMetadata {
  youtube_title: string;
  youtube_description: string;
  youtube_tags: string[];
  facebook_caption: string;
  hashtags: string[];
}

/**
 * Phase 6: input for POST /api/gemini/generate-metadata.
 * `language` is a BCP-47-ish label (e.g. "en", "bn"); the backend
 * defaults it to "en".
 */
export interface GenerateMetadataInput {
  driveFileId: string;
  /** Optional user context about the video; max 2000 chars. */
  topic?: string;
  /** Optional transcript/subtitles; max 20000 chars. */
  transcript?: string;
  language?: string;
}

/** Phase 6: how the Gemini suggestion was derived. */
export type MetadataAnalysisMode = "frames" | "metadata";

/** Phase 6: response data for POST /api/gemini/generate-metadata. */
export interface GeminiMetadataResult extends GeminiMetadata {
  /** "frames" when video frames were extracted and sent to Gemini. */
  analysisMode: MetadataAnalysisMode;
  /** Number of extracted frames actually sent to Gemini (0 in metadata mode). */
  framesUsed: number;
}

/** Phase 6: response data for GET /api/gemini/status. */
export interface GeminiStatus {
  configured: boolean;
  /**
   * Phase 8: the model that will actually be used for this caller's
   * generate-metadata requests — the user's per-user override when
   * set (Settings page), otherwise the server default (GEMINI_MODEL).
   */
  model: string;
  ffmpegAvailable: boolean;
}

/**
 * Phase 8: per-user publishing defaults + AI preferences, stored in
 * Firestore `settings/{uid}` (server-side only writes; the frontend
 * reads/writes via GET/PUT /api/settings).
 */
export interface UserSettings {
  /** Default YouTube privacy for new publishes. */
  defaultPrivacy: "public" | "unlisted" | "private";
  /** Default YouTube category id; "" means "not set". */
  defaultCategoryId: string;
  defaultMadeForKids: boolean;
  defaultNotifySubscribers: boolean;
  /** Default Facebook Page id; undefined means "use the account's selected Page". */
  defaultPageId?: string;
  /** Default hashtags, stored normalized (no leading "#"). */
  defaultHashtags: string[];
  /**
   * YouTube description template. Supports the `{title}` and
   * `{filename}` placeholders, substituted when the template is
   * applied to a publish.
   */
  defaultDescriptionTemplate: string;
  /**
   * Per-user Gemini model override; undefined means "use the server
   * default (GEMINI_MODEL)". Constrained to the allowlist below.
   */
  geminiModel?: string;
}

/**
 * Phase 8: the Gemini models a user may pick as their personal
 * default (Settings page). Single source of truth: the backend
 * validates PUT /api/settings against it, and the frontend renders
 * the model picker from it. The server default (config GEMINI_MODEL)
 * is "gemini-2.0-flash" — verified 2026-10-01 against Google's docs
 * for the v1beta generateContent REST endpoint.
 */
export const GEMINI_MODEL_ALLOWLIST = [
  "gemini-2.0-flash",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
] as const;

/** One of the GEMINI_MODEL_ALLOWLIST entries. */
export type GeminiModelName = (typeof GEMINI_MODEL_ALLOWLIST)[number];

/**
 * Phase 8: hardcoded defaults used when a user has no
 * `settings/{uid}` doc yet. GET /api/settings merges the stored doc
 * over these.
 */
export const DEFAULT_USER_SETTINGS: UserSettings = {
  defaultPrivacy: "private",
  defaultCategoryId: "",
  defaultMadeForKids: false,
  defaultNotifySubscribers: true,
  defaultHashtags: [],
  defaultDescriptionTemplate: "",
};

/** API envelope — every backend response uses this shape. */
export type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

/** A video file listed from Google Drive. */
export interface DriveVideoFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  modifiedTime: string; // ISO-8601
  thumbnailLink?: string;
  /**
   * Whether the file's container/codec is supported by the publish
   * pipeline. Phase 3 supports: mp4, mov, avi, mkv, webm (by MIME type
   * or file extension, case-insensitive).
   */
  supported?: boolean;
  /** Human-readable reason when supported === false. */
  supportReason?: string;
  /** From Drive's videoMediaMetadata, when available. */
  durationMillis?: number;
  width?: number;
  height?: number;
}

/** Paginated response for GET /api/drive/files. */
export interface DriveFileListResponse {
  files: DriveVideoFile[];
  nextPageToken?: string;
}

/** Response for GET /api/drive/preview-token/:fileId. */
export interface DrivePreviewToken {
  /** Relative URL of the signed preview endpoint; prefix with the API base URL. */
  url: string;
  expiresAt: string; // ISO-8601
}
