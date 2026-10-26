#!/usr/bin/env bash
# Build the backend image and deploy it to Google Cloud Run, then (re)create the
# Cloud Scheduler job that replaces Vercel Cron. See docs/deploy-cloud-run.md.
#
#   GCP_PROJECT=my-project ./scripts/deploy-cloud-run.sh
#
# Secrets are read from Secret Manager (create them once — see the doc), so no
# credentials pass through this script.
set -euo pipefail

: "${GCP_PROJECT:?Set GCP_PROJECT to your Google Cloud project id}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-carpool-api}"
REPO="${REPO:-carpool}"                      # Artifact Registry repository
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:?Set ALLOWED_ORIGINS (space-separated frontend origins)}"
SUPABASE_URL="${SUPABASE_URL:?Set SUPABASE_URL}"
MIN_INSTANCES="${MIN_INSTANCES:-1}"          # 1 = no cold starts (small monthly cost)
MAX_INSTANCES="${MAX_INSTANCES:-3}"
DB_POOL_MAX="${DB_POOL_MAX:-10}"              # per instance; keep MAX_INSTANCES x this under the DB limit

# Optional: Redis for cross-instance realtime (secret carpool-redis-url holds REDIS_URL).
# For Memorystore (private IP) also set VPC_NETWORK and VPC_SUBNET so Cloud Run can reach it.
SECRETS="DATABASE_URL=carpool-database-url:latest,JWT_SECRET=carpool-jwt-secret:latest,CRON_SECRET=carpool-cron-secret:latest,MAP_API_KEY=carpool-map-api-key:latest"
EXTRA=()
if gcloud secrets describe carpool-redis-url >/dev/null 2>&1; then
  SECRETS="${SECRETS},REDIS_URL=carpool-redis-url:latest"
fi
if [[ -n "${VPC_NETWORK:-}" && -n "${VPC_SUBNET:-}" ]]; then
  EXTRA+=(--network "$VPC_NETWORK" --subnet "$VPC_SUBNET" --vpc-egress private-ranges-only)
fi

IMAGE="${REGION}-docker.pkg.dev/${GCP_PROJECT}/${REPO}/${SERVICE}:$(git rev-parse --short HEAD)"

gcloud config set project "$GCP_PROJECT" >/dev/null
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com

gcloud artifacts repositories describe "$REPO" --location "$REGION" >/dev/null 2>&1 \
  || gcloud artifacts repositories create "$REPO" --repository-format docker --location "$REGION"

# Build in Cloud Build using the repo-root Dockerfile (no local Docker needed).
gcloud builds submit --tag "$IMAGE" .

# --session-affinity keeps a WebSocket client on the same instance;
# --timeout is the max WebSocket/request lifetime (clients reconnect after it).
gcloud run deploy "$SERVICE" \
  --image "$IMAGE" --region "$REGION" --allow-unauthenticated \
  --cpu 1 --memory 512Mi --concurrency 80 --timeout 3600 --session-affinity \
  --min-instances "$MIN_INSTANCES" --max-instances "$MAX_INSTANCES" \
  --set-env-vars "ALLOWED_ORIGINS=${ALLOWED_ORIGINS},SUPABASE_URL=${SUPABASE_URL},DB_POOL_MAX=${DB_POOL_MAX}" \
  --set-secrets "$SECRETS" "${EXTRA[@]}"

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')"
echo "Deployed: $URL"

# Daily expiry sweep (Vercel Cron equivalent). Sends the same bearer secret.
CRON_SECRET="$(gcloud secrets versions access latest --secret carpool-cron-secret)"
JOB="${SERVICE}-expire"
COMMON=(--location "$REGION" --schedule "0 4 * * *" --time-zone "Etc/UTC"
        --uri "${URL}/cron/expire" --http-method GET)
# `create` takes --headers; `update` calls it --update-headers (and rejects --headers).
if gcloud scheduler jobs describe "$JOB" --location "$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$JOB" "${COMMON[@]}" --update-headers "Authorization=Bearer ${CRON_SECRET}"
else
  gcloud scheduler jobs create http "$JOB" "${COMMON[@]}" --headers "Authorization=Bearer ${CRON_SECRET}"
fi

curl -fsS "${URL}/health" && echo
echo "Next: set VITE_API_BASE_URL=${URL} (and VITE_REALTIME_STRATEGY=websocket) in the frontend build."
