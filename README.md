# Ukubot Cloud

A private, single-owner backend hosting control panel. It deploys ordinary Node.js/Express repositories to Google Cloud Run and gives each backend its own HTTPS URL.

**This is a backend host, not an AI app and not a static-site host.** Your frontends can stay on GitHub Pages and call the deployed backend with `fetch()`.

## Architecture

- Dashboard: static HTML/CSS/JS.
- Control plane: this Node.js service, protected by one private owner token.
- Workloads: each deployed GitHub repository becomes a separate Cloud Run service.
- Source: public GitHub repository in this first MVP.
- Runtime: a dedicated Cloud Run HTTPS URL for each backend.

## Current MVP

- Deploy public Node.js repositories.
- Supply runtime environment variables (including secrets) at deployment time.
- Keep a list of deployed services and their URLs.
- Inspect deployment job status/output.
- Check Cloud Run service health and delete services.
- Optional always-allocated CPU for apps that run background work between HTTP requests.
- One private owner token; no public customer accounts.

Not included yet: private GitHub repositories, durable project metadata database, custom domains, log streaming, billing, automatic GitHub webhook redeploys, or multi-user accounts.

## Fabric Pro compatibility note

Fabric Pro uses long-running background generation jobs and stores job state/files in the app's local process/filesystem. When deploying it, tick **Keep CPU available between requests** so background generation can continue between polling requests. This can increase cost while the instance is active.

This does not make in-memory jobs or generated ZIPs durable: a Cloud Run restart or scale-down can still lose them. For reliable production use, move job state and generated files to persistent services. For your personal first test, use one instance and test a small mod before relying on it.

## Google Cloud setup

Create a Google Cloud project and attach a billing account. Enable the APIs:

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

Create a dedicated service account for Ukubot Cloud:

```bash
gcloud iam service-accounts create ukubot-cloud-deployer
```

Grant it the following roles in your project:
- `roles/run.admin`
- `roles/cloudbuild.builds.editor`
- `roles/artifactregistry.writer`
- `roles/iam.serviceAccountUser`

The control plane should run with this service account attached. Google Cloud's gcloud CLI can use the identity attached to a Cloud Run service; do not create or commit a service-account JSON key. See [Google's gcloud authentication documentation](https://cloud.google.com/sdk/docs/authenticate).

## Deploy the control plane

Set these environment variables:
- `OWNER_TOKEN`: random secret at least 32 characters long.
- `GOOGLE_CLOUD_PROJECT`: your Google Cloud project ID.
- `GOOGLE_CLOUD_REGION`: for example, `us-west1`.
- `ALLOWED_ORIGINS`: exact browser origins allowed to use the dashboard.

Deploy from this repository (after installing and authenticating the Google Cloud CLI):

```bash
gcloud run deploy ukubot-cloud-control \
  --source . \
  --project YOUR_PROJECT_ID \
  --region us-west1 \
  --allow-unauthenticated \
  --service-account ukubot-cloud-deployer@YOUR_PROJECT_ID.iam.gserviceaccount.com \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID,GOOGLE_CLOUD_REGION=us-west1,OWNER_TOKEN=YOUR_LONG_RANDOM_TOKEN,ALLOWED_ORIGINS=https://YOUR-ACCOUNT.github.io" \
  --memory 1Gi --cpu 1 --no-cpu-throttling --max-instances 1 --min-instances 0
```

The control plane container includes Git and the Google Cloud CLI. Its attached service account performs the deployment commands. The control plane uses always-allocated CPU so its asynchronous build/deploy task can continue after the dashboard request returns; it can still scale to zero when idle. This may incur compute charges while a deployment is running.

## Dashboard

The dashboard lives in `dashboard/`. It can be opened locally or published on GitHub Pages. In Settings, enter the control-plane URL and owner token. The token is stored in the current browser tab's `sessionStorage`.

Set `ALLOWED_ORIGINS` to the dashboard's exact origin. A GitHub Pages project site normally sends the origin `https://YOUR-ACCOUNT.github.io` (the repository path is not part of the origin).

## Deploy a backend

A supported repository needs a `package.json` start script, for example:

```json
{ "scripts": { "start": "node server.js" }, "dependencies": { "express": "^4.21.2" } }
```

The app must listen on `process.env.PORT || 8080` and bind to `0.0.0.0`.

In the dashboard, enter a service name, public GitHub URL, and optional environment variables (one `KEY=value` per line). For Fabric Pro, for example, you would set its existing `GROQ_API_KEY`, `GROQ_MODEL`, and `CORS_ORIGINS` values there. The key is applied only to the backend runtime, not the GitHub Pages frontend.

The deployer runs `gcloud run deploy --source` and returns the new backend's HTTPS URL.

## API

- `GET /api/health`
- `GET /api/projects` (owner token required)
- `POST /api/deployments` (owner token required)
- `GET /api/jobs/:id` (owner token required)
- `GET /api/projects/:name/health` (owner token required)
- `DELETE /api/projects/:name` (owner token required)

## Costs and safety

Cloud Run has a free usage allowance, not unlimited free hosting. Builds, CPU/memory time, requests, and outbound traffic can cost money. Always-allocated CPU can cost more than request-based CPU. Set budget alerts and review actual usage; a budget alert alone does not stop charges.

This is a private, single-owner MVP. Never share the owner token or expose the control API as a public deployment service.
