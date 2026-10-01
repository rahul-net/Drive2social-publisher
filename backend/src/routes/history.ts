import { Router } from "express";
import type {
  ApiResponse,
  HistoryListResponse,
  PublishHistory,
} from "@drive2social/shared";
import {
  requireAuth,
  type AuthenticatedRequest,
} from "../middleware/requireAuth.js";
import { requireUid } from "../lib/authRequest.js";
import { getDb } from "../lib/db.js";
import {
  paginate,
  paginationQuerySchema,
} from "../lib/pagination.js";

// ============================================================
// Publishing history — mounted at /api/history (Phase 7).
//
//   GET / — paginated publishHistory rows for the user, newest
//           first. Rows are written by the upload engines on success
//           (PUBLISHED) and by the queue worker on every FAILED
//           terminal state — including server-restart recovery — so
//           this is the complete record of every publish attempt.
//
// Token ownership: userId == req.user.uid. Paginated with ?limit=
// (default 20, max 100) and ?startAfter= (an entry id).
// ============================================================

export const historyRouter = Router();

historyRouter.get(
  "/",
  requireAuth,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const uid = requireUid(req);
      const query = paginationQuerySchema.parse(req.query);
      // Single equality filter (automatic index); newest-first
      // ordering happens in memory. See lib/pagination.ts.
      const snap = await getDb()
        .collection("publishHistory")
        .where("userId", "==", uid)
        .get();
      const sorted = snap.docs
        .map((d) => ({ ...(d.data() as PublishHistory), id: d.id }))
        .sort((a, b) =>
          a.publishedAt > b.publishedAt
            ? -1
            : a.publishedAt < b.publishedAt
              ? 1
              : a.id < b.id
                ? -1
                : 1,
        );
      const page = paginate(sorted, (e) => e.id, query);
      const body: ApiResponse<HistoryListResponse> = {
        ok: true,
        data: { entries: page.items, nextCursor: page.nextCursor },
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);
