"""Respondent LLM: generates answers with inline citations using Ollama."""

import requests
import json

OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL = "llama3.1"

SYSTEM_PROMPT = """You are a research assistant specializing in Engineering and Technology at the doctorate level. You help researchers understand, synthesize, and critically analyze academic literature.

INSTRUCTIONS:
- Answer the question using ONLY the provided context chunks.
- For every claim you make, cite the source using [Source: filename, Chunk N] format.
- If the context does not contain enough information to answer, say so explicitly.
- Be precise, technical, and thorough in your responses.
- Structure your answer with clear paragraphs for readability.
- Do not fabricate information not present in the provided context.
- When appropriate, note contradictions or gaps across sources."""


def build_prompt(question: str, chunks: list[dict]) -> str:
    """Build the prompt with context chunks for the respondent."""
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


def generate_answer(question: str, chunks: list[dict]) -> dict:
    """Generate an answer from the respondent LLM.

    Returns:
        dict with keys: answer, model, success, error (if any)
    """
    if not chunks:
        return {
            "answer": "No relevant documents were found to answer this question. "
                      "Please upload PDF documents to the /documents folder and "
                      "ensure they are indexed.",
            "model": MODEL,
            "success": True,
        }

    prompt = build_prompt(question, chunks)

    try:
        response = requests.post(
            OLLAMA_URL,
            json={
                "model": MODEL,
                "prompt": prompt,
                "system": SYSTEM_PROMPT,
                "stream": False,
                "options": {
                    "temperature": 0.3,
                    "top_p": 0.9,
                    "num_predict": 2048,
                },
            },
            timeout=300,
        )
        response.raise_for_status()
        data = response.json()
        return {
            "answer": data.get("response", "").strip(),
            "model": MODEL,
            "success": True,
        }
    except requests.ConnectionError:
        return {
            "answer": "",
            "model": MODEL,
            "success": False,
            "error": "Cannot connect to Ollama. Is it running? Start with: ollama serve",
        }
    except requests.Timeout:
        return {
            "answer": "",
            "model": MODEL,
            "success": False,
            "error": "Ollama request timed out. The model may be loading.",
        }
    except Exception as e:
        return {
            "answer": "",
            "model": MODEL,
            "success": False,
            "error": f"Respondent LLM error: {str(e)}",
        }
