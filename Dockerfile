# ================================================================
# Scholarium — All-in-one Research Assistant (Python + Ollama)
# Uses the official ollama/ollama image as base (Ubuntu-based, contains
# all GPU/ML runtimes) and installs Python 3.11 + app on top.
# ================================================================
FROM ollama/ollama:latest

# Avoid interactive prompts during apt installs
ENV DEBIAN_FRONTEND=noninteractive

# Install Python 3.11 + system deps needed by PyMuPDF / ChromaDB / pip
RUN apt-get update && apt-get install -y --no-install-recommends \
        software-properties-common \
        curl \
        ca-certificates \
    && add-apt-repository -y ppa:deadsnakes/ppa \
    && apt-get update && apt-get install -y --no-install-recommends \
        python3.11 \
        python3.11-venv \
        python3.11-dev \
        python3-pip \
        libgl1 \
        libglib2.0-0 \
        build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3.11 /usr/local/bin/python \
    && ln -sf /usr/bin/python3.11 /usr/local/bin/python3

# Install pip for python3.11
RUN curl -fsSL https://bootstrap.pypa.io/get-pip.py | python3.11

WORKDIR /app

# Install Python dependencies first (leverages layer caching)
COPY requirements.txt .
RUN python3.11 -m pip install --no-cache-dir -r requirements.txt

# Pre-download the embedding + reranker models into the image (~2 GB)
RUN python3.11 -c "from sentence_transformers import SentenceTransformer, CrossEncoder; \
                   SentenceTransformer('BAAI/bge-large-en-v1.5'); \
                   CrossEncoder('BAAI/bge-reranker-v2-m3', max_length=512)"

# Copy application source
COPY app.py evaluator.py judge.py rag_pipeline.py respondent.py ./
COPY templates/ ./templates/
COPY static/ ./static/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Disable browser auto-open (no display in container)
ENV SCHOLARIUM_NO_BROWSER=1

EXPOSE 8080

# Persistent volumes
VOLUME ["/app/projects", "/root/.ollama"]

# Override the base image's ENTRYPOINT (which is just `ollama`) with ours
ENTRYPOINT ["/entrypoint.sh"]
CMD []
