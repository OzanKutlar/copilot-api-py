#!/bin/bash
# Opens copilot-api in the mode chosen by setup.py. Double-click it in Finder,
# or run it in a terminal. Run `python3 setup.py` once first.
# Make it executable once with: chmod +x scripts/copilot-desktop.command
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -x "./run.sh" ]; then
    echo "run.sh is missing. Run: python3 setup.py"
    exit 1
fi

# ${@+"$@"} rather than "$@": macOS's bash 3.2 rejects "$@" under set -u when there are no arguments.
exec ./run.sh ${@+"$@"}
