"""RAG Pipeline: PDF loading, chunking, embedding, and retrieval via ChromaDB.
Supports multi-project isolation — each project gets its own documents dir and vector collection."""

import os
import hashlib
from pathlib import Path

import fitz  # PyMuPDF
import chromadb
from sentence_transformers import SentenceTransformer

BASE_DIR = os.path.dirname(__file__)
PROJECTS_DIR = os.path.join(BASE_DIR, "projects")
CHUNK_SIZE = 500
CHUNK_OVERLAP = 50
TOP_K = 5
CHARS_PER_TOKEN = 4
CHUNK_CHARS = CHUNK_SIZE * CHARS_PER_TOKEN
OVERLAP_CHARS = CHUNK_OVERLAP * CHARS_PER_TOKEN

# Shared embedder — loaded once, reused across all projects
_shared_embedder = None


def get_embedder():
    global _shared_embedder
    if _shared_embedder is None:
        _shared_embedder = SentenceTransformer("all-MiniLM-L6-v2")
    return _shared_embedder


class RAGPipeline:
    def __init__(self, project_id: str):
        self.project_id = project_id
        self.documents_dir = os.path.join(PROJECTS_DIR, project_id, "documents")
        self.vectordb_dir = os.path.join(PROJECTS_DIR, project_id, "vectordb")
        os.makedirs(self.documents_dir, exist_ok=True)
        os.makedirs(self.vectordb_dir, exist_ok=True)

        self.embedder = get_embedder()
        self.client = chromadb.PersistentClient(path=self.vectordb_dir)
        self.collection_name = f"project_{project_id}"
        self.collection = self.client.get_or_create_collection(
            name=self.collection_name,
            metadata={"hnsw:space": "cosine"},
        )
        self._indexed_hashes: set[str] = set()
        self._load_indexed_hashes()

    def _load_indexed_hashes(self):
        try:
            existing = self.collection.get(include=["metadatas"])
            for meta in existing["metadatas"]:
                if meta and "file_hash" in meta:
                    self._indexed_hashes.add(meta["file_hash"])
        except Exception:
            pass

    def _hash_file(self, filepath: str) -> str:
        h = hashlib.sha256()
        with open(filepath, "rb") as f:
            for block in iter(lambda: f.read(8192), b""):
                h.update(block)
        return h.hexdigest()

    def extract_text_from_pdf(self, filepath: str) -> tuple[str, list[str]]:
        doc = fitz.open(filepath)
        pages = []
        full_text = ""
        for page in doc:
            page_text = page.get_text()
            pages.append(page_text)
            full_text += page_text
        doc.close()
        return full_text, pages

    def chunk_text(self, text: str, source: str, page_texts: list[str] | None = None) -> list[dict]:
        chunks = []
        chunk_idx = 0
        if page_texts and page_texts[0].strip():
            first_page = page_texts[0].strip()[:1500]
            chunks.append({
                "text": f"[Document metadata - Title page] {first_page}",
                "source": source,
                "chunk_index": chunk_idx,
            })
            chunk_idx += 1
        start = 0
        while start < len(text):
            end = start + CHUNK_CHARS
            chunk_text = text[start:end].strip()
            if chunk_text:
                chunks.append({"text": chunk_text, "source": source, "chunk_index": chunk_idx})
                chunk_idx += 1
            start += CHUNK_CHARS - OVERLAP_CHARS
        return chunks

    def index_document(self, filepath: str) -> int:
        file_hash = self._hash_file(filepath)
        if file_hash in self._indexed_hashes:
            return 0
        filename = os.path.basename(filepath)
        text, page_texts = self.extract_text_from_pdf(filepath)
        if not text.strip():
            return 0
        chunks = self.chunk_text(text, filename, page_texts)
        if not chunks:
            return 0
        ids = [f"{file_hash}_{c['chunk_index']}" for c in chunks]
        documents = [c["text"] for c in chunks]
        embeddings = self.embedder.encode(documents).tolist()
        metadatas = [{"source": c["source"], "chunk_index": c["chunk_index"], "file_hash": file_hash} for c in chunks]
        self.collection.add(ids=ids, documents=documents, embeddings=embeddings, metadatas=metadatas)
        self._indexed_hashes.add(file_hash)
        return len(chunks)

    def index_all_documents(self) -> dict:
        results = {"total_chunks": 0, "files_processed": 0, "files_skipped": 0}
        pdf_files = list(Path(self.documents_dir).glob("*.pdf"))
        for pdf_path in pdf_files:
            added = self.index_document(str(pdf_path))
            if added > 0:
                results["files_processed"] += 1
                results["total_chunks"] += added
            else:
                results["files_skipped"] += 1
        return results

    def retrieve(self, query: str, top_k: int = TOP_K) -> list[dict]:
        if self.collection.count() == 0:
            return []
        query_embedding = self.embedder.encode([query]).tolist()
        results = self.collection.query(
            query_embeddings=query_embedding,
            n_results=min(top_k, self.collection.count()),
            include=["documents", "metadatas", "distances"],
        )
        chunks = []
        for i in range(len(results["ids"][0])):
            chunks.append({
                "id": results["ids"][0][i],
                "text": results["documents"][0][i],
                "source": results["metadatas"][0][i].get("source", "unknown"),
                "chunk_index": results["metadatas"][0][i].get("chunk_index", 0),
                "distance": results["distances"][0][i],
            })
        return chunks

    def get_document_count(self) -> int:
        return len(self._indexed_hashes)

    def get_chunk_count(self) -> int:
        return self.collection.count()

    def clear_index(self):
        self.client.delete_collection(self.collection_name)
        self.collection = self.client.get_or_create_collection(
            name=self.collection_name, metadata={"hnsw:space": "cosine"},
        )
        self._indexed_hashes.clear()
