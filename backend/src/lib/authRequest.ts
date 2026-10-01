import { HttpError } from "../middleware/errorHandler.js";
import type { AuthenticatedRequest } from "../middleware/requireAuth.js";

/**
 * Extract the Firebase uid from an authenticated request.
 * requireAuth guarantees it; this is the shared safety net so route
 * handlers never touch req.user optionally.
 */
export function requireUid(req: AuthenticatedRequest): string {
  if (!req.user) {
    throw new HttpError(
      500,
      "INTERNAL_ERROR",
      "Authenticated request is missing identity",
    );
  }
  return req.user.uid;
}
