import { z } from "zod";
import { config } from "../config.js";
import { getDb } from "./db.js";
import { logger } from "./logger.js";
import { HttpError } from "../middleware/errorHandler.js";
import { decryptToken, encryptToken } from "./tokenCrypto.js";

// ============================================================
// Meta (Facebook Login) OAuth — Phase 5.
//
// Verified 2026-10-01 against Meta's current docs:
//   - Video API publishing guide (requirements + publish flow):
//       https://developers.facebook.com/docs/video-api/guides/publishing/
//   - Page Videos reference (upload_phase {start,transfer,finish,cancel},
//     title, description params; CREATE_CONTENT task + the three
//     permissions):
//       https://developers.facebook.com/docs/graph-api/reference/page/videos/
//   - Resumable-upload phase details (mirrored from the Meta docs):
//       https://github.com/restfb/restfb.github.io/blob/HEAD/_includes/documentation/publishing-big-video.md
//   - Graph API versions (v22.0 supported until 2027-05-20; latest
//     stable v26.0):
//       https://developers.facebook.com/docs/graph-api/changelog/
//
// Page video publishing requires, per the Page Videos reference:
//   - a Page access token requested by a person who can perform the
//     CREATE_CONTENT task on the Page, and
//   - the permissions pages_show_list, pages_read_engagement,
//     pages_manage_posts granted via Facebook Login.
//
// App-review reality (see the Meta access-levels doc): permissions with
// Standard Access can only be granted by app-role users
// (admins/developers/testers). pages_manage_posts needs App Review
// (Advanced Access) before the general public can publish — the app
// works in development mode until then. The frontend Accounts card
// states this honestly.
//
// Token shape: the code exchange yields a SHORT-LIVED user token
// (~hours); exchanging it with grant_type=fb_exchange_token yields a
// LONG-LIVED user token (~60 days). Page access tokens fetched via
// GET /me/accounts with the long-lived user token are
// non-expiring ("Expires: Never") as long as the user stays a Page
// admin and the app's permissions aren't revoked. We store ONLY the
// long-lived Page tokens (encrypted) — the user token is discarded
// after /me/accounts. Page tokens are non-expiring, so unlike Google
// there is no refresh path; a bad token means reconnect.
//
// Meta provides NO token-revoke endpoint for this flow (unlike
// Google's /revoke). Disconnecting deletes the local doc and tells the
// user to also remove the app at facebook.com → Settings → Apps.
// ============================================================

/** Scopes requested for Page video publishing (per the docs above). */
export const META_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
] as const;

/** The Page task Meta requires for publishing content. */
export const META_PUBLISH_TASK = "CREATE_CONTENT";

function graphBase(): string {
  return `https://graph.facebook.com/${config.META_GRAPH_VERSION}`;
}

export function metaOAuthDialogUrl(): string {
  return `https://www.facebook.com/${config.META_GRAPH_VERSION}/dialog/oauth`;
}

export function metaTokenDocId(uid: string): string {
  return `${uid}_meta`;
}

/** Whether a Page's task list grants publishing capability. */
export function pageCanPublish(tasks: string[]): boolean {
  return tasks.includes(META_PUBLISH_TASK);
}

// --- stored doc ----------------------------------------------------------

export interface MetaPageEntry {
  pageId: string;
  pageName: string;
  tasks: string[];
  pageToken_enc: string;
}

export interface MetaTokenDoc {
  userId: string;
  provider: "meta";
  scopes: string[];
  fbUserId: string;
  fbUserName: string;
  pages: MetaPageEntry[];
  selectedPageId?: string;
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
}

export async function getMetaTokenDoc(uid: string): Promise<MetaTokenDoc | null> {
  const snap = await getDb().doc(`connectedAccounts/${metaTokenDocId(uid)}`).get();
  if (!snap.exists) return null;
  return snap.data() as MetaTokenDoc;
}

// --- errors ---------------------------------------------------------------

export class MetaNotConnectedError extends HttpError {
  constructor() {
    super(
      403,
      "META_NOT_CONNECTED",
      "Facebook is not connected. Connect your Facebook account on the Accounts page first.",
    );
    this.name = "MetaNotConnectedError";
  }
}

/** Thrown when a Page is missing, belongs to another user, or lacks CREATE_CONTENT. */
export class FacebookPageNotAuthorizedError extends HttpError {
  constructor(pageId: string, detail: string) {
    super(
      403,
      "FACEBOOK_PAGE_NOT_AUTHORIZED",
      `Page ${pageId} cannot publish: ${detail}`,
    );
    this.name = "FacebookPageNotAuthorizedError";
  }
}

// --- Graph API error extraction ---------------------------------------------

const graphErrorSchema = z.object({
  error: z.object({
    message: z.string().optional(),
    type: z.string().optional(),
    code: z.number().optional(),
    error_subcode: z.number().optional(),
  }),
});

export interface MetaApiError {
  code: number | undefined;
  subcode: number | undefined;
  type: string | undefined;
  message: string;
}

/** Parse a Graph API error body into a structured error (never throws). */
export function extractMetaError(res: Response, body: unknown): MetaApiError {
  const parsed = graphErrorSchema.safeParse(body);
  if (parsed.success) {
    const e = parsed.data.error;
    return {
      code: e.code,
      subcode: e.error_subcode,
      type: e.type,
      message: e.message ?? `Meta API request failed (HTTP ${res.status}).`,
    };
  }
  return {
    code: undefined,
    subcode: undefined,
    type: undefined,
    message: `Meta API request failed (HTTP ${res.status}).`,
  };
}

async function graphGet<T>(
  path: string,
  params: Record<string, string>,
  what: string,
): Promise<T> {
  const url = new URL(`${graphBase()}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(url.toString());
  } catch (err) {
    throw new HttpError(
      502,
      "META_NETWORK_ERROR",
      `${what}: network error contacting Meta (${err instanceof Error ? err.message : "unknown"}). It can be retried.`,
    );
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const metaErr = extractMetaError(res, body);
    // Never surface the raw Meta error verbatim when it might contain
    // token fragments; the extracted message is safe (no tokens).
    throw new HttpError(
      res.status >= 500 ? 502 : res.status,
      "META_API_ERROR",
      `${what}: ${metaErr.message} (Meta error code ${metaErr.code ?? "unknown"})`,
    );
  }
  return body as T;
}

// --- OAuth token exchange ----------------------------------------------------

const codeExchangeSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().optional(),
  token_type: z.string().optional(),
});

/**
 * Exchange the authorization code for a short-lived user access token.
 * GET https://graph.facebook.com/v<VER>/oauth/access_token
 *   ?client_id=&redirect_uri=&client_secret=&code=
 */
export async function exchangeMetaCode(
  code: string,
): Promise<{ accessToken: string; expiresIn?: number }> {
  const body = await graphGet<unknown>(
    "/oauth/access_token",
    {
      client_id: config.META_APP_ID,
      redirect_uri: config.META_REDIRECT_URI,
      client_secret: config.META_APP_SECRET,
      code,
    },
    "Meta authorization-code exchange",
  );
  const parsed = codeExchangeSchema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(
      502,
      "META_TOKEN_ERROR",
      "Meta did not return an access token. The connection can be retried.",
    );
  }
  const result: { accessToken: string; expiresIn?: number } = {
    accessToken: parsed.data.access_token,
  };
  if (parsed.data.expires_in !== undefined) {
    result.expiresIn = parsed.data.expires_in;
  }
  return result;
}

const longLivedSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().optional(),
  token_type: z.string().optional(),
});

/**
 * Exchange a short-lived user token for a long-lived (~60 days) user
 * token: grant_type=fb_exchange_token. The Page tokens derived from it
 * via /me/accounts are non-expiring.
 */
export async function exchangeForLongLivedUserToken(
  shortLivedToken: string,
): Promise<string> {
  const body = await graphGet<unknown>(
    "/oauth/access_token",
    {
      grant_type: "fb_exchange_token",
      client_id: config.META_APP_ID,
      client_secret: config.META_APP_SECRET,
      fb_exchange_token: shortLivedToken,
    },
    "Meta long-lived token exchange",
  );
  const parsed = longLivedSchema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(
      502,
      "META_TOKEN_ERROR",
      "Meta did not return a long-lived token. The connection can be retried.",
    );
  }
  return parsed.data.access_token;
}

// --- user + pages ------------------------------------------------------------

const meSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

/** GET /me?fields=id,name — the Facebook user's id and display name. */
export async function fetchMetaUser(
  userToken: string,
): Promise<{ id: string; name: string }> {
  const body = await graphGet<unknown>(
    "/me",
    { fields: "id,name", access_token: userToken },
    "Meta user profile",
  );
  const parsed = meSchema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(
      502,
      "META_USERINFO_FAILED",
      "Could not read the Facebook profile. The connection can be retried.",
    );
  }
  return parsed.data;
}

const accountsSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        access_token: z.string().min(1),
        tasks: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

export interface MetaPageGrant {
  id: string;
  name: string;
  accessToken: string;
  tasks: string[];
}

/**
 * GET /me/accounts?fields=id,name,access_token,tasks with the
 * LONG-LIVED user token. The returned Page access tokens are
 * non-expiring ("Expires: Never") while the grant holds.
 */
export async function fetchMetaPages(
  longLivedUserToken: string,
): Promise<MetaPageGrant[]> {
  const body = await graphGet<unknown>(
    "/me/accounts",
    {
      fields: "id,name,access_token,tasks",
      access_token: longLivedUserToken,
    },
    "Meta Page list",
  );
  const parsed = accountsSchema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(
      502,
      "META_PAGES_FAILED",
      "Could not read the Facebook Pages for this account. The connection can be retried.",
    );
  }
  return parsed.data.data.map((p) => ({
    id: p.id,
    name: p.name,
    accessToken: p.access_token,
    tasks: p.tasks,
  }));
}

// --- persistence ---------------------------------------------------------------

export interface UpsertMetaTokenInput {
  uid: string;
  scopes: string[];
  fbUserId: string;
  fbUserName: string;
  pages: MetaPageGrant[];
}

/**
 * Create or replace connectedAccounts/{uid}_meta. Page tokens are
 * encrypted at rest (tokenCrypto, same as Google). The short-lived and
 * long-lived USER tokens are deliberately not stored — only the
 * non-expiring Page tokens.
 */
export async function upsertMetaTokenDoc(input: UpsertMetaTokenInput): Promise<void> {
  const now = new Date().toISOString();
  const ref = getDb().doc(`connectedAccounts/${metaTokenDocId(input.uid)}`);
  const existing = await ref.get();
  const prev = existing.exists ? (existing.data() as Partial<MetaTokenDoc>) : {};

  const doc: MetaTokenDoc = {
    userId: input.uid,
    provider: "meta",
    scopes: input.scopes,
    fbUserId: input.fbUserId,
    fbUserName: input.fbUserName,
    pages: input.pages.map((p) => ({
      pageId: p.id,
      pageName: p.name,
      tasks: p.tasks,
      pageToken_enc: encryptToken(p.accessToken),
    })),
    createdAt: prev.createdAt ?? now,
    updatedAt: now,
  };
  // exactOptionalPropertyTypes: only carry a previous selection forward
  // when the page still exists in the new grant.
  const prevSelected = prev.selectedPageId;
  if (
    prevSelected !== undefined &&
    doc.pages.some((p) => p.pageId === prevSelected)
  ) {
    doc.selectedPageId = prevSelected;
  }
  await ref.set(doc);
  logger.info(
    { uid: input.uid, pages: doc.pages.length },
    "Meta account connected",
  );
}

/** Redacted page listing for the API (never tokens). */
export function toRedactedPages(doc: MetaTokenDoc): Array<{
  pageId: string;
  pageName: string;
  tasks: string[];
  canPublish: boolean;
}> {
  return doc.pages.map((p) => ({
    pageId: p.pageId,
    pageName: p.pageName,
    tasks: p.tasks,
    canPublish: pageCanPublish(p.tasks),
  }));
}

export interface ResolvedPageToken {
  pageId: string;
  pageName: string;
  pageToken: string;
}

/**
 * Resolve a Page's decrypted access token with token-ownership and
 * publish-capability checks. Throws MetaNotConnectedError (no doc) or
 * FacebookPageNotAuthorizedError (unknown page, or page lacks the
 * CREATE_CONTENT task). The plaintext token is returned to the caller
 * — never log it.
 */
export async function getPageToken(
  uid: string,
  pageId: string,
): Promise<ResolvedPageToken> {
  const doc = await getMetaTokenDoc(uid);
  if (!doc) throw new MetaNotConnectedError();
  const page = doc.pages.find((p) => p.pageId === pageId);
  if (!page) {
    throw new FacebookPageNotAuthorizedError(
      pageId,
      "this Page was not granted to Drive2Social. Reconnect Facebook and make sure the Page is selected during the Facebook permission dialog.",
    );
  }
  if (!pageCanPublish(page.tasks)) {
    throw new FacebookPageNotAuthorizedError(
      pageId,
      `the connected Facebook user lacks the ${META_PUBLISH_TASK} task on this Page. ` +
        "Ask a Page admin to grant the CREATE_CONTENT task (Page Settings → Page access), then reconnect.",
    );
  }
  return {
    pageId: page.pageId,
    pageName: page.pageName,
    pageToken: decryptToken(page.pageToken_enc),
  };
}
