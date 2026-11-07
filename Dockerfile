FROM python:3.11-slim

# Hugging Face Docker Spaces run the container as uid 1000.
RUN useradd -m -u 1000 user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH \
    HF_HOME=/home/user/.cache/huggingface \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /home/user/app
COPY --chown=user requirements.txt .
# CPU-only PyTorch: the CUDA build is ~2 GB larger and the Space has no GPU.
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.txt

COPY --chown=user app.py .
COPY --chown=user frontend ./frontend
USER user

# Pre-download Chronos-Bolt-Small at build time so cold starts don't wait on it.
RUN python -c "from chronos import BaseChronosPipeline; BaseChronosPipeline.from_pretrained('amazon/chronos-bolt-small', device_map='cpu')" || true

EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
