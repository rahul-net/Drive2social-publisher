import { Router } from "express";
import type { ApiResponse } from "@drive2social/shared";
import { HttpError } from "../middleware/errorHandler.js";
import {
  requireAuth,
  type AuthenticatedRequest,
} from "../middleware/requireAuth.js";

// ============================================================
// GET /api/me — proof that requireAuth works.
// Returns the Firebase identity decoded from the Bearer ID token.
// Every later route that needs "who is this user" protects itself
// with requireAuth the same way.
// ============================================================

export const meRouter = Router();

meRouter.get("/", requireAuth, (req: AuthenticatedRequest, res) => {
  if (!req.user) {
    // requireAuth guarantees req.user on success; this is a safety net.
    throw new HttpError(
      500,
      "INTERNAL_ERROR",
      "Authenticated request is missing identity",
    );
  }
  const data: { uid: string; email?: string } = { uid: req.user.uid };
  if (req.user.email !== undefined) {
    data.email = req.user.email;
  }
  const body: ApiResponse<typeof data> = { ok: true, data };
  res.json(body);
});
