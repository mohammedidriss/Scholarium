# Scholarium — Multi-Project Research Assistant

A professional, multi-project research platform for Engineering and Technology doctorate research. Built with a dual-LLM architecture: one model answers questions from your documents with citations, another evaluates response quality. All running locally on your machine — no cloud APIs, no data leaves your computer.

## Features

### Multi-Project Workspace
- Create multiple isolated research projects (e.g., "Blockchain in Finance", "AI Security")
- Each project has its own documents, notes, Q&A history, summaries, and vector database
- Full-screen project selection on startup — complete data segregation between projects
- Navigate between projects with the "← Projects" button

### RAG-Powered Q&A
- Upload PDF research papers and ask questions in natural language
- Retrieves the most relevant passages using semantic search (ChromaDB + sentence-transformers)
- Generates answers with inline citations pointing to exact source documents and chunks
- Cancel button to abort long-running queries

### Dual-LLM Evaluation
- **Respondent LLM** (`qwen2.5:14b` via Ollama) — generates answers from your documents with strong academic reasoning
- **Judge LLM** (`qwen2.5:14b` via Ollama) — scores every answer on 4 dimensions:
  - Faithfulness (grounded in documents?)
  - Relevance (answers the question?)
  - Hallucination (fabricated anything?)
  - Completeness (missed key points?)
- Scores displayed as colored bars (green/amber/red)

### Document Management
- Upload PDFs via drag-and-drop or the Upload button
- Full-scroll document viewer with page separators
- Search within documents with highlighted matches
- Reading status tracking (Unread → Reading → Reviewed)
- Reading progress bar (auto-tracked by scroll position)
- Download or delete documents
- Filter documents by status and collection

### AI Document Analysis
- **Summarize** — AI-generated summary with key findings and methodology extraction
- **Literature Matrix** — auto-generate a comparison table across all papers (title, year, methodology, findings, sample size)
- **Citation Generator** — extract metadata and generate APA, IEEE, or Harvard citations with copy-to-clipboard
- Summary panel shown side-by-side with the document viewer

### Note-Taking
- Create, edit, and delete notes per project
- Bi-directional linking using `[[Note Title]]` syntax — clickable links with backlinks
- Take notes while viewing documents (linked to the document)
- Export notes to PDF or DOCX

### PDF Highlighting
- Select text in the document viewer and click "Highlight" to save
- Highlights rendered with amber background when document is reopened
- Highlights panel with delete functionality

### Collections & Organization
- Group documents into named collections
- Filter document list by collection or reading status

### Research Journal
- Daily research journal with auto-populated statistics (Q&A count, documents viewed)
- Write daily research notes, review past entries

### Conversation History
- Full Q&A history saved per project
- Replay past conversations with scores
- Export answers to PDF or DOCX
- Copy answers to clipboard

### System Health Dashboard
- Real-time health monitoring of all services (Python, Flask, Ollama, LLMs, ChromaDB, Embeddings)
- Click to expand detailed status view
- Auto-refreshes every 30 seconds

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Flask (Python) |
| Frontend | Vanilla HTML/CSS/JS (dark theme) |
| Vector Database | ChromaDB (persistent, per-project) |
| Embeddings | sentence-transformers (`all-MiniLM-L6-v2`) |
| Respondent LLM | Ollama + `qwen2.5:14b` (14B) |
| Full-doc context mode | 32K-token window for per-document Q&A (bypasses RAG) |
| Embeddings | `BAAI/bge-large-en-v1.5` (1024-dim, academic-aware) |
| Reranker | `BAAI/bge-reranker-v2-m3` cross-encoder |
| Hybrid retrieval | Dense (BGE) + Sparse (BM25), merged and reranked |
| Judge LLM | Ollama + `qwen2.5:14b` (14B, with fallback chain) |
| PDF Processing | PyMuPDF (fitz) |
| PDF/DOCX Export | fpdf2, python-docx |

## Quick Start (macOS — one command)

```bash
git clone https://github.com/mohammedidriss/Scholarium.git
cd Scholarium
chmod +x install.sh start.sh restart.sh
./install.sh
./start.sh
```

That's it. `install.sh` handles everything: Homebrew, Python 3.11, Ollama, LLM models (~14 GB), venv, dependencies, and pre-downloaded embedding models. Then `start.sh` launches the app and opens your browser to http://localhost:8080.

Subsequent usage:

```bash
./start.sh      # start the app
./restart.sh    # kill any running instance + start again (use after code changes)
```

See **Setup** below for the manual step-by-step if you prefer.

---

## Setup

### Prerequisites
- **macOS** (tested on Apple Silicon MacBook Pro, M-series)
- **Python 3.11+**
- **Ollama** (local LLM runtime)
- **8GB+ RAM** (16GB+ recommended for the 14B judge model)

### Step 1: Install Ollama

```bash
brew install ollama
```

### Step 2: Start Ollama

```bash
ollama serve
```

Keep this running in a separate terminal.

### Step 3: Pull the LLM models

```bash
# Required: Respondent model (answers questions)
ollama pull qwen2.5:14b

# Required: Judge model (evaluates answer quality)
ollama pull qwen2.5:14b
```

**Judge model fallback chain:** If `qwen2.5:14b` is not available, the system automatically tries `qwen2.5:32b` → `gemma2:27b` → `llama3.1` (in that order). You only need one of these installed.

**Model sizing guide:**

| Model | Size | RAM Needed | Quality | Speed |
|-------|------|-----------|---------|-------|
| `llama3.2:latest` | 2.0 GB | ~4 GB | Good (respondent) | Very fast |
| `llama3.1` | 4.9 GB | ~8 GB | Stronger respondent / fallback judge | Fast |
| `qwen2.5:14b` | 9.0 GB | ~12 GB | Strong (judge) | Moderate |
| `qwen2.5:32b` | 19 GB | ~24 GB | Best (judge) | Slow |
| `gemma2:27b` | 16 GB | ~20 GB | Good (judge) | Moderate |

### Step 4: Clone and install Python dependencies

```bash
git clone https://github.com/mohammedidriss/Scholarium.git
cd Scholarium

python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### Step 5: Run the application

```bash
python app.py
```

The browser opens automatically at **http://localhost:8080**.

## Usage

### Getting Started
1. Launch the app — you'll see the **Project Selection Screen**
2. Click **"+ New Project"** to create your first research project
3. Enter a project name and optional description
4. Click the project card to enter the workspace

### Working in a Project
1. **Upload PDFs** — click "Upload PDF" or drag-and-drop onto the chat input
2. **Ask questions** — type in the chat and press Send. The assistant retrieves relevant passages and generates an answer with citations
3. **View documents** — go to the Docs tab, click "View" to open the full-scroll reader
4. **Summarize** — click "Summarize" on a document to generate an AI summary with key findings
5. **Take notes** — use the Notes tab or the note bar in the document viewer
6. **Generate citations** — click "Cite" in the document viewer to get APA/IEEE/Harvard citations
7. **Literature matrix** — go to the Matrix tab and click "Generate" to compare all papers in a table
8. **Research journal** — use the Journal tab to log daily research activity

### Switching Projects
- Click **"← Projects"** in the top-left corner to return to the project selection screen
- Each project is completely isolated — documents, notes, history, and all data are separate

## Project Structure

```
Scholarium/
├── app.py                  # Flask server + all API routes (1,482 lines)
├── rag_pipeline.py         # RAG: PDF loading, chunking, embedding, ChromaDB retrieval
├── evaluator.py            # Orchestrates respondent + judge LLMs (per-project)
├── respondent.py           # Respondent LLM logic (llama3.2 via Ollama)
├── judge.py                # Judge LLM logic (qwen2.5:14b with fallback chain)
├── requirements.txt        # Python dependencies
├── templates/
│   └── index.html          # Web UI (project screen + workspace)
├── static/
│   ├── app.js              # Frontend logic (1,788 lines)
│   └── style.css           # Dark theme styles (1,970 lines)
├── projects/               # All project data (auto-created)
│   ├── projects.json       # Project registry
│   └── <project-id>/       # Per-project isolated data
│       ├── documents/      # PDF papers
│       ├── vectordb/       # ChromaDB vector store
│       ├── notes.json      # Research notes
│       ├── qa_log.json     # Q&A conversation history
│       ├── summaries.json  # AI-generated paper summaries
│       ├── highlights.json # Document highlights
│       ├── citations.json  # Extracted citation metadata
│       ├── journal.json    # Daily research journal
│       ├── reading_status.json
│       └── literature_matrix.json
└── README.md
```

## API Endpoints

All data routes are scoped under `/api/projects/<project_id>/`:

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/projects` | List all projects |
| POST | `/api/projects` | Create new project |
| PUT | `/api/projects/<id>` | Rename/update project |
| DELETE | `/api/projects/<id>` | Delete project and all data |
| POST | `/api/projects/<id>/query` | RAG query (ask a question) |
| GET | `/api/projects/<id>/documents` | List documents |
| POST | `/api/projects/<id>/upload` | Upload PDF |
| GET | `/api/projects/<id>/notes` | List notes |
| GET | `/api/projects/<id>/history` | Q&A history |
| GET | `/api/projects/<id>/summaries` | Document summaries |
| POST | `/api/projects/<id>/matrix/generate` | Generate literature matrix |
| GET | `/api/health` | System health check |
| POST | `/api/restart` | Restart server |

## Example Research Questions

- "What are the main contributions of this paper?"
- "Compare the methodologies used across these studies."
- "What limitations do the authors identify?"
- "Summarize the experimental results and their significance."
- "Who are the authors of this document?"
- "What future research directions are suggested?"

## Requirements

- Python 3.11+
- macOS (Apple Silicon recommended)
- Ollama running locally
- 8GB RAM minimum (16GB+ recommended for qwen2.5:14b judge model)

## Docker (All-in-One)

Scholarium ships with an all-in-one Docker image that bundles the Flask app, Python dependencies, the embedding model, and Ollama. LLMs are pulled into a Docker volume on first run (~14 GB, one time).

### Build

```bash
docker build -t scholarium .
```

### Run

```bash
docker run -d \
    --name scholarium \
    -p 8080:8080 \
    -v scholarium_data:/app/projects \
    -v scholarium_ollama:/root/.ollama \
    scholarium
```

Open http://localhost:8080 in your browser.

### What the volumes store

| Volume | Contents |
|---|---|
| `scholarium_data` | All your projects — documents, notes, Q&A history, summaries, manuscripts, vector DB. Survives container removal. |
| `scholarium_ollama` | Downloaded LLM models (`llama3.2:latest`, `qwen2.5:14b`). Avoids re-downloading on every rebuild. |

### Override models

```bash
docker run -d -p 8080:8080 \
    -e SCHOLARIUM_RESPONDENT=llama3.2 \
    -e SCHOLARIUM_JUDGE=gemma2:9b \
    -v scholarium_data:/app/projects \
    -v scholarium_ollama:/root/.ollama \
    scholarium
```

### Stopping and cleanup

```bash
docker stop scholarium
docker rm scholarium

# To delete ALL user data (projects + models):
docker volume rm scholarium_data scholarium_ollama
```

### Notes for Apple Silicon

The Linux container runs Ollama on CPU — you will not get Apple's Metal GPU acceleration inside the container. For the fastest inference on a Mac, run Ollama natively on the host and build a slimmer image that connects to it via `host.docker.internal:11434`. The current all-in-one image trades some speed for one-command portability.

## License

MIT
