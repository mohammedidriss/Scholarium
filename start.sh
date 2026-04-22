#!/bin/bash
# ==============================================================================
# Scholarium — Start Script
# ==============================================================================
# Ensures Ollama is running, activates the venv, and launches the Flask app.
# ==============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✓ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠ $1${NC}"; }
err()  { echo -e "${RED}✗ $1${NC}" >&2; }

echo -e "${BOLD}"
echo "================================================================"
echo "  Scholarium — starting..."
echo "================================================================"
echo -e "${NC}"

# ------------------------------------------------------------------------------
# 1. venv check
# ------------------------------------------------------------------------------
if [[ ! -d venv ]]; then
    err "Virtual environment not found. Run ./install.sh first."
    exit 1
fi

# ------------------------------------------------------------------------------
# 2. Ensure Ollama is running
# ------------------------------------------------------------------------------
if ! command -v ollama >/dev/null 2>&1; then
    err "Ollama not installed. Run ./install.sh first."
    exit 1
fi

if ! curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
    warn "Ollama not running — starting it now..."
    if brew services start ollama >/dev/null 2>&1; then
        ok "Started via brew services"
    else
        nohup ollama serve >/tmp/ollama.log 2>&1 &
        ok "Started Ollama as background process"
    fi

    printf "  Waiting for Ollama to respond"
    for i in {1..30}; do
        if curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
            echo ""
            ok "Ollama ready"
            break
        fi
        printf "."
        sleep 1
    done
    echo ""
else
    ok "Ollama already running"
fi

# ------------------------------------------------------------------------------
# 3. Port 8080 check
# ------------------------------------------------------------------------------
if lsof -ti:8080 >/dev/null 2>&1; then
    err "Port 8080 is already in use. If Scholarium is already running, open http://localhost:8080"
    err "Otherwise run: ./restart.sh  (to kill the existing process and restart)"
    exit 1
fi

# ------------------------------------------------------------------------------
# 4. Activate venv and run Flask app
# ------------------------------------------------------------------------------
# shellcheck disable=SC1091
source venv/bin/activate

ok "Launching Scholarium on http://localhost:8080"
echo
exec python app.py
