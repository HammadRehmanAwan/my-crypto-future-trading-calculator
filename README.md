---
title: FutureX — AI Crypto Futures
emoji: 📈
colorFrom: blue
colorTo: indigo
sdk: static
pinned: false
license: apache-2.0
---

# FutureX — AI Crypto Futures Calculator

An AI-powered cryptocurrency futures trading calculator using real-time market data and statistical forecasting.

## ✅ Fully Free — No API Keys Required

| Component | Source | Cost |
|---|---|---|
| Price Data | CoinGecko public API | Free |
| AI Forecast | Holt's double-exponential smoothing | Free |
| Hosting | Hugging Face Spaces (Static) | Free |

## Features

- **Live Price Chart** — Real-time candlestick data with Bollinger Bands and forecast overlay for 15 major coins
- **AI Forecast** — Holt's double-exponential smoothing with confidence intervals
- **Technical Analysis** — RSI(14), MACD(12/26/9), Bollinger Bands(20, 2σ) with plain-English explanations
- **Futures Calculator** — Liquidation price, margin, PnL (gross + net after fees & funding), ROE, risk/reward ratio
- **Trade Signals** — Composite score combining forecast + 3 indicators, beginner-friendly summary
- **AI Portfolio Dashboard** — Enter your capital, pick a risk profile, get ranked trade opportunities
- **Volatility Email Alerts** — Auto-email when a watched coin moves sharply (server-side via GitHub Actions cron)

## Supported Coins

BTC, ETH, BNB, SOL, XRP, ADA, AVAX, DOGE, DOT, MATIC, LINK, UNI, LTC, ATOM, FIL

## How to Use

1. Select a coin from the chart dropdown or ticker
2. Set direction (Long/Short), leverage, and position size
3. Optionally set Take Profit / Stop Loss (or leave 0 to use the AI forecast target)
4. Click **Analyze Trade** to see all metrics, signals, and the price forecast

## Tech Stack

| Layer | Tool |
|---|---|
| AI Forecast | Holt double-exponential smoothing (client-side) |
| Ensemble Models | Chronos-Bolt · XGBoost · ETS · Holt-Winters · Linear Trend |
| Backend | FastAPI on Render (free tier) |
| AI Chat | HuggingFace InferenceClient (Zorion — Llama/Qwen/Mistral/Phi cascade) |
| Price Data | CoinGecko free public API |
| Futures Data | OKX public API |
| Alerts | GitHub Actions cron + EmailJS |
| Auth | Firebase Google Sign-in |

## Local Development

```bash
pip install -r requirements.txt
python backend.py
```

---
⚠️ *For educational purposes only. Not financial advice. Crypto trading carries significant risk.*
