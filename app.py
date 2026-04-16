"""Flask web server for the Multi-Project Research Assistant."""

import io
import json
import os
import shutil
import threading
import uuid
import webbrowser
from datetime import datetime

from flask import Flask, render_template, request, jsonify, send_file
from werkzeug.utils import secure_filename

from evaluator import get_evaluator, clear_evaluator_cache

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024  # 100 MB max upload

PROJECTS_DIR = os.path.join(os.path.dirname(__file__), "projects")
PROJECTS_FILE = os.path.join(PROJECTS_DIR, "projects.json")
ALLOWED_EXTENSIONS = {"pdf"}


# ---------------------------------------------------------------------------
# Generic JSON helpers
# ---------------------------------------------------------------------------

def _load_json(path, default=None):
    """Load JSON from path, returning default on any failure."""
    if default is None:
        default = []
    if not os.path.exists(path):
        return default
    try:
        with open(path, "r") as f:
            return json.load(f)
    except (json.JSONDecodeError, FileNotFoundError, OSError):
        return default


def _save_json(path, data):
    """Write data as JSON to path."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


# ---------------------------------------------------------------------------
# Project path helpers
# ---------------------------------------------------------------------------

def project_path(pid, filename):
    """Return absolute path for a file inside a project directory."""
    return os.path.join(PROJECTS_DIR, pid, filename)


def project_docs_dir(pid):
    """Return the documents directory for a project."""
    return os.path.join(PROJECTS_DIR, pid, "documents")


def _load_projects():
    """Load the master projects list."""
    return _load_json(PROJECTS_FILE, default=[])


def _save_projects(projects):
    """Persist the master projects list."""
    _save_json(PROJECTS_FILE, projects)


def _get_project(pid):
    """Find a project by id or return None."""
    for p in _load_projects():
        if p["id"] == pid:
            return p
    return None


def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


# ---------------------------------------------------------------------------
# Migration: move old single-project data into projects/<default_id>/
# ---------------------------------------------------------------------------

def _migrate_old_data():
    """If an old documents/ folder exists at project root, migrate it into a
    default project under the new multi-project structure."""
    base = os.path.dirname(__file__)
    old_docs = os.path.join(base, "documents")
    if not os.path.isdir(old_docs):
        return

    has_pdfs = any(f.lower().endswith(".pdf") for f in os.listdir(old_docs))
    if not has_pdfs:
        return

    pid = uuid.uuid4().hex[:12]
    now = datetime.now().isoformat()

    proj_dir = os.path.join(PROJECTS_DIR, pid)
    os.makedirs(proj_dir, exist_ok=True)

    # Move documents/
    shutil.move(old_docs, os.path.join(proj_dir, "documents"))

    # Move vectordb/ if it exists
    old_vectordb = os.path.join(base, "vectordb")
    if os.path.isdir(old_vectordb):
        shutil.move(old_vectordb, os.path.join(proj_dir, "vectordb"))

    # Move JSON data files
    json_files = [
        "notes.json", "summaries.json", "reading_status.json",
        "highlights.json", "citations.json", "collections.json",
        "journal.json", "literature_matrix.json", "qa_log.json",
    ]
    for jf in json_files:
        old_path = os.path.join(base, jf)
        if os.path.exists(old_path):
            shutil.move(old_path, os.path.join(proj_dir, jf))

    # Register the new project
    projects = _load_projects()
    projects.append({
        "id": pid,
        "name": "Default Project",
        "description": "Migrated from single-project layout",
        "created_at": now,
        "updated_at": now,
    })
    _save_projects(projects)
    print(f"  Migrated old data into project '{pid}' (Default Project)")


# ===========================================================================
# GLOBAL ROUTES
# ===========================================================================

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/health", methods=["GET"])
def health():
    """Check health of all system services."""
    import sys
    import platform
    import flask as fl
    import requests as req

    services = []

    # 1. Python
    services.append({
        "name": "Python",
        "status": "ok",
        "detail": f"{sys.version.split()[0]} ({platform.machine()})",
    })

    # 2. Flask
    services.append({
        "name": "Flask",
        "status": "ok",
        "detail": f"v{fl.__version__} on port 8080",
    })

    # 3. Ollama server
    try:
        r = req.get("http://localhost:11434/api/tags", timeout=3)
        r.raise_for_status()
        models_data = r.json()
        available_models = [m["name"] for m in models_data.get("models", [])]
        available_base = [m["name"].split(":")[0] for m in models_data.get("models", [])]
        model_count = len(models_data.get("models", []))
        services.append({"name": "Ollama", "status": "ok", "detail": f"Running ({model_count} models)"})
    except Exception:
        available_models = []
        available_base = []
        services.append({"name": "Ollama", "status": "error", "detail": "Not reachable"})

    # 4. Respondent model
    from respondent import MODEL as RESP_MODEL
    if RESP_MODEL in available_models or RESP_MODEL in available_base or f"{RESP_MODEL}:latest" in available_models:
        services.append({"name": "Respondent LLM", "status": "ok", "detail": RESP_MODEL})
    else:
        services.append({"name": "Respondent LLM", "status": "error", "detail": f"{RESP_MODEL} not found"})

    # 5. Judge model
    from judge import _get_available_model
    judge_model = _get_available_model()
    if judge_model:
        services.append({"name": "Judge LLM", "status": "ok", "detail": judge_model})
    else:
        services.append({"name": "Judge LLM", "status": "error", "detail": "No judge model"})

    # 6. Embeddings
    services.append({"name": "Embeddings", "status": "ok", "detail": "all-MiniLM-L6-v2"})

    # 7. Total projects count
    projects = _load_projects()
    services.append({
        "name": "Projects",
        "status": "ok",
        "detail": f"{len(projects)} project(s)",
    })

    return jsonify(services)


@app.route("/api/restart", methods=["POST"])
def restart_server():
    """Restart the Flask server by re-executing the process."""
    import sys
    import signal

    def _restart():
        import time
        import subprocess
        time.sleep(1.5)
        subprocess.Popen(
            [sys.executable] + sys.argv,
            cwd=os.path.dirname(os.path.abspath(__file__)),
        )
        os._exit(0)

    threading.Thread(target=_restart, daemon=True).start()
    return jsonify({"success": True, "message": "Restarting..."})


# ===========================================================================
# PROJECT MANAGEMENT ROUTES
# ===========================================================================

@app.route("/api/projects", methods=["GET"])
def list_projects():
    """List all projects."""
    return jsonify(_load_projects())


@app.route("/api/projects", methods=["POST"])
def create_project():
    """Create a new project with directory structure."""
    data = request.get_json() or {}
    if not data.get("name", "").strip():
        return jsonify({"error": "Project name is required"}), 400

    pid = uuid.uuid4().hex[:12]
    now = datetime.now().isoformat()

    proj = {
        "id": pid,
        "name": data["name"].strip(),
        "description": data.get("description", "").strip(),
        "created_at": now,
        "updated_at": now,
    }

    # Create directory structure
    os.makedirs(os.path.join(PROJECTS_DIR, pid, "documents"), exist_ok=True)

    projects = _load_projects()
    projects.append(proj)
    _save_projects(projects)
    return jsonify(proj), 201


@app.route("/api/projects/<pid>", methods=["PUT"])
def update_project(pid):
    """Update project name and/or description."""
    data = request.get_json() or {}
    projects = _load_projects()
    for p in projects:
        if p["id"] == pid:
            if "name" in data:
                p["name"] = data["name"].strip()
            if "description" in data:
                p["description"] = data["description"].strip()
            p["updated_at"] = datetime.now().isoformat()
            _save_projects(projects)
            return jsonify(p)
    return jsonify({"error": "Project not found"}), 404


@app.route("/api/projects/<pid>", methods=["DELETE"])
def delete_project(pid):
    """Delete a project, its directory, and clear evaluator cache."""
    projects = _load_projects()
    filtered = [p for p in projects if p["id"] != pid]
    if len(filtered) == len(projects):
        return jsonify({"error": "Project not found"}), 404

    # Remove project directory
    proj_dir = os.path.join(PROJECTS_DIR, pid)
    if os.path.isdir(proj_dir):
        shutil.rmtree(proj_dir)

    # Clear evaluator cache for this project
    clear_evaluator_cache(pid)

    _save_projects(filtered)
    return jsonify({"success": True, "message": f"Project {pid} deleted"})


# ===========================================================================
# PROJECT-SCOPED DATA ROUTES
# ===========================================================================

# --- Query ---

@app.route("/api/projects/<pid>/query", methods=["POST"])
def project_query(pid):
    """Process a user question through the full RAG pipeline for a project."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    data = request.get_json()
    if not data or not data.get("question", "").strip():
        return jsonify({"error": "No question provided"}), 400

    question = data["question"].strip()
    ev = get_evaluator(pid)
    result = ev.process_query(question)
    return jsonify(result)


# --- Parse PDF ---

@app.route("/api/projects/<pid>/parse-pdf", methods=["POST"])
def project_parse_pdf(pid):
    """Extract text content from an uploaded PDF."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files["file"]
    if file.filename == "" or not allowed_file(file.filename):
        return jsonify({"error": "Only PDF files are allowed"}), 400

    import fitz
    import tempfile
    try:
        pdf_bytes = file.read()
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            tmp.write(pdf_bytes)
            tmp_path = tmp.name
        doc = fitz.open(tmp_path)
        page_count = len(doc)
        text = ""
        for page in doc:
            text += page.get_text()
        doc.close()
        os.unlink(tmp_path)
        return jsonify({
            "success": True,
            "filename": file.filename,
            "text": text.strip(),
            "page_count": page_count,
        })
    except Exception as e:
        return jsonify({"error": f"Failed to parse PDF: {str(e)}"}), 400


# --- Upload ---

@app.route("/api/projects/<pid>/upload", methods=["POST"])
def project_upload(pid):
    """Upload and index a PDF document into a project."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "No file selected"}), 400

    if not allowed_file(file.filename):
        return jsonify({"error": "Only PDF files are allowed"}), 400

    filename = secure_filename(file.filename)
    docs_dir = project_docs_dir(pid)
    os.makedirs(docs_dir, exist_ok=True)
    filepath = os.path.join(docs_dir, filename)
    file.save(filepath)

    ev = get_evaluator(pid)
    chunks_added = ev.index_single_document(filepath)
    return jsonify({
        "success": True,
        "filename": filename,
        "chunks_added": chunks_added,
        "message": f"Indexed {filename}: {chunks_added} chunks added"
            if chunks_added > 0
            else f"{filename} was already indexed",
    })


# --- Index ---

@app.route("/api/projects/<pid>/index", methods=["POST"])
def project_reindex(pid):
    """Re-index all documents in a project."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    ev = get_evaluator(pid)
    result = ev.index_documents()
    return jsonify(result)


# --- Status ---

@app.route("/api/projects/<pid>/status", methods=["GET"])
def project_status(pid):
    """Get current status for a project (doc count, chunk count)."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    ev = get_evaluator(pid)
    return jsonify(ev.get_status())


# --- Documents ---

@app.route("/api/projects/<pid>/documents", methods=["GET"])
def project_list_documents(pid):
    """List all PDF documents with metadata for a project."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    import fitz
    docs_dir = project_docs_dir(pid)
    if not os.path.isdir(docs_dir):
        return jsonify([])

    docs = []
    for fname in sorted(os.listdir(docs_dir)):
        if not fname.lower().endswith(".pdf"):
            continue
        fpath = os.path.join(docs_dir, fname)
        size = os.path.getsize(fpath)
        pages = 0
        word_count = 0
        try:
            d = fitz.open(fpath)
            pages = len(d)
            for p in d:
                word_count += len(p.get_text().split())
            d.close()
        except Exception:
            pass
        reading_min = max(1, round(word_count / 250))
        docs.append({
            "filename": fname,
            "size_bytes": size,
            "size_display": f"{size / 1024:.0f} KB" if size < 1048576 else f"{size / 1048576:.1f} MB",
            "pages": pages,
            "word_count": word_count,
            "reading_time": f"{reading_min} min read",
        })
    return jsonify(docs)


@app.route("/api/projects/<pid>/documents/<filename>/text", methods=["GET"])
def project_document_text(pid, filename):
    """Return extracted text from a PDF, split by page."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    import fitz
    fpath = os.path.join(project_docs_dir(pid), secure_filename(filename))
    if not os.path.exists(fpath):
        return jsonify({"error": "Document not found"}), 404
    try:
        doc = fitz.open(fpath)
        pages = []
        for i, page in enumerate(doc):
            pages.append({"page": i + 1, "text": page.get_text()})
        doc.close()
        return jsonify({"filename": filename, "pages": pages, "total_pages": len(pages)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/projects/<pid>/documents/<filename>/download", methods=["GET"])
def project_document_download(pid, filename):
    """Serve a PDF file for download."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    fpath = os.path.join(project_docs_dir(pid), secure_filename(filename))
    if not os.path.exists(fpath):
        return jsonify({"error": "Document not found"}), 404
    return send_file(fpath, mimetype="application/pdf", as_attachment=True, download_name=filename)


@app.route("/api/projects/<pid>/documents/<filename>", methods=["DELETE"])
def project_delete_document(pid, filename):
    """Delete a document and re-index the project."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    fpath = os.path.join(project_docs_dir(pid), secure_filename(filename))
    if not os.path.exists(fpath):
        return jsonify({"error": "Document not found"}), 404
    os.remove(fpath)

    ev = get_evaluator(pid)
    ev.rag.clear_index()
    ev.index_documents()
    return jsonify({"success": True, "message": f"Deleted {filename} and re-indexed"})


# --- Summaries ---

@app.route("/api/projects/<pid>/documents/<filename>/summarize", methods=["POST"])
def project_summarize_document(pid, filename):
    """Generate a summary + key findings for a document using the respondent LLM."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    import fitz
    import requests as req

    fpath = os.path.join(project_docs_dir(pid), secure_filename(filename))
    if not os.path.exists(fpath):
        return jsonify({"error": "Document not found"}), 404

    # Check cache
    force = request.args.get("force", "").lower() == "true"
    summaries_path = project_path(pid, "summaries.json")
    summaries = _load_json(summaries_path, default={})
    if filename in summaries and not force:
        return jsonify(summaries[filename])

    # Extract first ~4 pages of text
    try:
        doc = fitz.open(fpath)
        text = ""
        for i, page in enumerate(doc):
            if i >= 4:
                break
            text += page.get_text()
        doc.close()
    except Exception as e:
        return jsonify({"error": f"Failed to read PDF: {e}"}), 500

    text = text[:8000]

    prompt = (
        f"Analyze the following academic paper excerpt and provide:\n"
        f"1. A concise SUMMARY (3-5 sentences covering the paper's purpose, methodology, and conclusions)\n"
        f"2. KEY FINDINGS (3-6 bullet points of the most important results/contributions)\n"
        f"3. METHODOLOGY (1-2 sentences on the research approach)\n\n"
        f"Format your response EXACTLY as:\n"
        f"SUMMARY:\n<summary text>\n\n"
        f"KEY FINDINGS:\n- <finding 1>\n- <finding 2>\n...\n\n"
        f"METHODOLOGY:\n<methodology text>\n\n"
        f"--- DOCUMENT TEXT ---\n{text}"
    )

    try:
        from respondent import MODEL, OLLAMA_URL
        response = req.post(
            OLLAMA_URL,
            json={
                "model": MODEL,
                "prompt": prompt,
                "system": "You are an academic paper analyst. Provide structured analysis.",
                "stream": False,
                "options": {"temperature": 0.2, "num_predict": 1024},
            },
            timeout=300,
        )
        response.raise_for_status()
        raw = response.json().get("response", "").strip()

        result = {
            "filename": filename,
            "raw": raw,
            "summary": "",
            "key_findings": [],
            "methodology": "",
            "generated_at": datetime.now().isoformat(),
        }

        current = ""
        for line in raw.split("\n"):
            if line.strip().upper().startswith("SUMMARY"):
                current = "summary"
                continue
            elif line.strip().upper().startswith("KEY FINDINGS"):
                current = "findings"
                continue
            elif line.strip().upper().startswith("METHODOLOGY"):
                current = "methodology"
                continue

            if current == "summary":
                result["summary"] += line + " "
            elif current == "findings" and line.strip().startswith("-"):
                result["key_findings"].append(line.strip()[1:].strip())
            elif current == "methodology":
                result["methodology"] += line + " "

        result["summary"] = result["summary"].strip()
        result["methodology"] = result["methodology"].strip()
        if not result["summary"]:
            result["summary"] = raw[:500]

        summaries[filename] = result
        _save_json(summaries_path, summaries)

        return jsonify(result)

    except Exception as e:
        return jsonify({"error": f"Summarization failed: {str(e)}"}), 500


@app.route("/api/projects/<pid>/summaries", methods=["GET"])
def project_get_summaries(pid):
    """Return all cached document summaries for a project."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    summaries_path = project_path(pid, "summaries.json")
    return jsonify(_load_json(summaries_path, default={}))


# --- Notes ---

@app.route("/api/projects/<pid>/notes", methods=["GET"])
def project_get_notes(pid):
    """Return all notes for a project, most recent first."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    notes_path = project_path(pid, "notes.json")
    notes = _load_json(notes_path, default=[])
    notes.sort(key=lambda n: n.get("updated_at", ""), reverse=True)
    return jsonify(notes)


@app.route("/api/projects/<pid>/notes", methods=["POST"])
def project_create_note(pid):
    """Create a new note in a project."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    data = request.get_json() or {}
    now = datetime.now().isoformat()
    note = {
        "id": uuid.uuid4().hex[:12],
        "title": data.get("title", "Untitled Note"),
        "content": data.get("content", ""),
        "created_at": now,
        "updated_at": now,
    }
    notes_path = project_path(pid, "notes.json")
    notes = _load_json(notes_path, default=[])
    notes.append(note)
    _save_json(notes_path, notes)
    return jsonify(note), 201


@app.route("/api/projects/<pid>/notes/<nid>", methods=["PUT"])
def project_update_note(pid, nid):
    """Update an existing note."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    data = request.get_json() or {}
    notes_path = project_path(pid, "notes.json")
    notes = _load_json(notes_path, default=[])
    for note in notes:
        if note["id"] == nid:
            if "title" in data:
                note["title"] = data["title"]
            if "content" in data:
                note["content"] = data["content"]
            note["updated_at"] = datetime.now().isoformat()
            _save_json(notes_path, notes)
            return jsonify(note)
    return jsonify({"error": "Note not found"}), 404


@app.route("/api/projects/<pid>/notes/<nid>", methods=["DELETE"])
def project_delete_note(pid, nid):
    """Delete a note."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    notes_path = project_path(pid, "notes.json")
    notes = _load_json(notes_path, default=[])
    filtered = [n for n in notes if n["id"] != nid]
    if len(filtered) == len(notes):
        return jsonify({"error": "Note not found"}), 404
    _save_json(notes_path, filtered)
    return jsonify({"success": True})


@app.route("/api/projects/<pid>/notes/<nid>/export", methods=["GET"])
def project_export_note(pid, nid):
    """Export a note as PDF or DOCX."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    fmt = request.args.get("format", "pdf").lower()
    notes_path = project_path(pid, "notes.json")
    notes = _load_json(notes_path, default=[])
    note = next((n for n in notes if n["id"] == nid), None)
    if note is None:
        return jsonify({"error": "Note not found"}), 404

    if fmt == "pdf":
        return _export_pdf(note)
    elif fmt == "docx":
        return _export_docx(note)
    else:
        return jsonify({"error": "Unsupported format. Use 'pdf' or 'docx'."}), 400


# --- History ---

@app.route("/api/projects/<pid>/history", methods=["GET"])
def project_get_history(pid):
    """Return all past Q&A entries for a project."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    qa_path = project_path(pid, "qa_log.json")
    history = _load_json(qa_path, default=[])
    history.reverse()
    return jsonify(history)


@app.route("/api/projects/<pid>/history", methods=["DELETE"])
def project_clear_history(pid):
    """Clear all conversation history for a project."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    qa_path = project_path(pid, "qa_log.json")
    _save_json(qa_path, [])
    return jsonify({"success": True})


# --- Reading Status ---

@app.route("/api/projects/<pid>/reading-status", methods=["GET"])
def project_get_reading_status(pid):
    """Return reading status for all documents in a project."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    rs_path = project_path(pid, "reading_status.json")
    return jsonify(_load_json(rs_path, default={}))


@app.route("/api/projects/<pid>/reading-status/<filename>", methods=["PUT"])
def project_update_reading_status(pid, filename):
    """Update reading status and/or progress for a document."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    data = request.get_json() or {}
    rs_path = project_path(pid, "reading_status.json")
    statuses = _load_json(rs_path, default={})
    entry = statuses.get(filename, {"status": "unread", "progress_pct": 0, "last_opened": None})

    if "status" in data:
        if data["status"] not in ("unread", "reading", "reviewed"):
            return jsonify({"error": "Invalid status. Must be unread, reading, or reviewed."}), 400
        entry["status"] = data["status"]
    if "progress_pct" in data:
        pct = data["progress_pct"]
        if not isinstance(pct, (int, float)) or pct < 0 or pct > 100:
            return jsonify({"error": "progress_pct must be a number between 0 and 100."}), 400
        entry["progress_pct"] = pct
    entry["last_opened"] = datetime.now().isoformat()

    statuses[filename] = entry
    _save_json(rs_path, statuses)
    return jsonify(entry)


# --- Highlights ---

@app.route("/api/projects/<pid>/highlights/<filename>", methods=["GET"])
def project_get_highlights(pid, filename):
    """Get all highlights for a document in a project."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    hl_path = project_path(pid, "highlights.json")
    highlights = _load_json(hl_path, default={})
    return jsonify(highlights.get(filename, []))


@app.route("/api/projects/<pid>/highlights/<filename>", methods=["POST"])
def project_add_highlight(pid, filename):
    """Add a highlight to a document."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    data = request.get_json() or {}
    if not data.get("text"):
        return jsonify({"error": "Highlight text is required."}), 400
    if "page" not in data:
        return jsonify({"error": "Page number is required."}), 400

    highlight = {
        "id": uuid.uuid4().hex[:12],
        "text": data["text"],
        "page": data["page"],
        "created_at": datetime.now().isoformat(),
    }

    hl_path = project_path(pid, "highlights.json")
    highlights = _load_json(hl_path, default={})
    if filename not in highlights:
        highlights[filename] = []
    highlights[filename].append(highlight)
    _save_json(hl_path, highlights)
    return jsonify(highlight), 201


@app.route("/api/projects/<pid>/highlights/<filename>/<hid>", methods=["DELETE"])
def project_delete_highlight(pid, filename, hid):
    """Remove a highlight from a document."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    hl_path = project_path(pid, "highlights.json")
    highlights = _load_json(hl_path, default={})
    if filename not in highlights:
        return jsonify({"error": "No highlights found for this document."}), 404
    original_len = len(highlights[filename])
    highlights[filename] = [h for h in highlights[filename] if h["id"] != hid]
    if len(highlights[filename]) == original_len:
        return jsonify({"error": "Highlight not found."}), 404
    _save_json(hl_path, highlights)
    return jsonify({"success": True})


# --- Citations ---

@app.route("/api/projects/<pid>/citations/<filename>/generate", methods=["POST"])
def project_generate_citation(pid, filename):
    """Extract citation metadata from first page via LLM."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    import fitz
    import requests as req

    fpath = os.path.join(project_docs_dir(pid), secure_filename(filename))
    if not os.path.exists(fpath):
        return jsonify({"error": "Document not found"}), 404

    force = request.args.get("force", "").lower() == "true"
    cit_path = project_path(pid, "citations.json")
    citations = _load_json(cit_path, default={})
    if filename in citations and not force:
        return jsonify(citations[filename])

    try:
        doc = fitz.open(fpath)
        text = doc[0].get_text() if len(doc) > 0 else ""
        doc.close()
    except Exception as e:
        return jsonify({"error": f"Failed to read PDF: {e}"}), 500

    text = text[:4000]

    prompt = (
        "Extract the following metadata from this academic paper text. "
        "Respond in JSON format with these exact keys: "
        "title, authors (as a list of strings), year (as a string), source_info (journal or conference name).\n\n"
        "Extract: title, authors (list), year, journal/conference from this text:\n\n"
        f"{text}"
    )

    try:
        from respondent import MODEL, OLLAMA_URL
        response = req.post(
            OLLAMA_URL,
            json={
                "model": MODEL,
                "prompt": prompt,
                "system": "You are a metadata extractor. Return valid JSON only.",
                "stream": False,
                "options": {"temperature": 0.1, "num_predict": 512},
            },
            timeout=120,
        )
        response.raise_for_status()
        raw = response.json().get("response", "").strip()

        import re
        json_match = re.search(r'\{[^{}]*\}', raw, re.DOTALL)
        if json_match:
            metadata = json.loads(json_match.group())
        else:
            metadata = json.loads(raw)

        entry = {
            "title": metadata.get("title", ""),
            "authors": metadata.get("authors", []),
            "year": str(metadata.get("year", "")),
            "source_info": metadata.get("source_info", ""),
            "generated_at": datetime.now().isoformat(),
        }

        citations[filename] = entry
        _save_json(cit_path, citations)
        return jsonify(entry)

    except Exception as e:
        return jsonify({"error": f"Citation extraction failed: {str(e)}"}), 500


@app.route("/api/projects/<pid>/citations/<filename>/format", methods=["GET"])
def project_format_citation(pid, filename):
    """Return a formatted citation string in the requested style."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    style = request.args.get("style", "apa").lower()
    cit_path = project_path(pid, "citations.json")
    citations = _load_json(cit_path, default={})
    if filename not in citations:
        return jsonify({"error": "No citation data found. Generate citation first."}), 404

    entry = citations[filename]
    title = entry.get("title", "Untitled")
    authors = entry.get("authors", [])
    year = entry.get("year", "n.d.")
    source = entry.get("source_info", "")

    authors_str = ", ".join(authors) if authors else "Unknown"

    if style == "apa":
        formatted = f"{authors_str} ({year}). {title}. {source}."
    elif style == "ieee":
        formatted = f'{authors_str}, "{title}," {source}, {year}.'
    elif style == "harvard":
        formatted = f"{authors_str} ({year}) '{title}', {source}."
    else:
        return jsonify({"error": "Unsupported style. Use apa, ieee, or harvard."}), 400

    return jsonify({"style": style, "citation": formatted})


# --- Collections ---

@app.route("/api/projects/<pid>/collections", methods=["GET"])
def project_get_collections(pid):
    """List all collections for a project."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    col_path = project_path(pid, "collections.json")
    return jsonify(_load_json(col_path, default=[]))


@app.route("/api/projects/<pid>/collections", methods=["POST"])
def project_create_collection(pid):
    """Create a new collection in a project."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    data = request.get_json() or {}
    if not data.get("name"):
        return jsonify({"error": "Collection name is required."}), 400

    now = datetime.now().isoformat()
    collection = {
        "id": uuid.uuid4().hex[:12],
        "name": data["name"],
        "documents": data.get("documents", []),
        "created_at": now,
        "updated_at": now,
    }

    col_path = project_path(pid, "collections.json")
    collections = _load_json(col_path, default=[])
    collections.append(collection)
    _save_json(col_path, collections)
    return jsonify(collection), 201


@app.route("/api/projects/<pid>/collections/<cid>", methods=["PUT"])
def project_update_collection(pid, cid):
    """Update a collection."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    data = request.get_json() or {}
    col_path = project_path(pid, "collections.json")
    collections = _load_json(col_path, default=[])
    for col in collections:
        if col["id"] == cid:
            if "name" in data:
                col["name"] = data["name"]
            if "documents" in data:
                col["documents"] = data["documents"]
            col["updated_at"] = datetime.now().isoformat()
            _save_json(col_path, collections)
            return jsonify(col)
    return jsonify({"error": "Collection not found"}), 404


@app.route("/api/projects/<pid>/collections/<cid>", methods=["DELETE"])
def project_delete_collection(pid, cid):
    """Delete a collection."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    col_path = project_path(pid, "collections.json")
    collections = _load_json(col_path, default=[])
    filtered = [c for c in collections if c["id"] != cid]
    if len(filtered) == len(collections):
        return jsonify({"error": "Collection not found"}), 404
    _save_json(col_path, filtered)
    return jsonify({"success": True})


# --- Journal ---

def _compute_today_stats(pid):
    """Compute auto_stats for today by counting Q&A log entries and reading status."""
    today_str = datetime.now().strftime("%Y-%m-%d")
    qa_count = 0
    qa_path = project_path(pid, "qa_log.json")
    qa_log = _load_json(qa_path, default=[])
    for entry in qa_log:
        ts = entry.get("timestamp", "")
        if ts.startswith(today_str):
            qa_count += 1

    docs_viewed = []
    rs_path = project_path(pid, "reading_status.json")
    statuses = _load_json(rs_path, default={})
    for fname, info in statuses.items():
        last_opened = info.get("last_opened", "")
        if last_opened and last_opened.startswith(today_str):
            docs_viewed.append(fname)

    return {"qa_count": qa_count, "docs_viewed": docs_viewed}


@app.route("/api/projects/<pid>/journal", methods=["GET"])
def project_get_journal(pid):
    """Return all journal entries for a project, newest first."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    j_path = project_path(pid, "journal.json")
    entries = _load_json(j_path, default=[])
    entries.sort(key=lambda e: e.get("created_at", ""), reverse=True)
    return jsonify(entries)


@app.route("/api/projects/<pid>/journal/today", methods=["GET"])
def project_get_journal_today(pid):
    """Get or create today's journal entry with auto-populated stats."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    today_str = datetime.now().strftime("%Y-%m-%d")
    j_path = project_path(pid, "journal.json")
    entries = _load_json(j_path, default=[])

    for entry in entries:
        if entry.get("date") == today_str:
            entry["auto_stats"] = _compute_today_stats(pid)
            _save_json(j_path, entries)
            return jsonify(entry)

    now = datetime.now().isoformat()
    entry = {
        "id": uuid.uuid4().hex[:12],
        "date": today_str,
        "content": "",
        "auto_stats": _compute_today_stats(pid),
        "created_at": now,
        "updated_at": now,
    }
    entries.append(entry)
    _save_json(j_path, entries)
    return jsonify(entry)


@app.route("/api/projects/<pid>/journal/<jid>", methods=["PUT"])
def project_update_journal(pid, jid):
    """Update a journal entry's content."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    data = request.get_json() or {}
    j_path = project_path(pid, "journal.json")
    entries = _load_json(j_path, default=[])
    for entry in entries:
        if entry["id"] == jid:
            if "content" in data:
                entry["content"] = data["content"]
            entry["updated_at"] = datetime.now().isoformat()
            _save_json(j_path, entries)
            return jsonify(entry)
    return jsonify({"error": "Journal entry not found"}), 404


# --- Literature Matrix ---

@app.route("/api/projects/<pid>/matrix", methods=["GET"])
def project_get_matrix(pid):
    """Return the cached literature matrix for a project."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    m_path = project_path(pid, "literature_matrix.json")
    return jsonify(_load_json(m_path, default={"generated_at": None, "entries": []}))


@app.route("/api/projects/<pid>/matrix/generate", methods=["POST"])
def project_generate_matrix(pid):
    """Generate literature matrix entries for documents not yet analyzed."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    import fitz
    import requests as req

    m_path = project_path(pid, "literature_matrix.json")
    matrix = _load_json(m_path, default={"generated_at": None, "entries": []})
    existing_filenames = {e["filename"] for e in matrix["entries"]}

    docs_dir = project_docs_dir(pid)
    docs_to_process = []
    if os.path.isdir(docs_dir):
        for fname in sorted(os.listdir(docs_dir)):
            if not fname.lower().endswith(".pdf"):
                continue
            if fname not in existing_filenames:
                docs_to_process.append(fname)

    if not docs_to_process:
        return jsonify({"message": "All documents already in matrix.", "matrix": matrix})

    from respondent import MODEL, OLLAMA_URL
    new_entries = []
    errors = []

    for fname in docs_to_process:
        fpath = os.path.join(docs_dir, fname)

        try:
            doc = fitz.open(fpath)
            text = ""
            for i, page in enumerate(doc):
                if i >= 4:
                    break
                text += page.get_text()
            doc.close()
        except Exception as e:
            errors.append({"filename": fname, "error": f"Failed to read PDF: {e}"})
            continue

        text = text[:8000]

        prompt = (
            "Extract the following metadata from this academic paper text. "
            "Respond in JSON format with these exact keys: "
            "title (string), year (string), methodology (string, brief description of research method), "
            "findings (string, key findings summary), sample_size (string, e.g. 'N=150' or 'N/A' if not applicable).\n\n"
            f"--- DOCUMENT TEXT ---\n{text}"
        )

        try:
            response = req.post(
                OLLAMA_URL,
                json={
                    "model": MODEL,
                    "prompt": prompt,
                    "system": "You are an academic paper metadata extractor. Return valid JSON only.",
                    "stream": False,
                    "options": {"temperature": 0.1, "num_predict": 512},
                },
                timeout=180,
            )
            response.raise_for_status()
            raw = response.json().get("response", "").strip()

            import re
            json_match = re.search(r'\{[^{}]*\}', raw, re.DOTALL)
            if json_match:
                metadata = json.loads(json_match.group())
            else:
                metadata = json.loads(raw)

            entry = {
                "filename": fname,
                "title": metadata.get("title", ""),
                "year": str(metadata.get("year", "")),
                "methodology": metadata.get("methodology", ""),
                "findings": metadata.get("findings", ""),
                "sample_size": metadata.get("sample_size", ""),
            }
            new_entries.append(entry)

        except Exception as e:
            errors.append({"filename": fname, "error": str(e)})

    matrix["entries"].extend(new_entries)
    matrix["generated_at"] = datetime.now().isoformat()
    _save_json(m_path, matrix)

    return jsonify({
        "message": f"Processed {len(new_entries)} documents, {len(errors)} errors.",
        "new_entries": new_entries,
        "errors": errors,
        "matrix": matrix,
    })


# --- Answer Export ---

@app.route("/api/projects/<pid>/answer/export", methods=["POST"])
def project_export_answer(pid):
    """Export a Q&A answer as PDF or DOCX."""
    if not _get_project(pid):
        return jsonify({"error": "Project not found"}), 404

    data = request.get_json() or {}
    fmt = data.get("format", "pdf").lower()
    question = data.get("question", "")
    answer = data.get("answer", "")
    scores = data.get("scores", {})
    model = data.get("model", "")
    timestamp = data.get("timestamp", "")

    if not answer:
        return jsonify({"error": "No answer to export"}), 400

    if fmt == "pdf":
        return _export_answer_pdf(question, answer, scores, model, timestamp)
    elif fmt == "docx":
        return _export_answer_docx(question, answer, scores, model, timestamp)
    else:
        return jsonify({"error": "Unsupported format. Use 'pdf' or 'docx'."}), 400


# ===========================================================================
# Export helper functions
# ===========================================================================

def _export_pdf(note: dict):
    from fpdf import FPDF

    pdf = FPDF()
    pdf.add_page()
    pdf.set_auto_page_break(auto=True, margin=20)

    # Title
    pdf.set_font("Helvetica", "B", 18)
    pdf.cell(0, 12, note["title"], new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)

    # Date
    pdf.set_font("Helvetica", "", 10)
    pdf.set_text_color(120, 120, 120)
    created = note.get("created_at", "")[:19].replace("T", " ")
    pdf.cell(0, 6, f"Created: {created}", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(6)

    # Content
    pdf.set_text_color(0, 0, 0)
    pdf.set_font("Helvetica", "", 12)
    content = note["content"].encode("latin-1", "replace").decode("latin-1")
    pdf.multi_cell(0, 7, content)

    buf = io.BytesIO()
    pdf.output(buf)
    buf.seek(0)

    filename = f"{note['title'][:50].replace(' ', '_')}.pdf"
    return send_file(buf, mimetype="application/pdf", as_attachment=True,
                     download_name=filename)


def _export_docx(note: dict):
    from docx import Document
    from docx.shared import Pt, RGBColor

    doc = Document()

    # Title
    doc.add_heading(note["title"], level=1)

    # Date
    date_para = doc.add_paragraph()
    created = note.get("created_at", "")[:19].replace("T", " ")
    run = date_para.add_run(f"Created: {created}")
    run.font.size = Pt(10)
    run.font.color.rgb = RGBColor(120, 120, 120)

    # Content
    for paragraph_text in note["content"].split("\n"):
        doc.add_paragraph(paragraph_text)

    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)

    filename = f"{note['title'][:50].replace(' ', '_')}.docx"
    return send_file(
        buf,
        mimetype="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        as_attachment=True,
        download_name=filename,
    )


def _export_answer_pdf(question, answer, scores, model, timestamp):
    from fpdf import FPDF

    pdf = FPDF()
    pdf.add_page()
    pdf.set_auto_page_break(auto=True, margin=20)

    # Title
    pdf.set_font("Helvetica", "B", 16)
    pdf.cell(0, 10, "Research Assistant - Q&A Export", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)

    # Metadata
    pdf.set_font("Helvetica", "", 9)
    pdf.set_text_color(120, 120, 120)
    if timestamp:
        pdf.cell(0, 5, f"Date: {timestamp[:19].replace('T', ' ')}", new_x="LMARGIN", new_y="NEXT")
    if model:
        pdf.cell(0, 5, f"Model: {model}", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)

    # Question
    pdf.set_text_color(0, 0, 0)
    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 8, "Question:", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 12)
    q_text = question.encode("latin-1", "replace").decode("latin-1")
    pdf.multi_cell(0, 7, q_text)
    pdf.ln(4)

    # Answer
    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 8, "Answer:", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 11)
    a_text = answer.encode("latin-1", "replace").decode("latin-1")
    pdf.multi_cell(0, 6, a_text)
    pdf.ln(4)

    # Scores
    if scores:
        pdf.set_font("Helvetica", "B", 12)
        pdf.cell(0, 8, "Evaluation Scores:", new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 10)
        for dim, sdata in scores.items():
            if isinstance(sdata, dict):
                score_val = sdata.get("score", "N/A")
                explanation = sdata.get("explanation", "")
                label = dim.replace("_", " ").title()
                pct = f"{int(float(score_val) * 100)}%" if isinstance(score_val, (int, float)) else str(score_val)
                line = f"{label}: {pct} - {explanation}"
                line = line.encode("latin-1", "replace").decode("latin-1")
                pdf.multi_cell(0, 6, line)
                pdf.ln(1)

    buf = io.BytesIO()
    pdf.output(buf)
    buf.seek(0)
    return send_file(buf, mimetype="application/pdf", as_attachment=True,
                     download_name="research_answer.pdf")


def _export_answer_docx(question, answer, scores, model, timestamp):
    from docx import Document
    from docx.shared import Pt, RGBColor

    doc = Document()
    doc.add_heading("Research Assistant - Q&A Export", level=1)

    # Metadata
    if timestamp or model:
        meta = doc.add_paragraph()
        if timestamp:
            run = meta.add_run(f"Date: {timestamp[:19].replace('T', ' ')}   ")
            run.font.size = Pt(9)
            run.font.color.rgb = RGBColor(120, 120, 120)
        if model:
            run = meta.add_run(f"Model: {model}")
            run.font.size = Pt(9)
            run.font.color.rgb = RGBColor(120, 120, 120)

    # Question
    doc.add_heading("Question", level=2)
    doc.add_paragraph(question)

    # Answer
    doc.add_heading("Answer", level=2)
    for para in answer.split("\n"):
        doc.add_paragraph(para)

    # Scores
    if scores:
        doc.add_heading("Evaluation Scores", level=2)
        for dim, sdata in scores.items():
            if isinstance(sdata, dict):
                score_val = sdata.get("score", "N/A")
                explanation = sdata.get("explanation", "")
                label = dim.replace("_", " ").title()
                pct = f"{int(float(score_val) * 100)}%" if isinstance(score_val, (int, float)) else str(score_val)
                p = doc.add_paragraph()
                run = p.add_run(f"{label}: {pct}")
                run.bold = True
                p.add_run(f" - {explanation}")

    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)
    return send_file(
        buf,
        mimetype="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        as_attachment=True,
        download_name="research_answer.docx",
    )


# ===========================================================================
# Startup
# ===========================================================================

def open_browser():
    """Open the browser after a short delay."""
    import time
    time.sleep(1.5)
    webbrowser.open("http://localhost:8080")


if __name__ == "__main__":
    # Ensure projects directory exists
    os.makedirs(PROJECTS_DIR, exist_ok=True)

    # Migrate old single-project data if present
    print("Checking for legacy data to migrate...")
    _migrate_old_data()

    # Index documents for every existing project
    projects = _load_projects()
    for proj in projects:
        pid = proj["id"]
        print(f"Indexing project '{proj['name']}' ({pid})...")
        ev = get_evaluator(pid)
        idx_result = ev.index_documents()
        print(f"  Files processed: {idx_result['files_processed']}, "
              f"Chunks added: {idx_result['total_chunks']}, "
              f"Skipped: {idx_result['files_skipped']}")
        status = ev.get_status()
        print(f"  Total documents: {status['documents_indexed']}, "
              f"Total chunks: {status['total_chunks']}")

    if not projects:
        print("\n  No projects found. Create one via the web UI.\n")

    # Open browser in background thread
    threading.Thread(target=open_browser, daemon=True).start()

    print("Starting server at http://localhost:8080")
    app.run(host="0.0.0.0", port=8080, debug=False)
