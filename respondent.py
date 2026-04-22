"""Respondent LLM: generates answers with inline citations using Ollama.

Two modes:
  - RAG mode (generate_answer): retrieves chunks, sends top-k with question
  - Full-document mode (generate_answer_full_doc): sends the entire document text
    to the LLM — better for per-document questions, no retrieval errors
"""

import requests

OLLAMA_URL = "http://localhost:11434/api/generate"
# Upgraded from llama3.2 (3B) to qwen2.5:14b for stronger academic reasoning
MODEL = "qwen2.5:14b"

SYSTEM_PROMPT = """You are a research assistant specializing in Engineering and Technology at the doctorate level. You help researchers understand, synthesize, and critically analyze academic literature.

INSTRUCTIONS:
- Answer the question using ONLY the provided context.
- Cite sources inline as [Source: filename, Chunk N] (RAG mode) or [Source: filename] (full-document mode).
- If the context does not contain enough information, say so explicitly — do NOT guess.
- Be precise, technical, and thorough.
- Structure your answer with clear paragraphs.
- Do not fabricate information.
- Note contradictions or gaps across sources when relevant."""


def build_prompt(question: str, chunks: list[dict]) -> str:
    """Build the prompt with RAG context chunks for the respondent."""
    context_parts = []
    for i, chunk in enumerate(chunks):
        context_parts.append(
            f"--- Context Chunk {i + 1} (Source: {chunk['source']}, "
            f"Chunk {chunk['chunk_index']}) ---\n{chunk['text']}\n"
        )
    context_block = "\n".join(context_parts)

    return (
        f"CONTEXT DOCUMENTS:\n{context_block}\n\n"
        f"QUESTION: {question}\n\n"
        f"Provide a detailed, well-cited answer based on the context above."
    )


def _call_ollama(prompt: str, system: str = SYSTEM_PROMPT, num_predict: int = 2048, temperature: float = 0.3, num_ctx: int | None = None) -> dict:
    """Low-level Ollama call. Returns {answer, model, success, error}."""
    options = {
        "temperature": temperature,
        "top_p": 0.9,
        "num_predict": num_predict,
    }
    if num_ctx is not None:
        options["num_ctx"] = num_ctx

    try:
        response = requests.post(
            OLLAMA_URL,
            json={
                "model": MODEL,
                "prompt": prompt,
                "system": system,
                "stream": False,
                "options": options,
            },
            timeout=600,
        )
        response.raise_for_status()
        data = response.json()
        return {
            "answer": data.get("response", "").strip(),
            "model": MODEL,
            "success": True,
        }
    except requests.ConnectionError:
        return {"answer": "", "model": MODEL, "success": False,
                "error": "Cannot connect to Ollama. Is it running? Start with: ollama serve"}
    except requests.Timeout:
        return {"answer": "", "model": MODEL, "success": False,
                "error": "Ollama request timed out. The model may be loading."}
    except Exception as e:
        return {"answer": "", "model": MODEL, "success": False,
                "error": f"Respondent LLM error: {str(e)}"}


def generate_answer(question: str, chunks: list[dict]) -> dict:
    """RAG mode: answer a question given retrieved chunks."""
    if not chunks:
        return {
            "answer": "No relevant documents were found to answer this question. "
                      "Please upload PDF documents and ensure they are indexed.",
            "model": MODEL,
            "success": True,
        }
    prompt = build_prompt(question, chunks)
    return _call_ollama(prompt)


def generate_answer_full_doc(question: str, filename: str, document_text: str, max_chars: int = 120000) -> dict:
    """Full-document mode: send the entire document to the LLM (no retrieval).

    Best for per-document questions like 'Summarize this paper' or
    'What methodology did the authors use?'. qwen2.5:14b supports 128K context
    which accommodates ~25-30K words of text.
    """
    if not document_text.strip():
        return {"answer": "", "model": MODEL, "success": False,
                "error": "Document is empty or could not be read."}

    # Truncate if needed (keeping head + tail which usually have intro+conclusion)
    text = document_text.strip()
    if len(text) > max_chars:
        head_chars = int(max_chars * 0.7)
        tail_chars = max_chars - head_chars - 100
        text = text[:head_chars] + "\n\n[... middle content truncated for length ...]\n\n" + text[-tail_chars:]

    prompt = (
        f"You are analyzing the full text of a single document: '{filename}'.\n\n"
        f"--- DOCUMENT TEXT ---\n{text}\n--- END DOCUMENT ---\n\n"
        f"QUESTION: {question}\n\n"
        f"Answer based ONLY on the document above. Cite specifically (page numbers, section names, or direct quotes) when possible."
    )

    # Use a larger context window for full-doc mode
    # qwen2.5:14b supports up to 128K tokens (~100K chars)
    # We cap num_ctx at 32K to keep VRAM reasonable
    return _call_ollama(prompt, num_predict=2048, num_ctx=32768)
