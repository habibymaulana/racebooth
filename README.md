# Racebooth V1

Racebooth is a free, browser-based four-photo photobooth. Visitors choose a photostrip frame, capture four pictures, select a finishing look, and receive a private gallery with download and sharing options.

## Features

- **Free visitor flow:** Start a session without creating an account or completing checkout. A session accepts four photos and has a configurable lifetime.
- **Camera capture:** Uses the browser camera. Selfie mirroring can be selected before capture; the chosen orientation is used for the saved result. Camera access requires HTTPS or `localhost`.
- **Locked photostrip frame:** Choose one of 12 designs at the beginning of a session. The selection stays locked through capture and editing.
- **Photo looks:** Choose among 14 options after capture: Original, seven color treatments, and six artistic pixel treatments. The backend processes the saved originals when producing the final images.
- **Private gallery and sharing:** View and download the photos and completed strip through authorized backend routes. QR sharing uses an expiring, read-only gallery link.
- **Optional email delivery:** A configured n8n webhook can send a gallery link. Email is disabled until its endpoint and authentication are configured.
- **Operator quality control:** A protected operator area reports backend checks and incidents. Optional Hermes/Groq diagnoses are requested by an operator and provide recommendations; they do not perform repairs.

## Architecture

- **Frontend:** React, React Router, and Vite.
- **API:** Express on Node.js, with PostgreSQL persistence and Sharp image processing.
- **Photo storage:** Private local filesystem storage for development, or a private S3-compatible Cloudflare R2 bucket for a hosted backend. Browser access goes through authorized API routes; photos are not served from a public bucket.
- **Email:** Optional authenticated backend-to-n8n webhook. Gmail credentials belong in n8n, not in the frontend or repository.
- **Operator diagnosis:** Optional private Hermes API connection, configured for Groq inference. It is independent of camera capture and email delivery.

The repository includes deployment templates targeting a Vercel frontend, Render backend staging, Neon PostgreSQL over TLS, and private Cloudflare R2 storage. Templates are not deployed services. See [deployment readiness](docs/deployment-readiness.md) for the current limitations and migration requirements.

## Local development

### Requirements

- Node.js 24 or newer and npm.
- A PostgreSQL development database with the Racebooth base schema and migrations applied.
- A browser with camera access. `localhost` is treated as a secure context by supported browsers.

The included Docker Compose file starts the application services only. It expects PostgreSQL and the supporting local infrastructure to be provisioned separately; it is not a fresh, self-contained database setup.

### Configure and run

1. Install dependencies and create a private backend environment file:

   ```sh
   npm ci --prefix backend
   npm ci --prefix frontend
   cp backend/.env.example backend/.env
   chmod 600 backend/.env
   ```

2. Edit `backend/.env` for your dedicated development database. Set the database host, name, user, and password; generate unique local values for `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY`; allow the frontend development origin in `APP_ORIGINS`; and set `PUBLIC_APP_ORIGIN` to that same local origin. For local development, use `COOKIE_SECURE=false`, `PGSSL=false`, and `PHOTO_STORAGE_DRIVER=local`. Keep n8n email and Hermes inference disabled unless you have deliberately configured those integrations.

   `backend/.env.example` documents the available settings. Its service addresses are examples for the existing local setup and may need to be changed for your machine. Never commit `.env` or put backend credentials in a Vite `VITE_` variable.

3. Initialize only a development database. Start with `database/01-schema.sql` when creating a new local database, then run the additive migration runner:

   ```sh
   npm run migrate --prefix backend
   ```

   Confirm the backend environment points to the intended development database before running migrations. Do not use this setup procedure against an existing production database.

   To try the protected operator area, provision a development operator in that database. The script prompts for the password without echoing it:

   ```sh
   npm run provision:operator --prefix backend -- --email <operator-email> --name <operator-name>
   ```

   Verify the configured database first. Provisioning creates a new account and does not modify an existing one.

4. Start the API and Vite development server in separate terminals:

   ```sh
   npm run dev --prefix backend
   ```

   ```sh
   API_PROXY_TARGET=http://localhost:3000 npm run dev --prefix frontend
   ```

5. Open the local Vite address printed by the frontend command. Camera access is available on `localhost`. For a phone to scan a QR code and reach the gallery, use a reachable HTTPS deployment; a computer's `localhost` address is not reachable from another device.

Photos written in local mode are stored under the configured private storage path (or the application default). That path is ignored by Git. The sample Compose setup uses a persistent Docker volume and does not define or reset PostgreSQL or n8n.

### Tests and build

```sh
npm test --prefix backend
npm run test:container --prefix backend
npm run build --prefix frontend
```

The container integration script uses a disposable PostgreSQL database and requires Docker. Review its prerequisites before running it; it does not replace a backup or a production migration plan.

## Environment configuration

Use `backend/.env.example` as the variable reference. Keep real values in a local, permission-restricted `.env` file or in the hosting provider's secret manager. Common settings include:

| Area | Settings |
|---|---|
| PostgreSQL | `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSL` |
| Sessions and browser security | `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, `COOKIE_SECURE`, `APP_ORIGINS`, `PUBLIC_APP_ORIGIN`, `TRUST_PROXY_HOPS` |
| Photo storage | `PHOTO_STORAGE_DRIVER`, `PHOTO_STORAGE_PATH`, and server-only `R2_*` values when using R2 |
| Email | `N8N_EMAIL_ENABLED`, `N8N_EMAIL_WEBHOOK_URL`, `N8N_EMAIL_WEBHOOK_SECRET` |
| Operator diagnosis | `HERMES_ENDPOINT`, `HERMES_API_KEY_FILE` or `HERMES_API_KEY`, provider/model settings, and `HERMES_INFERENCE_ENABLED` |

Production mode requires HTTPS origins, secure cookies, PostgreSQL TLS, a trusted proxy configuration, and private R2 storage. Integration credentials are optional and should remain disabled until their hosted endpoints and authentication have been verified. Do not put secrets in frontend build variables or commit local environment files.

## Deployment status and limitations

Racebooth is validated locally. Hosting configuration is prepared, but no public deployment is claimed:

- Vercel needs a project and the backend HTTPS origin for same-origin `/api` routing.
- The Render configuration is an evaluation/staging template. Render Free web services spin down after 15 minutes without traffic and use an ephemeral filesystem; see [Render's free service limits](https://render.com/docs/free). This is not a dependable production backend.
- A managed PostgreSQL database and private R2 bucket, credentials, backup/restore procedures, and live storage verification are still required.
- The current n8n Gmail workflow and Hermes runtime are local services. Email automation and AI diagnosis will not be continuously available to a hosted backend until secure, persistent hosted services are configured. The local instances should remain intact during migration.
- The Hermes integration is recommendation-only. Keep its API private and its toolsets disabled.
- Photo cleanup is opt-in. Choose and validate retention settings before enabling deletion on hosted data.

See [docs/deployment-readiness.md](docs/deployment-readiness.md) for the ordered deployment plan and [docs/hermes-setup.md](docs/hermes-setup.md) for the current private Hermes integration model.
