# Stage 7E — package administration and simulated checkout

**Status (2026-11-12):** implementation and local verification are complete in the working tree. The 56 backend unit tests, 40 disposable PostgreSQL integration tests, backend syntax checks, and Vite production build passed. The integration suite created only temporary users and records in its disposable PostgreSQL container. No persistent/local database was migrated, no durable admin account was created, and no cloud project or service was provisioned.

## Visitor experience

The public homepage reads active four-photo packages from `GET /api/public/packages`. Visitors can choose a package or use the existing free-session path. Package selection and frame selection happen before the camera session starts; the frame identifier is saved with the checkout and remains locked through capture and photostrip composition.

For a package, the browser posts the package ID, selected frame ID, and a UUID idempotency key to `POST /api/public/checkouts`. It cannot submit a trusted price, payment method, status, or success result. The backend reads the current active package and price from PostgreSQL, then in one transaction records an IDR transaction, marks it as `paid` with `payment_method='simulation'` and `is_simulated=true`, writes the simulation event and audit row, and creates the active four-photo photobooth session. A retry with the same key returns the same session and checkout credentials. This flow uses no external gateway, n8n callback, timer, or actual transfer of funds.

The public disclosure reads: **“Simulasi Pembayaran — Tidak ada uang sungguhan yang ditagihkan.”** The free booth remains available without registration or login.

## Database linkage and history

Additive migration `14-admin-packages-auto-simulation.sql`:

- Adds package description, JSON benefits, active display order, and update timestamp.
- Adds the `admin` account role without promoting or editing any existing account.
- Adds transaction currency (`IDR`), unique payment reference, and package snapshot fields. Existing payment rows are snapshotted before future package edits.
- Extends checkout metadata for the new visitor flow and locked frame.
- Allows the explicit `simulation` payment method and records the automatic simulator audit action.

The relationships are:

| Record | Relationship |
|---|---|
| `photo_packages.id` | Selected package referenced by checkout and transaction. |
| `public_checkout_sessions.id` | Persistent checkout session ID; one checkout row per transaction. |
| `payment_transactions.id` | Payment transaction ID; stores the amount snapshot, currency, reference, simulation marker, and package snapshot. |
| `photobooth_sessions.id` | Active four-photo session; its unique transaction link identifies the checkout that authorized it. |
| `payment_simulation_events` and `operator_payment_audit` | Append-only records of automatic simulated success. |
| `operator_transaction_requests` | Service-account scoped idempotency key prevents duplicate transactions on repeated requests. |

Existing transaction amounts and snapshots do not change when admins later edit the package. Deactivation hides a package from future public checkout but retains the referenced package row.

## Admin access

Package mutation APIs are protected by backend authorization, CSRF validation, and the authenticated session:

- `GET /api/admin/packages`
- `POST /api/admin/packages`
- `PATCH /api/admin/packages/:id`

Only an account whose database role is explicitly `admin` can use them. Operators keep their existing monitoring and transaction permissions, but cannot change packages. Supervisors can make GET requests only; mutating API requests return `403`. The admin UI is under `/operator/admin/packages` and does not appear in visitor navigation.

No default administrator is created. Provision one only after confirming the intended database and obtaining authorization. The existing hidden-password provisioning tool can create a new admin without changing an existing account:

```sh
npm run provision:admin --prefix backend -- --email <admin-email> --name <admin-name>
```

It requires an interactive terminal and prompts for the password without echoing it. Do not pass passwords in command arguments, shell history, or environment variables.

New managed packages have a fixed four-photo allowance. The current photostrip composer requires exactly four photos and locks the frame selected at session start. Older package rows with other photo limits remain in history but are not offered for public checkout.

## Vercel and service boundaries

The automatic simulation is compatible with the existing Vercel Services API entry point: it completes inside one PostgreSQL transaction and does not depend on process timers or background work. Neon still needs migration 14 applied to a new staging database before the API readiness check will serve requests. No environment variable is required to enable the internal simulator.

Keep these integrations separate:

- The legacy n8n payment simulator and webhook remain disabled. The new internal simulation does not call them.
- Hosted n8n Gmail delivery remains disabled until persistent, authenticated hosting exists.
- Hermes diagnosis remains disabled until its private runtime is persistently reachable from the hosted API.
- Local n8n, Hermes, PostgreSQL, photos, and Docker volumes remain untouched.

## Validation boundaries

Automated unit and disposable PostgreSQL integration tests verified roles, package validation, price resolution, idempotency, transaction/session linkage, audit rows, revenue separation, four saved originals, frame lock, selected-filter photostrip generation, and gallery downloads. The frontend production build also passed. These checks do not establish that Vercel routing, Neon connectivity, private Blob OIDC, a physical camera, or browser visual acceptance works in the cloud. Those checks remain for a separately approved Preview deployment.
