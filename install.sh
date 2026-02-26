#!/usr/bin/env bash
# OpenClaw Orchestra — Install Script
set -e

BOLD=$(tput bold 2>/dev/null || echo ""); RESET=$(tput sgr0 2>/dev/null || echo "")
info() { echo "${BOLD}[orchestra]${RESET} $*"; }
ok()   { echo "${BOLD}[orchestra]${RESET} ✅ $*"; }
die()  { echo "${BOLD}[orchestra]${RESET} ❌ $*"; exit 1; }

info "Setting up OpenClaw Orchestra…"

# Python 3
command -v python3 >/dev/null || die "python3 is required — install it first"
PY=$(command -v python3)

# Virtual environment
if [ ! -d ".venv" ]; then
  info "Creating virtual environment…"
  "$PY" -m venv .venv || die "python3-venv is needed: sudo apt install python3-venv"
fi

info "Installing Python dependencies…"
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet -r requirements.txt

# Data directory
mkdir -p data static

ok "Installed! Run ./run.sh to start Orchestra."
