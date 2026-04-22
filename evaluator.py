"""Evaluator: orchestrates the RAG pipeline, respondent LLM, and judge LLM.
Supports multi-project — each project gets its own pipeline and QA log."""

import json
import os
from datetime import datetime

from rag_pipeline import RAGPipeline
from respondent import generate_answer, generate_answer_full_doc
from judge import evaluate_answer

PROJECTS_DIR = os.path.join(os.path.dirname(__file__), "projects")

# Cache evaluators per project to avoid re-loading
_evaluator_cache: dict[str, "Evaluator"] = {}


def get_evaluator(project_id: str) -> "Evaluator":
    """Factory: return cached evaluator for a project, or create one."""
    if project_id not in _evaluator_cache:
        _evaluator_cache[project_id] = Evaluator(project_id)
    return _evaluator_cache[project_id]


def clear_evaluator_cache(project_id: str = None):
    """Clear cached evaluator(s). Call after project deletion."""
    if project_id:
        _evaluator_cache.pop(project_id, None)
    else:
        _evaluator_cache.clear()


class Evaluator:
    def __init__(self, project_id: str):
        self.project_id = project_id
        self.project_dir = os.path.join(PROJECTS_DIR, project_id)
        self.qa_log_file = os.path.join(self.project_dir, "qa_log.json")
        os.makedirs(self.project_dir, exist_ok=True)
        self.rag = RAGPipeline(project_id)
        self._ensure_log_file()

    def _ensure_log_file(self):
        if not os.path.exists(self.qa_log_file):
            with open(self.qa_log_file, "w") as f:
                json.dump([], f)

    def index_documents(self) -> dict:
        return self.rag.index_all_documents()

    def index_single_document(self, filepath: str) -> int:
        return self.rag.index_document(filepath)

    def _project_setting(self, key, default=None):
        """Load a per-project setting from projects/projects.json."""
        projects_file = os.path.join(PROJECTS_DIR, "projects.json")
        try:
            with open(projects_file, "r") as f:
                for p in json.load(f):
                    if p.get("id") == self.project_id:
                        return p.get(key, default)
        except Exception:
            pass
        return default

    def process_query(
        self,
        question: str,
        judge_enabled: bool | None = None,
        document_filename: str | None = None,
    ) -> dict:
        """Process a query. If document_filename is provided, use full-document
        context mode (no RAG) — send the entire document text to the LLM."""
        timestamp = datetime.now().isoformat()

        if document_filename:
            # Full-document mode — bypass RAG
            import fitz
            doc_path = os.path.join(self.rag.documents_dir, document_filename)
            full_text = ""
            source_ok = False
            if os.path.exists(doc_path):
                try:
                    doc = fitz.open(doc_path)
                    for page in doc:
                        full_text += page.get_text() + "\n"
                    doc.close()
                    source_ok = True
                except Exception as e:
                    respondent_result = {
                        "answer": "", "model": "", "success": False,
                        "error": f"Failed to read document: {e}",
                    }

            if source_ok:
                respondent_result = generate_answer_full_doc(question, document_filename, full_text)

            # Synthetic "chunks" record (just the filename) for UI display
            chunks = [{
                "id": "fulldoc:" + document_filename,
                "text": f"[Full document used: {document_filename}]",
                "source": document_filename,
                "chunk_index": 0,
                "distance": 0.0,
            }]
        else:
            chunks = self.rag.retrieve(question)
            respondent_result = generate_answer(question, chunks)

        # Resolve judge flag: explicit arg > project setting > default True
        if judge_enabled is None:
            judge_enabled = self._project_setting("judge_enabled", True)

        if not judge_enabled:
            # Judge disabled — skip evaluation
            judge_result = {
                "scores": {},
                "model": "disabled",
                "success": False,
                "error": "Judge LLM is disabled for this project.",
            }
        elif respondent_result["success"] and respondent_result["answer"]:
            judge_result = evaluate_answer(question, respondent_result["answer"], chunks)
        else:
            judge_result = {
                "scores": {
                    dim: {"score": 0.0, "explanation": "Respondent failed to generate answer"}
                    for dim in ["faithfulness", "relevance", "hallucination", "completeness"]
                },
                "model": "none",
                "success": False,
            }

        result = {
            "question": question,
            "answer": respondent_result.get("answer", ""),
            "respondent_success": respondent_result["success"],
            "respondent_error": respondent_result.get("error"),
            "respondent_model": respondent_result.get("model", ""),
            "chunks": [
                {
                    "text": c["text"][:500],
                    "source": c["source"],
                    "chunk_index": c["chunk_index"],
                    "distance": round(c["distance"], 4) if isinstance(c.get("distance"), (int, float)) else None,
                    "rerank_score": round(c.get("rerank_score"), 4) if isinstance(c.get("rerank_score"), (int, float)) else None,
                }
                for c in chunks
            ],
            "scores": judge_result.get("scores", {}),
            "judge_success": judge_result.get("success", False),
            "judge_error": judge_result.get("error"),
            "judge_model": judge_result.get("model", ""),
            "timestamp": timestamp,
            "document_count": self.rag.get_document_count(),
            "chunk_count": self.rag.get_chunk_count(),
        }

        self._log_qa(result)
        return result

    def _log_qa(self, result: dict):
        try:
            with open(self.qa_log_file, "r") as f:
                log = json.load(f)
        except (json.JSONDecodeError, FileNotFoundError):
            log = []

        log.append({
            "timestamp": result["timestamp"],
            "question": result["question"],
            "answer": result["answer"],
            "scores": result["scores"],
            "respondent_model": result["respondent_model"],
            "judge_model": result["judge_model"],
            "num_chunks_used": len(result["chunks"]),
        })

        with open(self.qa_log_file, "w") as f:
            json.dump(log, f, indent=2)

    def get_status(self) -> dict:
        return {
            "documents_indexed": self.rag.get_document_count(),
            "total_chunks": self.rag.get_chunk_count(),
            "has_documents": self.rag.get_document_count() > 0,
        }
