# Racebooth V1

Racebooth is a browser-based four-photo photobooth. Visitors can start a free session or choose a database-managed package and complete an explicitly simulated checkout without creating an account. Every simulated checkout is marked as a test record; no money is collected.

## Features

- **Public visitor flow:** No registration or login. Start a free session, or select an active package whose current price and benefits are loaded from PostgreSQL.
- **Simulated checkout:** The backend resolves the package price, records an automatically successful internal simulation, and creates the linked four-photo session in one database transaction. Checkout, transaction, session, package snapshot, and payment reference remain auditable. Simulations are excluded from real revenue.
- **Admin package management:** An explicitly provisioned admin can create, edit, order, activate, or deactivate packages. Operators and supervisors cannot change package settings; supervisors are read-only. Existing transaction snapshots preserve their historical terms.
- **Camera capture:** Uses the browser camera. Selfie mirroring can be selected before capture; the chosen orientation is used for the saved result. Camera access requires HTTPS or `localhost`.
- **Locked photostrip frame:** Choose one of 12 designs at the beginning of a session. The selection stays locked through capture and editing.
- **Photo looks:** Choose among 14 options after capture: Original, seven color treatments, and six artistic pixel treatments. The backend processes the saved originals when producing the final images.
- **Private gallery and sharing:** View and download the photos and completed strip through authorized backend routes. QR sharing uses an expiring, read-only gallery link.
- **Optional email delivery:** A configured n8n webhook can send a gallery link. Email is disabled until its endpoint and authentication are configured.
- **Operator quality control:** A protected operator area reports backend checks and incidents. Optional Hermes/Groq diagnoses are requested by an operator and provide recommendations; they do not perform repairs.

## Architecture

- **Frontend:** React, React Router, and Vite.
- **API:** Express on Node.js, with PostgreSQL persistence and Sharp image processing.
- **Photo storage:** Private local filesystem storage for development, Cloudflare R2 for the existing hosted-storage option, or an additive private Vercel Blob adapter for a Vercel deployment. Local and R2 storage remain available.
- **Email:** Optional authenticated backend-to-n8n webhook. Gmail credentials belong in n8n, not in the frontend or repository.
- **Operator diagnosis:** Optional private Hermes API connection, configured for Groq inference. It is independent of camera capture and email delivery.

The current staging target is a Vercel Vite frontend and Express API on one domain, with Neon PostgreSQL and private Vercel Blob. The single-project Services configuration is in beta and has not been deployed or cloud-validated. Earlier Render/R2 planning is retained as historical context in [deployment readiness](docs/deployment-readiness.md); see the current [Vercel deployment plan](docs/vercel-deployment.md) for requirements and limitations.

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

   To try the protected workspace, provision an operator account. Only provision an administrator when authorized; both commands prompt for a password without echoing it:

   ```sh
   npm run provision:operator --prefix backend -- --email <operator-email> --name <operator-name>
   ```

   ```sh
   npm run provision:admin --prefix backend -- --email <admin-email> --name <admin-name>
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
| PostgreSQL | Local: `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`; hosted: pooled `DATABASE_URL`, direct `DATABASE_URL_UNPOOLED` for migrations, `PGSSL` |
| Sessions and browser security | `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, `COOKIE_SECURE`, `APP_ORIGINS`, `PUBLIC_APP_ORIGIN`, `TRUST_PROXY_HOPS` |
| Photo storage | `PHOTO_STORAGE_DRIVER`, `PHOTO_STORAGE_PATH`, server-only `R2_*` values for R2, or Vercel-injected `BLOB_STORE_ID` with private Blob OIDC |
| Email | `N8N_EMAIL_ENABLED`, `N8N_EMAIL_WEBHOOK_URL`, `N8N_EMAIL_WEBHOOK_SECRET` |
| Operator diagnosis | `HERMES_ENDPOINT`, `HERMES_API_KEY_FILE` or `HERMES_API_KEY`, provider/model settings, and `HERMES_INFERENCE_ENABLED` |

Production mode requires HTTPS origins, secure cookies, PostgreSQL TLS, a trusted proxy configuration, and private durable photo storage. The automatic payment simulator is internal and explicitly simulated; it does not contact a payment provider or local n8n. Keep the legacy external payment webhook, n8n email, and Hermes integrations disabled until their hosted endpoints and authentication have been verified. Do not put secrets in frontend build variables or commit local environment files.

## Deployment status and limitations

Racebooth's current local Docker setup remains the validated environment. Hosting configuration is prepared, but no public deployment is claimed:

- Vercel Services can combine the Vite app and Express API under one domain, but its beta availability and this project's build/routing must be validated in the intended Vercel account.
- A new Neon database and private Vercel Blob store, their server-only credentials, backup/restore procedures, and live storage verification are still required. Existing local PostgreSQL records and photos are not migrated.
- Vercel Hobby is limited to personal, non-commercial use. Blob free quotas can pause access when exceeded, so they need monitoring before using real visitor photos.
- The current n8n Gmail workflow and Hermes runtime are local services. Email automation and AI diagnosis will not be continuously available to a hosted backend until secure, persistent hosted services are configured. The local instances should remain intact during migration.
- The Hermes integration is recommendation-only. Keep its API private and its toolsets disabled.
- Photo cleanup is opt-in. Choose and validate retention settings before enabling deletion on hosted data.

See [docs/deployment-readiness.md](docs/deployment-readiness.md) for the ordered deployment plan and [docs/hermes-setup.md](docs/hermes-setup.md) for the current private Hermes integration model.

See [docs/stage-7e-package-checkout.md](docs/stage-7e-package-checkout.md) for package-management permissions, the additive migration, simulated checkout records, and deployment notes.
