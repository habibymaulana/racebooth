# Hermes Agent — Stage 5 status

## Verified local configuration (8 November 2026)

- Official ARM64 Docker image pinned by digest; Hermes Agent `v0.23.0` (`2026.9.24`, upstream `2bd378ed`). The image was already installed before this validation and was not pulled again.
- Groq custom OpenAI-compatible provider: `https://api.groq.com/openai/v1`, model `openai/gpt-oss-20b`. The profile uses `GROQ_API_KEY`; the credential came from the `racebooth-groq` Keychain item. Its local profile copy is mode `0600` under a mode `0700` state directory. No billing or subscription setting was changed. Groq's account billing tier was not independently inspected.
- Authenticated Hermes API on `racebooth-hermes-net`, with no host-published port. The Hermes container has no database, n8n, or photo-storage mount. Only the Racebooth backend joins this network.
- `platform_toolsets.api_server: []`; authenticated `/v1/toolsets` returned 27 toolsets, all disabled. The operator adapter checks this before each inference and refuses to run if any toolset is enabled or cannot be inspected.
- Hermes is recommendation-only. Model calls happen only after an operator requests a diagnosis; they cannot trigger remediation. The backend sends only a fixed, sanitized category, severity, and observation. It excludes incident IDs, free-text descriptions, photographs, gallery tokens, email addresses, and credentials.
- The backend reads the gateway key from a mounted mode `0600` file. The key and Groq credential are not in frontend configuration or source control.

The gateway's API was initially probed before the supervised service had finished starting. The saved `gateway run` command and API configuration match the [official Docker guide](https://hermes-agent.nousresearch.com/docs/user-guide/docker) and [API server guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server). Once startup completed, the API returned 401 without authentication and 200 with the configured bearer key. No launch-command change or reinstallation was needed.

## QC inference and dashboard

One controlled, non-destructive system incident was created and sent once through the protected operator diagnosis route. The route required CSRF, session login, and operator authorization. The test used an in-memory operator fixture for the account lookup; it did not create or alter an operator account. Hermes/Groq returned a genuine diagnosis for the minimal evidence, which was saved in PostgreSQL `qc_diagnoses`. The protected status response returned the same saved severity, diagnosis, probable root cause, recommendation, and provider/model; the current operator frontend bundle renders all five fields.

The configured model shown in QC is `groq · openai/gpt-oss-20b`. The gateway's OpenAI API identifies itself as `hermes-agent`, so the backend records the configured provider/model alongside the saved output rather than presenting that gateway alias as the upstream model. The model status is based on a successful saved inference and is historical; connection readiness is reported separately.

At validation, `GET /health/detailed` reported degraded readiness because disk usage was 98.5%, despite approximately 3.5 GiB free. This remained above the required 2 GiB floor. The model inference succeeded, but Hermes will continue to flag the low free-space percentage until more space is available.

## Starting the local integration

The default state directory is `${HOME}/.local/share/racebooth-hermes`. Set `RACEBOOTH_HERMES_STATE_DIR` to another private directory when needed. Keep its key and profile outside the project with restrictive permissions. From the project root, start only the related services with:

```sh
docker compose -f compose.phase1.yml -f compose.hermes.yml up -d --no-deps hermes backend frontend
```

This override preserves the existing PostgreSQL, photo-storage volume, and n8n configuration. It does not publish the Hermes API port. Do not use `docker compose down -v` for this integration.

## Validation evidence (8 November 2026)

- Hermes runtime: running, version `v0.23.0`; authenticated identity and health endpoints responded; all 27 advertised API toolsets were disabled.
- Groq: one real inference completed using the configured custom provider/model. No fabricated response was saved on failure.
- Racebooth QC: unauthenticated status returned 401; fixture operator login returned 200; diagnosis returned 200; one diagnosis row was confirmed in PostgreSQL and the protected dashboard status returned matching values with `modelVerified: true`.
- Regression: backend unit tests 47/47; disposable PostgreSQL integration tests 34/34; backend syntax check passed; frontend Vite production build passed; live backend health returned `ok`.
- No Gmail message was sent. No existing database record was altered or deleted; one clearly labeled QC verification incident and its diagnosis were added. No Docker volume, n8n workflow, Git remote, or deployment was changed.

The inference test used deliberately sparse, generic incident metadata; its response appropriately described the lack of detailed evidence. Use diagnoses as operator recommendations, not as proof of root cause. Groq rate limits or provider failures return an error and do not save an invented diagnosis.

## Diagnostic scope

QC checks database connectivity, failed upload and photostrip records, up to 500 newest referenced files for availability and size, session counters and four-photo free-session limits, failed or stale unconfirmed email deliveries, recorded request/workflow failures, n8n health, and optional Hermes identity/readiness. No photos are read into the browser by QC. Storage checks never delete unreferenced files.

An n8n `GET /healthz` response establishes liveness only. It does not verify webhook authentication, the active workflow, Gmail credentials, Gmail's send result, or inbox receipt. An ambiguous email outcome remains unconfirmed and cannot be automatically retried. Only an explicit operator action can request a retry of a definite failed delivery, and the email service checks duplicate/pending records again.
