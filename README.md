---
title: Crypto Futures Trading Calculator AI
emoji: 📈
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
pinned: false
license: mit
---

# 📈 Crypto Futures Trading Calculator

An AI-powered cryptocurrency futures trading calculator that integrates **Amazon Chronos-T5-Small** — the most accurate open-source time-series forecasting model on Hugging Face.

## Features

- **AI Price Prediction** — [amazon/chronos-t5-small](https://huggingface.co/amazon/chronos-t5-small), a zero-shot probabilistic forecasting model pre-trained on 27 billion data points
- **Live Market Data** — Real-time prices from CoinGecko API (15 major coins)
- **Technical Analysis** — RSI(14), MACD(12/26/9), Bollinger Bands(20,2)
- **Futures Calculator** — Liquidation price, margin, PnL, ROE, risk/reward ratio
- **Trade Signals** — Composite signal combining AI + technicals

## Supported Coins

BTC, ETH, BNB, SOL, XRP, ADA, AVAX, DOGE, DOT, MATIC, LINK, UNI, LTC, ATOM, FIL

## How to Use

1. Select a cryptocurrency
2. Click **Refresh** to load the live price
3. Set your position parameters (direction, leverage, size)
4. Optionally set take profit / stop loss prices
5. Click **Analyze Trade** — the AI forecasts prices and calculates all metrics

## Tech Stack

| Layer | Tool |
|---|---|
| AI Model | `amazon/chronos-t5-small` (Hugging Face) |
| UI | Gradio 4.44 |
| Price Data | CoinGecko free API |
| Indicators | Pandas / NumPy |
| Charts | Plotly |

## Local Development

```bash
pip install -r requirements.txt
python app.py
```

---
⚠️ *For educational purposes only. Not financial advice.*
