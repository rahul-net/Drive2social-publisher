import { createHmac } from "crypto";
import { z } from "zod";
import { google, type drive_v3 } from "googleapis";
import { config } from "../config.js";
import { getDb } from "./db.js";
import { logger } from "./logger.js";
import { HttpError } from "../middleware/errorHandler.js";
import {
  decryptToken,
  encryptToken,
  getTokenEncryptionKey,
  safeEqual,
} from "./tokenCrypto.js";

// ============================================================
// googleOAuth — Google OAuth2 + Drive helpers (Phases 3–4).
//
// Phase 4 (YouTube) reuses: GOOGLE_SCOPES, scopesForPurpose (with the
// "youtube" purpose), GoogleTokenDoc / googleTokenDocId,
// getValidAccessToken, upsertGoogleTokenDoc, makeDriveClient,
// mapGoogleError, and the GOOGLE_REAUTH_REQUIRED /
// GOOGLE_NOT_CONNECTED error types.
//
// Token storage: Firestore `connectedAccounts`, doc id `{uid}_google`.
// Tokens are stored ONLY encrypted (AES-256-GCM, see tokenCrypto).
// Plaintext tokens are never logged.
// ============================================================

export const GOOGLE_OAUTH_AUTHORIZE_URL =
  "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_USERINFO_URL =
  "https://openidconnect.googleapis.com/v1/userinfo";

/** Scope catalog. Phase 4 added the YouTube purposes/scopes below. */
export const GOOGLE_SCOPES = {
  openid: "openid",
  email: "email",
  profile: "profile",
  driveReadonly: "https://www.googleapis.com/auth/drive.readonly",
  /** Phase 4: incremental YouTube scopes. */
  youtubeUpload: "https://www.googleapis.com/auth/youtube.upload",
  /** Phase 4: needed for channels.list mine=true (channel card). */
  youtubeReadonly: "https://www.googleapis.com/auth/youtube.readonly",
} as const;

/**
 * Connect "purposes" → the scopes requested for that purpose.
 * `youtube` (openid/email/profile + youtubeUpload + youtubeReadonly)
 * reuses the incremental merge in upsertGoogleTokenDoc so the Drive
 * grant is kept while YouTube scopes are added.
 */
export type GoogleOAuthPurpose = "drive" | "youtube";

const PURPOSE_SCOPES: Record<GoogleOAuthPurpose, readonly string[]> = {
  drive: [
    GOOGLE_SCOPES.openid,
    GOOGLE_SCOPES.email,
    GOOGLE_SCOPES.profile,
    GOOGLE_SCOPES.driveReadonly,
  ],
  youtube: [
    GOOGLE_SCOPES.openid,
    GOOGLE_SCOPES.email,
    GOOGLE_SCOPES.profile,
    GOOGLE_SCOPES.youtubeUpload,
    GOOGLE_SCOPES.youtubeReadonly,
  ],
};

export function scopesForPurpose(purpose: GoogleOAuthPurpose): string[] {
  return [...PURPOSE_SCOPES[purpose]];
}

/** Doc id for a user's Google token record. */
export function googleTokenDocId(uid: string): string {
  return `${uid}_google`;
}

/**
 * Server-side shape of `connectedAccounts/{uid}_google`.
 * Tokens exist here ONLY in encrypted form — this interface never
 * travels to the frontend (see ConnectedAccount in shared types).
 */
export interface GoogleTokenDoc {
  userId: string;
  provider: "google";
  scopes: string[];
  accountEmail?: string;
  accountName?: string;
  accessToken_enc: string;
  refreshToken_enc: string;
  expiresAt: number; // ms epoch
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
}

/**
 * Thrown when the user must reconnect Google: the refresh token was
 * revoked/expired (invalid_grant) or no usable token exists.
 * The frontend must show a "reconnect" CTA — never retry in a loop.
 */
export class GoogleReauthRequiredError extends HttpError {
  constructor(
    message = "Google access expired or was revoked. Please reconnect your Google account.",
  ) {
    super(401, "GOOGLE_REAUTH_REQUIRED", message);
    this.name = "GoogleReauthRequiredError";
  }
}

/** Thrown when the user never connected Google at all. */
export class GoogleNotConnectedError extends HttpError {
  constructor(
    message = "No Google account is connected. Connect Google Drive under Accounts first.",
  ) {
    super(403, "GOOGLE_NOT_CONNECTED", message);
    this.name = "GoogleNotConnectedError";
  }
}

/** Raw token doc, or null when the user never connected Google. */
export async function getGoogleTokenDoc(
  uid: string,
): Promise<GoogleTokenDoc | null> {
  const snap = await getDb().doc(`connectedAccounts/${googleTokenDocId(uid)}`).get();
  if (!snap.exists) return null;
  return snap.data() as GoogleTokenDoc;
}

// --- token endpoint ------------------------------------------------

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

export interface GoogleTokens {
  accessToken: string;
  expiresIn: number; // seconds
  refreshToken?: string;
  scope?: string;
}

async function postTokenEndpoint(
  params: Record<string, string>,
): Promise<GoogleTokens> {
  let res: Response;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });
  } catch (err) {
    throw new HttpError(
      502,
      "GOOGLE_TOKEN_ERROR",
      `Could not reach Google's token endpoint: ${err instanceof Error ? err.message : "network error"}`,
    );
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const errCode =
      typeof body === "object" && body !== null
        ? (body as { error?: unknown }).error
        : undefined;
    if (errCode === "invalid_grant") {
      // Refresh token revoked/expired (or auth code already used).
      throw new GoogleReauthRequiredError();
    }
    throw new HttpError(
      502,
      "GOOGLE_TOKEN_ERROR",
      `Google token request failed (HTTP ${res.status}).`,
    );
  }

  const parsed = tokenResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(
      502,
      "GOOGLE_TOKEN_ERROR",
      "Google token response had an unexpected shape.",
    );
  }
  const tokens: GoogleTokens = {
    accessToken: parsed.data.access_token,
    expiresIn: parsed.data.expires_in,
  };
  if (parsed.data.refresh_token !== undefined) {
    tokens.refreshToken = parsed.data.refresh_token;
  }
  if (parsed.data.scope !== undefined) {
    tokens.scope = parsed.data.scope;
  }
  return tokens;
}

/** Exchange an authorization code for tokens (OAuth callback). */
export async function exchangeAuthorizationCode(
  code: string,
): Promise<GoogleTokens> {
  try {
    return await postTokenEndpoint({
      code,
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      redirect_uri: config.GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
    });
  } catch (err) {
    // An invalid_grant here means a bad/expired/used auth code — a
    // retry-the-flow problem, not a stored-token problem.
    if (err instanceof GoogleReauthRequiredError) {
      throw new HttpError(
        400,
        "AUTH_CODE_EXPIRED",
        "The authorization code was invalid or expired. Please try connecting again.",
      );
    }
    throw err;
  }
}

/** Refresh using a plaintext refresh token. invalid_grant → reauth. */
export async function refreshAccessToken(
  refreshToken: string,
): Promise<GoogleTokens> {
  return postTokenEndpoint({
    client_id: config.GOOGLE_CLIENT_ID,
    client_secret: config.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
}

// --- userinfo -------------------------------------------------------

const userinfoSchema = z.object({
  sub: z.string().min(1),
  email: z.string().email().optional(),
  name: z.string().optional(),
});

export interface GoogleUserinfo {
  sub: string;
  email?: string;
  name?: string;
}

/** Fetch the Google account's profile (identifies the connection). */
export async function fetchGoogleUserinfo(
  accessToken: string,
): Promise<GoogleUserinfo> {
  let res: Response;
  try {
    res = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    throw new HttpError(
      502,
      "GOOGLE_USERINFO_FAILED",
      `Could not reach Google userinfo: ${err instanceof Error ? err.message : "network error"}`,
    );
  }
  if (!res.ok) {
    throw new HttpError(
      502,
      "GOOGLE_USERINFO_FAILED",
      `Google userinfo request failed (HTTP ${res.status}).`,
    );
  }
  const parsed = userinfoSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) {
    throw new HttpError(
      502,
      "GOOGLE_USERINFO_FAILED",
      "Google userinfo response had an unexpected shape.",
    );
  }
  const info: GoogleUserinfo = { sub: parsed.data.sub };
  if (parsed.data.email !== undefined) info.email = parsed.data.email;
  if (parsed.data.name !== undefined) info.name = parsed.data.name;
  return info;
}

/** Revoke a refresh (or access) token at Google. Returns false on failure. */
export async function revokeGoogleToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// --- access token lifecycle -------------------------------------------

/** In-flight refresh promises, keyed by uid — concurrent requests share one. */
const inflight = new Map<string, Promise<string>>();

/**
 * A valid access token for the user's Google connection.
 *
 * Reads `connectedAccounts/{uid}_google`; returns the stored access token
 * when it is not expiring within 60s, otherwise refreshes via the token
 * endpoint and persists the new token + expiry.
 *
 * Throws GoogleNotConnectedError (never connected) or
 * GoogleReauthRequiredError (refresh rejected with invalid_grant — the
 * frontend must show a "reconnect" CTA, never retry in a loop).
 */
export function getValidAccessToken(
  uid: string,
  opts?: { forceRefresh?: boolean },
): Promise<string> {
  const existing = inflight.get(uid);
  if (existing) return existing;
  const p = loadValidAccessToken(uid, opts?.forceRefresh === true).finally(
    () => {
      if (inflight.get(uid) === p) inflight.delete(uid);
    },
  );
  inflight.set(uid, p);
  return p;
}

async function loadValidAccessToken(
  uid: string,
  forceRefresh: boolean,
): Promise<string> {
  const doc = await getGoogleTokenDoc(uid);
  if (!doc) throw new GoogleNotConnectedError();

  if (!forceRefresh && doc.expiresAt - Date.now() > 60_000) {
    return decryptToken(doc.accessToken_enc);
  }

  // Refresh path. invalid_grant → GoogleReauthRequiredError (no retry loop).
  const refreshToken = decryptToken(doc.refreshToken_enc);
  const refreshed = await refreshAccessToken(refreshToken);
  await getDb()
    .doc(`connectedAccounts/${googleTokenDocId(uid)}`)
    .update({
      accessToken_enc: encryptToken(refreshed.accessToken),
      expiresAt: Date.now() + refreshed.expiresIn * 1000,
      updatedAt: new Date().toISOString(),
    });
  return refreshed.accessToken;
}

export interface UpsertGoogleTokenInput {
  uid: string;
  /** Scopes granted in this OAuth round. Merged (union) with existing. */
  scopes: string[];
  accountEmail?: string;
  accountName?: string;
  /** Plaintext — encrypted here, never logged. */
  accessToken: string;
  /** Plaintext — encrypted here. When absent, the stored one is kept. */
  refreshToken?: string;
  /** seconds until the access token expires */
  expiresIn: number;
}

/**
 * Create or update `connectedAccounts/{uid}_google`.
 *
 * Incremental-auth strategy (Phase 4 reuses this): scopes are UNIONED
 * with any previously granted scopes, so requesting YouTube scopes
 * later keeps the Drive grant. The refresh token is only replaced when
 * Google returns a new one; otherwise the stored one is kept.
 */
export async function upsertGoogleTokenDoc(
  input: UpsertGoogleTokenInput,
): Promise<void> {
  const ref = getDb().doc(`connectedAccounts/${googleTokenDocId(input.uid)}`);
  const snap = await ref.get();
  const prev = snap.exists ? (snap.data() as Partial<GoogleTokenDoc>) : undefined;
  const now = new Date().toISOString();

  let refreshTokenEnc: string | undefined;
  if (input.refreshToken !== undefined) {
    refreshTokenEnc = encryptToken(input.refreshToken);
  } else if (prev?.refreshToken_enc) {
    refreshTokenEnc = prev.refreshToken_enc;
  }
  if (!refreshTokenEnc) {
    throw new HttpError(
      502,
      "GOOGLE_TOKEN_ERROR",
      "Google did not return a refresh token and none is stored. Please reconnect.",
    );
  }

  const data: GoogleTokenDoc = {
    userId: input.uid,
    provider: "google",
    scopes: Array.from(new Set([...(prev?.scopes ?? []), ...input.scopes])),
    accessToken_enc: encryptToken(input.accessToken),
    refreshToken_enc: refreshTokenEnc,
    expiresAt: Date.now() + input.expiresIn * 1000,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
  if (input.accountEmail !== undefined) data.accountEmail = input.accountEmail;
  if (input.accountName !== undefined) data.accountName = input.accountName;
  if (prev?.accountEmail !== undefined && data.accountEmail === undefined) {
    data.accountEmail = prev.accountEmail;
  }
  if (prev?.accountName !== undefined && data.accountName === undefined) {
    data.accountName = prev.accountName;
  }

  await ref.set(data);
  logger.info(
    { uid: input.uid, scopes: data.scopes.length },
    "Google account connected/updated",
  );
}

// --- Drive client -------------------------------------------------------

/** Drive v3 client authenticated as the user (official googleapis client). */
export function makeDriveClient(accessToken: string): drive_v3.Drive {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.drive({ version: "v3", auth });
}

/** HTTP status of a googleapis (Gaxios) error, if any. */
export function googleErrorStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const response = (err as { response?: unknown }).response;
  if (typeof response !== "object" || response === null) return undefined;
  const status = (response as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function googleErrorReason(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const response = (err as { response?: unknown }).response;
  if (typeof response !== "object" || response === null) return undefined;
  const data = (response as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return undefined;
  const error = (data as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return undefined;
  const errors = (error as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  const first = errors[0] as { reason?: unknown };
  return typeof first.reason === "string" ? first.reason : undefined;
}

/**
 * Map a Google API failure to an honest HttpError:
 *  - 401 → GOOGLE_REAUTH_REQUIRED (frontend shows reconnect CTA)
 *  - 404 → DRIVE_FILE_NOT_FOUND
 *  - 429 / quota 403 → GOOGLE_RATE_LIMITED (retryable)
 * HttpErrors pass through untouched.
 */
export function mapGoogleError(err: unknown, what = "Google API"): HttpError {
  if (err instanceof HttpError) return err;
  const status = googleErrorStatus(err);
  const reason = googleErrorReason(err);
  if (status === 401) return new GoogleReauthRequiredError();
  if (status === 404) {
    return new HttpError(
      404,
      "DRIVE_FILE_NOT_FOUND",
      "The file was not found in Google Drive.",
    );
  }
  if (
    status === 429 ||
    (status === 403 && reason !== undefined && /ratelimit|quota/i.test(reason))
  ) {
    return new HttpError(
      429,
      "GOOGLE_RATE_LIMITED",
      "Google API rate limit reached. Please retry shortly.",
    );
  }
  if (status === 403) {
    return new HttpError(
      403,
      "GOOGLE_FORBIDDEN",
      "Google denied access to this resource.",
    );
  }
  return new HttpError(
    502,
    "GOOGLE_API_ERROR",
    `${what} request failed${status ? ` (HTTP ${status})` : ""}.`,
  );
}

// --- signed preview URLs -------------------------------------------------

const PREVIEW_TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * Short-lived HMAC-SHA256 capability token for the public preview
 * endpoint. The token binds (uid, fileId, expiry); the preview route
 * re-validates the signature AND that the file is a video the user can
 * access before streaming a single byte. 10-minute TTL.
 */
export function createPreviewToken(
  uid: string,
  fileId: string,
): { token: string; exp: number } {
  const exp = Date.now() + PREVIEW_TOKEN_TTL_MS;
  const token = createHmac("sha256", getTokenEncryptionKey())
    .update(`${uid}:${fileId}:${exp}`, "utf8")
    .digest("hex");
  return { token, exp };
}

/** Constant-time verification of a preview token. */
export function verifyPreviewToken(
  uid: string,
  fileId: string,
  exp: number,
  token: string,
): boolean {
  if (!Number.isFinite(exp) || exp <= Date.now()) return false;
  const expected = createHmac("sha256", getTokenEncryptionKey())
    .update(`${uid}:${fileId}:${exp}`, "utf8")
    .digest("hex");
  return safeEqual(token, expected);
}
