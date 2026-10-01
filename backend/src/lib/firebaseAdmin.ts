import {
  applicationDefault,
  cert,
  initializeApp,
  type App,
  type AppOptions,
} from "firebase-admin/app";
import { config } from "../config.js";
import { logger } from "./logger.js";

// ============================================================
// Firebase Admin SDK — lazy singleton.
//
// Credential strategy (in order):
//   1. FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
//      -> cert(...)  (service account, e.g. local dev / CI)
//   2. Otherwise -> applicationDefault()
//      (works automatically on Cloud Run / GCE / Cloud Functions)
//
// Initialization never crashes the server: failures are logged as a
// clear warning and surfaced as HTTP 503 AUTH_NOT_CONFIGURED by
// requireAuth, so /api/health and public routes keep working in dev.
// Tokens are never logged.
// ============================================================

const PLACEHOLDER_VALUE = "placeholder";

/** Thrown when firebase-admin is unavailable for auth work. */
export class FirebaseNotConfiguredError extends Error {
  constructor(message = "Firebase Admin is not configured") {
    super(message);
    this.name = "FirebaseNotConfiguredError";
  }
}

function hasServiceAccountCredentials(): boolean {
  return (
    config.FIREBASE_PROJECT_ID !== PLACEHOLDER_VALUE &&
    config.FIREBASE_CLIENT_EMAIL !== PLACEHOLDER_VALUE &&
    config.FIREBASE_PRIVATE_KEY !== PLACEHOLDER_VALUE
  );
}

let app: App | null = null;
let initAttempted = false;
let initError: Error | null = null;

function initialize(): void {
  initAttempted = true;
  try {
    if (hasServiceAccountCredentials()) {
      // Service account JSON private keys are often stored with literal
      // "\n" sequences in env vars — restore real newlines.
      const privateKey = config.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n");
      app = initializeApp({
        credential: cert({
          projectId: config.FIREBASE_PROJECT_ID,
          clientEmail: config.FIREBASE_CLIENT_EMAIL,
          privateKey,
        }),
      });
      logger.info("Firebase Admin initialized with service account credentials");
    } else {
      const options: AppOptions = { credential: applicationDefault() };
      if (config.FIREBASE_PROJECT_ID !== PLACEHOLDER_VALUE) {
        options.projectId = config.FIREBASE_PROJECT_ID;
      }
      app = initializeApp(options);
      logger.warn(
        "Firebase service account credentials are not configured; " +
          "using Application Default Credentials. " +
          "If ADC is also unavailable, requireAuth will respond " +
          "503 AUTH_NOT_CONFIGURED. See docs/SETUP.md (Phase 10).",
      );
    }
  } catch (err) {
    initError = err instanceof Error ? err : new Error(String(err));
    logger.warn(
      { err: initError.message },
      "Firebase Admin initialization failed — auth-protected routes will " +
        "respond 503 AUTH_NOT_CONFIGURED",
    );
  }
}

/**
 * Attempt Firebase Admin initialization. Safe to call at server boot:
 * never throws — failures are logged as a warning instead.
 */
export function initFirebaseAdmin(): void {
  if (!initAttempted) {
    initialize();
  }
}

/**
 * The shared Firebase Admin app instance.
 * @throws {FirebaseNotConfiguredError} when initialization failed or never ran.
 */
export function getFirebaseApp(): App {
  if (app) return app;
  if (!initAttempted) {
    initFirebaseAdmin();
    if (app) return app;
  }
  throw new FirebaseNotConfiguredError(
    initError
      ? `Firebase Admin unavailable: ${initError.message}`
      : "Firebase Admin is not configured",
  );
}

/** Whether the Firebase Admin SDK is currently usable. */
export function isFirebaseConfigured(): boolean {
  return app !== null;
}
