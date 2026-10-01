import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    // Never let secrets or tokens into logs.
    //
    // Phase 9 note: pino-http (backend/src/index.ts) serializes every
    // request with pino-std-serializers, which logs the FULL request
    // headers and the parsed query — including
    // `Authorization: Bearer <Firebase ID token>` and the public
    // preview endpoint's HMAC `token` query param. The req-scoped
    // paths below redact exactly those, without hiding the rest of
    // the request log.
    paths: [
      "*.accessToken",
      "*.refreshToken",
      "*.idToken",
      "*.apiKey",
      "*.api_key",
      // Provider token-endpoint responses use snake_case.
      "*.access_token",
      "*.refresh_token",
      // Encrypted-at-rest token blobs (harmless but useless in logs).
      "*.accessToken_enc",
      "*.refreshToken_enc",
      // Phase 5: Meta Page access tokens (encrypted), stored per page.
      "*.pageToken_enc",
      "authorization",
      // pino-http request logs: the Bearer ID token header and the
      // HMAC preview-token query param.
      "req.headers.authorization",
      "req.query.token",
      "GOOGLE_CLIENT_SECRET",
      "META_APP_SECRET",
      "GEMINI_API_KEY",
      "FIREBASE_PRIVATE_KEY",
      "TOKEN_ENCRYPTION_KEY",
      // Phase 4: the YouTube resumable-upload session URI is a bearer
      // capability — never let it into logs either.
      "*.uploadSessionUri",
      "uploadSessionUri",
      // Phase 5/7: resumable-upload session identifiers are
      // server-only (stripped from API responses by sanitizeJob).
      "*.uploadSessionId",
      "uploadSessionId",
      "*.facebookUploadSessionId",
      "facebookUploadSessionId",
    ],
    censor: "[REDACTED]",
  },
});
