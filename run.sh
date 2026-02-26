#!/usr/bin/env bash
# OpenClaw Orchestra — Start Script
set -e

if [ ! -d ".venv" ]; then
  echo "Run ./install.sh first"
  exit 1
fi

PORT="${ORCHESTRA_PORT:-9000}"
echo "🎼  OpenClaw Orchestra starting on http://0.0.0.0:$PORT"
echo "    Open http://localhost:$PORT in your browser"
echo "    Press Ctrl+C to stop"
echo ""

ORCHESTRA_PORT="$PORT" .venv/bin/python app.py
