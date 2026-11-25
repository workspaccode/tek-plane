#!/usr/bin/env bash
# Start 6dx at http://localhost:${PORT:-8000}
#   ./run.sh         only this computer
#   ./run.sh --lan   also other devices on the same Wi-Fi
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8000}"
if [[ "${1:-}" == "--lan" ]]; then
  shift
  HOST=0.0.0.0
  IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || true)"
  echo ""
  echo "  6dx on this computer:  http://localhost:${PORT}"
  echo "  6dx on your Wi-Fi:     http://${IP:-<this-computer-ip>}:${PORT}"
  echo "  (Google sign-in works on localhost only; other devices sign in with an email code.)"
  echo ""
fi
uv sync --quiet
exec uv run uvicorn backend.app.main:app --host "${HOST:-127.0.0.1}" --port "${PORT}" "$@"
