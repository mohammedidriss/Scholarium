# Dual-LLM Research Assistant

A RAG-powered research assistant for Engineering and Technology doctorate research. Uses two LLMs: one to answer questions from your documents, and another to evaluate answer quality.

## Architecture

- **RAG Pipeline**: Loads PDFs, chunks text, embeds with `all-MiniLM-L6-v2`, stores in ChromaDB
- **Respondent LLM** (`llama3.1` via Ollama): Answers questions with inline citations from your documents
- **Judge LLM** (`llama3.1:70b` via Ollama, falls back to `gemma2:27b` or `llama3.1`): Scores answers on faithfulness, relevance, hallucination, and completeness

## Setup

### 1. Install Ollama

```bash
brew install ollama
```

### 2. Pull the models

```bash
# Required: respondent model
ollama pull llama3.1

# Recommended: larger judge model (pick one)
ollama pull llama3.1:70b    # Best quality (requires ~40GB RAM)
# OR
ollama pull gemma2:27b      # Good alternative (requires ~18GB RAM)
# OR just use llama3.1 for both (automatic fallback)
```

### 3. Start Ollama

```bash
ollama serve
```

### 4. Install Python dependencies

```bash
cd research_assistant
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 5. Run the app

```bash
python app.py
```

The browser opens automatically at http://localhost:5000.

## Adding Documents

**Option A** — Drag and drop PDFs into the chat input area, or click "Upload PDF" in the top bar.

**Option B** — Copy PDF files into the `documents/` folder, then restart the app (it auto-indexes on startup).

## Usage

1. Upload your research papers (PDF)
2. Ask questions in the chat — the assistant retrieves relevant passages and generates an answer with citations
3. The right panel shows judge evaluation scores:
   - **Faithfulness**: Is the answer grounded in the documents?
   - **Relevance**: Does it address your question?
   - **No Hallucination**: Did the model avoid fabricating information?
   - **Completeness**: Were all important points covered?
4. Click "Sources" under any answer to see the exact document chunks used

## Example Questions

- "What are the main contributions of this paper?"
- "Compare the methodologies used across these studies."
- "What limitations do the authors identify in their approach?"
- "Summarize the experimental results and their statistical significance."
- "What future research directions are suggested?"

## Session History

All Q&A interactions and scores are logged to `qa_log.json` for later review.

## Project Structure

```
research_assistant/
├── documents/          # Drop PDF papers here
├── vectordb/           # ChromaDB persistent storage
├── app.py              # Flask server + routes
├── rag_pipeline.py     # Document loading + retrieval
├── respondent.py       # Respondent LLM logic
├── judge.py            # Judge LLM logic
├── evaluator.py        # Orchestrates both LLMs
├── templates/
│   └── index.html      # Web UI
├── static/
│   └── style.css       # UI styles
├── requirements.txt    # Python dependencies
├── qa_log.json         # Auto-generated session log
└── README.md
```

## Requirements

- Python 3.11+
- macOS (tested on Apple Silicon)
- Ollama running locally
- ~8GB RAM minimum (more for larger judge models)
# Scholarium
