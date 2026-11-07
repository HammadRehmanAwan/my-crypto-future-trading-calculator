---
title: FutureX — AI Crypto Futures
emoji: 📈
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
license: apache-2.0
---

# FutureX model server

This Space runs the real ML models behind FutureX's ensemble forecast:

- **Amazon Chronos-Bolt-Small** (`amazon/chronos-bolt-small`): zero-shot time-series forecasting
- **XGBoost**: gradient-boosted regressor trained on rolling technical features

Endpoints: `POST /api/ml-forecast`, `GET /api/model-status`, Gradio demo at `/ai`,
and the static FutureX site at `/`.

Deployed automatically from GitHub by `.github/workflows/deploy-hf-spaces.yml`.
