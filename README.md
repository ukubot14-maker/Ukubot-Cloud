# Ukubot Cloud

A private, single-owner backend hosting control panel. It deploys ordinary Node.js/Express repositories to Google Cloud Run and gives each backend its own HTTPS URL.

**This is a backend host, not an AI app and not a static-site host.** Your frontends can stay on GitHub Pages and call the deployed backend with `fetch()`.

## Architecture

- Dashboard: static HTML/CSS/JS.
- Control plane: this Node.js service, protected by one private owner token.
- Workloads: each deployed GitHub repository becomes a separate Cloud Run service.
- Deploy source: public GitHub repository (first MVP).
- Runtime: Cloud Run HTTPS URL such as `https://my-api-xxxxx-uw.a.run.app`.

## Current MVP scope

- Deploy public Node.js repositories.
- Set runtime environment variables during deployment.
- List deployments in the current control-plane process.
- Check deployment jobs and view deployment output.
- Redeploy a project from its saved repository URL.
- Delete a Cloud Run service.
- Private owner-only control API.

Not included yet: GitHub OAuth, multi-user accounts, private repositories, persistent database for dashboard metadata, custom domains, billing, log streaming, and automatic GitHub webhook redeploys.

## Important Fabric Pro note

Fabric Pro runs long background generation jobs and currently keeps job state in process memory. Cloud Run can scale instances down or restart them. This MVP can deploy Fabric Pro, but for reliable long-running generation we should next move Fabric Pro's job queue and generated ZIP storage to durable services (for example Cloud Tasks/Cloud Run Jobs plus Cloud Storage or a database). Do not assume the current in-memory jobs survive a restart.

## Google Cloud setup

Create a Google Cloud project and attach a billing account. Enable:

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

Create a dedicated service account for the control plane. Grant it the minimum required roles for the MVP:
- Cloud Run Admin (`roles/run.admin`)
- Cloud Build Editor (`roles/cloudbuild.builds.editor`)
- Artifact Registry Writer (`roles/artifactregistry.writer`)
- Service Account User (`roles/iam.serviceAccountUser`)

Create a JSON key for that service account and store it as a Secret Manager secret. Mount it into the control-plane Cloud Run service at `/secrets/gcloud-key.json`; set `GOOGLE_APPLICATION_CREDENTIALS=/secrets/gcloud-key.json`. Avoid committing the key to GitHub.

## Deploy the control plane

Set these environment variables when deploying this repository:
- `OWNER_TOKEN`: long random secret (at least 32 characters).
- `GOOGLE_CLOUD_PROJECT`: target Google Cloud project ID.
- `GOOGLE_CLOUD_REGION`: e.g. `us-west1`.
- `GOOGLE_APPLICATION_CREDENTIALS`: mounted service-account key path.
- `ALLOWED_ORIGINS`: comma-separated exact dashboard origins.

Deploy this repository itself to Cloud Run (from your own machine, after installing/authenticating gcloud):

```bash
gcloud run deploy ukubot-cloud-control \
  --source . \
  --region us-west1 \
  --allow-unauthenticated \
  --set-env-vars GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID,GOOGLE_CLOUD_REGION=us-west1,OWNER_TOKEN=YOUR_LONG_RANDOM_TOKEN,ALLOWED_ORIGINS=https://YOUR-ACCOUNT.github.io \
  --memory 1Gi --cpu 1 --max-instances 1 --min-instances 0
```

For the service-account key, configure a Secret Manager volume mount in the Cloud Run service settings. Do not put the JSON key contents in plain environment variables or source control.

The control plane's container needs the Google Cloud CLI and Git; the included Dockerfile installs them. When using a mounted key, the app activates it with gcloud on startup.

## Dashboard

The dashboard is in `dashboard/`. It can be opened locally or published on GitHub Pages. Set the control-plane URL and owner token in the dashboard's Settings dialog. The token is kept only in the browser tab's sessionStorage.

Set `ALLOWED_ORIGINS` to the dashboard's exact origin. For a GitHub Pages project site, the browser Origin is normally `https://YOUR-ACCOUNT.github.io` (not the repository path).

## Deploy a backend

A repository must have a `package.json` with a start script. Example:

```json
{ "scripts": { "start": "node server.js" }, "dependencies": { "express": "^4.21.2" } }
```

The app must listen on `0.0.0.0` and `process.env.PORT || 8080`.

In the dashboard, enter a project name, a public GitHub URL, and optional environment variables. The control plane runs `gcloud run deploy --source` and returns the service URL.

## Costs and safety

Cloud Run has a free usage allowance, not unlimited free hosting. Builds, memory/CPU time, requests, and outbound network usage can incur charges. Configure Google Cloud budget alerts and review usage. A budget alert alone does not stop spending.

This control plane is intentionally private and single-owner. Never share the owner token. Do not expose it as a public deployment service.
