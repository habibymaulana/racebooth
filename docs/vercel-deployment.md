# Stage 7C — Vercel deployment plan

**Status (2026-11-09):** deployment configuration and serverless adapters are prepared in the local working tree. No Vercel project, Neon database, Blob store, billing setting, or deployment has been created or changed. The local Docker, PostgreSQL, R2, n8n, and Hermes environments remain the existing development system. This document describes a staging path; it does not claim that cloud operation has been verified.

## Architecture decision

A single Vercel project is technically feasible with **Vercel Services**: the Vite app and Express API are separate build roots in one deployment, with `/api/*` routed to Express and all other paths routed to Vite. Services are currently in beta on all plans, and the Vercel project must have its framework set to **Services**. Account access, service builds, and live routing remain unverified. If Services is unavailable to the account, use two Vercel projects only after designing and validating the proxy, cookie, and same-origin behavior.

The intended staging system is:

| Part | Hosted target | Notes |
|---|---|---|
| Browser app | Vercel Vite service | React Router fallback stays in the web service. |
| API | Vercel Express service | One serverless Express handler, same `/api` paths and domain. |
| Database | Neon PostgreSQL | Pooled TLS URL at runtime; direct URL only for one-time schema migrations. |
| Photos | Vercel private Blob | New cloud objects only. Local and Cloudflare R2 adapters remain supported. |
| Email | Disabled in hosted environment | Existing n8n and Gmail workflow remain local and untouched. |
| Operator diagnosis | Disabled in hosted environment | Existing Hermes/Groq runtime remains private and local. |
| Payment simulation | Internal PostgreSQL transaction | No provider, n8n webhook, money transfer, or external service is involved; every checkout is marked simulated and excluded from real revenue. |

The main route configuration is [`vercel.json`](../vercel.json). The API entrypoint, [`backend/src/vercel.js`](../backend/src/vercel.js), creates the database pool and Express app once per warm function instance, exports the app, and starts no listener or background timer. The local Docker startup continues to use `backend/src/server.js`.

## Serverless compatibility and image limits

The V1 API is request/response based and does not require WebSockets, a persistent process, or local disk for production photos. PostgreSQL holds sessions and metadata; Blob holds private photo objects. The serverless entrypoint checks database connectivity and applied migrations through migration 14 before serving requests. A module-level `pg` pool is capped at three connections per function instance. Session state and shared rate-limit counters live in PostgreSQL; rate-limit identifiers are HMACed before storage. Migration 13 adds the counter table; migration 14 adds package administration and automatic simulated checkout. Run these only on the new, empty Neon staging database for this Preview.

Vercel limits Function request and ordinary response payloads to 4.5 MB. Current capture sends **one raw JPEG per request**, not all four images together. In serverless builds, the frontend must receive `VITE_MAX_PHOTO_UPLOAD_BYTES=4000000`; it then reduces JPEG quality and, if needed, scales a captured image down while retaining at least 1280 pixels of width before upload. The API also enforces a 4,000,000-byte serverless request cap. If the browser cannot encode below that limit, it asks the visitor to retake the image. The four-photo finalization request contains metadata only; the API loads the four saved images from Blob and runs the existing selected filter and photostrip composition.

Private Blob previews are authorized by the session or share-token route and return a path-scoped, short-lived signed GET URL capped by the gallery/share expiry. Downloads use the authenticated API route and stream the private Blob bytes, so the image is not encoded into JSON or sent as an ordinary buffered response. Vercel documents that streamed Function responses are exempt from the 4.5 MB response cap; the configured service duration is 60 seconds, which still bounds processing and download time. Real capture size, artistic-filter latency, cold starts, and photostrip/download streaming need verification in a Vercel preview. No cloud upload or real browser acceptance test has run.

The existing camera, 12 frame designs, 14 filters, QR sharing, and UI flow are preserved. Client-side upload compression is enabled only when the Vite environment variable is set; local Docker behavior is unchanged. The Vercel service must build with Node.js 24, matching the backend package engine requirement. Confirm the `sharp` native bundle and the complete Function bundle fit Vercel's deployment limits during the first preview build.

## Private photos and retention

Set `PHOTO_STORAGE_DRIVER=vercel-blob`. The adapter uploads original photos, processed variants, and photostrips to a **private** Blob store, with random per-object names under a session prefix. It never writes public Blob URLs to the database. Existing authorization checks still run before a short-lived preview URL is created. Session and share expiry bound those URLs; a QR link does not expose a permanent storage URL. Downloads are streamed after authorization.

The Vercel Blob adapter has not been exercised against a real store. Before using visitor photos, validate private upload, authorized preview, expired session/share rejection, download, and delete/retention behavior in a disposable staging session. Do not copy local or R2 photos into the new store as part of initial staging.

Vercel Hobby Blob currently includes 1 GB-month storage, 10,000 simple operations, 2,000 advanced operations, and 10 GB of Blob transfer. A normal completed session writes four photo objects and one photostrip, so the advanced-operation allowance alone is roughly 400 completed sessions if nothing else writes objects; storage and transfer may impose a lower limit. On Hobby, Blob becomes unavailable after included limits are exceeded rather than charging an overage. Monitor usage and define retention before inviting visitors. Hobby is limited to personal, non-commercial use; it is suitable only for a non-commercial staging evaluation.

## Database and environment values

Connect Neon through the Vercel Marketplace integration only after approving account/resource setup. Use a **new, empty staging database**. Do not point the migration runner at local Docker PostgreSQL or copy existing local records as part of this stage. The Marketplace supplies `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED` (direct) when connected. Runtime connections use the pooler and TLS verification; the one-off migration script prefers the direct URL. When `PGSSL=true`, the backend removes URI SSL query options before passing the URL to `pg` and supplies TLS verification explicitly, because node-postgres documents that URL SSL options replace object SSL settings.

Configure the following values by environment. Never prefix a backend secret with `VITE_`. Visitor package checkout is an internal synchronous database transaction and requires no payment simulator URL or n8n service.

### Backend service values

| Variable | Value / handling |
|---|---|
| `NODE_ENV` | `production` for Vercel deployments, including Preview. |
| `SERVERLESS_DEPLOYMENT` | `true`. |
| `DATABASE_URL` | Neon pooled PostgreSQL URL, injected by the Marketplace. |
| `DATABASE_URL_UNPOOLED` | Neon direct URL, used by the one-time migration runner; do not expose it to Vite. |
| `DATABASE_POOL_MAX` | `3` (the application caps serverless pools at three per instance). |
| `PGSSL` | `true`; certificate verification remains enabled. |
| `SESSION_SECRET` | Generate a new unique random value of at least 48 characters. Keep server-only. |
| `TOKEN_ENCRYPTION_KEY` | Generate a new independent 32-byte key encoded as exactly 64 hex characters. Keep server-only. |
| `COOKIE_SECURE` | `true`; API uses secure, host-only `__Host-` cookies. |
| `TRUST_PROXY_HOPS` | `1` for the Vercel proxy path; verify that `req.ip` reflects the client before accepting production traffic or relying on IP limits. |
| `APP_ORIGINS` | Production: exact HTTPS production origin. Preview may be empty so the API derives the current deployment origin from Vercel's `VERCEL_URL` system variable. |
| `PUBLIC_APP_ORIGIN` | Production: exact HTTPS production origin. Leave unset for Preview; the API uses its deployment `VERCEL_URL`. |
| `PHOTO_STORAGE_DRIVER` | `vercel-blob`. |
| `BLOB_STORE_ID` | Injected when the private Blob store is connected to the project. |
| Vercel Blob OIDC | Vercel supplies its short-lived token in each Function request context; `@vercel/blob` resolves it. Do not create a manual `VERCEL_OIDC_TOKEN` runtime variable or copy/log the token. |
| `N8N_ENABLED` | `false`. |
| `N8N_EMAIL_ENABLED` | `false`. |
| `N8N_SIMULATOR_ENABLED` | `false`; this disables the legacy external n8n simulator. Internal visitor checkout remains simulated within PostgreSQL. |
| `HERMES_INFERENCE_ENABLED` | `false`. |
| `PHOTO_CLEANUP_ENABLED` | `false` until retention is validated against hosted staging data. |
| `CRON_SECRET` | Do not set while cleanup is disabled. If cleanup is later approved, generate a separate random secret of at least 32 characters and configure the Vercel Cron secret. |

Vercel system environment variables must be available to the API service for Preview. The code accepts the `VERCEL_URL` hostname only in serverless mode, adds that exact HTTPS origin for same-origin validation, and uses it for Preview QR/gallery links when `PUBLIC_APP_ORIGIN` is unset. Production must set the stable public origin explicitly. The framework setting and environment scopes have not been cloud-tested.

### Frontend build values

| Variable | Value / handling |
|---|---|
| `VITE_MAX_PHOTO_UPLOAD_BYTES` | `4000000`; required for Vercel capture compression. |
| `VITE_API_TIMEOUT_MS` | `60000`; aligns the client timeout with the current API service duration. |

These two values are public build settings, not credentials. Do not configure API keys, database URLs, Blob tokens, session secrets, or Hermes credentials as Vite variables. `BLOB_READ_WRITE_TOKEN` is not needed when Vercel OIDC works; do not add a static token just to duplicate OIDC.

The remaining existing security settings should be reviewed against the actual project domain. Set `PHOTO_GALLERY_TTL_HOURS` and `PHOTO_SHARE_TTL_MINUTES` to the approved retention/access window. Keep n8n email, Hermes, and legacy external simulator endpoints disabled in the hosted deployment until those services have persistent hosting and private connectivity. The internal payment simulation is self-contained, auditable, and does not collect real money.

## n8n and Hermes service boundaries

The local n8n Gmail workflow and Hermes v0.23.0/Groq runtime remain untouched. A hosted Vercel Function cannot depend on a developer Mac being powered on or on Docker-only names such as `n8n` and `hermes`. Until separately hosted persistent services, HTTPS/authentication, and private service access are approved and verified:

- Hosted gallery-email sending and delivery-status automation must remain disabled. Do not point Vercel at the local n8n URL.
- Hosted Hermes incident diagnosis and model status must remain disabled. Do not make the Hermes gateway public or forward its local secret to Vercel.
- Camera capture, saving, filter processing, photostrips, galleries, QR links, and downloads remain independent of these optional integrations.

## Staging sequence (for a separately approved deployment)

1. Confirm the Vercel account is Hobby and non-commercial and that Vercel Services beta is available. Choose a free Neon plan and stop if setup requests paid billing or a required payment method. If the project cannot select the Services framework, pause and choose a reviewed two-project fallback.
2. Import `habibymaulana/racebooth` into Vercel with `main` as the production branch. Set the project framework to **Services**. Keep automatic production promotion off until the preview is accepted.
3. Connect a new Neon Marketplace database and a new **private** Vercel Blob store to the project. Do not change local Docker, R2, PostgreSQL, n8n, Hermes, or their volumes.
4. Set backend variables above in server-only environments. Set the two `VITE_*` values for the frontend build. Scope `PUBLIC_APP_ORIGIN` and the production `APP_ORIGINS` to the actual production hostname; Preview can derive its per-deployment origin from `VERCEL_URL`.
5. Initialize only the new, empty Neon staging database with `database/01-schema.sql`, then run the tracked backend migrations through migration 14 with the secure direct connection. Run the migration process in its one-off development configuration (`SERVERLESS_DEPLOYMENT=false`, `PHOTO_STORAGE_DRIVER=local`, `PGSSL=true`) and provide the direct Neon URL through a private, mode-600 temporary environment file or approved secret runner. Do not use the production function's OIDC context or put connection strings in shell history, logs, Git, screenshots, or Vite config. The migrations create the service identity but do not seed visitor packages or an administrator. Securely provision a separate staging admin, then create only explicitly approved staging package names and prices through the protected package UI; until then, the package list is empty and only the free-session path is available. Local operators, packages, and QC records are not copied automatically.
6. Build a Vercel Preview and verify `/api/health`, React Router deep links, same-origin CSRF/login cookies, session expiry, shared PostgreSQL rate limits, camera HTTPS permission, one 4-photo session, each selected filter, all 12 frame designs, private Blob access, share-token expiry, QR links, and downloads. Measure request and function duration with representative images. Verify Vercel logs contain no secrets or photo bytes.
7. Verify usage/retention and manually review the operator dashboard. Keep hosted email and Hermes disabled. Do not claim those capabilities as hosted until their services are migrated and separately tested.
8. Only after staging acceptance, approve any custom domain, production environment, retention deletion, public release, or paid/commercial plan as a separate action. No commit, push, or deployment is authorized by this preparation task.

## Remaining blockers

- No Vercel account/project access, Services beta setting, Neon database, private Blob store, domains, or environment values have been supplied or provisioned.
- The `vercel.json` Services schema, the frontend shared-source import, Express entrypoint, `sharp` bundle, runtime package installation, and routing need a real Vercel Preview build. This local environment has no Vercel CLI installed.
- Private Blob authentication, signed preview URLs, download streaming, camera upload compression, 60-second function ceiling, and full 4-photo artistic finalization need real cloud/browser validation.
- Migration 13 must be applied to a new Neon database before the readiness handler will serve the API. The existing local database and private assets are not migrated.
- Hosted operator provisioning is required before protected dashboard acceptance. Hosted n8n email and Hermes QC remain intentionally unavailable.
- Vercel Hobby permits personal, non-commercial use only. A commercial public Racebooth service would need a plan and cost review before launch; this task does not enable billing.

## Official references

- [Vercel Services guide](https://vercel.com/kb/guide/vercel-services) — single-project service roots, rewrites, beta availability.
- [Vercel Services configuration reference](https://vercel.com/docs/services/config-reference) and [`vercel.json` function settings](https://vercel.com/docs/project-configuration/vercel-json#functions) — service-scoped Function duration configuration.
- [Vercel Express guide](https://vercel.com/kb/guide/ship-a-express-app-on-vercel) — default-export entrypoint, streaming, cron behavior.
- [Vercel Function limits](https://vercel.com/docs/functions/limitations) — request/response payload limits and streaming exception.
- [Vercel system environment variables](https://vercel.com/docs/environment-variables/system-environment-variables) — `VERCEL_URL` availability.
- [Vercel private Blob](https://vercel.com/docs/vercel-blob/private-storage), [signed URLs](https://vercel.com/docs/vercel-blob/vercel-signed-urls), and [OIDC request context](https://vercel.com/docs/oidc) — authenticated private access and scoped expiring URLs.
- [Vercel Blob pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing) and [Hobby plan](https://vercel.com/docs/plans/hobby) — free quotas and non-commercial restriction.
- [Neon Marketplace integration](https://vercel.com/marketplace/neon), [pooled/unpooled environment values](https://github.com/neondatabase/website/blob/main/content/faqs/find-database-url-neon.md), and [Neon connection pooling](https://neon.tech/docs/connect/connection-pooling) — managed Postgres and serverless pooling.
