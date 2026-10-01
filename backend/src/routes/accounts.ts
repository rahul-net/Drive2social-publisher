import { Router } from "express";
import type { ApiResponse, ConnectedAccount } from "@drive2social/shared";
import {
  requireAuth,
  type AuthenticatedRequest,
} from "../middleware/requireAuth.js";
import { getDb } from "../lib/db.js";
import { requireUid } from "../lib/authRequest.js";
import { logger } from "../lib/logger.js";
import { decryptToken } from "../lib/tokenCrypto.js";
import {
  googleTokenDocId,
  revokeGoogleToken,
  type GoogleTokenDoc,
} from "../lib/googleOAuth.js";
import {
  metaTokenDocId,
  pageCanPublish,
  type MetaTokenDoc,
} from "../lib/metaOAuth.js";

// ============================================================
// Account management — mounted at /api/accounts.
//
// Responses are REDACTED: tokens and expiry internals never leave the
// server. Only display-safe fields (provider, scopes, accountEmail,
// accountName, channel/page info, connectedAt) travel over the wire.
// ============================================================

export const accountsRouter = Router();

/** Strip server-only fields from a token doc. */
function toConnectedAccount(
  id: string,
  data: Partial<GoogleTokenDoc> & Partial<MetaTokenDoc> & { provider?: string },
): ConnectedAccount {
  const account: ConnectedAccount = {
    id,
    userId: data.userId ?? "",
    provider: (data.provider ?? "google") as ConnectedAccount["provider"],
    scopes: data.scopes ?? [],
    createdAt: data.createdAt ?? new Date(0).toISOString(),
    updatedAt: data.updatedAt ?? new Date(0).toISOString(),
  };
  if (data.accountEmail !== undefined) account.accountEmail = data.accountEmail;
  if (data.accountName !== undefined) account.accountName = data.accountName;
  // For Google: tell the frontend which account this is (Drive vs YouTube).
  const googlePurpose = (data as Partial<GoogleTokenDoc>).purpose;
  if (
    data.provider === "google" &&
    (googlePurpose === "drive" || googlePurpose === "youtube")
  ) {
    account.purpose = googlePurpose;
  }

  // Phase 5 (Meta): map the Facebook identity onto the display-safe
  // fields. Tokens and the raw pages' task lists stay server-side;
  // only redacted page info travels over the wire.
  const meta = data as Partial<MetaTokenDoc>;
  if (data.provider === "meta" && meta.fbUserName !== undefined) {
    account.accountName = meta.fbUserName;
    const pages = meta.pages ?? [];
    account.metaPages = pages.map((p) => ({
      pageId: p.pageId,
      pageName: p.pageName,
      tasks: p.tasks,
      canPublish: pageCanPublish(p.tasks),
    }));
    if (meta.selectedPageId !== undefined) {
      account.selectedPageId = meta.selectedPageId;
      const selected = pages.find((p) => p.pageId === meta.selectedPageId);
      if (selected) account.pageName = selected.pageName;
    }
  }
  return account;
}

/** GET /api/accounts — list the user's connected accounts (redacted). */
accountsRouter.get(
  "/",
  requireAuth,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const uid = requireUid(req);
      const snap = await getDb()
        .collection("connectedAccounts")
        .where("userId", "==", uid)
        .get();
      const accounts = snap.docs.map((d) =>
        toConnectedAccount(
          d.id,
          d.data() as Partial<GoogleTokenDoc> & Partial<MetaTokenDoc>,
        ),
      );
      const body: ApiResponse<ConnectedAccount[]> = { ok: true, data: accounts };
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * DELETE /api/accounts/google/:purpose — disconnect one Google account.
 * Revokes the refresh token at Google, then deletes the local doc.
 * Disconnect always succeeds locally: a revoke failure is logged as a
 * warning but never blocks the disconnect.
 *
 * Also accepts DELETE /api/accounts/google?purpose=drive for old clients;
 * with no purpose, BOTH docs are disconnected.
 */
accountsRouter.delete(
  "/google/:purpose?",
  requireAuth,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const uid = requireUid(req);
      const rawPurpose =
        (req.params.purpose as string | undefined) ??
        (req.query.purpose as string | undefined);
      const purposes: Array<"drive" | "youtube"> =
        rawPurpose === "drive" || rawPurpose === "youtube"
          ? [rawPurpose]
          : ["drive", "youtube"];

      for (const purpose of purposes) {
        const ref = getDb().doc(
          `connectedAccounts/${googleTokenDocId(uid, purpose)}`,
        );
        const snap = await ref.get();

        if (snap.exists) {
          const data = snap.data() as Partial<GoogleTokenDoc>;
          if (data.refreshToken_enc) {
            try {
              const refreshToken = decryptToken(data.refreshToken_enc);
              const revoked = await revokeGoogleToken(refreshToken);
              if (!revoked) {
                logger.warn(
                  { uid, purpose },
                  "Google token revoke returned non-OK; disconnecting locally anyway",
                );
              }
            } catch (err) {
              logger.warn(
                { uid, purpose, err: err instanceof Error ? err.message : String(err) },
                "Google token revoke failed; disconnecting locally anyway",
              );
            }
          }
          await ref.delete();
          logger.info({ uid, purpose }, "Google account disconnected");
        }
      }

      const body: ApiResponse<{ disconnected: boolean }> = {
        ok: true,
        data: { disconnected: true },
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * DELETE /api/accounts/meta — disconnect Facebook.
 * Deletes the local `connectedAccounts/{uid}_meta` doc (encrypted
 * Page tokens included).
 *
 * HONEST LIMITATION: Meta provides no token-revoke endpoint for the
 * Facebook Login flow used here (unlike Google's /revoke). The
 * response tells the user to also remove the app at
 * facebook.com → Settings → Apps and Business Integrations to fully
 * revoke access. The server never fakes a revoke call.
 */
accountsRouter.delete(
  "/meta",
  requireAuth,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const uid = requireUid(req);
      const ref = getDb().doc(`connectedAccounts/${metaTokenDocId(uid)}`);
      const snap = await ref.get();
      if (snap.exists) {
        await ref.delete();
        logger.info({ uid }, "Meta account disconnected");
      }

      const body: ApiResponse<{ disconnected: boolean; note: string }> = {
        ok: true,
        data: {
          disconnected: true,
          note: "Meta has no token-revoke API for this login flow, so Drive2Social only deleted its stored copy of your Page tokens. To fully revoke access, also remove the app at facebook.com → Settings → Apps and Business Integrations.",
        },
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);
