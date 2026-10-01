# Drive2Social Publisher — Setup Guide

From zero to a working deployment: every external service, exact console
click-paths, the full environment-variable table, deploy commands, quotas,
verification, troubleshooting, and security. Work through the sections in
order.

**Time estimate:** ~1–2 hours for development setup, plus waiting time for
Google OAuth verification / Meta app review if you go to production.

> **Hard rules (from the project's security model):**
> - **Never ask users for Google, YouTube, or Facebook passwords.** This
>   app uses OAuth 2.0 only.
> - All secrets live **server-side only** (backend env / Secret Manager).
>   Nothing secret may use a `VITE_` prefix or appear in frontend code.
> - Copy `.env.example` → `.env` and **never commit `.env`**.

---

## 0. What you need before you start

- A Google account (Google Cloud + Firebase + a YouTube channel)
- A Meta developer account + a Facebook Page you administer
- Node.js 20+
- A Gemini API key ([Google AI Studio](https://aistudio.google.com/app/apikey))
- A domain (only required for **production**; development runs on localhost)
- `gcloud` + `firebase` CLIs (only for deployment, section 8)

---

## 1. Google Cloud project

1. Go to [Google Cloud Console](https://console.cloud.google.com/) →
   **Select a project → New project** (e.g. `drive2social-publisher`).
2. **APIs & Services → Library** — enable these two APIs:
   - **Google Drive API**
   - **YouTube Data API v3**
3. **APIs & Services → OAuth consent screen**:
   - User type: **External**
   - Fill in **App name**, **User support email**, **Developer contact email**
   - If you have a production domain, add it under **Authorized domains**
   - **Scopes → Add or remove scopes** — add exactly these:
     - `openid`, `email`, `profile` (basic sign-in identity)
     - `https://www.googleapis.com/auth/drive.readonly` (list/read your
       Drive videos — least privilege; the app never writes to Drive)
     - `https://www.googleapis.com/auth/youtube.upload` (upload to your channel)
     - `https://www.googleapis.com/auth/youtube.readonly` (read channel info)
   - **Test users**: while the app is in *Testing* publishing status, add
     **every** Google account that will sign in (including your own).
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**
   - **Authorized redirect URIs** — add both (dev and prod), exactly:
     - `http://localhost:8080/api/auth/google/callback` (development)
     - `https://<your-backend-domain>/api/auth/google/callback` (production)
   - Save the **Client ID** and **Client secret** → `GOOGLE_CLIENT_ID` /
     `GOOGLE_CLIENT_SECRET` in the backend `.env`. The secret lives
     **server-side only** — never put it in frontend code.

### 1a. YouTube API realities (read before you promise users anything)

- **Quota:** every project gets **10,000 units/day** free. One
  `videos.insert` (upload) costs **1,600 units** → about **6 uploads/day**
  per project across all users. `videos.list` / `channels.list` cost 1
  unit. Quota resets at **midnight Pacific Time**. The app surfaces
  `quotaExceeded` as a clear retry-later error — it never fakes a success.
- **Unverified apps:** uploads from an OAuth app that has **not passed
  Google's verification** are **forced to PRIVATE**, no matter which
  privacy you select. The app detects this (it compares the privacy
  YouTube returned against what you requested) and shows an explicit
  warning on the job: *"You requested X but YouTube published it as
  private — verify your OAuth consent screen."* To publish
  public/unlisted, complete **OAuth verification** (OAuth consent screen →
  **Publish app**) and, for real volume, request a **quota increase**
  (takes weeks–months; plan ahead).
- **`youtube.upload` is a *sensitive* scope** (not *restricted*), so
  verification needs a privacy policy page, a homepage, and a demo video
  — but no third-party security assessment.
- **Notify subscribers:** the app exposes it as a toggle and passes
  `notifySubscribers=true/false` to `videos.insert`.

---

## 2. Firebase (Auth + Firestore)

1. Go to [Firebase Console](https://console.firebase.google.com/) →
   **Add project** (you can reuse the Google Cloud project from section 1).
2. **Build → Authentication → Sign-in method** → enable **Google**.
   Add your production domain under **Settings → Authorized domains**
   (localhost is allowed by default).
3. **Build → Firestore Database → Create database** (production mode,
   choose a region near you).
4. **Deploy the security rules** in `firestore.rules`:
   ```bash
   npm install -g firebase-tools
   firebase login
   firebase init firestore   # accept defaults; we'll overwrite the rules file
   cp firestore.rules firestore.rules  # (use the repo's file)
   firebase deploy --only firestore:rules
   ```
   Or paste the file contents manually at
   **Firestore Database → Rules → Edit rules → Publish**.
   Security model: the backend (Admin SDK) bypasses rules and enforces
   ownership itself; the web client may only **read its own
   `publishJobs` / `publishHistory` docs** (for live progress). Token
   collections are server-only.
5. **Service account for the backend:** Project settings →
   **Service accounts** → **Generate new private key** → fill
   `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`
   in the backend `.env`. (On Cloud Run you can **skip this** — the
   backend uses Application Default Credentials when these vars are
   absent.)
6. **Web app config:** Project settings → **Your apps** → add a **Web
   app** → copy `apiKey`, `authDomain`, `projectId`, `appId` → the
   `VITE_FIREBASE_*` variables. The Firebase **web API key is public by
   design**; security comes from the Firestore rules above, not from
   hiding it.

---

## 3. Gemini API

1. Get a key at [Google AI Studio](https://aistudio.google.com/app/apikey)
   → `GEMINI_API_KEY` in the backend `.env` (**server-side only** — the
   frontend never sees it).
2. Optional: `GEMINI_MODEL` (server default; e.g. `gemini-2.0-flash`).
   Users can also pick a model per-account in **Settings**; only models on
   the server's allowlist (see `shared/src/index.ts`) are accepted.
3. How the app uses it (honest): it sends the file name, format, size,
   duration, your topic/transcript, plus up to 8 still frames extracted
   server-side with **ffmpeg** — install ffmpeg on the server for frame
   analysis; without it the app falls back to **metadata-only** mode and
   tells you which mode was used. Output is structured JSON validated
   against a schema, then clamped to platform limits (title ≤ 100 chars,
   description ≤ 5000, tags ≤ 500 chars total). You always review and edit
   the result before publishing — nothing is published from AI output
   unchecked.

---

## 4. Meta Developer App (Facebook Page publishing)

1. Go to [Meta for Developers](https://developers.facebook.com/) →
   **My Apps → Create app** (type *Business* or *Other*; the publishing
   flow works with either).
2. **Add product → Facebook Login**:
   - **Settings → Valid OAuth Redirect URIs** — add exactly:
     - `http://localhost:8080/api/auth/meta/callback` (development)
     - `https://<your-backend-domain>/api/auth/meta/callback` (production)
3. Note the **App ID** and **App Secret** → `META_APP_ID` /
   `META_APP_SECRET` (the secret is **server-side only**).
4. The app requests these permissions at login:
   - `pages_show_list` — list Pages you manage
   - `pages_read_engagement` — read Page info
   - `pages_manage_posts` — publish videos to the Page
5. After login the app calls `/me/accounts`, lets you **pick a Page**,
   then exchanges the Page token for a **long-lived Page token**
   (effectively permanent until revoked) stored **encrypted server-side**.
   Publishing uses Meta's official resumable upload
   (`upload_phase=start/transfer/finish` on `graph-video.facebook.com`),
   then polls processing status. Caption = video description; hashtags go
   in the description text.

### 4a. Meta realities (read before production)

- **App review is REQUIRED** for `pages_manage_posts` (and friends) in
  production. In **Development mode** the login/publish flow works only
  for users with a role on the app (Admin, Developer, Tester) — add
  testers under **Roles → Testers**. For real users, submit each
  permission for **App Review** with a screencast of the flow.
- **Pages only.** The Graph API cannot publish to personal Facebook
  profiles — this is a Meta platform restriction, not an app limitation.
  The person connecting must have the **CREATE_CONTENT** task on the Page.
- **Video limits:** resumable uploads support files up to ~2 GB (the app
  rejects larger files at enqueue time with a clear message). Meta
  processes the video after upload; the app polls for ~5 minutes and marks
  the job PUBLISHED once Meta accepts it (even if processing is still
  running — retrying would create a duplicate).
- **No server-side token revoke:** Meta provides no API to revoke a Page
  token. "Disconnect" in the app deletes the stored token and tells the
  user to also remove the app at
  facebook.com → Settings → Business integrations — never faked.

---

## 5. Environment variables (complete reference)

Set backend vars in `.env` (dev) or **Secret Manager** (prod, section 8).
Set frontend `VITE_*` vars in `frontend/.env` (dev) or your static host's
environment settings (prod). Dev vs prod values are noted per row.

### Backend (`backend/.env` — server-side only, never shipped to browsers)

| Variable | Required | Dev value | Prod value | Notes |
|---|---|---|---|---|
| `PORT` | No | `8080` | `8080` (Cloud Run injects its own) | HTTP listen port |
| `FRONTEND_URL` | No | `http://localhost:5173` | `https://<your-frontend-domain>` | CORS is locked to this origin |
| `LOG_LEVEL` | No | `info` | `info` / `warn` | pino: fatal\|error\|warn\|info\|debug\|trace |
| `GOOGLE_CLIENT_ID` | Yes | from §1 step 4 | same client (add prod redirect URI) | OAuth client ID (public-ish, but keep server-side) |
| `GOOGLE_CLIENT_SECRET` | Yes | from §1 step 4 | same | **Secret.** Server-side only |
| `GOOGLE_REDIRECT_URI` | Yes | `http://localhost:8080/api/auth/google/callback` | `https://<backend>/api/auth/google/callback` | Must **exactly** match a URI registered in Google Cloud Console |
| `META_APP_ID` | Yes | from §4 step 3 | same app (add prod redirect URI) | Meta App ID |
| `META_APP_SECRET` | Yes | from §4 step 3 | same | **Secret.** Server-side only |
| `META_GRAPH_VERSION` | No | `v22.0` | `v22.0` | Graph API version; v22.0 supported until 2027-05-20 |
| `META_REDIRECT_URI` | Yes | `http://localhost:8080/api/auth/meta/callback` | `https://<backend>/api/auth/meta/callback` | Must **exactly** match Valid OAuth Redirect URIs in the Meta App Dashboard |
| `GEMINI_API_KEY` | Yes | from §3 | same (or a separate prod key) | **Secret.** Sent only as `x-goog-api-key` on backend→Google calls |
| `GEMINI_MODEL` | No | `gemini-2.0-flash` | `gemini-2.0-flash` | Server default; per-user override allowed in Settings (allowlisted) |
| `FIREBASE_PROJECT_ID` | Yes* | from §2 step 6 | same | *Omit all three `FIREBASE_*` on Cloud Run to use ADC instead |
| `FIREBASE_CLIENT_EMAIL` | Yes* | service-account email | same | *See above |
| `FIREBASE_PRIVATE_KEY` | Yes* | service-account key (keep `\n` escapes) | same | **Secret.** *See above |
| `TOKEN_ENCRYPTION_KEY` | Yes | `openssl rand -base64 32` | `openssl rand -base64 32` (**new**, stored in Secret Manager) | **Secret.** Must decode to exactly 32 bytes; encrypts OAuth tokens at rest |

Generate the encryption key:
```bash
openssl rand -base64 32   # → paste as TOKEN_ENCRYPTION_KEY
```

### Frontend (`frontend/.env` — `VITE_` prefix required; these are public by design)

| Variable | Required | Dev value | Prod value | Notes |
|---|---|---|---|---|
| `VITE_API_URL` | Yes | `http://localhost:8080` | `https://<your-backend-domain>` | Backend base URL (no trailing slash) |
| `VITE_FIREBASE_API_KEY` | Yes | from §2 step 6 | same | Public web API key (security comes from Firestore rules) |
| `VITE_FIREBASE_AUTH_DOMAIN` | Yes | `<project>.firebaseapp.com` | same | |
| `VITE_FIREBASE_PROJECT_ID` | Yes | from §2 step 6 | same | |
| `VITE_FIREBASE_APP_ID` | Yes | from §2 step 6 | same | |

> If `VITE_FIREBASE_*` are missing or still placeholders, the sign-in page
> shows an honest "Firebase is not configured" message instead of
> crashing. If `VITE_API_URL` is wrong, API calls fail with a clear
> network error — check the browser console.

---

## 6. Run locally

```bash
cp .env.example .env            # backend vars → backend/.env (see table above)
cp frontend/.env.example frontend/.env   # frontend vars

npm install
npm run dev:backend             # http://localhost:8080  (tsx watch)
npm run dev:frontend            # http://localhost:5173  (vite)
```

- `VITE_API_URL` must point at the backend (`http://localhost:8080`).
- Production build: `npm run build` (typechecks shared → backend →
  frontend in order). Full typecheck: `npm run typecheck`.
- Serve the backend from compiled output: `npm run start --workspace=backend`
  (`node backend/dist/index.js`); `GET /api/health` should return 200.

---

## 7. PWA (installable app)

The frontend ships as a Progressive Web App out of the box:

- `frontend/public/manifest.webmanifest` — name "Drive2Social Publisher",
  `short_name` "Drive2Social", `display: standalone`, `start_url`/`scope`
  `/`, `theme_color`/`background_color`.
- Icons in `frontend/public/`: `icon-192.png`, `icon-512.png` ("any"),
  `icon-maskable-512.png` (maskable, safe-zone padded). Replace them
  with your own branding before shipping if you like.
- `frontend/public/sw.js` — hand-rolled service worker, registered by
  `src/main.tsx` in production builds only:
  - **Navigations:** network-first, fall back to the cached app shell
    (the UI stays browsable offline).
  - **Static assets** (JS/CSS/images): cache-first.
  - **`/api/*`:** network-only — job state is never served stale.
- **Offline honesty:** an app-wide "You're offline" banner appears when
  the connection drops, and the Publish button stays disabled while
  offline. **Publishing always requires the internet** — the PWA shell
  being offline-capable does not change that.
- PWA artifacts are verified in `frontend/dist/` after every build
  (manifest, `sw.js`, icons, and the built `index.html` referencing them).

---

## 8. Deploy to production

### 8a. Backend → Cloud Run (Docker)

The backend ships a production `backend/Dockerfile`
(`node:20-slim`, multi-stage build, prod deps only, non-root `appuser`,
healthcheck on `/api/health`). Build from the **repo root**:

```bash
# 1. Create the Artifact Registry repo (once)
gcloud artifacts repositories create drive2social \
  --repository-format=docker \
  --location=<REGION>   # e.g. asia-southeast1

# 2. Build and push (from the repo root)
REGION=<REGION>; PROJECT=<PROJECT_ID>
docker build -f backend/Dockerfile \
  -t $REGION-docker.pkg.dev/$PROJECT/drive2social/backend:latest .
docker push $REGION-docker.pkg.dev/$PROJECT/drive2social/backend:latest
```

**Secrets → Secret Manager (recommended — never `--set-env-vars` for secrets):**

```bash
# Create secrets (once)
printf '%s' "$TOKEN_ENCRYPTION_KEY" | gcloud secrets create token-encryption-key --data-file=-
printf '%s' "$GOOGLE_CLIENT_SECRET" | gcloud secrets create google-client-secret --data-file=-
printf '%s' "$META_APP_SECRET"     | gcloud secrets create meta-app-secret --data-file=-
printf '%s' "$GEMINI_API_KEY"      | gcloud secrets create gemini-api-key --data-file=-
printf '%s' "$FIREBASE_PRIVATE_KEY" | gcloud secrets create firebase-private-key --data-file=-

# Grant the Cloud Run service account access (once per secret)
for s in token-encryption-key google-client-secret meta-app-secret gemini-api-key firebase-private-key; do
  gcloud secrets add-iam-policy-binding $s \
    --member="serviceAccount:<CLOUD_RUN_SA_EMAIL>" \
    --role="roles/secretmanager.secretAccessor"
done

# Deploy: non-secrets via --set-env-vars, secrets via --set-secrets
gcloud run deploy drive2social-backend \
  --image=$REGION-docker.pkg.dev/$PROJECT/drive2social/backend:latest \
  --region=$REGION \
  --allow-unauthenticated \
  --port=8080 \
  --memory=1Gi --cpu=1 --min-instances=0 --max-instances=1 \
  --set-env-vars="FRONTEND_URL=https://<your-frontend-domain>,GOOGLE_CLIENT_ID=<id>,GOOGLE_REDIRECT_URI=https://<backend>/api/auth/google/callback,META_APP_ID=<id>,META_REDIRECT_URI=https://<backend>/api/auth/meta/callback,META_GRAPH_VERSION=v22.0,GEMINI_MODEL=gemini-2.0-flash,FIREBASE_PROJECT_ID=<project>,FIREBASE_CLIENT_EMAIL=<sa-email>,LOG_LEVEL=info" \
  --set-secrets="GOOGLE_CLIENT_SECRET=google-client-secret:latest,META_APP_SECRET=meta-app-secret:latest,GEMINI_API_KEY=gemini-api-key:latest,FIREBASE_PRIVATE_KEY=firebase-private-key:latest,TOKEN_ENCRYPTION_KEY=token-encryption-key:latest"
```

Notes:
- **Omit `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` /
  `FIREBASE_PRIVATE_KEY`** entirely to use the Cloud Run runtime service
  account via Application Default Credentials (cleanest on GCP).
- `--max-instances=1` is deliberate: the upload queue worker is in-memory
  (see README "API limitations"), so a single instance avoids duplicate
  processing. If you scale out, move the worker to Cloud Tasks first.
- For very large video uploads, raise `--timeout` (default 5 min is often
  too short) — e.g. `--timeout=3600`.
- On first deploy, copy the service URL and use it as
  `https://<your-backend-domain>` for the OAuth redirect URIs in sections
  1 and 4 (then redeploy with the final env vars).

### 8b. Frontend → Firebase Hosting (or any static host)

```bash
# Build with production env baked in:
VITE_API_URL=https://<your-backend-domain> \
VITE_FIREBASE_API_KEY=<key> \
VITE_FIREBASE_AUTH_DOMAIN=<project>.firebaseapp.com \
VITE_FIREBASE_PROJECT_ID=<project> \
VITE_FIREBASE_APP_ID=<id> \
npm run build --workspace=frontend

# Deploy the static dist/ to Firebase Hosting:
firebase init hosting        # public dir: frontend/dist, SPA rewrite: yes
firebase deploy --only hosting
```

Any static host works (Cloud Storage + CDN, Netlify, Vercel…): serve
`frontend/dist/` with an SPA fallback rewrite (`/*` → `/index.html`).
On Firebase Hosting also add your backend domain to **Authentication →
Settings → Authorized domains**.

### 8c. Post-deploy checklist

- [ ] `firestore.rules` deployed (§2 step 4)
- [ ] Prod OAuth redirect URIs registered in Google Cloud Console (§1) and
      Meta App Dashboard (§4)
- [ ] `FRONTEND_URL` = production frontend origin (CORS is locked to it)
- [ ] All five secrets in Secret Manager (never in `--set-env-vars`)
- [ ] `GET https://<backend>/api/health` → 200
- [ ] Google OAuth app **verified** if real users will publish publicly (§10)
- [ ] Meta App Review **approved** for the three Page permissions (§10)

---

## 9. Quotas & limits (summary)

| Limit | Value | What happens |
|---|---|---|
| YouTube Data API quota | 10,000 units/day/project | `videos.insert` = 1,600 units → **~6 uploads/day**; resets midnight PT |
| Unverified Google OAuth app | Privacy forced to **PRIVATE** | App shows an explicit warning on the job |
| YouTube upload size | 256 GB / 12 h (API) | App rejects >2 GB at enqueue for Facebook parity |
| Facebook resumable upload | ~2 GB | App rejects larger files at enqueue with a clear message |
| Facebook Page token | Long-lived (effectively permanent) | Until user removes the app; then `FACEBOOK_REAUTH_REQUIRED` |
| Meta rate limits | Per-app/per-page throttling | App maps 4/17/32 → `FACEBOOK_RATE_LIMITED` (retryable) |
| Gemini quotas | Per-key RPM/TPM | Surfaced as a clear error; key is server-side |

---

## 10. Verification & app review (going public)

### Google OAuth verification
Needed as soon as anyone beyond your test users signs in, and required
for uploads to respect the privacy you select (public/unlisted). Path:
**Google Cloud Console → APIs & Services → OAuth consent screen →
Publish app** → fill the verification form (privacy policy URL, homepage,
a demo video showing the Drive → YouTube flow). `youtube.upload` is a
**sensitive** scope, not restricted — no third-party security assessment,
but review still takes days–weeks. Quota increases go through a separate
API compliance audit.

### Meta App Review
`pages_manage_posts`, `pages_read_engagement`, `pages_show_list` must each
be submitted for **App Review** before anyone without a role on your app
can use them. Path: **Meta App Dashboard → App Review → Permissions and
features** → request each permission with a screencast of the real flow
(connect Page → generate metadata → publish). Until approved, the app
works only for Admins/Developers/Testers (add them under **Roles**).

---

## 11. Troubleshooting

| Error code / symptom | Cause → fix |
|---|---|
| `NO_TOKEN` (401) | No `Authorization: Bearer` header — sign in again; the frontend attaches it automatically |
| `INVALID_TOKEN` (401) | Firebase ID token expired/invalid — the app refreshes silently; if persistent, sign out/in |
| `AUTH_NOT_CONFIGURED` (503) | Backend Firebase Admin not configured — set `FIREBASE_*` env vars or run on GCP with ADC |
| `GOOGLE_REAUTH_REQUIRED` | Google refresh token expired/revoked (`invalid_grant`) — reconnect Google on the Accounts page (never retried in a loop by design) |
| `DRIVE_FILE_NOT_FOUND` (404) | File deleted or not shared with the connected account — pick another video |
| `GOOGLE_RATE_LIMITED` / `YOUTUBE_QUOTA_EXCEEDED` | Daily quota spent (~6 YouTube uploads/day) — wait until midnight PT or request a quota increase |
| Video published but privacy is "private" though you chose otherwise | Unverified Google OAuth app — YouTube forces private; the job shows an explicit warning; verify the OAuth consent screen (§10) |
| `FACEBOOK_REAUTH_REQUIRED` (OAuth 190) | Page token expired/revoked — reconnect Facebook on the Accounts page |
| `FACEBOOK_PERMISSION_DENIED` (200/10) | Missing permission or no CREATE_CONTENT task on the Page — re-grant in the login dialog; check Page roles |
| `FACEBOOK_RATE_LIMITED` (4/17/32) | Meta throttling — retryable=true; the queue backs off automatically |
| Facebook login works for you but not others | App in Development mode — request App Review (§10) or add them as Testers |
| `DUPLICATE_PUBLISH` (409) | Same Drive file → same destination already PUBLISHED — tick "Publish anyway" to intentionally publish a second copy |
| `GEMINI_NOT_CONFIGURED` | `GEMINI_API_KEY` missing on the server — set it and restart |
| Gemini used metadata-only mode | ffmpeg not installed on the server — install it for frame analysis |
| Job FAILED but marked retryable | Safe to retry — YouTube/Facebook uploads resume from the saved session, never restart from zero |
| `RATE_LIMITED` (429) | Per-IP/per-user API rate limit — back off and retry; check `Retry-After` |
| Google sign-in works but Drive shows "not connected" | Drive/YouTube need the extra OAuth scopes, separate from Firebase sign-in — reconnect on the Accounts page |
| `VITE_API_URL` wrong | Frontend shows network errors — set it to the backend origin (no trailing slash) and rebuild |

---

## 12. Security setup (from the security review)

- [ ] `firestore.rules` deployed — web clients can only read their own
      job/history docs; token collections are server-only (§2 step 4).
- [ ] Secrets server-side only — none of `GOOGLE_CLIENT_SECRET`,
      `META_APP_SECRET`, `GEMINI_API_KEY`, `FIREBASE_PRIVATE_KEY`,
      `TOKEN_ENCRYPTION_KEY` may be `VITE_`-prefixed or appear in
      frontend code or API responses.
- [ ] `.env` never committed (it's gitignored; CI should fail on it).
- [ ] `TOKEN_ENCRYPTION_KEY` generated with `openssl rand -base64 32`
      and stored in Secret Manager in production.
- [ ] OAuth tokens encrypted at rest (AES-256-GCM) — handled in code
      (`backend/src/lib/tokenCrypto.ts`); never log tokens.
- [ ] `FRONTEND_URL` set to the exact production origin (CORS allowlist).
- [ ] Rate limiting enabled on auth/upload routes (in code).
