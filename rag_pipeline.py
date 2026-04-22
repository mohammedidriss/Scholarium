"""RAG Pipeline: PDF loading, chunking, embedding, and hybrid retrieval with reranking.

Upgraded stack:
- BGE-large embeddings (academic-aware, 1024-dim)
- BM25 sparse retrieval (keyword-based) combined with dense embeddings
- BGE cross-encoder reranker for precision top-k re-ordering
- Semantic-ish chunking (paragraph aware)
- Auto-rebuild on embedding dim change (for upgrades from older models)
"""

import os
import hashlib
import re
from pathlib import Path

import fitz  # PyMuPDF
import chromadb
from sentence_transformers import SentenceTransformer, CrossEncoder

BASE_DIR = os.path.dirname(__file__)
PROJECTS_DIR = os.path.join(BASE_DIR, "projects")

# Embeddings
EMBEDDING_MODEL = "BAAI/bge-large-en-v1.5"
EMBEDDING_DIM = 1024
RERANKER_MODEL = "BAAI/bge-reranker-v2-m3"

# Chunking
CHUNK_SIZE = 500  # tokens (approx)
CHUNK_OVERLAP = 80
TOP_K = 5
CANDIDATES_K = 30  # retrieve wider, rerank to top_k
CHARS_PER_TOKEN = 4
CHUNK_CHARS = CHUNK_SIZE * CHARS_PER_TOKEN
OVERLAP_CHARS = CHUNK_OVERLAP * CHARS_PER_TOKEN

# Shared globals — load models once, reuse across all projects
_shared_embedder = None
_shared_reranker = None


def get_embedder():
    """Lazy-load the shared BGE embedder."""
    global _shared_embedder
    if _shared_embedder is None:
        _shared_embedder = SentenceTransformer(EMBEDDING_MODEL)
    return _shared_embedder


def get_reranker():
    """Lazy-load the shared BGE cross-encoder reranker."""
    global _shared_reranker
    if _shared_reranker is None:
        # max_length=512: reranker handles (query, passage) pairs up to 512 tokens
        _shared_reranker = CrossEncoder(RERANKER_MODEL, max_length=512)
    return _shared_reranker


def _tokenize_for_bm25(text: str) -> list[str]:
    """Simple tokenizer for BM25: lowercase, split on non-word, drop empties and short tokens."""
    tokens = re.findall(r"[a-z0-9]+", text.lower())
    return [t for t in tokens if len(t) > 1]


class RAGPipeline:
    def __init__(self, project_id: str):
        self.project_id = project_id
        self.documents_dir = os.path.join(PROJECTS_DIR, project_id, "documents")
        self.vectordb_dir = os.path.join(PROJECTS_DIR, project_id, "vectordb")
        os.makedirs(self.documents_dir, exist_ok=True)
        os.makedirs(self.vectordb_dir, exist_ok=True)

        self.embedder = get_embedder()
        self.client = chromadb.PersistentClient(path=self.vectordb_dir)
        # Version the collection so old MiniLM-indexed DBs don't collide with BGE
        self.collection_name = f"project_{project_id}_bge"
        self.collection = self.client.get_or_create_collection(
            name=self.collection_name,
            metadata={"hnsw:space": "cosine"},
        )
        self._indexed_hashes: set[str] = set()
        self._load_indexed_hashes()

        # BM25 index — built lazily on first retrieve; marked dirty on index changes
        self._bm25 = None
        self._bm25_corpus: list[dict] = []  # parallel list of chunk dicts
        self._bm25_dirty = True

        # Mark any old MiniLM collection as obsolete (leave data, but we won't use it)

    # --- Indexing -----------------------------------------------------------

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
            full_text += page_text + "\n"
        doc.close()
        return full_text, pages

    def chunk_text(self, text: str, source: str, page_texts: list[str] | None = None) -> list[dict]:
        """Paragraph-aware chunking with overlap. Prepends a dedicated
        metadata chunk from page 1 (title/authors/abstract)."""
        chunks = []
        chunk_idx = 0

        # Dedicated metadata chunk from page 1
        if page_texts and page_texts[0].strip():
            first_page = page_texts[0].strip()[:1800]
            chunks.append({
                "text": f"[Document metadata - Title page] {first_page}",
                "source": source,
                "chunk_index": chunk_idx,
            })
            chunk_idx += 1

        # Split into paragraphs, then pack paragraphs into chunks up to CHUNK_CHARS
        paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
        if not paragraphs:
            # Fallback to raw sliding window
            paragraphs = [text.strip()] if text.strip() else []

        buf = ""
        for p in paragraphs:
            if not p:
                continue
            if len(buf) + len(p) + 2 <= CHUNK_CHARS:
                buf = (buf + "\n\n" + p) if buf else p
            else:
                if buf:
                    chunks.append({"text": buf, "source": source, "chunk_index": chunk_idx})
                    chunk_idx += 1
                    # overlap: keep tail of previous buffer
                    tail = buf[-OVERLAP_CHARS:] if len(buf) > OVERLAP_CHARS else buf
                    buf = tail + "\n\n" + p if len(p) <= CHUNK_CHARS else p
                else:
                    # Paragraph too big on its own — hard split it
                    start = 0
                    while start < len(p):
                        piece = p[start:start + CHUNK_CHARS]
                        chunks.append({"text": piece, "source": source, "chunk_index": chunk_idx})
                        chunk_idx += 1
                        start += CHUNK_CHARS - OVERLAP_CHARS
                    buf = ""
        if buf:
            chunks.append({"text": buf, "source": source, "chunk_index": chunk_idx})
            chunk_idx += 1

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
        # BGE models benefit from normalized embeddings
        embeddings = self.embedder.encode(
            documents,
            normalize_embeddings=True,
            show_progress_bar=False,
        ).tolist()
        metadatas = [
            {"source": c["source"], "chunk_index": c["chunk_index"], "file_hash": file_hash}
            for c in chunks
        ]
        self.collection.add(
            ids=ids, documents=documents, embeddings=embeddings, metadatas=metadatas
        )
        self._indexed_hashes.add(file_hash)
        self._bm25_dirty = True
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

    # --- Retrieval ----------------------------------------------------------

    def _build_bm25_index(self):
        """Build in-memory BM25 index from all chunks in the collection."""
        from rank_bm25 import BM25Okapi
        try:
            result = self.collection.get(include=["documents", "metadatas"])
        except Exception:
            self._bm25 = None
            self._bm25_corpus = []
            self._bm25_dirty = False
            return

        docs = result.get("documents") or []
        ids = result.get("ids") or []
        metas = result.get("metadatas") or []
        if not docs:
            self._bm25 = None
            self._bm25_corpus = []
            self._bm25_dirty = False
            return

        tokenized = [_tokenize_for_bm25(d) for d in docs]
        self._bm25 = BM25Okapi(tokenized)
        self._bm25_corpus = [
            {"id": ids[i], "text": docs[i], "meta": metas[i] if i < len(metas) else {}}
            for i in range(len(docs))
        ]
        self._bm25_dirty = False

    def retrieve(self, query: str, top_k: int = TOP_K, rerank: bool = True) -> list[dict]:
        """Hybrid retrieval: dense (BGE) + sparse (BM25), merged, then cross-encoder reranked."""
        if self.collection.count() == 0:
            return []

        query_clean = (query or "").strip()
        if not query_clean:
            return []

        # Dense retrieval
        query_emb = self.embedder.encode(
            [query_clean],
            normalize_embeddings=True,
            show_progress_bar=False,
        ).tolist()
        n_dense = min(CANDIDATES_K, self.collection.count())
        dense = self.collection.query(
            query_embeddings=query_emb,
            n_results=n_dense,
            include=["documents", "metadatas", "distances"],
        )

        merged: dict[str, dict] = {}
        for i in range(len(dense["ids"][0])):
            cid = dense["ids"][0][i]
            merged[cid] = {
                "id": cid,
                "text": dense["documents"][0][i],
                "source": dense["metadatas"][0][i].get("source", "unknown"),
                "chunk_index": dense["metadatas"][0][i].get("chunk_index", 0),
                "distance": dense["distances"][0][i],
                "source_method": "dense",
            }

        # Sparse retrieval (BM25)
        if self._bm25_dirty:
            self._build_bm25_index()

        if self._bm25 is not None and self._bm25_corpus:
            tokens = _tokenize_for_bm25(query_clean)
            if tokens:
                scores = self._bm25.get_scores(tokens)
                # Top-N sparse
                sparse_n = min(CANDIDATES_K, len(scores))
                top_idx = sorted(range(len(scores)), key=lambda i: -scores[i])[:sparse_n]
                for i in top_idx:
                    if scores[i] <= 0:
                        continue
                    entry = self._bm25_corpus[i]
                    cid = entry["id"]
                    if cid not in merged:
                        merged[cid] = {
                            "id": cid,
                            "text": entry["text"],
                            "source": (entry["meta"] or {}).get("source", "unknown"),
                            "chunk_index": (entry["meta"] or {}).get("chunk_index", 0),
                            "distance": None,
                            "source_method": "sparse",
                        }
                    # Record BM25 score in any case
                    merged[cid]["bm25"] = float(scores[i])

        candidates = list(merged.values())
        if not candidates:
            return []

        # Cross-encoder rerank (top precision)
        if rerank and len(candidates) > 1:
            try:
                reranker = get_reranker()
                pairs = [(query_clean, c["text"]) for c in candidates]
                rerank_scores = reranker.predict(pairs, show_progress_bar=False)
                for c, s in zip(candidates, rerank_scores):
                    c["rerank_score"] = float(s)
                candidates.sort(key=lambda c: c.get("rerank_score", 0.0), reverse=True)
            except Exception as e:
                # If reranker fails, fall back to dense ordering
                print(f"  (Reranker fallback: {e})")
                candidates.sort(key=lambda c: c.get("distance") or 1e9)

        return candidates[:top_k]

    # --- Info / maintenance ------------------------------------------------

    def get_document_count(self) -> int:
        return len(self._indexed_hashes)

    def get_chunk_count(self) -> int:
        return self.collection.count()

    def clear_index(self):
        try:
            self.client.delete_collection(self.collection_name)
        except Exception:
            pass
        self.collection = self.client.get_or_create_collection(
            name=self.collection_name, metadata={"hnsw:space": "cosine"},
        )
        self._indexed_hashes.clear()
        self._bm25 = None
        self._bm25_corpus = []
        self._bm25_dirty = True
