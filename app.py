"""
Crypto Futures Trading Calculator
Powered by Amazon Chronos-Bolt-Small + XGBoost + CoinGecko API
"""

import warnings
warnings.filterwarnings("ignore")

import os
import numpy as np
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import requests
from datetime import timedelta
import gradio as gr
import torch

# ──────────────────────────────────────────────────────────────────────────────
# COIN REGISTRY
# ──────────────────────────────────────────────────────────────────────────────

SUPPORTED_COINS = {
    "Bitcoin (BTC)":    "bitcoin",
    "Ethereum (ETH)":   "ethereum",
    "BNB (BNB)":        "binancecoin",
    "Solana (SOL)":     "solana",
    "XRP (XRP)":        "ripple",
    "Cardano (ADA)":    "cardano",
    "Avalanche (AVAX)": "avalanche-2",
    "Dogecoin (DOGE)":  "dogecoin",
    "Polkadot (DOT)":   "polkadot",
    "Polygon (MATIC)":  "matic-network",
    "Chainlink (LINK)": "chainlink",
    "Uniswap (UNI)":    "uniswap",
    "Litecoin (LTC)":   "litecoin",
    "Cosmos (ATOM)":    "cosmos",
    "Filecoin (FIL)":   "filecoin",
}

# ──────────────────────────────────────────────────────────────────────────────
# MODEL  (lazy-loaded, singleton)
# ──────────────────────────────────────────────────────────────────────────────

_pipeline = None


def load_model():
    global _pipeline
    if _pipeline is not None:
        return _pipeline, None
    try:
        from chronos import BaseChronosPipeline
        _pipeline = BaseChronosPipeline.from_pretrained(
            "amazon/chronos-bolt-small",
            device_map="cpu",
            torch_dtype=torch.float32,
        )
        return _pipeline, None
    except Exception as exc:
        return None, str(exc)


# ──────────────────────────────────────────────────────────────────────────────
# DATA FETCHING
# ──────────────────────────────────────────────────────────────────────────────

def fetch_ohlcv(coin_id: str, days: int = 90):
    """Fetch daily price + volume from CoinGecko (free, no key)."""
    url = f"https://api.coingecko.com/api/v3/coins/{coin_id}/market_chart"
    params = {"vs_currency": "usd", "days": days}
    try:
        resp = requests.get(url, params=params, timeout=15)
        resp.raise_for_status()
        raw = resp.json()
        df = pd.DataFrame(raw["prices"], columns=["ts", "price"])
        df["volume"] = [v[1] for v in raw["total_volumes"]]
        df["ts"] = pd.to_datetime(df["ts"], unit="ms")
        df.set_index("ts", inplace=True)
        return df, None
    except Exception as exc:
        return None, str(exc)


def fetch_current_price(coin_id: str):
    url = "https://api.coingecko.com/api/v3/simple/price"
    params = {"ids": coin_id, "vs_currencies": "usd", "include_24hr_change": "true"}
    try:
        resp = requests.get(url, params=params, timeout=10)
        resp.raise_for_status()
        d = resp.json()[coin_id]
        return d["usd"], d.get("usd_24h_change", 0.0), None
    except Exception as exc:
        return None, None, str(exc)


# ──────────────────────────────────────────────────────────────────────────────
# TECHNICAL INDICATORS
# ──────────────────────────────────────────────────────────────────────────────

def calc_rsi(prices: np.ndarray, period: int = 14) -> np.ndarray:
    s = pd.Series(prices)
    delta = s.diff()
    gain = delta.clip(lower=0).rolling(period).mean()
    loss = (-delta.clip(upper=0)).rolling(period).mean()
    rs = gain / loss
    return (100 - 100 / (1 + rs)).fillna(50).values


def calc_macd(prices: np.ndarray, fast=12, slow=26, sig=9):
    s = pd.Series(prices)
    ema_f = s.ewm(span=fast, adjust=False).mean()
    ema_s = s.ewm(span=slow, adjust=False).mean()
    line   = ema_f - ema_s
    signal = line.ewm(span=sig, adjust=False).mean()
    hist   = line - signal
    return line.values, signal.values, hist.values


def calc_bollinger(prices: np.ndarray, period=20, mult=2):
    s   = pd.Series(prices)
    mid = s.rolling(period).mean()
    std = s.rolling(period).std()
    return (mid + mult * std).values, mid.values, (mid - mult * std).values


# ──────────────────────────────────────────────────────────────────────────────
# AI PRICE PREDICTION  (Chronos)
# ──────────────────────────────────────────────────────────────────────────────

def ai_forecast(prices: np.ndarray, horizon: int = 7):
    pipe, err = load_model()
    if err:
        return None, err
    context = torch.tensor(prices[-60:], dtype=torch.float32).unsqueeze(0)
    try:
        q_pred, _ = pipe.predict_quantiles(
            context,
            prediction_length=horizon,
            quantile_levels=[0.1, 0.5, 0.9],
        )
        # q_pred shape: (1, horizon, 3)
        lo  = q_pred[0, :, 0].numpy()
        med = q_pred[0, :, 1].numpy()
        hi  = q_pred[0, :, 2].numpy()
        return {"low": lo, "median": med, "high": hi}, None
    except Exception as exc:
        return None, str(exc)


# ──────────────────────────────────────────────────────────────────────────────
# FUTURES MATHS
# ──────────────────────────────────────────────────────────────────────────────

def futures_metrics(
    entry: float,
    leverage: float,
    size_usd: float,
    direction: str,
    take_profit: float | None = None,
    stop_loss: float | None = None,
):
    margin    = size_usd / leverage
    contracts = size_usd / entry
    mmr       = 0.005   # 0.5 % maintenance margin rate (industry standard)

    if direction == "Long":
        liq     = entry * (1 - 1 / leverage + mmr)
        liq_dist = (entry - liq) / entry * 100
        pnl_fn  = lambda px: contracts * (px - entry)
    else:
        liq     = entry * (1 + 1 / leverage - mmr)
        liq_dist = (liq - entry) / entry * 100
        pnl_fn  = lambda px: contracts * (entry - px)

    res = dict(
        entry=entry, leverage=leverage, size=size_usd,
        margin=margin, contracts=contracts,
        liq=liq, liq_dist=liq_dist, direction=direction,
    )

    if take_profit:
        pnl_tp = pnl_fn(take_profit)
        res.update(take_profit=take_profit, pnl_tp=pnl_tp, roe_tp=pnl_tp / margin * 100)

    if stop_loss:
        pnl_sl = pnl_fn(stop_loss)
        res.update(stop_loss=stop_loss, pnl_sl=pnl_sl, roe_sl=pnl_sl / margin * 100)

    if take_profit and stop_loss:
        reward = abs(take_profit - entry)
        risk   = abs(stop_loss  - entry)
        res["rr"] = reward / risk if risk else None

    return res


# ──────────────────────────────────────────────────────────────────────────────
# CHART BUILDERS
# ──────────────────────────────────────────────────────────────────────────────

def chart_prediction(df, fcst, horizon, coin_label):
    fig = go.Figure()
    n   = min(60, len(df))
    dt  = df.index[-n:]
    px  = df["price"].values[-n:]

    fig.add_trace(go.Scatter(
        x=dt, y=px, name="Historical",
        line=dict(color="#00D4FF", width=2),
    ))

    if fcst:
        last_dt = df.index[-1]
        fdates  = pd.date_range(start=last_dt + timedelta(days=1), periods=horizon)

        fig.add_trace(go.Scatter(
            x=list(fdates) + list(reversed(fdates)),
            y=list(fcst["high"]) + list(reversed(fcst["low"])),
            fill="toself",
            fillcolor="rgba(0,212,255,0.10)",
            line=dict(color="rgba(0,0,0,0)"),
            name="80% CI",
        ))
        fig.add_trace(go.Scatter(
            x=fdates, y=fcst["median"],
            name="AI Median Forecast",
            line=dict(color="#FFD700", width=2, dash="dash"),
            marker=dict(size=6),
        ))

    fig.update_layout(
        title=f"{coin_label} — Chronos-Bolt AI Price Forecast",
        xaxis_title="Date",
        yaxis_title="Price (USD)",
        template="plotly_dark",
        height=420,
        legend=dict(x=0, y=1),
    )
    return fig


def chart_technicals(df, rsi_v, macd_l, macd_s, macd_h, bb_u, bb_m, bb_l, coin_label):
    fig = make_subplots(
        rows=3, cols=1,
        subplot_titles=("Price + Bollinger Bands", "RSI (14)", "MACD (12/26/9)"),
        row_heights=[0.50, 0.25, 0.25],
        vertical_spacing=0.06,
    )
    n  = min(60, len(df))
    dt = df.index[-n:]
    px = df["price"].values[-n:]

    # Price + BB
    fig.add_trace(go.Scatter(x=dt, y=px, name="Price",
                             line=dict(color="#00D4FF")), 1, 1)
    fig.add_trace(go.Scatter(x=dt, y=bb_u[-n:], name="BB Upper",
                             line=dict(color="#888", dash="dot")), 1, 1)
    fig.add_trace(go.Scatter(x=dt, y=bb_m[-n:], name="BB Mid",
                             line=dict(color="#888", dash="dash")), 1, 1)
    fig.add_trace(go.Scatter(
        x=dt, y=bb_l[-n:], name="BB Lower",
        line=dict(color="#888", dash="dot"),
        fill="tonexty", fillcolor="rgba(136,136,136,0.08)",
    ), 1, 1)

    # RSI
    fig.add_trace(go.Scatter(x=dt, y=rsi_v[-n:], name="RSI",
                             line=dict(color="#FFD700")), 2, 1)
    fig.add_hline(y=70, line_dash="dash", line_color="red",      row=2, col=1)
    fig.add_hline(y=30, line_dash="dash", line_color="#00FF88",  row=2, col=1)

    # MACD
    colors = ["#00FF88" if v >= 0 else "#FF4444" for v in macd_h[-n:]]
    fig.add_trace(go.Bar(x=dt, y=macd_h[-n:], name="Hist",
                         marker_color=colors), 3, 1)
    fig.add_trace(go.Scatter(x=dt, y=macd_l[-n:], name="MACD",
                             line=dict(color="#00D4FF")), 3, 1)
    fig.add_trace(go.Scatter(x=dt, y=macd_s[-n:], name="Signal",
                             line=dict(color="#FF6B6B")), 3, 1)

    fig.update_layout(
        title=f"{coin_label} — Technical Analysis",
        template="plotly_dark",
        height=620,
        showlegend=False,
    )
    return fig


# ──────────────────────────────────────────────────────────────────────────────
# TEXT FORMATTERS
# ──────────────────────────────────────────────────────────────────────────────

def fmt_metrics(m: dict, curr_px: float, fcst, rsi_val: float, coin: str) -> str:
    pred = fcst["median"][-1] if fcst else None
    pct  = (pred - curr_px) / curr_px * 100 if pred else None
    h    = m.get("horizon", 7)

    lines = [
        f"## {coin} — Trading Metrics\n",
        "### 💰 Price",
        f"- **Current Price:** ${curr_px:,.4f}",
    ]
    if pred:
        lo, hi = fcst["low"][-1], fcst["high"][-1]
        lines += [
            f"- **AI Forecast ({h}d median):** ${pred:,.4f}  ({pct:+.2f}%)",
            f"- **80% Confidence Interval:** ${lo:,.4f} – ${hi:,.4f}",
        ]

    lines += [
        "\n### 📊 Position",
        f"- **Direction:** {'🟢 Long' if m['direction'] == 'Long' else '🔴 Short'}",
        f"- **Entry Price:** ${m['entry']:,.4f}",
        f"- **Leverage:** {int(m['leverage'])}×",
        f"- **Position Size:** ${m['size']:,.2f}",
        f"- **Required Margin:** ${m['margin']:,.2f}",
        f"- **Contracts:** {m['contracts']:.6f}",
        "\n### ⚠️ Risk",
        f"- **Liquidation Price:** ${m['liq']:,.4f}",
        f"- **Distance to Liquidation:** {m['liq_dist']:.2f}%",
    ]

    if "take_profit" in m:
        lines += [
            "\n### 🎯 Take Profit",
            f"- **TP Price:** ${m['take_profit']:,.4f}",
            f"- **PnL at TP:** ${m['pnl_tp']:+,.2f}",
            f"- **ROE at TP:** {m['roe_tp']:+.2f}%",
        ]
    if "stop_loss" in m:
        lines += [
            "\n### 🛑 Stop Loss",
            f"- **SL Price:** ${m['stop_loss']:,.4f}",
            f"- **PnL at SL:** ${m['pnl_sl']:+,.2f}",
            f"- **ROE at SL:** {m['roe_sl']:+.2f}%",
        ]
    if m.get("rr"):
        lines.append(f"- **Risk / Reward:** 1 : {m['rr']:.2f}")

    rsi_tag = "Overbought 🔴" if rsi_val > 70 else "Oversold 🟢" if rsi_val < 30 else "Neutral 🟡"
    lines += [
        "\n### 📈 Technicals",
        f"- **RSI(14):** {rsi_val:.1f}  ({rsi_tag})",
    ]
    return "\n".join(lines)


def fmt_signal(
    rsi_val, macd_l, macd_s, px, bb_u, bb_l, direction, m, fcst
) -> str:
    score   = 0
    bullets = []

    if rsi_val < 30:
        bullets.append("🟢 RSI oversold → bullish momentum likely"); score += 1
    elif rsi_val > 70:
        bullets.append("🔴 RSI overbought → bearish pressure likely"); score -= 1
    else:
        bullets.append(f"🟡 RSI neutral at {rsi_val:.1f}")

    if macd_l > macd_s:
        bullets.append("🟢 MACD above signal line → bullish"); score += 1
    else:
        bullets.append("🔴 MACD below signal line → bearish"); score -= 1

    if px < bb_l:
        bullets.append("🟢 Price below lower BB → potential bounce"); score += 1
    elif px > bb_u:
        bullets.append("🔴 Price above upper BB → potential reversal"); score -= 1
    else:
        bullets.append("🟡 Price within Bollinger Bands")

    h = m.get("horizon", 7)
    if fcst:
        chg = (fcst["median"][-1] - px) / px * 100
        if chg > 2:
            bullets.append(f"🟢 Chronos-Bolt AI forecasts **+{chg:.1f}%** over {h} days"); score += 2
        elif chg < -2:
            bullets.append(f"🔴 Chronos-Bolt AI forecasts **{chg:.1f}%** over {h} days"); score -= 2
        else:
            bullets.append(f"🟡 Chronos-Bolt AI sees minimal move ({chg:+.1f}%)")

    ld = m["liq_dist"]
    if ld < 5:
        bullets.append(f"🚨 **CRITICAL**: Liquidation only {ld:.1f}% away!"); score -= 1
    elif ld < 10:
        bullets.append(f"⚠️ Liquidation {ld:.1f}% away — moderate risk")
    else:
        bullets.append(f"✅ Liquidation {ld:.1f}% away — manageable")

    if score >= 3:
        heading = "## 🟢 STRONG BULLISH SIGNAL"
    elif score >= 1:
        heading = "## 🟡 MILDLY BULLISH"
    elif score <= -3:
        heading = "## 🔴 STRONG BEARISH SIGNAL"
    elif score <= -1:
        heading = "## 🟡 MILDLY BEARISH"
    else:
        heading = "## ⚪ NEUTRAL — Wait for clearer setup"

    alignment = ""
    if (score > 0 and direction == "Long") or (score < 0 and direction == "Short"):
        alignment = "\n✅ **Your direction aligns with market signals.**"
    elif score != 0:
        alignment = "\n⚠️ **Your direction is counter-trend — manage risk carefully.**"

    body  = heading + alignment
    body += "\n\n**Individual Signals:**\n" + "\n".join(f"- {b}" for b in bullets)
    body += f"\n\n**Composite Score:** {score:+d}"
    body += "\n\n---\n*⚠️ Educational tool only — not financial advice.*"
    return body


# ──────────────────────────────────────────────────────────────────────────────
# ORCHESTRATION
# ──────────────────────────────────────────────────────────────────────────────

def analyze(coin_label, direction, entry_px, leverage, size_usd, tp, sl, horizon):
    coin_id = SUPPORTED_COINS.get(coin_label, "bitcoin")

    df, err = fetch_ohlcv(coin_id, days=90)
    if err:
        return None, f"❌ Data fetch failed: {err}", None, None

    prices  = df["price"].values
    curr_px = float(prices[-1])
    ep      = float(entry_px) if entry_px else curr_px

    fcst, ferr = ai_forecast(prices, int(horizon))
    if ferr:
        gr.Warning(f"AI model unavailable: {ferr}. Showing technical analysis only.")

    tp_val = float(tp) if tp else (float(fcst["median"][-1]) if fcst else None)
    sl_val = float(sl) if sl else None

    m = futures_metrics(ep, float(leverage), float(size_usd), direction, tp_val, sl_val)
    m["horizon"] = int(horizon)

    rsi_v              = calc_rsi(prices)
    macd_l, macd_s, macd_h = calc_macd(prices)
    bb_u, bb_m, bb_l   = calc_bollinger(prices)

    fig_pred = chart_prediction(df, fcst, int(horizon), coin_label)
    fig_tech = chart_technicals(
        df, rsi_v, macd_l, macd_s, macd_h, bb_u, bb_m, bb_l, coin_label
    )

    metrics_md = fmt_metrics(m, curr_px, fcst, rsi_v[-1], coin_label)
    signal_md  = fmt_signal(
        rsi_v[-1], macd_l[-1], macd_s[-1], curr_px,
        bb_u[-1], bb_l[-1], direction, m, fcst,
    )

    return fig_pred, metrics_md, fig_tech, signal_md


def refresh_price(coin_label):
    coin_id = SUPPORTED_COINS.get(coin_label, "bitcoin")
    px, chg, err = fetch_current_price(coin_id)
    if err:
        return f"Error: {err}"
    emoji = "🟢" if chg > 0 else "🔴"
    return f"{emoji} ${px:,.2f}  ({chg:+.2f}% 24h)"


# ──────────────────────────────────────────────────────────────────────────────
# GRADIO UI
# ──────────────────────────────────────────────────────────────────────────────

THEME = gr.themes.Soft(
    primary_hue="cyan",
    secondary_hue="blue",
    neutral_hue="slate",
    font=[gr.themes.GoogleFont("Inter"), "sans-serif"],
)

with gr.Blocks(title="Crypto Futures AI Calculator", theme=THEME) as demo:

    gr.Markdown("""
# 📈 Crypto Futures Trading Calculator
### Powered by [Amazon Chronos-Bolt-Small](https://huggingface.co/amazon/chronos-bolt-small) · XGBoost · CoinGecko · RSI · MACD · Bollinger Bands

> **Chronos-Bolt-Small** is Amazon's fast zero-shot probabilistic time-series model.
> **XGBoost** provides a feature-based gradient-boosted regression trained on rolling indicators.
> Both models run live on this Space — no heuristics.
    """)

    with gr.Row():
        coin_dd     = gr.Dropdown(
            list(SUPPORTED_COINS), value="Bitcoin (BTC)",
            label="Cryptocurrency", scale=2,
        )
        price_box   = gr.Textbox(label="Live Price", interactive=False, scale=2)
        refresh_btn = gr.Button("🔄 Refresh Price", variant="secondary", scale=1)

    refresh_btn.click(refresh_price, [coin_dd], [price_box])
    coin_dd.change(refresh_price, [coin_dd], [price_box])

    with gr.Row():
        with gr.Column(scale=1):
            gr.Markdown("### ⚙️ Position Parameters")
            direction = gr.Radio(["Long", "Short"], value="Long", label="Direction")
            entry_px  = gr.Number(
                label="Entry Price (USD)  — leave 0 to use live price", value=0)
            leverage  = gr.Slider(1, 125, value=10, step=1, label="Leverage (×)")
            size_usd  = gr.Number(label="Position Size (USD)", value=1000)

            gr.Markdown("### 🎯 Risk Management")
            tp = gr.Number(
                label="Take Profit (USD)  — leave 0 to use AI prediction", value=0)
            sl = gr.Number(
                label="Stop Loss (USD)    — leave 0 to skip", value=0)

            gr.Markdown("### 🤖 AI Forecast Settings")
            horizon = gr.Slider(1, 14, value=7, step=1, label="Forecast Horizon (days)")

            run_btn = gr.Button("🚀 Analyze Trade", variant="primary", size="lg")

        with gr.Column(scale=2):
            metrics_md = gr.Markdown()

    with gr.Row():
        pred_plot  = gr.Plot(label="📊 AI Price Prediction")
        signal_md  = gr.Markdown()

    tech_plot = gr.Plot(label="📉 Technical Analysis")

    run_btn.click(
        analyze,
        inputs=[coin_dd, direction, entry_px, leverage, size_usd, tp, sl, horizon],
        outputs=[pred_plot, metrics_md, tech_plot, signal_md],
    )

    gr.Markdown("""
---
### 📚 How It Works

| Component | Detail |
|---|---|
| **ML Forecast** | [amazon/chronos-bolt-small](https://huggingface.co/amazon/chronos-bolt-small) — zero-shot probabilistic time-series forecasting |
| **ML Regression** | XGBoost regressor trained on rolling RSI, MACD, EMA, ATR, and return features |
| **Price Data** | CoinGecko free public API (no API key required) |
| **Indicators** | RSI(14), MACD(12/26/9), Bollinger Bands(20, 2σ) |
| **Futures Math** | Liquidation price, PnL, ROE, Risk/Reward ratio |
| **Trade Signal** | Composite score from Chronos-Bolt + XGBoost + 3 technical indicators |

⚠️ *For educational purposes only. Crypto trading carries significant risk. Not financial advice.*
    """)

# ──────────────────────────────────────────────────────────────────────────────
# FASTAPI WRAPPER — serves the FutureX HTML frontend at /, Gradio AI at /ai,
# and Firebase config at /firebase-config (so the frontend works on HF Space).
# ──────────────────────────────────────────────────────────────────────────────

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

_fastapi = FastAPI()

_fastapi.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://hammadrehmanawan.github.io",
        "https://hammadrehman-crypto-futures-calculator.hf.space",
    ],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@_fastapi.get("/firebase-config", include_in_schema=False)
async def _firebase_config():
    return JSONResponse({
        "apiKey":            os.environ.get("FIREBASE_API_KEY", ""),
        "authDomain":        os.environ.get("FIREBASE_AUTH_DOMAIN", ""),
        "projectId":         os.environ.get("FIREBASE_PROJECT_ID", ""),
        "storageBucket":     os.environ.get("FIREBASE_STORAGE_BUCKET", ""),
        "messagingSenderId": os.environ.get("FIREBASE_MESSAGING_SENDER_ID", ""),
        "appId":             os.environ.get("FIREBASE_APP_ID", ""),
        "measurementId":     os.environ.get("FIREBASE_MEASUREMENT_ID", ""),
    })


@_fastapi.get("/", include_in_schema=False)
@_fastapi.get("/index.html", include_in_schema=False)
async def _index():
    return FileResponse("index.html")


@_fastapi.get("/app.js", include_in_schema=False)
async def _appjs():
    return FileResponse("app.js")


@_fastapi.get("/style.css", include_in_schema=False)
async def _css():
    return FileResponse("style.css")


@_fastapi.get("/favicon.svg", include_in_schema=False)
async def _favicon():
    return FileResponse("favicon.svg")


# ──────────────────────────────────────────────────────────────────────────────
# AI CHAT  — mirrors the Render backend's /chat so the Space is self-sufficient.
# Rule-based KB first (instant), then an HF Inference model cascade with live
# market-context injection. Uses `requests` (already a dependency); HF_TOKEN
# stays server-side. Sync def → FastAPI runs it in a threadpool.
# ──────────────────────────────────────────────────────────────────────────────

_CHAT_KB = {
    "rsi": (
        "RSI (Relative Strength Index) measures price momentum on a 0–100 scale. "
        "Below 30 = oversold (potential buy signal), above 70 = overbought (potential sell signal). "
        "RSI works best combined with trend and volume analysis."
    ),
    "macd": (
        "MACD (Moving Average Convergence Divergence) shows momentum direction. "
        "When the MACD line crosses above the signal line it's a bullish signal (buy). "
        "When it crosses below, it's bearish (sell). The histogram shows the distance between them."
    ),
    "funding": (
        "Funding rate is a periodic payment between long and short traders in perpetual futures. "
        "Positive funding → longs pay shorts (bullish bias, long crowding risk). "
        "Negative funding → shorts pay longs (bearish bias, short squeeze risk). "
        "Extreme positive rates often precede corrections."
    ),
    "ema": (
        "EMA (Exponential Moving Average) gives more weight to recent prices. "
        "Common periods: 20 (short-term trend), 50 (medium), 200 (long-term/macro). "
        "Price above all EMAs = strong uptrend. EMA 20 crossing EMA 50 (golden cross) = bullish signal."
    ),
    "bollinger": (
        "Bollinger Bands show volatility using a 20-period SMA ± 2 standard deviations. "
        "Price touching the upper band = potentially overbought. Lower band = potentially oversold. "
        "Band squeeze (narrow) often precedes a large breakout move."
    ),
    "support": (
        "Support levels are price areas where buyers historically step in, preventing further declines. "
        "Strong support comes from high-volume price zones, previous swing lows, or moving averages. "
        "Breaking below support often triggers stop-losses and further selling."
    ),
    "resistance": (
        "Resistance levels are price areas where sellers historically emerge, capping advances. "
        "Breaking above resistance with high volume is a bullish breakout signal. "
        "Old resistance often becomes new support once price breaks through."
    ),
    "liquidation": (
        "Liquidation happens when a leveraged position can no longer meet margin requirements. "
        "Large liquidation clusters (liquidation heatmaps) act as price magnets. "
        "Cascade liquidations can cause rapid price spikes in either direction."
    ),
    "open interest": (
        "Open Interest is the total value of all outstanding futures contracts. "
        "Rising OI with rising price = bullish (new money entering longs). "
        "Rising OI with falling price = bearish (new shorts being added). "
        "Falling OI with any price move = position unwinding (less conviction)."
    ),
    "long squeeze": (
        "A long squeeze occurs when overleveraged long positions are forced to close. "
        "Triggered by a price drop that hits stop-losses, causing cascading liquidations downward. "
        "Signs: very high L/S ratio, high positive funding, high OI — watch for sudden reversals."
    ),
    "short squeeze": (
        "A short squeeze occurs when heavily shorted assets rally, forcing shorts to cover. "
        "This creates a feedback loop: more buying → higher prices → more short covering. "
        "Signs: very low L/S ratio, negative funding, high OI. Can produce explosive upward moves."
    ),
    "atr": (
        "ATR (Average True Range) measures market volatility as the average price range over N periods. "
        "High ATR = high volatility. Used for position sizing and stop-loss placement. "
        "A common rule: place stops 1.5–2× ATR away from entry to avoid noise."
    ),
    "vwap": (
        "VWAP (Volume Weighted Average Price) is the average price weighted by trading volume. "
        "Institutions often use VWAP as a benchmark. Price above VWAP = bullish intraday bias. "
        "Price below VWAP = bearish. VWAP acts as dynamic support/resistance."
    ),
}


def _rule_based_response(message: str, context: dict):
    msg_lower = message.lower()
    for keyword, explanation in _CHAT_KB.items():
        if keyword in msg_lower:
            return explanation

    coin_name = context.get("coinName", "")
    price = context.get("currentPrice")
    analysis = context.get("analysis")

    # Forecast / prediction — answer with the model projection, not a price line.
    if any(w in msg_lower for w in ("predict", "forecast", "prediction", "tomorrow",
                                     "next day", "next two", "next few", "outlook", "going to")):
        fc = context.get("forecast")
        if fc:
            trend = analysis.get("trend") if analysis else None
            extra = f" Momentum is {trend}." if trend else ""
            return (f"{coin_name or 'This asset'} model forecast: {fc}.{extra} "
                    f"Forecasts are probabilistic, not guarantees — manage risk and avoid over-leverage.")

    if coin_name and ("price" in msg_lower or "worth" in msg_lower or "trading" in msg_lower):
        if price:
            trend = analysis.get("trend", "unknown") if analysis else "unknown"
            return (f"{coin_name} is currently trading at ${price:,.2f}. "
                    f"Current trend direction: {trend}. Always use risk management when trading.")
        return f"I don't have the current price for {coin_name}. Please run the full analysis first."

    if "signal" in msg_lower or "should i" in msg_lower or "buy" in msg_lower or "sell" in msg_lower:
        if analysis:
            rsi = analysis.get("rsi", 50)
            macd = analysis.get("macd", "Unknown")
            trend = analysis.get("trend", "Unknown")
            return (f"For {coin_name}: RSI is {rsi:.1f} "
                    f"({('oversold' if rsi < 30 else 'overbought' if rsi > 70 else 'neutral')}), "
                    f"MACD is {macd}, trend is {trend}. Educational analysis only — not financial advice.")
        return ("I need analysis data first. Please run a full analysis on the Intelligence Hub tab. "
                "I can also explain indicators like RSI, MACD and funding rates — just ask!")
    return None


# Chat model cascade via HF Inference Providers (serverless, proper chat API).
# Uses InferenceClient so models run via the provider network — no cold starts
# for widely-used models. Falls back gracefully to the rule-based KB.
_HF_CHAT_MODELS = [
    "meta-llama/Llama-3.1-8B-Instruct",
    "Qwen/Qwen2.5-7B-Instruct",
    "mistralai/Mistral-7B-Instruct-v0.3",
    "microsoft/Phi-4-mini-instruct",
]


def _fmt_num(v):
    try:
        return f"{float(v):,.0f}"
    except (TypeError, ValueError):
        return None


def _build_system_prompt(context: dict) -> str:
    coin = context.get("coinName") or "the crypto market"
    lines = [
        "You are Zorion, an elite crypto market intelligence analyst — the tone of a",
        "Bloomberg analyst, institutional trader and quant researcher combined.",
        "Calm, precise, analytical, confident, never emotional, never hype-driven.",
        "Never say things like 'to the moon' or 'this will explode'. Instead frame",
        "everything as probability: 'structure favours upside continuation', etc.",
        "Answer using the LIVE platform data below. Be concise (under 130 words).",
        "Structure your reply as a brief analyst read: an observation, the supporting",
        "evidence (cite the actual indicators), the key risk, then your conclusion.",
        "Always explain WHY — never give a conclusion without evidence. Always note",
        "risk. This is educational analysis, not financial advice — never tell the",
        "user to definitively buy or sell.",
        f"Asset in focus: {coin}.",
    ]
    recall = context.get("recall")
    if recall:
        lines.append(f"Conversation note: {recall} reference it naturally if relevant.")
    data = []
    price = context.get("currentPrice")
    if price:
        try:
            data.append(f"Price ${float(price):,.2f}")
        except (TypeError, ValueError):
            pass
    if context.get("rsi") is not None:
        data.append(f"RSI(14) {context['rsi']}")
    if context.get("macd"):
        data.append(f"MACD {context['macd']}")
    if context.get("trend"):
        data.append(f"Trend {context['trend']}")
    if context.get("techScore") is not None:
        data.append(f"Tech score {context['techScore']}/100")
    fr = context.get("funding")
    if fr is not None:
        try:
            data.append(f"Funding {float(fr) * 100:.4f}%")
        except (TypeError, ValueError):
            pass
    oi = _fmt_num(context.get("openInterest"))
    if oi:
        data.append(f"Open interest ${oi}")
    if context.get("lsRatio") is not None:
        data.append(f"Long/Short ratio {context['lsRatio']}")
    if context.get("marketBias"):
        data.append(f"Futures bias {context['marketBias']}")
    if context.get("fearGreed"):
        data.append(f"Fear&Greed {context['fearGreed']}")
    if context.get("forecast"):
        data.append(f"7d forecast {context['forecast']}")
    if context.get("portfolio"):
        data.append(f"User portfolio: {context['portfolio']}")
    if data:
        lines.append("LIVE DATA — " + "; ".join(data) + ".")
    return " ".join(lines)


def _format_prompt(model: str, system: str, user: str) -> str:
    m = model.lower()
    if "qwen" in m:
        return (f"<|im_start|>system\n{system}<|im_end|>\n"
                f"<|im_start|>user\n{user}<|im_end|>\n<|im_start|>assistant\n")
    if "mistral" in m:
        return f"<s>[INST] {system}\n\n{user} [/INST]"
    if "phi" in m:
        return f"<|system|>{system}<|end|><|user|>{user}<|end|><|assistant|>"
    return f"{system}\n\nUser: {user}\nAssistant:"


def _clean_llm_text(text: str) -> str:
    if not text:
        return ""
    for tok in ("<|im_end|>", "<|im_start|>", "<|end|>", "<|system|>",
                "<|user|>", "<|assistant|>", "[/INST]", "[INST]", "</s>", "<s>"):
        text = text.replace(tok, " ")
    for cut in ("\nUser:", "\nUSER:", "<|"):
        if cut in text:
            text = text.split(cut)[0]
    return text.strip()


@_fastapi.post("/chat", include_in_schema=False)
def _chat(body: dict):
    message = (body.get("message") or "").strip()
    context = body.get("context") or {}
    if not message:
        return {"response": "Please send a message."}

    rule_resp = _rule_based_response(message, context)
    msg_lower = message.lower()
    wants_llm = any(k in msg_lower for k in (
        "portfolio", "rebalance", "outlook", "summary", "summar", "review",
        "should i", "what happens", "drop", "crash", "risky", "diversif",
        "analyze", "analyse", "my ", "overall", "right now",
        "predict", "forecast", "prediction", "next day", "next two", "tomorrow",
    ))
    if rule_resp and not wants_llm:
        return {"response": rule_resp, "source": "kb"}

    hf_token = os.environ.get("HF_TOKEN", "")
    if hf_token:
        from huggingface_hub import InferenceClient as _HFClient
        system_prompt = _build_system_prompt(context)
        client = _HFClient(token=hf_token)
        for model in _HF_CHAT_MODELS:
            try:
                completion = client.chat_completion(
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": message},
                    ],
                    model=model,
                    max_tokens=220,
                    temperature=0.6,
                    top_p=0.9,
                )
                text = (completion.choices[0].message.content or "").strip()
                if text and len(text) > 10:
                    return {"response": text, "source": "llm", "model": model}
            except Exception:
                continue

    if rule_resp:
        return {"response": rule_resp, "source": "kb"}

    return {
        "response": ("I can help explain crypto trading concepts! Try asking me about: "
                     "RSI, MACD, Bollinger Bands, funding rates, open interest, "
                     "long/short squeeze, ATR, VWAP, support and resistance levels."),
        "source": "fallback",
    }


# ──────────────────────────────────────────────────────────────────────────────
# ML FORECAST API  — called by the Render backend so the ensemble uses real
# Chronos-Bolt and XGBoost instead of statistical approximations.
#
#  POST /api/ml-forecast  {"prices": [float, ...]}   (up to 90 daily closes)
#
#  Returns: {"chronos_bolt_pct": float, "xgboost_pct": float}
#             (% change over 7 days; key absent on error so caller falls back
#              gracefully to its statistical baseline value)
# ──────────────────────────────────────────────────────────────────────────────

@_fastapi.post("/api/ml-forecast", include_in_schema=False)
def api_ml_forecast(body: dict):
    import numpy as _np

    prices_raw = body.get("prices", [])
    if len(prices_raw) < 20:
        return JSONResponse({"error": "Need at least 20 prices"}, status_code=422)

    pa   = _np.array(prices_raw, dtype=_np.float64)
    curr = float(pa[-1])
    out: dict = {}

    # ── Chronos-Bolt (real model) ─────────────────────────────────────
    pipe, _err = load_model()
    if pipe is not None:
        try:
            ctx       = torch.tensor(pa[-60:], dtype=torch.float32).unsqueeze(0)
            q_pred, _ = pipe.predict_quantiles(ctx, prediction_length=7,
                                               quantile_levels=[0.1, 0.5, 0.9])
            # q_pred shape: (1, 7, 3) — take day-7 median (index 1)
            med7 = float(q_pred[0, -1, 1].item())
            out["chronos_bolt_pct"] = round((med7 - curr) / curr * 100, 3)
        except Exception:
            pass  # absent key → backend keeps its statistical fallback

    # ── XGBoost: real XGBRegressor trained on rolling features ────────
    try:
        from xgboost import XGBRegressor
        from sklearn.preprocessing import StandardScaler

        n = len(pa)
        s = pd.Series(pa)
        rsi_a          = calc_rsi(pa)
        ml_v, ms_v, _  = calc_macd(pa)
        e9  = s.ewm(span=9,  adjust=False).mean().values
        e21 = s.ewm(span=21, adjust=False).mean().values
        e50 = s.ewm(span=50, adjust=False).mean().values

        X_rows, y_rows = [], []
        for i in range(50, n - 7):
            p     = pa[i]
            atr_i = float(_np.mean(_np.abs(_np.diff(pa[max(0, i - 14):i + 1]))))
            r5    = (p - pa[i - 5])  / pa[i - 5]  * 100
            r10   = (p - pa[i - 10]) / pa[i - 10] * 100
            r20   = (p - pa[i - 20]) / pa[i - 20] * 100
            X_rows.append([
                float(rsi_a[i]),
                float(ml_v[i] - ms_v[i]),
                (p - e9[i])  / e9[i]  * 100,
                (p - e21[i]) / e21[i] * 100,
                (p - e50[i]) / e50[i] * 100,
                atr_i / p * 100,
                r5, r10, r20,
            ])
            y_rows.append((pa[i + 7] - p) / p * 100)

        if len(X_rows) >= 15:
            Xa, ya = _np.array(X_rows), _np.array(y_rows)
            scaler = StandardScaler()
            Xs     = scaler.fit_transform(Xa)
            xgbr   = XGBRegressor(
                n_estimators=100, learning_rate=0.08,
                max_depth=3, subsample=0.8, random_state=42, verbosity=0,
            )
            xgbr.fit(Xs, ya)

            p     = curr
            atr_c = float(_np.mean(_np.abs(_np.diff(pa[-15:]))))
            feat  = [[
                float(rsi_a[-1]),
                float(ml_v[-1] - ms_v[-1]),
                (p - e9[-1])  / e9[-1]  * 100,
                (p - e21[-1]) / e21[-1] * 100,
                (p - e50[-1]) / e50[-1] * 100,
                atr_c / p * 100,
                (p - pa[-6])  / pa[-6]  * 100 if n >= 6  else 0.0,
                (p - pa[-11]) / pa[-11] * 100 if n >= 11 else 0.0,
                (p - pa[-21]) / pa[-21] * 100 if n >= 21 else 0.0,
            ]]
            out["xgboost_pct"] = round(float(xgbr.predict(scaler.transform(feat))[0]), 3)
    except Exception as xgb_err:
        out["xgboost_error"] = str(xgb_err)

    return out


@_fastapi.get("/api/model-status", include_in_schema=False)
def api_model_status():
    pipe, _ = load_model()
    xgb_ok = False
    try:
        import xgboost  # noqa: F401
        xgb_ok = True
    except ImportError:
        pass
    return {"chronos_bolt": pipe is not None, "xgboost": xgb_ok}


# Gradio AI calculator at /ai  (does NOT override the HTML frontend at /)
app = gr.mount_gradio_app(_fastapi, demo, path="/ai")
