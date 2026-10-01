# Drive2Social Publisher

Pick a video from Google Drive → Gemini generates the title, description,
tags, and Facebook caption → publish to your **YouTube channel** and/or
**Facebook Page**, with a live upload queue, retry/resume, and full
publish history.

Real APIs only: Google Drive, YouTube Data API v3, Meta Graph API, Gemini
— no mocks, no simulated uploads, OAuth 2.0 throughout (passwords are
never asked for or handled).

---

## Features

- **Google Drive browser** — search and filter your Drive videos
  (mp4/mov/avi/mkv/webm), in-browser preview streamed securely from the
  backend (HMAC capability URLs, Range support).
- **Gemini metadata generation** — title, description, YouTube tags, and
  Facebook caption from file metadata plus up to 8 ffmpeg-extracted video
  frames; structured JSON validated against a schema and clamped to
  platform limits. You always review and edit before publishing.
- **YouTube publishing** — resumable `videos.insert` uploads with progress,
  privacy/category/made-for-kids/notify-subscribers settings, explicit
  warning when an unverified OAuth app forces uploads private.
- **Facebook Page publishing** — official resumable upload
  (`upload_phase=start/transfer/finish`) with processing-status polling.
- **Upload queue** — background worker, one active job per user, progress
  from real confirmed bytes, pause-safe resume for both destinations,
  per-job error codes with `retryable` flags.
- **Duplicate protection** — same Drive file → same destination that is
  already PUBLISHED returns `409 DUPLICATE_PUBLISH` with a link to the
  existing post; "Publish anyway" overrides intentionally.
- **Publish history** — every successful publish recorded and browsable.
- **Per-user settings** — default YouTube privacy/category, default
  Facebook Page, Gemini model override (server allowlist).
- **Security** — Firebase Auth (Google sign-in) on every route; OAuth
  tokens encrypted at rest (AES-256-GCM); Firestore security rules
  (`firestore.rules`); helmet + CORS locked to `FRONTEND_URL` + rate
  limits; secrets server-side only.
- **PWA** — installable app shell: web manifest, offline-capable shell via
  service worker, honest offline banner, publish buttons disabled while
  offline.

---

## Architecture

```
Browser (React PWA)
   │  Firebase Auth (Google sign-in, ID token)
   ▼
Express API (Node 20, Cloud Run) ──▶ Firestore (jobs, history, tokens, settings)
   │        │            │
   │        │            └─▶ Gemini API (metadata: title/desc/tags/caption)
   │        │
   │        ├─▶ Google Drive API (list/stream videos)
   │        └─▶ YouTube Data API v3 (resumable videos.insert)
   │
   └─▶ Meta Graph API (OAuth, /me/accounts, resumable Page video upload)

Upload queue worker: in-memory loop inside the API process —
Firestore is the source of truth; one active job per user.
```

### Repo structure

```
drive2social-publisher/
├── frontend/          # Vite + React + TypeScript PWA (src/, public/ icons+manifest+sw)
├── backend/           # Express + TypeScript API (src/, Dockerfile, .dockerignore)
│   └── src/
│       ├── index.ts       # app wiring, /api/health, route mounting
│       ├── config.ts      # zod-validated env (fail-fast)
│       ├── routes/        # auth, accounts, drive, youtube, meta, facebook,
│       │                  # gemini, publish, jobs, history, settings, health, me
│       ├── services/      # uploadQueue, youtubeUpload, facebookUpload, gemini, videoFrames
│       ├── lib/           # firebaseAdmin, googleOAuth, metaOAuth, tokenCrypto, db, …
│       └── middleware/    # requireAuth, errorHandler, rateLimit helpers
├── shared/            # Shared TypeScript domain types (job, metadata, errors)
├── docs/SETUP.md      # Complete setup guide (start here)
├── firestore.rules    # Firestore security rules (deploy these)
└── .env.example       # Documented example env (copy → .env, never commit .env)
```

---

## Quickstart

**Full step-by-step setup (Google Cloud, Firebase, Meta app, Gemini,
deploy) → [`docs/SETUP.md`](docs/SETUP.md).** The short version:

```bash
cp .env.example .env                 # backend env (see docs/SETUP.md §5 for the full table)
cp frontend/.env.example frontend/.env
openssl rand -base64 32              # → TOKEN_ENCRYPTION_KEY

npm install
npm run dev:backend                  # http://localhost:8080
npm run dev:frontend                 # http://localhost:5173
```

### Scripts (repo root)

| Command | What it does |
|---|---|
| `npm run dev:backend` | Backend with hot reload (`tsx watch`) |
| `npm run dev:frontend` | Vite dev server |
| `npm run build` | Typecheck + build shared → backend → frontend |
| `npm run typecheck` | `tsc --noEmit` across all three workspaces |

Backend env vars: see the complete table in [`docs/SETUP.md` §5](docs/SETUP.md#5-environment-variables-complete-reference).

---

## Deployment (summary)

- **Backend** → Cloud Run from `backend/Dockerfile`
  (`node:20-slim`, multi-stage, non-root user, healthcheck on
  `/api/health`). Build from repo root, push to Artifact Registry,
  `gcloud run deploy` with non-secrets in `--set-env-vars` and the five
  real secrets in **Secret Manager** (`--set-secrets`).
- **Frontend** → Firebase Hosting (or any static host): build with the
  `VITE_*` vars baked in, serve `frontend/dist/` with an SPA fallback.
- **Firestore rules** → `firebase deploy --only firestore:rules`.

Exact commands and the production checklist are in
[`docs/SETUP.md` §8](docs/SETUP.md#8-deploy-to-production).

---

## API limitations (honest)

These are platform constraints the app surfaces clearly instead of
working around:

- **Unverified Google OAuth apps:** YouTube forces uploads to **PRIVATE**
  regardless of the privacy you select. The job shows an explicit warning;
  complete Google's OAuth verification to publish public/unlisted.
- **YouTube quota:** 10,000 units/day per project; one `videos.insert` =
  1,600 units → **~6 uploads/day** across all users. Resets midnight PT.
- **Meta app review:** `pages_manage_posts` and friends require App Review
  before anyone without a role on your Meta app can publish; in
  Development mode only Admins/Developers/Testers work.
- **Facebook Pages only.** The Graph API cannot publish to personal
  profiles; the connector needs the CREATE_CONTENT task on the Page.
- **Gemini frame analysis is ffmpeg-optional:** without ffmpeg on the
  server, metadata generation falls back to metadata-only mode and says so.
- **Single-instance queue worker:** the upload worker is in-memory, so run
  **one** Cloud Run instance (`--max-instances=1`); scaling out needs the
  worker moved to Cloud Tasks first.

---

## Security notes

- OAuth 2.0 only — the app never sees user passwords.
- OAuth tokens encrypted at rest (AES-256-GCM, `TOKEN_ENCRYPTION_KEY`);
  never logged, never in URLs, never sent to the frontend.
- `firestore.rules`: web clients read only their own job/history docs;
  token collections are server-only; the backend Admin SDK enforces
  ownership.
- Secrets (`GOOGLE_CLIENT_SECRET`, `META_APP_SECRET`, `GEMINI_API_KEY`,
  `FIREBASE_PRIVATE_KEY`, `TOKEN_ENCRYPTION_KEY`) are backend-env /
  Secret Manager only — never `VITE_`-prefixed, never committed.
- No fake uploads, no mocked auth, no placeholder success responses —
  every publish hits the real platform API.

---

## License

Private project. All rights reserved.
