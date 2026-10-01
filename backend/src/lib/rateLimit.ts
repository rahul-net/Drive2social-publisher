import rateLimit from "express-rate-limit";
import type { Request } from "express";
import type { AuthenticatedRequest } from "../middleware/requireAuth.js";

// ============================================================
// Sensitive-route rate limiters (Phase 9).
//
// The global limiter in index.ts (120/min per IP) stops blunt
// flooding; these stricter limiters protect abuse-prone endpoints.
// All keying is explicit (never the library default):
//   - per-IP   for OAuth entry points,
//   - per-user for cost-bearing endpoints (Gemini, publish), keyed on
//     the Firebase uid — so requireAuth MUST run before the limiter
//     in the middleware chain.
//
// All limiters answer in the ApiResponse error envelope (429
// RATE_LIMITED), consistent with the central error handler.
// ============================================================

function ipKey(req: Request): string {
  return req.ip ?? "unknown";
}

/** Firebase uid when requireAuth already ran, else the client IP. */
function userOrIpKey(req: Request): string {
  const uid = (req as AuthenticatedRequest).user?.uid;
  return uid ?? ipKey(req);
}

const RATE_LIMITED_BODY = {
  ok: false as const,
  error: {
    code: "RATE_LIMITED",
    message: "Too many requests. Please try again later.",
  },
};

function makeLimiter(
  windowMs: number,
  limit: number,
  keyGenerator: (req: Request) => string,
) {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    statusCode: 429,
    message: RATE_LIMITED_BODY,
  });
}

/**
 * OAuth start-url endpoints (/api/auth/google/start-url,
 * /api/auth/meta/start-url): 20/hour per IP. These create single-use
 * OAuth state docs in Firestore, so per-IP throttling stops
 * state-doc spam without punishing a legit user (a connect flow
 * needs one or two hits).
 */
export const oauthStartUrlLimiter = makeLimiter(60 * 60_000, 20, ipKey);

/**
 * POST /api/publish: 30/hour per user. Enqueues paid-API uploads
 * (YouTube/Facebook) — a per-user ceiling, keyed on the Firebase
 * uid. Apply AFTER requireAuth.
 */
export const publishLimiter = makeLimiter(60 * 60_000, 30, userOrIpKey);

/**
 * POST /api/gemini/generate-metadata: 30/hour per user. Gemini calls
 * cost money and take minutes — a per-user ceiling, keyed on the
 * Firebase uid. Apply AFTER requireAuth.
 */
export const geminiGenerateLimiter = makeLimiter(60 * 60_000, 30, userOrIpKey);
