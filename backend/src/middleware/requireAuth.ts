import type { NextFunction, Request, Response } from "express";
import type { ApiResponse } from "@drive2social/shared";
import { getAuth } from "firebase-admin/auth";
import {
  FirebaseNotConfiguredError,
  getFirebaseApp,
} from "../lib/firebaseAdmin.js";

/**
 * requireAuth middleware — Phase 2 (Firebase Auth).
 *
 * Reads `Authorization: Bearer <Firebase ID token>`, verifies it with
 * firebase-admin, and attaches the decoded identity to `req.user`.
 *
 * Response contract (all in the ApiResponse envelope):
 *   - 401 NO_TOKEN             — missing or empty Authorization header
 *   - 401 INVALID_TOKEN        — expired, revoked, malformed, or otherwise
 *                                unverifiable ID token
 *   - 503 AUTH_NOT_CONFIGURED  — firebase-admin could not be initialized
 *                                (dev without credentials), honest instead of fake
 *
 * Tokens are never logged.
 */
export interface AuthenticatedRequest extends Request {
  user?: {
    uid: string;
    email?: string;
  };
}

type ErrorBody = ApiResponse<never>;

function sendError(
  res: Response,
  status: number,
  code: "NO_TOKEN" | "INVALID_TOKEN" | "AUTH_NOT_CONFIGURED",
  message: string,
): void {
  const body: ErrorBody = { ok: false, error: { code, message } };
  res.status(status).json(body);
}

function hasFirebaseAuthCode(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("auth/");
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    sendError(
      res,
      401,
      "NO_TOKEN",
      "Missing Authorization header. Expected 'Authorization: Bearer <Firebase ID token>'.",
    );
    return;
  }

  const idToken = header.slice("Bearer ".length).trim();
  if (!idToken) {
    sendError(res, 401, "NO_TOKEN", "Authorization header contained an empty Bearer token.");
    return;
  }

  let app;
  try {
    app = getFirebaseApp();
  } catch (err) {
    if (err instanceof FirebaseNotConfiguredError) {
      sendError(
        res,
        503,
        "AUTH_NOT_CONFIGURED",
        "Firebase Auth is not configured on this server. See docs/SETUP.md (Phase 10).",
      );
      return;
    }
    next(err);
    return;
  }

  getAuth(app)
    .verifyIdToken(idToken)
    .then((decoded) => {
      // exactOptionalPropertyTypes: only set email when present.
      const user: { uid: string; email?: string } = { uid: decoded.uid };
      if (decoded.email !== undefined) {
        user.email = decoded.email;
      }
      (req as AuthenticatedRequest).user = user;
      next();
    })
    .catch((err: unknown) => {
      if (hasFirebaseAuthCode(err)) {
        // Token-level failure: expired, revoked, malformed, wrong project, ...
        sendError(res, 401, "INVALID_TOKEN", "Invalid or expired Firebase ID token.");
        return;
      }
      // A non-auth/* verification failure means the server side itself is
      // broken (e.g. no usable credentials) — honest 503, not a fake 401.
      sendError(
        res,
        503,
        "AUTH_NOT_CONFIGURED",
        "Firebase Auth is not configured on this server. See docs/SETUP.md (Phase 10).",
      );
    });
}
