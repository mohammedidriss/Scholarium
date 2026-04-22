#!/bin/bash
# ==============================================================================
# Scholarium — Full macOS Installer
# ==============================================================================
# One-shot installer: Homebrew → Python 3.11 → Ollama → LLMs → venv → deps → embedding models.
# Safe to re-run (idempotent).
# ==============================================================================

set -e  # exit on any error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colours
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No color

RESPONDENT_MODEL="${SCHOLARIUM_RESPONDENT:-qwen2.5:14b}"
JUDGE_MODEL="${SCHOLARIUM_JUDGE:-qwen2.5:14b}"
FALLBACK_MODEL="llama3.2:latest"

step() { echo -e "\n${BOLD}${BLUE}==> $1${NC}"; }
ok()   { echo -e "${GREEN}   ✓ $1${NC}"; }
warn() { echo -e "${YELLOW}   ⚠ $1${NC}"; }
err()  { echo -e "${RED}   ✗ $1${NC}" >&2; }

echo -e "${BOLD}"
echo "================================================================"
echo "  Scholarium — Research Assistant Installer"
echo "================================================================"
echo -e "${NC}"
echo "This script will install and configure everything needed to run"
echo "Scholarium on macOS. It's safe to re-run — it skips steps that"
echo "are already complete."
echo
echo "What will be installed:"
echo "  • Homebrew (if missing)"
echo "  • Python 3.11 (if missing)"
echo "  • Ollama (LLM runtime)"
echo "  • LLM models: ${RESPONDENT_MODEL} (≈9 GB), ${FALLBACK_MODEL} (≈2 GB)"
echo "  • Python dependencies (Flask, ChromaDB, sentence-transformers, etc.)"
echo "  • Embedding + reranker models (≈2 GB)"
echo
echo "Disk space needed: ~14 GB"
echo "Time needed: 10-30 minutes (depends on connection speed)"
echo
read -rp "Press Enter to continue, or Ctrl+C to cancel... "

# ------------------------------------------------------------------------------
# Step 1: macOS check
# ------------------------------------------------------------------------------
step "Checking macOS version"
if [[ "$(uname)" != "Darwin" ]]; then
    err "This installer is for macOS only. Detected: $(uname)"
    exit 1
fi
ok "macOS detected: $(sw_vers -productVersion)"

# ------------------------------------------------------------------------------
# Step 2: Homebrew
# ------------------------------------------------------------------------------
step "Checking Homebrew"
if ! command -v brew >/dev/null 2>&1; then
    warn "Homebrew not found. Installing..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

    # Add brew to PATH for Apple Silicon
    if [[ -f /opt/homebrew/bin/brew ]]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [[ -f /usr/local/bin/brew ]]; then
        eval "$(/usr/local/bin/brew shellenv)"
    fi
    ok "Homebrew installed"
else
    ok "Homebrew already installed ($(brew --version | head -1))"
fi

# ------------------------------------------------------------------------------
# Step 3: Python 3.11+
# ------------------------------------------------------------------------------
step "Checking Python 3.11+"
PYTHON_CMD=""
for cmd in python3.11 python3.12 python3.13 python3; do
    if command -v "$cmd" >/dev/null 2>&1; then
        ver=$("$cmd" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
        major=${ver%.*}; minor=${ver#*.}
        if [[ "$major" -ge 3 && "$minor" -ge 11 ]]; then
            PYTHON_CMD="$cmd"
            break
        fi
    fi
done

if [[ -z "$PYTHON_CMD" ]]; then
    warn "Python 3.11+ not found. Installing via Homebrew..."
    brew install python@3.11
    PYTHON_CMD="python3.11"
    ok "Python 3.11 installed"
else
    ok "Using $PYTHON_CMD ($("$PYTHON_CMD" --version))"
fi

# ------------------------------------------------------------------------------
# Step 4: Ollama
# ------------------------------------------------------------------------------
step "Checking Ollama"
if ! command -v ollama >/dev/null 2>&1; then
    warn "Ollama not found. Installing via Homebrew..."
    brew install ollama
    ok "Ollama installed"
else
    ok "Ollama already installed ($(ollama --version 2>/dev/null || echo unknown))"
fi

# Start ollama service in background if not already running
if ! curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
    warn "Ollama server is not running. Starting it..."
    # Try brew services first (clean), else background process
    if brew services start ollama >/dev/null 2>&1; then
        ok "Started via brew services"
    else
        nohup ollama serve >/tmp/ollama.log 2>&1 &
        ok "Started as background process (log: /tmp/ollama.log)"
    fi

    # Wait for it to be ready
    printf "   Waiting for Ollama to respond"
    for i in {1..30}; do
        if curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
            echo ""
            ok "Ollama is ready"
            break
        fi
        printf "."
        sleep 1
    done
    echo ""
else
    ok "Ollama server is already running"
fi

# ------------------------------------------------------------------------------
# Step 5: Pull LLM models
# ------------------------------------------------------------------------------
step "Checking / pulling LLM models"

have_model() {
    ollama list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$1"
}

if have_model "$RESPONDENT_MODEL"; then
    ok "$RESPONDENT_MODEL already present"
else
    warn "Pulling $RESPONDENT_MODEL (≈9 GB — this will take a while)..."
    ollama pull "$RESPONDENT_MODEL"
    ok "$RESPONDENT_MODEL pulled"
fi

# Pull fallback model so the judge toggle + respondent fallback works
if have_model "$FALLBACK_MODEL"; then
    ok "$FALLBACK_MODEL already present"
else
    warn "Pulling $FALLBACK_MODEL (≈2 GB, used as fallback)..."
    ollama pull "$FALLBACK_MODEL"
    ok "$FALLBACK_MODEL pulled"
fi

# ------------------------------------------------------------------------------
# Step 6: Python virtual environment
# ------------------------------------------------------------------------------
step "Setting up Python virtual environment"
if [[ ! -d venv ]]; then
    "$PYTHON_CMD" -m venv venv
    ok "Virtual environment created at ./venv"
else
    ok "Virtual environment already exists at ./venv"
fi

# shellcheck disable=SC1091
source venv/bin/activate
pip install --quiet --upgrade pip
ok "pip upgraded"

# ------------------------------------------------------------------------------
# Step 7: Install Python dependencies
# ------------------------------------------------------------------------------
step "Installing Python dependencies"
if [[ ! -f requirements.txt ]]; then
    err "requirements.txt not found in $SCRIPT_DIR"
    exit 1
fi
pip install --quiet -r requirements.txt
ok "Dependencies installed"

# ------------------------------------------------------------------------------
# Step 8: Pre-download embedding models
# ------------------------------------------------------------------------------
step "Pre-downloading embedding + reranker models (first run only, ≈2 GB)"
python - <<'PYEOF'
print("  Downloading BAAI/bge-large-en-v1.5...")
from sentence_transformers import SentenceTransformer, CrossEncoder
SentenceTransformer("BAAI/bge-large-en-v1.5")
print("  Downloading BAAI/bge-reranker-v2-m3...")
CrossEncoder("BAAI/bge-reranker-v2-m3", max_length=512)
print("  Done.")
PYEOF
ok "Embedding + reranker models cached"

# ------------------------------------------------------------------------------
# Done
# ------------------------------------------------------------------------------
echo
echo -e "${BOLD}${GREEN}"
echo "================================================================"
echo "  Installation complete!"
echo "================================================================"
echo -e "${NC}"
echo "To start Scholarium:"
echo "  ./start.sh"
echo
echo "To restart it (e.g. after code changes):"
echo "  ./restart.sh"
echo
echo "The browser will open automatically at http://localhost:8080"
echo
