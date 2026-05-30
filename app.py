"""
Crypto Futures Trading Calculator
Powered by Amazon Chronos-T5-Small (Hugging Face) + CoinGecko API
"""

import warnings
warnings.filterwarnings("ignore")

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
        from chronos import ChronosPipeline
        _pipeline = ChronosPipeline.from_pretrained(
            "amazon/chronos-t5-small",
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
    params = {"vs_currency": "usd", "days": days, "interval": "daily"}
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
        forecast = pipe.predict(
            context=context,
            prediction_length=horizon,
            num_samples=100,
        )
        samples = forecast[0].numpy()          # (100, horizon)
        lo  = np.quantile(samples, 0.10, axis=0)
        med = np.quantile(samples, 0.50, axis=0)
        hi  = np.quantile(samples, 0.90, axis=0)
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
        title=f"{coin_label} — Chronos-T5 AI Price Forecast",
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
            bullets.append(f"🟢 Chronos AI forecasts **+{chg:.1f}%** over {h} days"); score += 2
        elif chg < -2:
            bullets.append(f"🔴 Chronos AI forecasts **{chg:.1f}%** over {h} days"); score -= 2
        else:
            bullets.append(f"🟡 Chronos AI sees minimal move ({chg:+.1f}%)")

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
### Powered by [Amazon Chronos-T5-Small](https://huggingface.co/amazon/chronos-t5-small) · CoinGecko · RSI · MACD · Bollinger Bands

> **Chronos-T5-Small** is Amazon's state-of-the-art zero-shot probabilistic time-series model,
> pre-trained on **27 billion data points** — the most accurate open-source crypto forecasting model on Hugging Face.
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
| **AI Model** | [amazon/chronos-t5-small](https://huggingface.co/amazon/chronos-t5-small) — zero-shot probabilistic time-series forecasting |
| **Price Data** | CoinGecko free public API (no API key required) |
| **Indicators** | RSI(14), MACD(12/26/9), Bollinger Bands(20, 2σ) |
| **Futures Math** | Liquidation price, PnL, ROE, Risk/Reward ratio |
| **Trade Signal** | Composite score from AI + 3 technical indicators |

⚠️ *For educational purposes only. Crypto trading carries significant risk. Not financial advice.*
    """)

if __name__ == "__main__":
    demo.launch()
