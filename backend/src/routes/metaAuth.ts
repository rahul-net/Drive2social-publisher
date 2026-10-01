import { randomBytes } from "crypto";
import { Router } from "express";
import { z } from "zod";
import type { ApiResponse } from "@drive2social/shared";
import { config } from "../config.js";
import { HttpError } from "../middleware/errorHandler.js";
import {
  requireAuth,
  type AuthenticatedRequest,
} from "../middleware/requireAuth.js";
import { getDb } from "../lib/db.js";
import { requireUid } from "../lib/authRequest.js";
import { logger } from "../lib/logger.js";
import { oauthStartUrlLimiter } from "../lib/rateLimit.js";
import { FirebaseNotConfiguredError } from "../lib/firebaseAdmin.js";
import {
  META_SCOPES,
  exchangeForLongLivedUserToken,
  exchangeMetaCode,
  fetchMetaPages,
  fetchMetaUser,
  metaOAuthDialogUrl,
  upsertMetaTokenDoc,
} from "../lib/metaOAuth.js";

// ============================================================
// Meta (Facebook) OAuth routes — mounted at /api/auth/meta.
//
// Mirrors the Google flow (routes/googleAuth.ts):
//   1. Frontend (authenticated) calls GET /start-url → receives the
//      Facebook consent URL as JSON (a full-page navigation can't
//      send the Authorization header, so the endpoint is JSON, not a
//      302 — the uid is bound server-side in the `state` document).
//   2. User consents at Facebook → Facebook redirects to GET
//      /callback (PUBLIC — the user arrives from Facebook; the
//      `state` value IS the auth, single-use, 10-minute TTL).
//   3. Callback exchanges the code for a short-lived user token,
//      exchanges that for a long-lived user token, fetches
//      /me/accounts for the (non-expiring) Page access tokens, stores
//      the ENCRYPTED page tokens in `connectedAccounts/{uid}_meta`,
//      and 302s back to the frontend
//      (/accounts?meta=connected or ?meta=error&reason=…).
//      Tokens are never placed in the redirect URL.
//
// Scopes: pages_show_list, pages_read_engagement, pages_manage_posts
// (per the Page Videos reference:
// https://developers.facebook.com/docs/graph-api/reference/page/videos/).
// ============================================================

export const metaAuthRouter = Router();

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

interface MetaOAuthStateDoc {
  state: string;
  uid: string;
  purpose: "meta";
  scopes: string[];
  createdAt: number; // ms epoch
}

function assertMetaOAuthConfigured(): void {
  if (
    config.META_APP_ID === "placeholder" ||
    config.META_APP_SECRET === "placeholder"
  ) {
    throw new HttpError(
      503,
      "META_OAUTH_NOT_CONFIGURED",
      "Meta OAuth is not configured on this server (META_APP_ID / META_APP_SECRET). See docs/SETUP.md (Phase 10).",
    );
  }
}

function frontendAccountsUrl(params: string): string {
  const base = config.FRONTEND_URL.replace(/\/+$/, "");
  return `${base}/accounts${params}`;
}

/**
 * GET /api/auth/meta/start-url — requireAuth.
 * Returns { url } — the Facebook consent URL to navigate to.
 */
metaAuthRouter.get(
  "/start-url",
  requireAuth,
  oauthStartUrlLimiter,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      assertMetaOAuthConfigured();
      const uid = requireUid(req);
      const scopes = [...META_SCOPES];

      const state = randomBytes(32).toString("hex");
      const doc: MetaOAuthStateDoc = {
        state,
        uid,
        purpose: "meta",
        scopes,
        createdAt: Date.now(),
      };
      await getDb().doc(`oauthStates/${state}`).set(doc);

      const url = new URL(metaOAuthDialogUrl());
      url.searchParams.set("client_id", config.META_APP_ID);
      url.searchParams.set("redirect_uri", config.META_REDIRECT_URI);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", scopes.join(","));
      url.searchParams.set("state", state);

      const body: ApiResponse<{ url: string }> = {
        ok: true,
        data: { url: url.toString() },
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);

/** Consume (read + delete) an OAuth state; throws on unknown/expired. */
async function consumeOAuthState(state: string): Promise<MetaOAuthStateDoc> {
  const ref = getDb().doc(`oauthStates/${state}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpError(
      400,
      "INVALID_STATE",
      "Unknown or already-used OAuth state.",
    );
  }
  const data = snap.data() as MetaOAuthStateDoc;
  // Single-use: delete even if expired.
  await ref.delete().catch(() => undefined);
  if (data.purpose !== "meta") {
    throw new HttpError(
      400,
      "INVALID_STATE",
      "OAuth state was issued for a different provider.",
    );
  }
  if (Date.now() - data.createdAt > OAUTH_STATE_TTL_MS) {
    throw new HttpError(
      400,
      "EXPIRED_STATE",
      "OAuth session expired. Please try again.",
    );
  }
  return data;
}

const callbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1),
  error: z.string().optional(),
});

/** Map a callback failure to the safe `reason` query param for the frontend. */
function callbackFailureReason(err: unknown): string {
  if (err instanceof FirebaseNotConfiguredError) return "server_not_configured";
  if (err instanceof HttpError) {
    switch (err.code) {
      case "INVALID_STATE":
        return "invalid_state";
      case "EXPIRED_STATE":
        return "expired_state";
      case "META_TOKEN_ERROR":
        return "token_exchange_failed";
      case "META_USERINFO_FAILED":
        return "userinfo_failed";
      case "META_PAGES_FAILED":
        return "pages_failed";
      default:
        return "callback_failed";
    }
  }
  return "callback_failed";
}

/**
 * GET /api/auth/meta/callback — PUBLIC (user arrives from Facebook).
 * Exchanges the code, stores the encrypted Page tokens, and redirects
 * to the frontend. Never leaks tokens into the redirect URL.
 */
metaAuthRouter.get("/callback", async (req, res) => {
  const fail = (reason: string): void => {
    res.redirect(
      302,
      frontendAccountsUrl(`?meta=error&reason=${encodeURIComponent(reason)}`),
    );
  };

  let parsed: z.infer<typeof callbackQuerySchema>;
  try {
    parsed = callbackQuerySchema.parse(req.query);
  } catch {
    fail("invalid_request");
    return;
  }

  // Facebook sends ?error=access_denied&error_reason=user_denied when
  // the user cancels consent.
  if (parsed.error) {
    await getDb()
      .doc(`oauthStates/${parsed.state}`)
      .delete()
      .catch(() => undefined);
    logger.info(
      { oauthError: parsed.error },
      "Meta OAuth returned an error (likely consent denied)",
    );
    fail(parsed.error === "access_denied" ? "access_denied" : "oauth_error");
    return;
  }

  if (!parsed.code) {
    fail("missing_code");
    return;
  }

  try {
    assertMetaOAuthConfigured();
    const stateDoc = await consumeOAuthState(parsed.state);

    // code → short-lived user token → long-lived user token → Pages.
    // Only the Page tokens (non-expiring) are stored; the user tokens
    // are transient and never persisted.
    const short = await exchangeMetaCode(parsed.code);
    const longLived = await exchangeForLongLivedUserToken(short.accessToken);
    const me = await fetchMetaUser(longLived);
    const pages = await fetchMetaPages(longLived);

    await upsertMetaTokenDoc({
      uid: stateDoc.uid,
      scopes: stateDoc.scopes,
      fbUserId: me.id,
      fbUserName: me.name,
      pages,
    });

    if (pages.length === 0) {
      // Connected, but no Pages were granted — the user will see the
      // honest empty state on the Accounts page.
      logger.info(
        { uid: stateDoc.uid },
        "Meta OAuth succeeded but the user granted no Pages",
      );
    }
    res.redirect(302, frontendAccountsUrl("?meta=connected"));
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Meta OAuth callback failed",
    );
    fail(callbackFailureReason(err));
  }
});
