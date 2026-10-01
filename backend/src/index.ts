import cors from "cors";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";
import { initFirebaseAdmin } from "./lib/firebaseAdmin.js";
import { healthRouter } from "./routes/health.js";
import { meRouter } from "./routes/me.js";
import { googleAuthRouter } from "./routes/googleAuth.js";
import { metaAuthRouter } from "./routes/metaAuth.js";
import { accountsRouter } from "./routes/accounts.js";
import { driveRouter } from "./routes/drive.js";
import { youtubeRouter } from "./routes/youtube.js";
import { metaRouter } from "./routes/meta.js";
import { facebookRouter } from "./routes/facebook.js";
import { geminiRouter } from "./routes/gemini.js";
import { settingsRouter } from "./routes/settings.js";
import { jobsRouter } from "./routes/jobs.js";
import { publishRouter } from "./routes/publish.js";
import { historyRouter } from "./routes/history.js";
import {
  startUploadQueueWorker,
  stopUploadQueueWorker,
} from "./services/uploadQueue.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { notFound } from "./middleware/notFound.js";

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: config.FRONTEND_URL,
    credentials: true,
  }),
);
app.use(express.json({ limit: "1mb" }));
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  }),
);
// Request logging. The default serializer logs the full request URL
// including the query string — the public preview endpoint carries a
// short-lived HMAC capability in ?token= (see routes/drive.ts), so the
// logged URL scrubs that one param. (pino-http runs the default
// request serializer first and passes its output here, so `req` is
// the already-serialized object.) The parsed query object is also
// redacted by the logger's redact paths (req.query.token).
app.use(
  pinoHttp({
    logger,
    serializers: {
      req: (req: unknown): unknown => {
        if (typeof req !== "object" || req === null) return req;
        const url = (req as { url?: unknown }).url;
        if (typeof url !== "string") return req;
        const qIndex = url.indexOf("?");
        if (qIndex < 0) return req;
        const params = new URLSearchParams(url.slice(qIndex + 1));
        if (!params.has("token")) return req;
        params.set("token", "[REDACTED]");
        return { ...req, url: `${url.slice(0, qIndex)}?${params.toString()}` };
      },
    },
  }),
);

app.use("/api/health", healthRouter);
app.use("/api/me", meRouter); // auth-protected example: GET /api/me
app.use("/api/auth/google", googleAuthRouter);
app.use("/api/auth/meta", metaAuthRouter);
app.use("/api/accounts", accountsRouter);
app.use("/api/drive", driveRouter);
app.use("/api/youtube", youtubeRouter);
app.use("/api/meta", metaRouter);
app.use("/api/facebook", facebookRouter);
app.use("/api/gemini", geminiRouter);
app.use("/api/settings", settingsRouter); // Phase 8: per-user settings
// Phase 7: unified publish endpoint + job queue API + history.
app.use("/api/publish", publishRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/history", historyRouter);

// Attempt Firebase Admin init at boot. Never crashes the server on
// failure — lib/firebaseAdmin logs a warning and requireAuth answers
// 503 AUTH_NOT_CONFIGURED for protected routes instead.
initFirebaseAdmin();

app.use(notFound);
app.use(errorHandler);

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, "drive2social backend listening");
});

// Phase 7: start the upload queue worker (boot recovery for
// interrupted jobs + the 2s dispatch loop). Never crashes boot:
// without Firestore credentials it logs a warning and stays idle.
startUploadQueueWorker();

/** Clean shutdown: stop the queue loop, drain HTTP, then exit. */
function shutdown(signal: string): void {
  logger.info({ signal }, "shutdown requested");
  stopUploadQueueWorker();
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
  // Never hang shutdown forever: in-flight uploads finish at their
  // next chunk boundary, but the process exits after 10s regardless.
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
