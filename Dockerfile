FROM python:3.11-slim

WORKDIR /app

# System deps (git needed for any VCS pip installs)
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

COPY . .

# HF Spaces routes traffic to app_port (7860)
EXPOSE 7860

# Single uvicorn process serving FastAPI (HTML frontend at /, Gradio at /ai)
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
