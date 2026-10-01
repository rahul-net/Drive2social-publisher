import dotenv from "dotenv";
import { z } from "zod";

// Load .env in local dev; Cloud Run provides env vars directly.
dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  FRONTEND_URL: z.string().url().default("http://localhost:5173"),

  // Google OAuth (Drive + YouTube). Phase 3 owns the auth flow.
  // REDIRECT_URI must exactly match the authorized redirect URI
  // registered in Google Cloud Console for this OAuth client.
  GOOGLE_CLIENT_ID: z.string().min(1).default("placeholder"),
  GOOGLE_CLIENT_SECRET: z.string().min(1).default("placeholder"),
  GOOGLE_REDIRECT_URI: z
    .string()
    .url()
    .default("http://localhost:8080/api/auth/google/callback"),

  // Meta OAuth (Facebook Pages). Phase 5 owns the auth flow.
  // META_REDIRECT_URI must exactly match the authorized redirect URI
  // registered in the Meta App Dashboard (Facebook Login → Settings →
  // Valid OAuth Redirect URIs). It must be the /callback route below.
  META_APP_ID: z.string().min(1).default("placeholder"),
  META_APP_SECRET: z.string().min(1).default("placeholder"),
  META_GRAPH_VERSION: z.string().default("v22.0"),
  META_REDIRECT_URI: z
    .string()
    .url()
    .default("http://localhost:8080/api/auth/meta/callback"),

  // Gemini AI. Phase 6 owns metadata generation.
  // SECURITY: the key is sent server-side only, exclusively as the
  // `x-goog-api-key` header on backend→Google requests. It must NEVER
  // reach the frontend (no VITE_ prefix, never in an API response).
  GEMINI_API_KEY: z.string().min(1).default("placeholder"),
  // Verified 2026-10-01 against Google's current docs: gemini-2.0-flash
  // is a valid generateContent model on the v1beta REST endpoint.
  GEMINI_MODEL: z.string().min(1).default("gemini-2.0-flash"),

  // Firebase. Phase 2 owns firebase-admin setup + requireAuth.
  FIREBASE_PROJECT_ID: z.string().min(1).default("placeholder"),
  FIREBASE_CLIENT_EMAIL: z.string().min(1).default("placeholder"),
  FIREBASE_PRIVATE_KEY: z.string().min(1).default("placeholder"),

  // OAuth tokens are encrypted at rest server-side.
  TOKEN_ENCRYPTION_KEY: z.string().min(1).default("placeholder"),
});

export type AppConfig = z.infer<typeof envSchema>;

function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // Fail fast on invalid environment so misconfig is never silent.
    throw new Error(
      `Invalid environment configuration: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

export const config: AppConfig = loadConfig();
