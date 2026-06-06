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
- **Futures Calculator** — Liquidation price, margin, PnL, ROE, risk/reward ratio
- **Trade Signals** — Composite score combining forecast + 3 indicators, beginner-friendly summary
- **AI Portfolio Dashboard** — Enter your capital, pick a risk profile, get ranked trade opportunities
- **Volatility Email Alerts** — Auto-email when a watched coin moves sharply (via EmailJS)

## Supported Coins

BTC, ETH, BNB, SOL, XRP, ADA, AVAX, DOGE, DOT, MATIC, LINK, UNI, LTC, ATOM, FIL

## How to Use

1. Select a coin from the chart dropdown or ticker
2. Set direction (Long/Short), leverage, and position size
3. Optionally set Take Profit / Stop Loss (or leave 0 to use the AI forecast target)
4. Click **Analyze Trade** to see all metrics, signals, and the price forecast

---
⚠️ *For educational purposes only. Not financial advice. Crypto trading carries significant risk.*

# 📈 Crypto Futures Trading Calculator

An AI-powered cryptocurrency futures trading calculator using **Amazon Chronos-Bolt-Small** — the fastest and most accurate **100% free** open-source time-series model on Hugging Face.

## ✅ Fully Free — No API Keys Required

| Component | Model / Source | Cost |
|---|---|---|
| AI Forecasting | `amazon/chronos-bolt-small` (Apache 2.0) | Free |
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
3. Optionally set Take Profit / Stop Loss prices (or leave 0 to use AI target)
4. Click **Analyze Trade** — AI forecasts prices and calculates all metrics

## Tech Stack

| Layer | Tool |
|---|---|
| AI Model | `amazon/chronos-bolt-small` — Apache 2.0, free |
| Fallback | `amazon/chronos-t5-small` — Apache 2.0, free |
| UI | Gradio 4.44 |
| Price Data | CoinGecko free public API |
| Charts | Plotly |

## Local Development

```bash
pip install -r requirements.txt
python app.py
```

---
⚠️ *For educational purposes only. Not financial advice. Crypto trading carries significant risk.*
