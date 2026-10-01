import { Router } from "express";
import { z } from "zod";
import type { ApiResponse, MetaPage } from "@drive2social/shared";
import {
  requireAuth,
  type AuthenticatedRequest,
} from "../middleware/requireAuth.js";
import { HttpError } from "../middleware/errorHandler.js";
import { requireUid } from "../lib/authRequest.js";
import { getDb } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import {
  getMetaTokenDoc,
  MetaNotConnectedError,
  pageCanPublish,
  toRedactedPages,
} from "../lib/metaOAuth.js";

// ============================================================
// Meta Pages — mounted at /api/meta.
//
// Token ownership: every call reads `connectedAccounts/{uid}_meta`
// for req.user.uid — a user can only ever see/select their own
// Pages. Responses are REDACTED: Page access tokens never leave the
// server; only pageId/pageName/tasks/canPublish travel over the wire.
//
//   GET  /pages          — the granted Pages (redacted)
//   POST /pages/select   — choose the default publishing Page
// ============================================================

export const metaRouter = Router();

/** GET /api/meta/pages — the user's granted Facebook Pages (redacted). */
metaRouter.get(
  "/pages",
  requireAuth,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const uid = requireUid(req);
      const doc = await getMetaTokenDoc(uid);
      if (!doc) throw new MetaNotConnectedError();
      const body: ApiResponse<MetaPage[]> = {
        ok: true,
        data: toRedactedPages(doc),
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);

const selectBodySchema = z.object({
  pageId: z.string().min(1).max(256),
});

/**
 * POST /api/meta/pages/select — set the default Page for publishing.
 * The Page must belong to this user AND be publish-capable
 * (CREATE_CONTENT task); otherwise 403 FACEBOOK_PAGE_NOT_AUTHORIZED.
 *
 * Phase 8: the account-level default Page lives here
 * (selectedPageId on the connectedAccounts doc); the user's
 * per-publish override lives in `settings/{uid}.defaultPageId` (see
 * routes/settings.ts). The enqueue path still falls back to
 * selectedPageId when no per-publish pageId is given.
 */
metaRouter.post(
  "/pages/select",
  requireAuth,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const uid = requireUid(req);
      const { pageId } = selectBodySchema.parse(req.body);
      const doc = await getMetaTokenDoc(uid);
      if (!doc) throw new MetaNotConnectedError();
      const page = doc.pages.find((p) => p.pageId === pageId);
      if (!page) {
        throw new HttpError(
          403,
          "FACEBOOK_PAGE_NOT_AUTHORIZED",
          "This Page was not granted to Drive2Social. Reconnect Facebook and make sure the Page is selected during the Facebook permission dialog.",
        );
      }
      if (!pageCanPublish(page.tasks)) {
        throw new HttpError(
          403,
          "FACEBOOK_PAGE_NOT_AUTHORIZED",
          `Page "${page.pageName}" cannot publish: the connected Facebook user lacks the CREATE_CONTENT task on it. ` +
            "Ask a Page admin to grant the CREATE_CONTENT task (Page Settings → Page access), then reconnect.",
        );
      }
      await getDb()
        .doc(`connectedAccounts/${uid}_meta`)
        .update({
          selectedPageId: pageId,
          updatedAt: new Date().toISOString(),
        });
      logger.info({ uid, pageId }, "Meta default Page selected");
      const body: ApiResponse<{ selectedPageId: string }> = {
        ok: true,
        data: { selectedPageId: pageId },
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);
