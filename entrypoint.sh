#!/bin/bash
# ================================================================
# Scholarium container entrypoint
# Starts Ollama in background, pulls models on first run, starts Flask.
# ================================================================
set -e

RESPONDENT_MODEL="${SCHOLARIUM_RESPONDENT:-qwen2.5:14b}"
JUDGE_MODEL="${SCHOLARIUM_JUDGE:-qwen2.5:14b}"

echo "================================================================"
echo "  Scholarium — Research Assistant (Docker)"
echo "================================================================"

# --- Start Ollama server in the background ---
echo "[1/3] Starting Ollama server..."
ollama serve > /tmp/ollama.log 2>&1 &
OLLAMA_PID=$!

# Wait (up to 180s) for Ollama to respond. First launch can be slow as it
# generates the SSH identity key and loads CUDA/Metal runtimes.
READY=0
for i in $(seq 1 180); do
    if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
        echo "      Ollama is up (pid=${OLLAMA_PID}, took ${i}s)"
        READY=1
        break
    fi
    # Show progress every 10 seconds
    if [ $((i % 10)) -eq 0 ]; then
        echo "      ...still waiting for Ollama (${i}s)"
    fi
    sleep 1
done

if [ "$READY" -ne 1 ]; then
    echo "ERROR: Ollama didn't become ready after 180s. Full log:"
    cat /tmp/ollama.log
    exit 1
fi

# --- Pull required models (only on first run) ---
echo "[2/3] Checking LLM models..."

if ollama list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "${RESPONDENT_MODEL}\(:latest\)\?"; then
    echo "      Respondent '${RESPONDENT_MODEL}' already present."
else
    echo "      Pulling respondent '${RESPONDENT_MODEL}' (~5 GB, one-time)..."
    ollama pull "${RESPONDENT_MODEL}"
fi

if ollama list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "${JUDGE_MODEL}"; then
    echo "      Judge '${JUDGE_MODEL}' already present."
else
    echo "      Pulling judge '${JUDGE_MODEL}' (~9 GB, one-time)..."
    ollama pull "${JUDGE_MODEL}" || echo "      WARNING: judge model pull failed — judging will fall back."
fi

# --- Launch Flask app (foreground, becomes PID 1 for docker signals) ---
echo "[3/3] Starting Scholarium web server on http://localhost:8080"
echo "================================================================"

# Clean shutdown: if Flask exits, stop Ollama too
trap 'kill -TERM "$OLLAMA_PID" 2>/dev/null' EXIT INT TERM

exec python app.py
