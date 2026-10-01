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
  GOOGLE_OAUTH_AUTHORIZE_URL,
  exchangeAuthorizationCode,
  fetchGoogleUserinfo,
  scopesForPurpose,
  upsertGoogleTokenDoc,
  type GoogleOAuthPurpose,
  type UpsertGoogleTokenInput,
} from "../lib/googleOAuth.js";

// ============================================================
// Google OAuth routes — mounted at /api/auth/google.
//
// Flow:
//   1. Frontend (authenticated) calls GET /start-url?purpose=drive
//      → receives the Google consent URL as JSON (a full-page
//        navigation can't send the Authorization header, so the
//        endpoint is JSON, not a 302 — the uid is bound server-side
//        in the `state` document).
//   2. User consents at Google → Google redirects to GET /callback
//      (PUBLIC — the user arrives from Google; the `state` value IS
//      the auth, single-use, 10-minute TTL).
//   3. Callback exchanges the code, stores encrypted tokens in
//      `connectedAccounts/{uid}_google`, and 302s back to the
//      frontend (/accounts?google=connected or ?google=error&reason=…).
//      Tokens are never placed in the redirect URL.
//
// Phase 4 added the "youtube" purpose to request additional scopes
// incrementally — the callback merges scopes via upsertGoogleTokenDoc.
// ============================================================

export const googleAuthRouter = Router();

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

interface OAuthStateDoc {
  state: string;
  uid: string;
  purpose: GoogleOAuthPurpose;
  scopes: string[];
  createdAt: number; // ms epoch
}

function assertGoogleOAuthConfigured(): void {
  if (
    config.GOOGLE_CLIENT_ID === "placeholder" ||
    config.GOOGLE_CLIENT_SECRET === "placeholder"
  ) {
    throw new HttpError(
      503,
      "GOOGLE_OAUTH_NOT_CONFIGURED",
      "Google OAuth is not configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). See docs/SETUP.md (Phase 10).",
    );
  }
}

function frontendAccountsUrl(params: string): string {
  const base = config.FRONTEND_URL.replace(/\/+$/, "");
  return `${base}/accounts${params}`;
}

const startUrlQuerySchema = z.object({
  purpose: z.enum(["drive", "youtube"]).default("drive"),
});

/**
 * GET /api/auth/google/start-url?purpose=drive — requireAuth.
 * Returns { url } — the Google consent URL to navigate to.
 */
googleAuthRouter.get(
  "/start-url",
  requireAuth,
  oauthStartUrlLimiter,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const { purpose } = startUrlQuerySchema.parse(req.query);
      assertGoogleOAuthConfigured();
      const uid = requireUid(req);
      const scopes = scopesForPurpose(purpose);

      const state = randomBytes(32).toString("hex");
      const doc: OAuthStateDoc = {
        state,
        uid,
        purpose,
        scopes,
        createdAt: Date.now(),
      };
      await getDb().doc(`oauthStates/${state}`).set(doc);

      const url = new URL(GOOGLE_OAUTH_AUTHORIZE_URL);
      url.searchParams.set("client_id", config.GOOGLE_CLIENT_ID);
      url.searchParams.set("redirect_uri", config.GOOGLE_REDIRECT_URI);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
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
async function consumeOAuthState(state: string): Promise<OAuthStateDoc> {
  const ref = getDb().doc(`oauthStates/${state}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpError(
      400,
      "INVALID_STATE",
      "Unknown or already-used OAuth state.",
    );
  }
  const data = snap.data() as OAuthStateDoc;
  // Single-use: delete even if expired.
  await ref.delete().catch(() => undefined);
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
      case "AUTH_CODE_EXPIRED":
        return "code_expired";
      case "GOOGLE_TOKEN_ERROR":
        return "token_exchange_failed";
      case "GOOGLE_USERINFO_FAILED":
        return "userinfo_failed";
      default:
        return "callback_failed";
    }
  }
  return "callback_failed";
}

/**
 * GET /api/auth/google/callback — PUBLIC (user arrives from Google).
 * Exchanges the code, upserts the encrypted token doc, and redirects
 * to the frontend. Never leaks tokens into the redirect URL.
 */
googleAuthRouter.get("/callback", async (req, res) => {
  const fail = (reason: string): void => {
    res.redirect(
      302,
      frontendAccountsUrl(`?google=error&reason=${encodeURIComponent(reason)}`),
    );
  };

  let parsed: z.infer<typeof callbackQuerySchema>;
  try {
    parsed = callbackQuerySchema.parse(req.query);
  } catch {
    fail("invalid_request");
    return;
  }

  // Google sends ?error=access_denied when the user cancels consent.
  if (parsed.error) {
    await getDb()
      .doc(`oauthStates/${parsed.state}`)
      .delete()
      .catch(() => undefined);
    logger.info(
      { oauthError: parsed.error },
      "Google OAuth returned an error (likely consent denied)",
    );
    fail(parsed.error === "access_denied" ? "access_denied" : "oauth_error");
    return;
  }

  if (!parsed.code) {
    fail("missing_code");
    return;
  }

  try {
    assertGoogleOAuthConfigured();
    const stateDoc = await consumeOAuthState(parsed.state);
    const tokens = await exchangeAuthorizationCode(parsed.code);
    const userinfo = await fetchGoogleUserinfo(tokens.accessToken);

    // exactOptionalPropertyTypes: only set optional fields when present.
    const upsertInput: UpsertGoogleTokenInput = {
      uid: stateDoc.uid,
      scopes: stateDoc.scopes,
      accessToken: tokens.accessToken,
      expiresIn: tokens.expiresIn,
    };
    if (tokens.refreshToken !== undefined) {
      upsertInput.refreshToken = tokens.refreshToken;
    }
    if (userinfo.email !== undefined) {
      upsertInput.accountEmail = userinfo.email;
    }
    if (userinfo.name !== undefined) {
      upsertInput.accountName = userinfo.name;
    }
    await upsertGoogleTokenDoc(upsertInput);

    res.redirect(302, frontendAccountsUrl("?google=connected"));
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Google OAuth callback failed",
    );
    fail(callbackFailureReason(err));
  }
});
