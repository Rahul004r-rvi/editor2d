#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "Creating Python venv…"
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi

export FLOOR_ANALYZER_PORT="${FLOOR_ANALYZER_PORT:-8787}"
echo "Floor analyzer API → http://127.0.0.1:${FLOOR_ANALYZER_PORT}"
exec .venv/bin/python server.py
