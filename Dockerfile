# Backend container for Cloud Run (or any other container host on GCP —
# GKE, Compute Engine, etc. all run the same image). Builds just the FastAPI
# backend; the frontend stays a static Vercel deploy per PRD.md.
FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app

# psycopg2-binary and cryptography both ship prebuilt manylinux wheels for
# this base image, so no build toolchain (gcc, libpq-dev) is needed here.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Only what the backend actually imports at runtime — see .dockerignore for
# what's excluded (frontend/, tests, docs, local .env files, etc.).
COPY backend/ backend/
COPY api/ api/

# Cloud Run injects $PORT (defaults to 8080 here for `docker run` outside
# Cloud Run) and requires the container to listen on it within the startup
# timeout. `exec` keeps gunicorn as PID 1 so it receives SIGTERM directly for
# a clean shutdown, instead of a wrapping shell swallowing it.
EXPOSE 8080
CMD exec gunicorn api.index:app \
    --worker-class uvicorn_worker.UvicornWorker \
    --workers "${WEB_CONCURRENCY:-2}" \
    --bind "0.0.0.0:${PORT:-8080}" \
    --timeout 60 \
    --access-logfile - \
    --error-logfile -
