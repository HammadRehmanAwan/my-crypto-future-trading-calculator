"""
FutureX Backend — Render FastAPI deployment.
Endpoints: /health, /firebase-config, /news,
           /futures/{coin_id}, /tokenomics/{coin_id},
           /onchain/{coin_id}, /sentiment, /chat
"""

import os
import time
import re
import asyncio
import httpx
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://hammadrehmanawan.github.io",
        "https://hammadrehman-crypto-futures-calculator.hf.space",
    ],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# ─── Coin → OKX perpetual swap instId ──────────────────────────────
# OKX public market data API works from US servers; Binance fapi is geo-blocked.

OKX_INST_IDS = {
    "bitcoin":       "BTC-USDT-SWAP",
    "ethereum":      "ETH-USDT-SWAP",
    "binancecoin":   "BNB-USDT-SWAP",
    "solana":        "SOL-USDT-SWAP",
    "ripple":        "XRP-USDT-SWAP",
    "cardano":       "ADA-USDT-SWAP",
    "avalanche-2":   "AVAX-USDT-SWAP",
    "dogecoin":      "DOGE-USDT-SWAP",
    "polkadot":      "DOT-USDT-SWAP",
    "matic-network": "MATIC-USDT-SWAP",
    "chainlink":     "LINK-USDT-SWAP",
    "uniswap":       "UNI-USDT-SWAP",
    "litecoin":      "LTC-USDT-SWAP",
    "cosmos":        "ATOM-USDT-SWAP",
    "filecoin":      "FIL-USDT-SWAP",
}

OKX_BASE = "https://www.okx.com"

# ─── Simple in-memory cache ─────────────────────────────────────────

_CACHE: dict = {}


def cache_get(key: str, ttl: float):
    hit = _CACHE.get(key)
    if hit and time.time() - hit["ts"] < ttl:
        return hit["data"]
    return None


def cache_set(key: str, data):
    _CACHE[key] = {"data": data, "ts": time.time()}


# ════════════════════════════════════════════════════════════════════
# HEALTH
# ════════════════════════════════════════════════════════════════════

@app.get("/health")
def health():
    return {"status": "ok"}


# ════════════════════════════════════════════════════════════════════
# FIREBASE CONFIG
# ════════════════════════════════════════════════════════════════════

@app.get("/firebase-config")
def firebase_config():
    return JSONResponse({
        "apiKey":            os.environ.get("FIREBASE_API_KEY", ""),
        "authDomain":        os.environ.get("FIREBASE_AUTH_DOMAIN", ""),
        "projectId":         os.environ.get("FIREBASE_PROJECT_ID", ""),
        "storageBucket":     os.environ.get("FIREBASE_STORAGE_BUCKET", ""),
        "messagingSenderId": os.environ.get("FIREBASE_MESSAGING_SENDER_ID", ""),
        "appId":             os.environ.get("FIREBASE_APP_ID", ""),
        "measurementId":     os.environ.get("FIREBASE_MEASUREMENT_ID", ""),
    })


# ════════════════════════════════════════════════════════════════════
# NEWS  (5-minute cache)
# ════════════════════════════════════════════════════════════════════

_NEWS_TTL = 300


@app.get("/news")
async def get_news():
    cached = cache_get("news", _NEWS_TTL)
    if cached is not None:
        return cached

    now = time.time()
    items: list = []

    # Source 1: CryptoCompare
    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            r = await client.get(
                "https://min-api.cryptocompare.com/data/v2/news/",
                params={
                    "lang": "EN",
                    "sortOrder": "latest",
                    "limit": "30",
                    "categories": "BTC,ETH,SOL,XRP,BNB,Crypto,Regulation,Mining,Technology",
                },
                headers={"User-Agent": "FutureX/1.0"},
            )
            if r.status_code == 200:
                raw = r.json().get("Data", [])
                if isinstance(raw, list):
                    items = [
                        {
                            "title":        a["title"],
                            "url":          a.get("url", ""),
                            "source":       a.get("source", ""),
                            "published_on": a["published_on"],
                        }
                        for a in raw
                        if a.get("title") and a.get("published_on")
                    ]
    except Exception:
        pass

    # Source 2: Hacker News fallback
    if not items:
        try:
            cutoff = int(now) - 7 * 24 * 3600
            async with httpx.AsyncClient(timeout=12.0) as client:
                r = await client.get(
                    "https://hn.algolia.com/api/v1/search_by_date",
                    params={
                        "query": "bitcoin ethereum crypto blockchain solana regulation XRP",
                        "tags": "story",
                        "hitsPerPage": "20",
                        "numericFilters": f"created_at_i>{cutoff}",
                    },
                )
                if r.status_code == 200:
                    hits = r.json().get("hits", [])
                    items = [
                        {
                            "title":        h["title"],
                            "url":          h.get("url") or f"https://news.ycombinator.com/item?id={h['objectID']}",
                            "source":       (h["url"].split("/")[2].replace("www.", "") if h.get("url") else "Hacker News"),
                            "published_on": h["created_at_i"],
                        }
                        for h in hits
                        if h.get("title") and h.get("created_at_i")
                    ]
        except Exception:
            pass

    result = items or []
    if result:
        cache_set("news", result)
    return result


# ════════════════════════════════════════════════════════════════════
# FUTURES  (60-second cache)
# ════════════════════════════════════════════════════════════════════

@app.get("/futures/{coin_id}")
async def get_futures(coin_id: str):
    coin_id = coin_id.lower()
    inst_id = OKX_INST_IDS.get(coin_id)
    if not inst_id:
        return JSONResponse({"error": f"No futures data for {coin_id}"}, status_code=404)

    cached = cache_get(f"futures-{coin_id}", 60)
    if cached is not None:
        return cached

    def safe_float(val, default=0.0):
        try:
            return float(val) if val is not None else default
        except (TypeError, ValueError):
            return default

    def safe_list_item(data, default=None):
        if isinstance(data, list) and data:
            return data[0]
        return default or {}

    def safe_okx(resp, default=None):
        try:
            if isinstance(resp, Exception) or resp.status_code != 200:
                return default
            body = resp.json()
            if body.get("code") != "0":
                return default
            return body.get("data", default)
        except Exception:
            return default

    async with httpx.AsyncClient(timeout=12.0) as client:
        responses = await asyncio.gather(
            # Ticker: last price, 24h vol, price change
            client.get(f"{OKX_BASE}/api/v5/market/ticker", params={"instId": inst_id}),
            # Funding rate
            client.get(f"{OKX_BASE}/api/v5/public/funding-rate", params={"instId": inst_id}),
            # Open interest (in USD)
            client.get(f"{OKX_BASE}/api/v5/public/open-interest",
                       params={"instType": "SWAP", "instId": inst_id}),
            # Long/Short account ratio (public endpoint, no auth needed)
            client.get(f"{OKX_BASE}/api/v5/rubik/stat/contracts/long-short-account-ratio",
                       params={"ccy": inst_id.split("-")[0], "period": "5m", "limit": "1"}),
            return_exceptions=True,
        )

    ticker_list = safe_okx(responses[0], [])
    fr_list     = safe_okx(responses[1], [])
    oi_list     = safe_okx(responses[2], [])
    ls_list     = safe_okx(responses[3], [])

    ticker = safe_list_item(ticker_list)
    fr     = safe_list_item(fr_list)
    oi     = safe_list_item(oi_list)
    ls     = safe_list_item(ls_list)

    last_price     = safe_float(ticker.get("last"))
    vol_24h_ccy    = safe_float(ticker.get("volCcy24h"))   # volume in quote currency (USDT)
    open_24h       = safe_float(ticker.get("open24h"))
    price_change   = ((last_price - open_24h) / open_24h * 100) if open_24h else 0.0

    funding_rate   = safe_float(fr.get("fundingRate"))     # e.g. 0.0001 = 0.01%/8h

    # OKX oiCcy = OI in base currency; oiUsd = OI in USD (if present)
    oi_usd         = safe_float(oi.get("oiUsd") or oi.get("oiCcy", 0)) * (
        last_price if not oi.get("oiUsd") else 1.0
    )

    # Long/Short ratio — OKX returns longShortRatio directly
    ls_ratio       = safe_float(ls.get("longShortRatio"), 1.0)
    long_pct       = round(ls_ratio / (1 + ls_ratio) * 100, 1) if ls_ratio else 50.0
    short_pct      = round(100 - long_pct, 1)

    # Derived signals
    fr_pct = funding_rate * 100   # as percentage
    long_squeeze_risk  = round(min(100, max(0, (ls_ratio - 1) * 40 + max(0,  fr_pct) * 50)), 1)
    short_squeeze_risk = round(min(100, max(0, (1 - ls_ratio) * 40 + max(0, -fr_pct) * 50)), 1)

    if ls_ratio > 1.1 and funding_rate > 0:
        market_bias = "Bullish"
    elif ls_ratio < 0.9 and funding_rate < 0:
        market_bias = "Bearish"
    else:
        market_bias = "Neutral"

    result = {
        "coin_id":              coin_id,
        "inst_id":              inst_id,
        "source":               "OKX",
        "open_interest":        round(oi_usd, 0),
        "funding_rate":         funding_rate,
        "ls_ratio":             round(ls_ratio, 3),
        "long_pct":             long_pct,
        "short_pct":            short_pct,
        "volume_24h":           round(vol_24h_ccy, 0),
        "price_change_pct":     round(price_change, 2),
        "long_squeeze_risk":    long_squeeze_risk,
        "short_squeeze_risk":   short_squeeze_risk,
        "market_bias":          market_bias,
    }
    cache_set(f"futures-{coin_id}", result)
    return result


# ════════════════════════════════════════════════════════════════════
# TOKENOMICS  (10-minute cache)
# ════════════════════════════════════════════════════════════════════

@app.get("/tokenomics/{coin_id}")
async def get_tokenomics(coin_id: str):
    coin_id = coin_id.lower()
    cached = cache_get(f"tokenomics-{coin_id}", 600)
    if cached is not None:
        return cached

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(
                f"https://api.coingecko.com/api/v3/coins/{coin_id}",
                params={
                    "localization": "false",
                    "tickers": "false",
                    "market_data": "true",
                    "community_data": "false",
                    "developer_data": "false",
                },
                headers={"User-Agent": "FutureX/1.0"},
            )
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=502)

    if r.status_code != 200:
        return JSONResponse({"error": f"CoinGecko returned {r.status_code}"}, status_code=r.status_code)

    data = r.json()
    md   = data.get("market_data", {})

    market_cap = md.get("market_cap", {}).get("usd") or 0
    fdv        = md.get("fully_diluted_valuation", {}).get("usd") or 0
    circ_sup   = md.get("circulating_supply") or 0
    total_sup  = md.get("total_supply") or circ_sup or 1
    max_sup    = md.get("max_supply") or total_sup or 1

    circulation_ratio = circ_sup / max_sup if max_sup > 0 else 1.0
    fdv_mc_ratio      = fdv / market_cap if market_cap > 0 else 1.0
    ath_chg           = md.get("ath_change_percentage", {}).get("usd") or 0

    # Tokenomics score (0–100)
    score = 70
    if fdv_mc_ratio > 5:   score -= 25
    elif fdv_mc_ratio > 3: score -= 15
    elif fdv_mc_ratio > 2: score -= 8

    if circulation_ratio < 0.3:  score -= 15
    elif circulation_ratio < 0.5: score -= 8

    # Inflation proxy: total_supply growth
    price_chg_1y = md.get("price_change_percentage_1y") or 0
    if price_chg_1y < -50: score -= 10

    score = max(0, min(100, score))

    result = {
        "coin_id":            coin_id,
        "market_cap":         market_cap,
        "fdv":                fdv,
        "circulating_supply": circ_sup,
        "total_supply":       total_sup,
        "max_supply":         max_sup,
        "circulation_ratio":  round(circulation_ratio, 4),
        "fdv_mc_ratio":       round(fdv_mc_ratio, 4),
        "ath_change_percentage": round(ath_chg, 2),
        "tokenomics_score":   score,
    }
    cache_set(f"tokenomics-{coin_id}", result)
    return result


# ════════════════════════════════════════════════════════════════════
# ON-CHAIN  (10-minute cache)
# ════════════════════════════════════════════════════════════════════

@app.get("/onchain/{coin_id}")
async def get_onchain(coin_id: str):
    coin_id = coin_id.lower()
    cached = cache_get(f"onchain-{coin_id}", 600)
    if cached is not None:
        return cached

    # CoinGecko community + developer data
    cg_data = {}
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(
                f"https://api.coingecko.com/api/v3/coins/{coin_id}",
                params={
                    "localization": "false",
                    "tickers": "false",
                    "market_data": "true",
                    "community_data": "true",
                    "developer_data": "true",
                },
                headers={"User-Agent": "FutureX/1.0"},
            )
            if r.status_code == 200:
                cg_data = r.json()
    except Exception:
        pass

    dev  = cg_data.get("developer_data", {})
    comm = cg_data.get("community_data", {})
    md   = cg_data.get("market_data", {})

    github_commits_4w = dev.get("commit_count_4_weeks") or 0
    reddit_active_48h = comm.get("reddit_active_accounts_48h") or 0

    market_cap = md.get("market_cap", {}).get("usd") or 1
    volume_24h = md.get("total_volume", {}).get("usd") or 0
    volume_mc_ratio = volume_24h / market_cap if market_cap > 0 else 0

    # BTC-specific on-chain data
    btc_transactions_24h = None
    btc_hash_rate        = None
    if coin_id == "bitcoin":
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                reqs = [
                    client.get("https://blockchain.info/q/24hrtransactioncount"),
                    client.get("https://blockchain.info/q/hashrate"),
                ]
                resps = await asyncio.gather(*reqs, return_exceptions=True)
            if not isinstance(resps[0], Exception) and resps[0].status_code == 200:
                btc_transactions_24h = int(resps[0].text.strip())
            if not isinstance(resps[1], Exception) and resps[1].status_code == 200:
                btc_hash_rate = float(resps[1].text.strip()) * 1e9  # GH/s → H/s
        except Exception:
            pass

    # Derived scores
    acc_score  = 50
    dist_score = 50

    if github_commits_4w > 100: acc_score += 15
    elif github_commits_4w > 30: acc_score += 8

    if reddit_active_48h > 5000: acc_score += 10
    elif reddit_active_48h > 1000: acc_score += 5

    if volume_mc_ratio > 0.15: acc_score -= 10; dist_score += 15
    elif volume_mc_ratio > 0.05: dist_score += 5

    acc_score  = max(0, min(100, acc_score))
    dist_score = max(0, min(100, dist_score))

    result = {
        "coin_id":              coin_id,
        "github_commits_4w":    github_commits_4w,
        "reddit_active_48h":    reddit_active_48h,
        "volume_mc_ratio":      round(volume_mc_ratio, 6),
        "accumulation_score":   acc_score,
        "distribution_score":   dist_score,
        "btc_transactions_24h": btc_transactions_24h,
        "btc_hash_rate":        btc_hash_rate,
    }
    cache_set(f"onchain-{coin_id}", result)
    return result


# ════════════════════════════════════════════════════════════════════
# SENTIMENT  (HF Inference API proxy with keyword fallback)
# ════════════════════════════════════════════════════════════════════

_SENT_POS = {
    "rally", "surge", "bullish", "bull", "gain", "soar", "rise", "risen", "jump",
    "climb", "recover", "breakout", "adoption", "institutional", "partnership",
    "approve", "approval", "stable", "growth", "demand", "positive", "optimistic",
    "strong", "boom", "increase", "profit", "buy", "accumulate", "inflow", "momentum",
    "higher", "green", "support", "record", "ath", "expand", "boost", "rebound",
}
_SENT_NEG = {
    "crash", "dump", "drop", "plunge", "bear", "bearish", "decline", "fall",
    "selloff", "hack", "exploit", "fraud", "scam", "ban", "restrict", "fine",
    "penalty", "investigation", "lawsuit", "liquidation", "bankrupt", "fear",
    "warning", "threat", "crisis", "collapse", "fail", "loss", "risk", "dangerous",
    "problem", "breach", "outflow", "correction", "stolen", "theft", "shutdown",
    "contagion", "scandal", "bubble", "downturn", "pessimistic", "lower", "red",
    "tumble", "slump", "plummet", "wipeout",
}


def _keyword_sentiment(text: str) -> dict:
    words = re.sub(r"[^a-z\s-]", " ", text.lower()).split()
    pos = sum(1 for w in words if w in _SENT_POS)
    neg = sum(1 for w in words if w in _SENT_NEG)
    total = max(1, pos + neg)
    if pos > neg:
        label = "positive"
    elif neg > pos:
        label = "negative"
    else:
        label = "neutral"
    return {
        "label":    label,
        "positive": pos / total,
        "negative": neg / total,
        "neutral":  max(0, 1 - pos / total - neg / total),
        "source":   "keyword",
    }


@app.get("/sentiment")
async def get_sentiment(text: str = Query(..., max_length=512)):
    hf_token = os.environ.get("HF_TOKEN", "")
    if hf_token:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                # ProsusAI/finbert — purpose-built financial sentiment model.
                r = await client.post(
                    "https://api-inference.huggingface.co/models/ProsusAI/finbert",
                    headers={"Authorization": f"Bearer {hf_token}"},
                    json={"inputs": text[:512]},
                )
                if r.status_code == 200:
                    results = r.json()
                    if isinstance(results, list) and results:
                        scores = results[0] if isinstance(results[0], list) else results
                        label_map = {"LABEL_0": "negative", "LABEL_1": "neutral", "LABEL_2": "positive",
                                     "negative": "negative", "neutral": "neutral", "positive": "positive"}
                        best = max(scores, key=lambda x: x.get("score", 0))
                        label = label_map.get(best.get("label", "neutral"), "neutral")
                        return {
                            "label":  label,
                            "scores": {label_map.get(s["label"], s["label"]): s["score"] for s in scores},
                            "source": "finbert",
                        }
        except Exception:
            pass

    return _keyword_sentiment(text)


# ════════════════════════════════════════════════════════════════════
# CHAT  (Rule-based + optional HF Inference enhancement)
# ════════════════════════════════════════════════════════════════════

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


def _rule_based_response(message: str, context: dict) -> str | None:
    msg_lower = message.lower()
    for keyword, explanation in _CHAT_KB.items():
        if keyword in msg_lower:
            return explanation

    # Coin-context responses
    coin_name = context.get("coinName", "")
    price     = context.get("currentPrice")
    analysis  = context.get("analysis")

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
                    f"Current trend direction: {trend}. "
                    f"Always use risk management when trading.")
        return f"I don't have the current price for {coin_name}. Please run the full analysis first."

    if "signal" in msg_lower or "should i" in msg_lower or "buy" in msg_lower or "sell" in msg_lower:
        if analysis:
            rsi  = analysis.get("rsi", 50)
            macd = analysis.get("macd", "Unknown")
            trend= analysis.get("trend", "Unknown")
            return (f"For {coin_name}: RSI is {rsi:.1f} ({('oversold' if rsi<30 else 'overbought' if rsi>70 else 'neutral')}), "
                    f"MACD is {macd}, trend is {trend}. "
                    f"This is educational analysis only — not financial advice. "
                    f"Use the full Intelligence Hub analysis for detailed signals.")
        return ("I need analysis data first. Please run a full analysis on the Intelligence Hub tab. "
                "I can explain indicators like RSI, MACD, funding rates, and more — just ask!")

    return None


# ── HF Inference model cascade (free serverless tier) ──────────────
# Tried in order; first one that responds wins. 7B models give the richest
# answers but may be cold/unavailable on the free tier — we fall back to the
# smaller instruct model and finally to the rule-based KB so chat never dies.
_HF_CHAT_MODELS = [
    "Qwen/Qwen2.5-7B-Instruct",
    "mistralai/Mistral-7B-Instruct-v0.3",
    "microsoft/Phi-4-mini-instruct",
    "Qwen/Qwen2.5-0.5B-Instruct",
]


def _fmt_num(v):
    try:
        return f"{float(v):,.0f}"
    except (TypeError, ValueError):
        return None


def _build_system_prompt(context: dict) -> str:
    """Inject the live platform data the frontend collected into the prompt."""
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
    """Each instruct family expects its own chat template."""
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
    """Strip chat-template artifacts a model may echo back."""
    if not text:
        return ""
    for tok in ("<|im_end|>", "<|im_start|>", "<|end|>", "<|system|>",
                "<|user|>", "<|assistant|>", "[/INST]", "[INST]", "</s>", "<s>"):
        text = text.replace(tok, " ")
    # Some models continue with a fresh turn — keep only the first one.
    for cut in ("\nUser:", "\nUSER:", "<|"):
        if cut in text:
            text = text.split(cut)[0]
    return text.strip()


@app.post("/chat")
async def chat(body: dict):
    message = (body.get("message") or "").strip()
    context = body.get("context") or {}

    if not message:
        return {"response": "Please send a message."}

    rule_resp = _rule_based_response(message, context)

    # Portfolio / outlook / scenario questions benefit from the LLM even when a
    # KB keyword matches — let those reach the model; pure definitions short-circuit.
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
        system_prompt = _build_system_prompt(context)
        try:
            async with httpx.AsyncClient(timeout=18.0) as client:
                for model in _HF_CHAT_MODELS:
                    try:
                        r = await client.post(
                            f"https://api-inference.huggingface.co/models/{model}",
                            headers={"Authorization": f"Bearer {hf_token}"},
                            json={
                                "inputs": _format_prompt(model, system_prompt, message),
                                "parameters": {
                                    "max_new_tokens": 220,
                                    "temperature": 0.6,
                                    "top_p": 0.9,
                                    "do_sample": True,
                                    "return_full_text": False,
                                },
                                "options": {"wait_for_model": False},
                            },
                        )
                        if r.status_code == 200:
                            resp_json = r.json()
                            if isinstance(resp_json, list) and resp_json:
                                text = _clean_llm_text(resp_json[0].get("generated_text", ""))
                                if text:
                                    return {"response": text, "source": "llm", "model": model}
                        # 503 = model loading, 404 = unavailable → try the next one.
                    except Exception:
                        continue
        except Exception:
            pass

    if rule_resp:
        return {"response": rule_resp, "source": "kb"}

    # Generic fallback
    return {
        "response": (
            "I can help explain crypto trading concepts! Try asking me about: "
            "RSI, MACD, Bollinger Bands, funding rates, open interest, "
            "long/short squeeze, ATR, VWAP, support and resistance levels."
        ),
        "source": "fallback",
    }


# ════════════════════════════════════════════════════════════════════
# ENSEMBLE FORECAST  (5-minute cache)
# 5-model pure-Python forecasting engine: chronos_bolt, chronos_2,
# timesfm, lstm, xgboost
# ════════════════════════════════════════════════════════════════════

# ── Helper: pure-Python math primitives ─────────────────────────────

def _clamp_f(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _ema_py(vals: list, n: int) -> list:
    """Return list of EMA values same length as vals (warm-up via SMA)."""
    if not vals or n <= 0:
        return list(vals)
    k = 2.0 / (n + 1)
    result = []
    sma = sum(vals[:n]) / n if len(vals) >= n else sum(vals) / len(vals)
    for i, v in enumerate(vals):
        if i < n:
            # during warm-up use running average
            result.append(sum(vals[:i + 1]) / (i + 1))
        elif i == n:
            result.append(sma)
        else:
            result.append(v * k + result[-1] * (1 - k))
    return result


def _rsi_py(prices: list, n: int = 14) -> float:
    """RSI over last n+1 prices."""
    if len(prices) < n + 1:
        return 50.0
    gains, losses = [], []
    for i in range(1, n + 1):
        diff = prices[-(n + 1 - i + 1)] - prices[-(n + 1 - i + 1) - 1] if False else 0
        # simpler: iterate last n changes
    deltas = [prices[i] - prices[i - 1] for i in range(max(1, len(prices) - n), len(prices))]
    gains = [d for d in deltas if d > 0]
    losses = [-d for d in deltas if d < 0]
    avg_gain = sum(gains) / n if gains else 0.0
    avg_loss = sum(losses) / n if losses else 0.0
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - (100.0 / (1 + rs))


def _macd_py(prices: list):
    """Return (macd_val, signal_val) tuple using EMA-12, EMA-26, signal-9."""
    if len(prices) < 26:
        return 0.0, 0.0
    ema12 = _ema_py(prices, 12)
    ema26 = _ema_py(prices, 26)
    macd_line = [ema12[i] - ema26[i] for i in range(len(prices))]
    signal_line = _ema_py(macd_line, 9)
    return macd_line[-1], signal_line[-1]


def _atr_py(prices: list, n: int = 14) -> float:
    """Simplified ATR: mean of abs daily changes over last n periods."""
    if len(prices) < 2:
        return 0.0
    changes = [abs(prices[i] - prices[i - 1]) for i in range(max(1, len(prices) - n), len(prices))]
    return sum(changes) / len(changes) if changes else 0.0


def _ols_slope(vals: list) -> float:
    """OLS linear regression slope (units per step)."""
    n = len(vals)
    if n < 2:
        return 0.0
    xs = list(range(n))
    mx = sum(xs) / n
    my = sum(vals) / n
    num = sum((xs[i] - mx) * (vals[i] - my) for i in range(n))
    den = sum((xs[i] - mx) ** 2 for i in range(n))
    return num / den if den else 0.0


def _score(pct: float) -> float:
    """Convert % change to -1..+1."""
    return _clamp_f(pct / 10.0, -1.0, 1.0)


# ── Regime detection ─────────────────────────────────────────────────

def _detect_regime_ens(prices: list) -> str:
    if len(prices) < 50:
        return "sideways"
    e9  = _ema_py(prices, 9)[-1]
    e21 = _ema_py(prices, 21)[-1]
    e50 = _ema_py(prices, 50)[-1]
    price = prices[-1]
    p20 = prices[-21] if len(prices) >= 21 else prices[0]
    mom20 = (price - p20) / p20 * 100 if p20 else 0.0
    if price > e9 > e21 > e50 and mom20 > 3.0:
        return "bull"
    if price < e9 < e21 < e50 and mom20 < -3.0:
        return "bear"
    return "sideways"


# ── Individual forecasting models ────────────────────────────────────

def _model_chronos_bolt(prices: list) -> float:
    """Short-window ETS (alpha=0.55, 10-day window), slight amplification ×1.1."""
    window = prices[-10:] if len(prices) >= 10 else prices
    if not window:
        return 0.0
    alpha = 0.55
    level = window[0]
    for p in window[1:]:
        level = alpha * p + (1 - alpha) * level
    forecast = level * 1.1
    pct = (forecast - prices[-1]) / prices[-1] * 100 if prices[-1] else 0.0
    return _clamp_f(pct, -20.0, 20.0)


def _model_chronos_2(prices: list) -> float:
    """Damped Holt-Winters (alpha=0.30, beta=0.08, phi=0.88, 30-day window),
    7-day damped trend extrapolation."""
    window = prices[-30:] if len(prices) >= 30 else prices
    if len(window) < 2:
        return 0.0
    alpha, beta, phi = 0.30, 0.08, 0.88
    level = window[0]
    trend = window[1] - window[0]
    for p in window[1:]:
        prev_level = level
        level = alpha * p + (1 - alpha) * (prev_level + phi * trend)
        trend = beta * (level - prev_level) + (1 - beta) * phi * trend
    # 7-day damped extrapolation
    forecast_price = level
    damp = 1.0
    for _ in range(7):
        damp *= phi
        forecast_price += damp * trend
    pct = (forecast_price - prices[-1]) / prices[-1] * 100 if prices[-1] else 0.0
    return _clamp_f(pct, -25.0, 25.0)


def _model_timesfm(prices: list) -> float:
    """OLS linear regression slope on 60-day window × 7 days, clamped ±25%."""
    window = prices[-60:] if len(prices) >= 60 else prices
    if len(window) < 2:
        return 0.0
    slope = _ols_slope(window)
    forecast_price = prices[-1] + slope * 7
    pct = (forecast_price - prices[-1]) / prices[-1] * 100 if prices[-1] else 0.0
    return _clamp_f(pct, -25.0, 25.0)


def _model_lstm(prices: list, rsi: float, macd_v: float, sig_v: float) -> float:
    """Exponentially-weighted memory on last 20 prices + RSI/MACD boosts."""
    window = prices[-20:] if len(prices) >= 20 else prices
    if not window:
        return 0.0
    n = len(window)
    weights = [0.5 ** (n - 1 - i) for i in range(n)]
    total_w = sum(weights)
    weighted_price = sum(weights[i] * window[i] for i in range(n)) / total_w if total_w else window[-1]
    pct = (weighted_price - prices[-1]) / prices[-1] * 100 if prices[-1] else 0.0
    # RSI reversal boosts
    if rsi < 28:
        pct += 4.5
    elif rsi > 72:
        pct -= 4.5
    elif rsi < 36:
        pct += 2.0
    elif rsi > 65:
        pct -= 2.0
    # MACD direction bonus
    if macd_v > sig_v:
        pct += 1.5
    elif macd_v < sig_v:
        pct -= 1.5
    return _clamp_f(pct, -20.0, 20.0)


def _model_xgboost(prices: list, rsi: float, macd_v: float, sig_v: float,
                   atr: float, e9: float, e21: float, e50: float) -> float:
    """Feature-weighted scoring combining RSI, MACD, EMA alignment, volatility,
    returns, and momentum."""
    price = prices[-1] if prices else 0.0

    # RSI feature (weight 0.22)
    rsi_val = (50 - rsi) * 0.30

    # MACD feature (weight 0.18)
    macd_val = 3.0 if macd_v > sig_v else -3.0

    # EMA alignment feature (weight 0.25), centered at -6
    ema_val = 0.0
    if price > e9:
        ema_val += 2
    if price > e21:
        ema_val += 3
    if price > e50:
        ema_val += 5
    if e9 > e21:
        ema_val += 2
    ema_val -= 6  # center

    # Volatility feature (weight 0.10): negative ATR pct, capped at -5
    atr_pct = atr / price * 100 if price else 0.0
    vol_val = max(-5.0, -atr_pct * 0.5)

    # Return feature (weight 0.15)
    p7  = prices[-8]  if len(prices) >= 8  else prices[0]
    p14 = prices[-15] if len(prices) >= 15 else prices[0]
    ret7  = (price - p7)  / p7  * 100 if p7  else 0.0
    ret14 = (price - p14) / p14 * 100 if p14 else 0.0
    ret_val = ret7 * 0.4 + ret14 * 0.2

    # Momentum feature (weight 0.10): OLS slope over last 14 prices × 14d × 0.3
    mom_window = prices[-14:] if len(prices) >= 14 else prices
    slope = _ols_slope(mom_window)
    mom_val = _clamp_f(slope * 14 / prices[-1] * 100 * 0.3 if prices[-1] else 0.0, -10.0, 10.0)

    score = (rsi_val * 0.22 + macd_val * 0.18 + ema_val * 0.25
             + vol_val * 0.10 + ret_val * 0.15 + mom_val * 0.10) * 10
    return _clamp_f(score, -20.0, 20.0)


# ── HF Space real-model bridge ───────────────────────────────────────

HF_SPACE_URL = "https://hammadrehman-crypto-futures-calculator.hf.space"


async def _call_hf_ml_models(prices: list) -> dict:
    """Call HF Space /api/ml-forecast. Returns {} on any failure."""
    try:
        async with httpx.AsyncClient(timeout=25.0) as client:
            r = await client.post(
                f"{HF_SPACE_URL}/api/ml-forecast",
                json={"prices": prices},
            )
            if r.status_code == 200:
                return r.json()
    except Exception:
        pass
    return {}


# ── Endpoint ─────────────────────────────────────────────────────────

@app.get("/ensemble-forecast/{coin_id}")
async def ensemble_forecast(coin_id: str):
    coin_id = coin_id.lower()

    cached = cache_get(f"ensemble-{coin_id}", 300)
    if cached is not None:
        return cached

    # Fetch 90 days of daily prices from CoinGecko
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(
                f"https://api.coingecko.com/api/v3/coins/{coin_id}/market_chart",
                params={"vs_currency": "usd", "days": "90", "interval": "daily"},
                headers={"User-Agent": "FutureX/1.0"},
            )
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=502)

    if r.status_code != 200:
        return JSONResponse(
            {"error": f"CoinGecko returned {r.status_code}"}, status_code=502
        )

    try:
        raw = r.json()
        prices = [p[1] for p in raw.get("prices", [])]
    except Exception as e:
        return JSONResponse({"error": f"Failed to parse prices: {e}"}, status_code=502)

    if len(prices) < 15:
        return JSONResponse({"error": "Insufficient price history"}, status_code=502)

    # ── Compute shared indicators ────────────────────────────────────
    price  = prices[-1]
    rsi    = _rsi_py(prices)
    macd_v, sig_v = _macd_py(prices)
    atr    = _atr_py(prices)
    atr_pct = atr / price * 100 if price else 0.0

    e9_series  = _ema_py(prices, 9)
    e21_series = _ema_py(prices, 21)
    e50_series = _ema_py(prices, 50)
    e9, e21, e50 = e9_series[-1], e21_series[-1], e50_series[-1]

    # ── Run individual models (statistical fallbacks) ────────────────
    pct_chronos_bolt = _model_chronos_bolt(prices)
    pct_chronos_2    = _model_chronos_2(prices)
    pct_timesfm      = _model_timesfm(prices)
    pct_lstm         = _model_lstm(prices, rsi, macd_v, sig_v)
    pct_xgboost      = _model_xgboost(prices, rsi, macd_v, sig_v, atr, e9, e21, e50)

    # ── Override with real ML predictions from HF Space ──────────────
    hf_preds  = await _call_hf_ml_models(prices)
    ml_powered: dict = {}

    if "chronos_bolt_pct" in hf_preds:
        pct_chronos_bolt = _clamp_f(float(hf_preds["chronos_bolt_pct"]), -20.0, 20.0)
        ml_powered["chronos_bolt"] = True

    if "chronos_2_pct" in hf_preds:
        pct_chronos_2 = _clamp_f(float(hf_preds["chronos_2_pct"]), -25.0, 25.0)
        ml_powered["chronos_2"] = True

    if "xgboost_pct" in hf_preds:
        pct_xgboost = _clamp_f(float(hf_preds["xgboost_pct"]), -20.0, 20.0)
        ml_powered["xgboost"] = True

    # ── Convert pct → -1..+1 scores ─────────────────────────────────
    sc_chronos_bolt = _score(pct_chronos_bolt)
    sc_chronos_2    = _score(pct_chronos_2)
    sc_timesfm      = _score(pct_timesfm)
    sc_lstm         = _score(pct_lstm)
    sc_xgboost      = _score(pct_xgboost)

    # ── Regime detection & weight adjustment ─────────────────────────
    regime = _detect_regime_ens(prices)

    w = {
        "chronos_bolt": 0.20,
        "chronos_2":    0.30,
        "timesfm":      0.20,
        "lstm":         0.15,
        "xgboost":      0.15,
    }

    if regime == "bull":
        w["chronos_2"]    += 0.08
        w["timesfm"]      += 0.05
        w["lstm"]         -= 0.07
        w["xgboost"]      -= 0.06
    elif regime == "bear":
        w["lstm"]         += 0.08
        w["xgboost"]      += 0.07
        w["chronos_2"]    -= 0.05
        w["timesfm"]      -= 0.10
    else:  # sideways
        w["xgboost"]      += 0.05
        w["chronos_bolt"] += 0.03
        w["timesfm"]      -= 0.08

    # Renormalize weights to sum = 1
    total_w = sum(w.values())
    w = {k: v / total_w for k, v in w.items()}

    # ── Weighted ensemble score ──────────────────────────────────────
    model_scores = {
        "chronos_bolt": sc_chronos_bolt,
        "chronos_2":    sc_chronos_2,
        "timesfm":      sc_timesfm,
        "lstm":         sc_lstm,
        "xgboost":      sc_xgboost,
    }
    final_score = sum(model_scores[k] * w[k] for k in w)

    # ── Signal ───────────────────────────────────────────────────────
    if final_score >= 0.30:
        ensemble_signal = "BUY"
    elif final_score <= -0.30:
        ensemble_signal = "SELL"
    else:
        ensemble_signal = "HOLD"

    # ── Confidence ───────────────────────────────────────────────────
    scores_list = list(model_scores.values())
    mean_s = sum(scores_list) / len(scores_list)
    variance = sum((s - mean_s) ** 2 for s in scores_list) / len(scores_list)
    stddev = variance ** 0.5
    agreement = max(0.0, 1.0 - stddev * 1.5)
    vol_adj = max(0.5, 1.0 - atr_pct / 20.0)
    confidence = min(0.95, agreement * vol_adj)

    result = {
        "asset":            coin_id,
        "ensemble_signal":  ensemble_signal,
        "final_score":      round(final_score, 4),
        "confidence":       round(confidence, 4),
        "regime":           regime,
        "weights": {k: round(v, 4) for k, v in w.items()},
        "model_scores": {k: round(v, 4) for k, v in model_scores.items()},
        "model_pct": {
            "chronos_bolt": round(pct_chronos_bolt, 4),
            "chronos_2":    round(pct_chronos_2, 4),
            "timesfm":      round(pct_timesfm, 4),
            "lstm":         round(pct_lstm, 4),
            "xgboost":      round(pct_xgboost, 4),
        },
        "ml_powered": ml_powered,
        "indicators": {
            "rsi":     round(rsi, 4),
            "atr_pct": round(atr_pct, 4),
            "ema9":    round(e9, 4),
            "ema21":   round(e21, 4),
            "ema50":   round(e50, 4),
            "price":   round(price, 4),
        },
        "price_history": [round(p, 4) for p in prices[-8:]],
    }

    cache_set(f"ensemble-{coin_id}", result)
    return result


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
