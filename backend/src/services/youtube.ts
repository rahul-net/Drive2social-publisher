import { z } from "zod";
import { HttpError } from "../middleware/errorHandler.js";
import { logger } from "../lib/logger.js";
import {
  GOOGLE_SCOPES,
  GoogleNotConnectedError,
  getGoogleTokenDoc,
  getValidAccessToken,
} from "../lib/googleOAuth.js";

// ============================================================
// YouTube Data API v3 helpers — Phase 4.
//
// - Pure, unit-testable error mapping: extractYouTubeError /
//   classifyYouTubeFailure (no fetch, no secrets — safe to test).
// - requireYouTubeScope: token-ownership guard; every YouTube call
//   resolves the uid's own token from connectedAccounts/{uid}_google.
// - getOwnYouTubeChannel / listVideoCategories: real API calls used
//   by the routes and the upload engine.
//
// Quota note: the default YouTube Data API quota is 10,000 units/day
// and videos.insert costs 1,600 units (~6 uploads/day). A 403 with
// reason "quotaExceeded" is classified as YOUTUBE_QUOTA_EXCEEDED —
// retryable=false, never retried blindly.
// ============================================================

/** A parsed YouTube Data API error (pure data — no secrets). */
export interface YouTubeErrorDetail {
  status: number;
  /** YouTube's machine-readable reason, e.g. "quotaExceeded". */
  reason?: string;
  /** YouTube's human message (truncated to a safe length). */
  message: string;
}

/** Outcome of classifying a YouTube failure for job bookkeeping. */
export interface ClassifiedFailure {
  /** Machine-readable code stored on the job doc's error.code. */
  code: string;
  /** User-facing message stored on the job doc's error.message. */
  message: string;
  /** Whether a later retry may succeed (network/5xx → true). */
  retryable: boolean;
}

const MAX_SAFE_MESSAGE_LEN = 400;

/**
 * Parse a YouTube Data API error body into a YouTubeErrorDetail.
 * Pure — no I/O. Tolerates non-JSON / unexpected shapes.
 */
export function extractYouTubeError(
  status: number,
  body: unknown,
): YouTubeErrorDetail {
  let reason: string | undefined;
  let message = `YouTube API request failed (HTTP ${status}).`;
  if (typeof body === "object" && body !== null) {
    const err = (body as { error?: unknown }).error;
    if (typeof err === "object" && err !== null) {
      const e = err as { message?: unknown; errors?: unknown };
      if (typeof e.message === "string" && e.message.length > 0) {
        message = e.message;
      }
      if (Array.isArray(e.errors) && e.errors.length > 0) {
        const first = e.errors[0] as { reason?: unknown };
        if (typeof first.reason === "string" && first.reason.length > 0) {
          reason = first.reason;
        }
      }
    }
  }
  if (message.length > MAX_SAFE_MESSAGE_LEN) {
    message = `${message.slice(0, MAX_SAFE_MESSAGE_LEN)}…`;
  }
  const detail: YouTubeErrorDetail = { status, message };
  if (reason !== undefined) detail.reason = reason;
  return detail;
}

/**
 * Map a YouTube failure to a job-bookkeeping decision. Pure — no I/O.
 *
 * Rules (per the verified API facts):
 *  - 401 → YOUTUBE_REAUTH_REQUIRED (the caller refreshes ONCE before
 *    reaching this; a second 401 means reauth). Never retry in a loop.
 *  - 403 quotaExceeded → YOUTUBE_QUOTA_EXCEEDED, retryable=false,
 *    with the ~6 uploads/day explanation. No blind retry.
 *  - 403 uploadLimitExceeded / youtubeSignupRequired →
 *    YOUTUBE_UPLOAD_LIMIT / NO_YOUTUBE_CHANNEL, retryable=false.
 *  - Other 4xx → retryable=false, YouTube's message surfaced safely.
 *  - 5xx → retryable=true (a later retry resumes the upload).
 */
export function classifyYouTubeFailure(
  detail: YouTubeErrorDetail,
): ClassifiedFailure {
  const { status, reason, message } = detail;
  if (status === 401) {
    return {
      code: "YOUTUBE_REAUTH_REQUIRED",
      message:
        "YouTube access expired or was revoked. Please reconnect your Google account (Accounts → Connect YouTube channel).",
      retryable: false,
    };
  }
  if (status === 403 && reason === "quotaExceeded") {
    return {
      code: "YOUTUBE_QUOTA_EXCEEDED",
      message:
        "YouTube API daily quota exceeded. The default quota allows roughly 6 uploads per day (each upload costs 1,600 of 10,000 units). Please try again tomorrow.",
      retryable: false,
    };
  }
  if (status === 403 && reason === "uploadLimitExceeded") {
    return {
      code: "YOUTUBE_UPLOAD_LIMIT",
      message:
        "This YouTube channel has hit its upload limit. Please try again later.",
      retryable: false,
    };
  }
  if (
    status === 403 &&
    (reason === "youtubeSignupRequired" || reason === "accountSuspended")
  ) {
    return {
      code: "NO_YOUTUBE_CHANNEL",
      message:
        "This Google account has no usable YouTube channel. Create one at youtube.com, then reconnect.",
      retryable: false,
    };
  }
  if (status === 403) {
    return { code: "YOUTUBE_FORBIDDEN", message, retryable: false };
  }
  if (status === 400) {
    return { code: "YOUTUBE_INVALID_REQUEST", message, retryable: false };
  }
  if (status === 404 || status === 410) {
    return { code: "YOUTUBE_NOT_FOUND", message, retryable: false };
  }
  if (status >= 500) {
    return {
      code: "YOUTUBE_API_ERROR",
      message: `YouTube returned an error (HTTP ${status}). The upload can be retried — it will resume from the saved session.`,
      retryable: true,
    };
  }
  return { code: "YOUTUBE_API_ERROR", message, retryable: false };
}

/** A network-level failure while talking to Google — always retryable. */
export function networkFailure(kind: string, err: unknown): ClassifiedFailure {
  const detail =
    err instanceof Error && err.message ? `: ${err.message}` : "";
  return {
    code: "YOUTUBE_NETWORK_ERROR",
    message: `${kind} failed because of a network error${detail}. The upload can be retried — it will resume from the saved session.`,
    retryable: true,
  };
}

/**
 * Token-ownership guard for YouTube calls. Throws:
 *  - GoogleNotConnectedError (403 GOOGLE_NOT_CONNECTED) when the user
 *    never connected Google at all;
 *  - HttpError 403 YOUTUBE_NOT_CONNECTED when the Google connection
 *    exists but the YouTube scopes were never granted (with an
 *    incremental-reconnect hint).
 */
export async function requireYouTubeScope(uid: string): Promise<void> {
  const doc = await getGoogleTokenDoc(uid, "youtube");
  if (!doc) {
    throw new GoogleNotConnectedError(
      "No Google account is connected. Connect Google under Accounts first.",
    );
  }
  if (!doc.scopes.includes(GOOGLE_SCOPES.youtubeUpload)) {
    throw new HttpError(
      403,
      "YOUTUBE_NOT_CONNECTED",
      "YouTube is not connected for this Google account. Connect your YouTube channel under Accounts (your Drive connection is kept).",
    );
  }
}

// --- JSON API calls ---------------------------------------------------

/**
 * GET a YouTube Data API endpoint as the user. On 401, refreshes the
 * access token ONCE and retries; a second 401 throws
 * YOUTUBE_REAUTH_REQUIRED. Other failures throw an HttpError carrying
 * the classified code/message (safe to surface).
 */
async function youtubeGetJson(
  uid: string,
  url: string,
  what: string,
): Promise<unknown> {
  let accessToken = await getValidAccessToken(uid, "youtube");
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    const failure = networkFailure(what, err);
    throw new HttpError(502, failure.code, failure.message);
  }

  if (res.status === 401) {
    // One refresh, then one retry — never a loop.
    accessToken = await getValidAccessToken(uid, "youtube", { forceRefresh: true });
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch (err) {
      const f = networkFailure(what, err);
      throw new HttpError(502, f.code, f.message);
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const classified = classifyYouTubeFailure(
      extractYouTubeError(res.status, body),
    );
    logger.warn(
      { uid, status: res.status, code: classified.code },
      `${what} failed`,
    );
    throw new HttpError(
      res.status === 429 ? 429 : classified.retryable ? 502 : 400,
      classified.code,
      classified.message,
    );
  }
  return res.json().catch(() => null);
}

export interface YouTubeChannelInfo {
  channelId: string;
  title: string;
  description?: string;
  thumbnailUrl?: string;
  subscriberCount?: number;
  videoCount?: number;
}

const channelsResponseSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1),
        snippet: z
          .object({
            title: z.string(),
            description: z.string().optional(),
            thumbnails: z
              .object({
                default: z.object({ url: z.string().url() }).optional(),
              })
              .optional(),
          })
          .optional(),
        statistics: z
          .object({
            subscriberCount: z.string().optional(),
            videoCount: z.string().optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});

function parseCount(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The user's own YouTube channel (channels.list mine=true).
 * Throws 403 YOUTUBE_NOT_CONNECTED when the YouTube scopes were never
 * granted, 404 NO_YOUTUBE_CHANNEL when the Google account has no
 * channel at all.
 */
export async function getOwnYouTubeChannel(
  uid: string,
): Promise<YouTubeChannelInfo> {
  await requireYouTubeScope(uid);
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("mine", "true");
  url.searchParams.set("part", "snippet,statistics");
  const parsed = channelsResponseSchema.safeParse(
    await youtubeGetJson(uid, url.toString(), "YouTube channels.list"),
  );
  const item = parsed.success ? parsed.data.items?.[0] : undefined;
  if (!item) {
    throw new HttpError(
      404,
      "NO_YOUTUBE_CHANNEL",
      "This Google account has no YouTube channel. Create one at youtube.com, then reconnect.",
    );
  }
  const info: YouTubeChannelInfo = {
    channelId: item.id,
    title: item.snippet?.title ?? "YouTube channel",
  };
  if (item.snippet?.description) info.description = item.snippet.description;
  const thumb = item.snippet?.thumbnails?.default?.url;
  if (thumb) info.thumbnailUrl = thumb;
  const subs = parseCount(item.statistics?.subscriberCount);
  if (subs !== undefined) info.subscriberCount = subs;
  const videos = parseCount(item.statistics?.videoCount);
  if (videos !== undefined) info.videoCount = videos;
  return info;
}

export interface YouTubeVideoCategory {
  id: string;
  title: string;
}

const categoriesResponseSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1),
        snippet: z.object({
          title: z.string(),
          assignable: z.boolean().optional(),
        }),
      }),
    )
    .optional(),
});

/** Assignable video categories for a region (default US). */
export async function listVideoCategories(
  uid: string,
  regionCode: string,
): Promise<YouTubeVideoCategory[]> {
  await requireYouTubeScope(uid);
  const url = new URL(
    "https://www.googleapis.com/youtube/v3/videoCategories",
  );
  url.searchParams.set("regionCode", regionCode);
  url.searchParams.set("part", "snippet");
  const parsed = categoriesResponseSchema.safeParse(
    await youtubeGetJson(uid, url.toString(), "YouTube videoCategories.list"),
  );
  if (!parsed.success) return [];
  return (parsed.data.items ?? [])
    .filter((c) => c.snippet.assignable !== false)
    .map((c) => ({ id: c.id, title: c.snippet.title }));
}
