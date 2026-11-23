#!/usr/bin/env bash
# Start tek-plane at http://localhost:${PORT:-8000}
set -euo pipefail
cd "$(dirname "$0")"
uv sync --quiet
exec uv run uvicorn backend.app.main:app --host "${HOST:-127.0.0.1}" --port "${PORT:-8000}" "$@"
