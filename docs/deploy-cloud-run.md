# Deploying the backend to Google Cloud Run

The FastAPI backend ships as a container (repo-root `Dockerfile`). The database
stays on Supabase Postgres; the frontend stays a static deploy.

## One-time setup

```bash
gcloud auth login
export GCP_PROJECT=<your-project-id>
gcloud config set project $GCP_PROJECT
gcloud services enable secretmanager.googleapis.com
```

Create the secrets (values are never passed on the command line of the deploy):

```bash
printf '%s' 'postgresql://...supabase pooler url...' | gcloud secrets create carpool-database-url --data-file=-
printf '%s' "$(openssl rand -hex 32)"               | gcloud secrets create carpool-jwt-secret   --data-file=-
printf '%s' "$(openssl rand -hex 32)"               | gcloud secrets create carpool-cron-secret  --data-file=-
printf '%s' '<google maps key>'                      | gcloud secrets create carpool-map-api-key  --data-file=-
```

Let the Cloud Run runtime service account read them:

```bash
SA="$(gcloud projects describe $GCP_PROJECT --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
for s in carpool-database-url carpool-jwt-secret carpool-cron-secret carpool-map-api-key; do
  gcloud secrets add-iam-policy-binding $s --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor
done
```

## Deploy

```bash
GCP_PROJECT=$GCP_PROJECT \
ALLOWED_ORIGINS="https://your-frontend.example.com" \
SUPABASE_URL="https://<project-ref>.supabase.co" \
./scripts/deploy-cloud-run.sh
```

The script builds with Cloud Build, deploys to Cloud Run, creates the daily
Cloud Scheduler job for `/cron/expire` (replacing Vercel Cron), and checks
`/health`. Re-run it to ship a new version.

## Environment

| Variable | Source | Notes |
|---|---|---|
| `DATABASE_URL` | secret | Use Supabase's **pooler** (port 6543/5432 pooler host), SSL on |
| `JWT_SECRET` | secret | long random string |
| `CRON_SECRET` | secret | the Scheduler job sends it as `Authorization: Bearer …` |
| `MAP_API_KEY` | secret | Google Maps key (also used for server-side routing) |
| `ALLOWED_ORIGINS` | env | space-separated frontend origins (CORS) |
| `SUPABASE_URL` | env | must match the frontend's `VITE_SUPABASE_URL` |
| `REDIS_URL` | secret, optional | `rediss://default:<password>@<host>:6379` — enables cross-instance realtime |
| `DB_POOL_MAX` | env | connections per instance (default 10, script uses 5) |
| `OSRM_BASE_URL` | env, optional | defaults to `http://localhost:5001`; set to a hosted OSRM or empty to disable (Google Routes is used when `MAP_API_KEY` is set) |
| `ADMIN_EMAILS` | env, optional | space-separated admin allowlist |

Keep `MAX_INSTANCES × DB_POOL_MAX` below the database's connection limit.

## Frontend

Point the frontend build at the new service:

```
VITE_API_BASE_URL=https://<service>-<hash>-<region>.a.run.app
VITE_REALTIME_STRATEGY=websocket   # Cloud Run can hold WebSockets; Vercel could not
```

Live updates (chat, accept/decline, driver location) then arrive immediately
instead of through the 3–8 s polling. Leave `VITE_REALTIME_STRATEGY` unset to
keep polling.

## Things to know

- **Realtime across instances (Redis).** WebSocket messages fan out through a
  Redis pub/sub channel (`carpool:ws`), so a message sent on one instance
  reaches a user connected to another. Set `REDIS_URL` (secret
  `carpool-redis-url`). If Redis is unreachable, the backend falls back to
  delivering on the local instance only. Without `REDIS_URL` it is local-only,
  so use `MAX_INSTANCES=1` or the polling strategy.
  - *Upstash / Redis Cloud:* easiest — use the `rediss://` URL, no VPC needed.
  - *Memorystore:* private IP; deploy with `VPC_NETWORK` and `VPC_SUBNET` set so
    Cloud Run (Direct VPC egress) can reach it.
- **Cold starts.** `MIN_INSTANCES=1` keeps an instance warm. Schema bootstrap
  (`run_migrations`) runs once at container start.
- **Local check of the image.**
  `docker build -t carpool-api . && docker run --rm -p 8080:8080 -e DATABASE_URL=... carpool-api`
  then `curl localhost:8080/health`.
- Vercel files (`vercel.json`, `api/index.py`) are still used by the container
  entrypoint (`api.index:app`); `vercel.json` can be dropped once Vercel no
  longer hosts the backend.
