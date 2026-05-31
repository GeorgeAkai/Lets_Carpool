#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

DOCKER_COMPOSE_CMD=""
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  DOCKER_COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DOCKER_COMPOSE_CMD="docker-compose"
fi

PYTHON_CMD="python3"
if [ -x "$ROOT_DIR/.venv/bin/python" ]; then
  PYTHON_CMD="$ROOT_DIR/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_CMD="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_CMD="python"
else
  echo "ERROR: Python not found. Install Python 3.12+ or create a .venv with the correct interpreter."
  exit 1
fi

NPM_CMD=""
if command -v npm >/dev/null 2>&1; then
  NPM_CMD="npm"
else
  echo "ERROR: npm not found. Install Node.js/npm to run the frontend."
  exit 1
fi

BACKEND_PID_FILE="$ROOT_DIR/backend.pid"
FRONTEND_PID_FILE="$ROOT_DIR/frontend.pid"
LOG_DIR="$ROOT_DIR/.run_logs"
mkdir -p "$LOG_DIR"

usage() {
  cat <<EOF
Usage: $0 <command>

Commands:
  start    Start postgres, backend, and frontend
  stop     Stop backend, frontend, and postgres
  restart  Stop then start again
EOF
}

ensure_backend_env() {
  if [ ! -f "$ROOT_DIR/.venv/bin/python" ]; then
    echo "Creating virtualenv in .venv..."
    "$PYTHON_CMD" -m venv "$ROOT_DIR/.venv"
  fi

  echo "Installing backend dependencies..."
  "$ROOT_DIR/.venv/bin/python" -m pip install --upgrade pip >/dev/null 2>&1
  "$ROOT_DIR/.venv/bin/python" -m pip install -e . >/dev/null
}

ensure_frontend_deps() {
  echo "Installing frontend dependencies..."
  cd "$ROOT_DIR/frontend"
  "$NPM_CMD" install >/dev/null
  cd "$ROOT_DIR"
}

start_services() {
  if [ -n "$DOCKER_COMPOSE_CMD" ]; then
    echo "Starting postgres via docker compose..."
    if $DOCKER_COMPOSE_CMD up -d postgres; then
      echo "Postgres is running."
    else
      echo "Warning: could not start postgres. Continuing without it (MVP backend uses in-memory storage)."
    fi
  else
    echo "Warning: docker compose not available. Skipping postgres (MVP backend uses in-memory storage)."
    echo "Enable Docker Desktop WSL integration, or install Docker Compose, if you need Postgres locally."
  fi

  ensure_backend_env
  ensure_frontend_deps

  if [ -f "$BACKEND_PID_FILE" ]; then
    echo "Warning: backend pid file already exists. Overwriting."
  fi
  if [ -f "$FRONTEND_PID_FILE" ]; then
    echo "Warning: frontend pid file already exists. Overwriting."
  fi

  echo "Starting backend on http://localhost:8000 ..."
  nohup "$ROOT_DIR/.venv/bin/python" -m uvicorn backend.app.main:create_app --factory --host 0.0.0.0 --port 8000 --reload > "$LOG_DIR/backend.log" 2>&1 &
  echo $! > "$BACKEND_PID_FILE"

  echo "Starting frontend on http://localhost:5173 ..."
  cd "$ROOT_DIR/frontend"
  nohup "$NPM_CMD" run dev -- --host 0.0.0.0 > "$LOG_DIR/frontend.log" 2>&1 &
  echo $! > "$FRONTEND_PID_FILE"
  cd "$ROOT_DIR"

  echo "Started all services."
  echo "Backend PID: $(cat "$BACKEND_PID_FILE")"
  echo "Frontend PID: $(cat "$FRONTEND_PID_FILE")"
  echo "Logs: $LOG_DIR"
}

stop_services() {
  echo "Stopping backend and frontend processes..."
  if [ -f "$BACKEND_PID_FILE" ]; then
    kill "$(cat "$BACKEND_PID_FILE")" >/dev/null 2>&1 || true
    rm -f "$BACKEND_PID_FILE"
  fi
  if [ -f "$FRONTEND_PID_FILE" ]; then
    kill "$(cat "$FRONTEND_PID_FILE")" >/dev/null 2>&1 || true
    rm -f "$FRONTEND_PID_FILE"
  fi

  echo "Stopping postgres via docker compose..."
  if [ -n "$DOCKER_COMPOSE_CMD" ]; then
    $DOCKER_COMPOSE_CMD down >/dev/null 2>&1 || true
  fi
  echo "Stopped all services."
}

if [ $# -ne 1 ]; then
  usage
  exit 1
fi

case "$1" in
  start)
    start_services
    ;;
  stop)
    stop_services
    ;;
  restart)
    stop_services
    start_services
    ;;
  *)
    usage
    exit 1
    ;;
esac
