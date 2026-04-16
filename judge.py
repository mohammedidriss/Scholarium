"""Judge LLM: evaluates respondent answers on faithfulness, relevance, hallucination, completeness."""

import json
import requests

OLLAMA_URL = "http://localhost:11434/api/generate"
JUDGE_MODELS = ["qwen2.5:14b", "qwen2.5:32b", "gemma2:27b", "llama3.1"]

JUDGE_SYSTEM_PROMPT = """You are an expert evaluator for academic research responses in Engineering and Technology. Your task is to evaluate a given answer against source documents and the original question.

You MUST respond with ONLY valid JSON in this exact format (no other text):
{
  "faithfulness": {
    "score": <float 0.0-1.0>,
    "explanation": "<one sentence>"
  },
  "relevance": {
    "score": <float 0.0-1.0>,
    "explanation": "<one sentence>"
  },
  "hallucination": {
    "score": <float 0.0-1.0>,
    "explanation": "<one sentence>"
  },
  "completeness": {
    "score": <float 0.0-1.0>,
    "explanation": "<one sentence>"
  }
}

SCORING GUIDE:
- faithfulness: 1.0 = every claim is directly supported by the source documents, 0.0 = no claims are supported
- relevance: 1.0 = the answer fully addresses the question asked, 0.0 = the answer is completely off-topic
- hallucination: 1.0 = no fabricated information (GOOD), 0.0 = entirely fabricated (BAD). High score = no hallucination.
- completeness: 1.0 = all important points from the context are covered, 0.0 = critical information was missed"""


def _get_available_model() -> str | None:
    """Check which judge model is available, trying in preference order."""
    try:
        resp = requests.get("http://localhost:11434/api/tags", timeout=10)
        resp.raise_for_status()
        available = {m["name"] for m in resp.json().get("models", [])}
        # Also check without :latest suffix
        available_base = {m["name"].split(":")[0] for m in resp.json().get("models", [])}
    except Exception:
        return None

    for model in JUDGE_MODELS:
        if model in available or model in available_base:
            return model
        # Check with :latest
        if f"{model}:latest" in available:
            return model

    return None


def build_judge_prompt(question: str, answer: str, chunks: list[dict]) -> str:
    """Build the evaluation prompt for the judge."""
    context_parts = []
    for i, chunk in enumerate(chunks):
        context_parts.append(
            f"--- Source Chunk {i + 1} (Source: {chunk['source']}, "
            f"Chunk {chunk['chunk_index']}) ---\n{chunk['text']}\n"
        )
    context_block = "\n".join(context_parts)

    return (
        f"ORIGINAL QUESTION:\n{question}\n\n"
        f"SOURCE DOCUMENTS:\n{context_block}\n\n"
        f"ANSWER TO EVALUATE:\n{answer}\n\n"
        f"Evaluate the answer above. Respond with ONLY the JSON scores."
    )


def _parse_scores(text: str) -> dict | None:
    """Try to extract JSON scores from the judge response."""
    # Try direct JSON parse
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Try to find JSON block in the response
    start = text.find("{")
    end = text.rfind("}") + 1
    if start >= 0 and end > start:
        try:
            return json.loads(text[start:end])
        except json.JSONDecodeError:
            pass

    return None


def evaluate_answer(question: str, answer: str, chunks: list[dict]) -> dict:
    """Evaluate the respondent's answer using the judge LLM.

    Returns:
        dict with keys: scores, model, success, error (if any)
    """
    model = _get_available_model()
    if model is None:
        return {
            "scores": _default_scores("No judge model available"),
            "model": "none",
            "success": False,
            "error": "No judge model found. Pull one with: ollama pull llama3.1",
        }

    prompt = build_judge_prompt(question, answer, chunks)

    try:
        response = requests.post(
            OLLAMA_URL,
            json={
                "model": model,
                "prompt": prompt,
                "system": JUDGE_SYSTEM_PROMPT,
                "stream": False,
                "options": {
                    "temperature": 0.1,
                    "num_predict": 1024,
                },
            },
            timeout=600,
        )
        response.raise_for_status()
        data = response.json()
        raw_response = data.get("response", "")

        scores = _parse_scores(raw_response)
        if scores is None:
            return {
                "scores": _default_scores("Could not parse judge response"),
                "model": model,
                "success": False,
                "error": f"Judge returned unparseable response",
                "raw_response": raw_response[:500],
            }

        # Validate and normalize scores
        normalized = {}
        for dimension in ["faithfulness", "relevance", "hallucination", "completeness"]:
            if dimension in scores:
                entry = scores[dimension]
                score = float(entry.get("score", 0.5)) if isinstance(entry, dict) else 0.5
                score = max(0.0, min(1.0, score))
                explanation = entry.get("explanation", "No explanation provided") if isinstance(entry, dict) else "No explanation"
                normalized[dimension] = {
                    "score": round(score, 2),
                    "explanation": explanation,
                }
            else:
                normalized[dimension] = {
                    "score": 0.5,
                    "explanation": "Dimension not evaluated by judge",
                }

        return {
            "scores": normalized,
            "model": model,
            "success": True,
        }

    except requests.ConnectionError:
        return {
            "scores": _default_scores("Ollama not reachable"),
            "model": model,
            "success": False,
            "error": "Cannot connect to Ollama for judge evaluation.",
        }
    except requests.Timeout:
        return {
            "scores": _default_scores("Judge timed out"),
            "model": model,
            "success": False,
            "error": "Judge evaluation timed out.",
        }
    except Exception as e:
        return {
            "scores": _default_scores(str(e)),
            "model": model,
            "success": False,
            "error": f"Judge error: {str(e)}",
        }


def _default_scores(reason: str) -> dict:
    """Return default scores when evaluation fails."""
    return {
        dim: {"score": 0.5, "explanation": f"Not evaluated: {reason}"}
        for dim in ["faithfulness", "relevance", "hallucination", "completeness"]
    }
