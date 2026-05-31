# Lets_Carpool

Connecting people to save gas and money.

A two-sided carpool marketplace MVP. Riders publish ride requests, drivers publish trips, and either side can search, connect, coordinate in chat, and confirm a gas split.

For product scope and domain language, see [`CONTEXT.md`](CONTEXT.md). For implementation slices, see [`ISSUES.md`](ISSUES.md).

## Tech stack

- **Frontend:** React + Vite (web MVP shell)
- **Backend:** Python 3.12, FastAPI
- **Database:** PostgreSQL + PostGIS (local dev via Docker)

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with Compose (`docker compose` or `docker-compose`)
- Python 3.12+
- Node.js 20+ and npm

## Quick start

From the repo root:

```bash
chmod +x run.sh
./run.sh start
```

This will:

1. Start Postgres/PostGIS in Docker when Docker is available
2. Create `.venv` and install backend dependencies (if needed)
3. Install frontend dependencies (if needed)
4. Start the API on [http://localhost:8000](http://localhost:8000)
5. Start the frontend on [http://localhost:5173](http://localhost:5173)

If Docker is not available in WSL, `./run.sh start` still launches the backend and frontend. The current MVP backend uses in-memory storage, so Postgres is optional for local development.

**WSL + Docker Desktop:** enable WSL integration in Docker Desktop settings if `docker compose` fails. `run.sh` prefers `docker compose` over the legacy `docker-compose` shim.

Stop everything:

```bash
./run.sh stop
```

Restart:

```bash
./run.sh restart
```

Logs are written to `.run_logs/backend.log` and `.run_logs/frontend.log`.

## Manual setup

Use this if you prefer to run services in separate terminals.

### 1. Database

```bash
docker compose up -d postgres
```

Default connection string:

```text
postgresql://carpool:carpool@localhost:5432/carpool
```

Apply the initial migration (PostGIS extension):

```bash
docker compose exec postgres psql -U carpool -d carpool -f - < backend/migrations/001_initial.sql
```

Or from the host if `psql` is installed:

```bash
PGPASSWORD=carpool psql -h localhost -U carpool -d carpool -f backend/migrations/001_initial.sql
```

### 2. Backend

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'

uvicorn backend.app.main:create_app --factory --host 0.0.0.0 --port 8000 --reload
```

Useful endpoints:

- API root: [http://localhost:8000/](http://localhost:8000/)
- Health: [http://localhost:8000/health](http://localhost:8000/health)
- Interactive docs: [http://localhost:8000/docs](http://localhost:8000/docs)

### 3. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

Optional env override (create `frontend/.env.local`):

```bash
VITE_API_BASE_URL=http://localhost:8000
```

The backend allows CORS from `http://localhost:5173`. If Vite picks another port, either free 5173 or update `allow_origins` in `backend/app/main.py`.

## Auth (email + JWT)

For now, auth is **name + email only** — no password, no Google/Apple OAuth yet.

1. Open the app and enter your name and email on the homepage.
2. The backend creates or fetches your user and returns a signed **JWT** access token.
3. The frontend stores that token and sends it as a Bearer token on authenticated API calls.

OAuth (Google/Apple) is planned for later. See [`CONTEXT.md`](CONTEXT.md).

Set `JWT_SECRET` in the environment for non-local deployments. The default dev secret is only for local development.

### API sign-in (for testing)

```bash
curl -X POST http://localhost:8000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ada Lovelace","email":"ada@berkeley.edu"}'
```

Use the returned `access_token` on authenticated routes:

```bash
curl http://localhost:8000/me \
  -H 'Authorization: Bearer <access_token>'
```

## Tests

Backend (from repo root):

```bash
./.venv/bin/python -m pytest backend/tests
```

Frontend:

```bash
npm --prefix frontend test
```

Frontend production build:

```bash
npm --prefix frontend run build
```

## Project layout

```text
backend/
  app/           FastAPI app and domain logic
  migrations/    SQL migrations (PostGIS)
  tests/         Backend integration tests
frontend/
  src/           Web app (Vite + React)
docker-compose.yml
run.sh           Start/stop all services
CONTEXT.md       Product and architecture context
PRD.md           Product requirements
ISSUES.md        MVP implementation slices
```

## Notes

- The current backend uses an in-memory store for marketplace data during MVP development. Postgres/PostGIS is configured for local dev and future persistence work.
- Payments, live tracking, full ID verification, ratings, and AI matching are out of scope for this MVP. See [`CONTEXT.md`](CONTEXT.md) for boundaries.
