---
title: Crypto Futures Trading Calculator AI
emoji: 📈
colorFrom: blue
colorTo: cyan
sdk: gradio
sdk_version: 4.44.0
app_file: app.py
pinned: false
license: apache-2.0
---

# 📈 Crypto Futures Trading Calculator

AI-powered crypto futures calculator using **Amazon Chronos-Bolt-Small** — the fastest 100% free open-source time-series model on Hugging Face.

## ✅ Fully Free — No API Keys Required

| Component | Model / Source | Cost |
|---|---|---|
| AI Forecasting | `amazon/chronos-bolt-small` (Apache 2.0) | Free |
| Fallback | `amazon/chronos-t5-small` (Apache 2.0) | Free |
| Price Data | CoinGecko public API | Free |
| Hosting | Hugging Face Spaces (CPU) | Free |

## Features

- **AI Price Prediction** — [amazon/chronos-bolt-small](https://huggingface.co/amazon/chronos-bolt-small), 20× faster than original Chronos, zero-shot probabilistic forecasting
- **Live Market Data** — Real-time prices from CoinGecko API (15 major coins)
- **Technical Analysis** — RSI(14), MACD(12/26/9), Bollinger Bands(20, 2σ)
- **Futures Calculator** — Liquidation price, margin, PnL, ROE, risk/reward ratio
- **Trade Signals** — Composite score combining AI forecast + 3 technical indicators

## Supported Coins

BTC, ETH, BNB, SOL, XRP, ADA, AVAX, DOGE, DOT, MATIC, LINK, UNI, LTC, ATOM, FIL

## How to Use

1. Select a cryptocurrency and click **Refresh Price**
2. Set your position: direction (Long/Short), leverage, size
3. Optionally set Take Profit / Stop Loss (or leave 0 to use AI target)
4. Click **Analyze Trade**

## Local Development

```bash
pip install -r requirements.txt
python app.py
```

---
⚠️ *For educational purposes only. Not financial advice.*
