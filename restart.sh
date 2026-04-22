#!/bin/bash
# ==============================================================================
# Scholarium — Restart Script
# ==============================================================================
# Kills any existing Scholarium process on port 8080 and starts a fresh one.
# Use this after making code changes or if the app seems frozen.
# ==============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✓ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠ $1${NC}"; }

echo -e "${BOLD}"
echo "================================================================"
echo "  Scholarium — restarting..."
echo "================================================================"
echo -e "${NC}"

# ------------------------------------------------------------------------------
# 1. Kill anything bound to port 8080 (the Flask app)
# ------------------------------------------------------------------------------
PIDS=$(lsof -ti:8080 2>/dev/null || true)
if [[ -n "$PIDS" ]]; then
    warn "Killing process(es) on port 8080: $PIDS"
    # shellcheck disable=SC2086
    kill -9 $PIDS 2>/dev/null || true
    sleep 1
    ok "Port 8080 freed"
else
    ok "Port 8080 already free"
fi

# ------------------------------------------------------------------------------
# 2. Hand off to start.sh
# ------------------------------------------------------------------------------
exec "$SCRIPT_DIR/start.sh"
