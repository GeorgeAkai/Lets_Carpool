#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

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
  start    Start backend and frontend (uses Neon via DATABASE_URL)
  stop     Stop backend and frontend
  restart  Stop then start again

Requires:
  DATABASE_URL   Neon connection string (postgresql://... or postgres://...)
                 Set in your shell or in backend/.env
EOF
}

check_neon_url() {
  # Load from backend/.env if present and DATABASE_URL not already set
  if [ -z "${DATABASE_URL:-}" ] && [ -f "$ROOT_DIR/backend/.env" ]; then
    set -o allexport
    # shellcheck disable=SC1091
    source "$ROOT_DIR/backend/.env"
    set +o allexport
  fi

  if [ -z "${DATABASE_URL:-}" ]; then
    echo "ERROR: DATABASE_URL is not set."
    echo ""
    echo "  Get your connection string from the Neon console and either:"
    echo "    export DATABASE_URL='postgresql://...' before running this script, or"
    echo "    add DATABASE_URL=postgresql://... to backend/.env"
    exit 1
  fi

  if [[ "$DATABASE_URL" != postgresql://* ]] && [[ "$DATABASE_URL" != postgres://* ]]; then
    echo "ERROR: DATABASE_URL does not look like a postgres connection string."
    echo "  Got: $DATABASE_URL"
    exit 1
  fi

  # Warn if it looks like a local postgres URL instead of Neon
  if [[ "$DATABASE_URL" == *"localhost"* ]] || [[ "$DATABASE_URL" == *"127.0.0.1"* ]]; then
    echo "Warning: DATABASE_URL points to localhost — expected a Neon cloud URL."
  fi

  SAFE_URL=$(echo "$DATABASE_URL" | sed 's|://[^:]*:[^@]*@|://***:***@|')
  echo "Database: Neon ($SAFE_URL)"
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
  check_neon_url
  ensure_backend_env
  ensure_frontend_deps

  if [ -f "$BACKEND_PID_FILE" ]; then
    echo "Warning: backend pid file already exists. Overwriting."
  fi
  if [ -f "$FRONTEND_PID_FILE" ]; then
    echo "Warning: frontend pid file already exists. Overwriting."
  fi

  echo "Starting backend on http://localhost:8000 ..."
  DATABASE_URL="$DATABASE_URL" \
  nohup "$ROOT_DIR/.venv/bin/python" -m uvicorn backend.app.main:create_app \
    --factory --host 0.0.0.0 --port 8000 --reload \
    > "$LOG_DIR/backend.log" 2>&1 &
  echo $! > "$BACKEND_PID_FILE"

  echo "Starting frontend on http://localhost:5173 ..."
  cd "$ROOT_DIR/frontend"
  nohup "$NPM_CMD" run dev -- --host 0.0.0.0 > "$LOG_DIR/frontend.log" 2>&1 &
  echo $! > "$FRONTEND_PID_FILE"
  cd "$ROOT_DIR"

  echo ""
  echo "Started all services."
  echo "  Backend PID : $(cat "$BACKEND_PID_FILE")"
  echo "  Frontend PID: $(cat "$FRONTEND_PID_FILE")"
  echo "  Logs        : $LOG_DIR"
  echo "  Backend     : http://localhost:8000"
  echo "  Frontend    : http://localhost:5173"
}

stop_services() {
  echo "Stopping backend and frontend..."
  if [ -f "$BACKEND_PID_FILE" ]; then
    kill "$(cat "$BACKEND_PID_FILE")" >/dev/null 2>&1 || true
    rm -f "$BACKEND_PID_FILE"
  fi
  if [ -f "$FRONTEND_PID_FILE" ]; then
    kill "$(cat "$FRONTEND_PID_FILE")" >/dev/null 2>&1 || true
    rm -f "$FRONTEND_PID_FILE"
  fi
  echo "Stopped."
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
