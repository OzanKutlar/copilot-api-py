#!/bin/bash
# Opens copilot-api. With a CombineWebUI clone in this folder it opens the
# desktop window (no ports); otherwise it starts the HTTP proxy on port 4141.
# Double-click it in Finder, or run it in a terminal. Expects a virtual
# environment at .venv (see README). Make it executable once with:
#   chmod +x scripts/copilot-desktop.command
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -x ".venv/bin/python" ]; then
    echo "No virtual environment at $(pwd)/.venv."
    echo "Create it with: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt -r CombineWebUI/requirements-desktop.txt"
    exit 1
fi

exec ".venv/bin/python" main.py start "$@"
