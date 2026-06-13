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

# ─── Coin → Binance symbol mapping ─────────────────────────────────

BINANCE_SYMBOLS = {
    "bitcoin":       "BTCUSDT",
    "ethereum":      "ETHUSDT",
    "binancecoin":   "BNBUSDT",
    "solana":        "SOLUSDT",
    "ripple":        "XRPUSDT",
    "cardano":       "ADAUSDT",
    "avalanche-2":   "AVAXUSDT",
    "dogecoin":      "DOGEUSDT",
    "polkadot":      "DOTUSDT",
    "matic-network": "MATICUSDT",
    "chainlink":     "LINKUSDT",
    "uniswap":       "UNIUSDT",
    "litecoin":      "LTCUSDT",
    "cosmos":        "ATOMUSDT",
    "filecoin":      "FILUSDT",
}

BINANCE_BASE = "https://fapi.binance.com"

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
    symbol = BINANCE_SYMBOLS.get(coin_id)
    if not symbol:
        return JSONResponse({"error": f"No Binance symbol for {coin_id}"}, status_code=404)

    cached = cache_get(f"futures-{coin_id}", 60)
    if cached is not None:
        return cached

    async with httpx.AsyncClient(timeout=10.0) as client:
        reqs = [
            client.get(f"{BINANCE_BASE}/fapi/v1/openInterest", params={"symbol": symbol}),
            client.get(f"{BINANCE_BASE}/fapi/v1/fundingRate", params={"symbol": symbol, "limit": 1}),
            client.get(f"{BINANCE_BASE}/futures/data/globalLongShortAccountRatio",
                       params={"symbol": symbol, "period": "5m", "limit": 1}),
            client.get(f"{BINANCE_BASE}/futures/data/topLongShortPositionRatio",
                       params={"symbol": symbol, "period": "5m", "limit": 1}),
            client.get(f"{BINANCE_BASE}/futures/data/takerlongshortRatio",
                       params={"symbol": symbol, "period": "5m", "limit": 1}),
            client.get(f"{BINANCE_BASE}/fapi/v1/ticker/24hr", params={"symbol": symbol}),
        ]
        responses = await asyncio.gather(*reqs, return_exceptions=True)

    def safe_json(resp, default=None):
        try:
            if isinstance(resp, Exception):
                return default
            if resp.status_code != 200:
                return default
            return resp.json()
        except Exception:
            return default

    oi_data       = safe_json(responses[0], {})
    fr_data       = safe_json(responses[1], [{}])
    ls_data       = safe_json(responses[2], [{}])
    top_ls_data   = safe_json(responses[3], [{}])
    taker_data    = safe_json(responses[4], [{}])
    ticker_data   = safe_json(responses[5], {})

    fr_list    = fr_data if isinstance(fr_data, list) else [{}]
    ls_list    = ls_data if isinstance(ls_data, list) else [{}]
    taker_list = taker_data if isinstance(taker_data, list) else [{}]

    open_interest = float(oi_data.get("openInterest", 0)) if oi_data else 0
    # openInterest from Binance is in contracts (base asset units), multiply by mark price
    mark_price = float(ticker_data.get("lastPrice", 0)) if ticker_data else 0
    oi_usd = open_interest * mark_price

    funding_rate = float(fr_list[0].get("fundingRate", 0)) if fr_list else 0
    ls_entry     = ls_list[0] if ls_list else {}
    ls_ratio     = float(ls_entry.get("longShortRatio", 1.0)) if ls_entry else 1.0

    taker_entry          = taker_list[0] if taker_list else {}
    taker_buy_sell_ratio = float(taker_entry.get("buySellRatio", 0.5)) if taker_entry else 0.5

    volume_24h       = float(ticker_data.get("quoteVolume", 0)) if ticker_data else 0
    price_change_pct = float(ticker_data.get("priceChangePercent", 0)) if ticker_data else 0

    # Derived signals
    long_squeeze_risk  = min(100, max(0, (ls_ratio - 1) * 40 + max(0,  funding_rate) * 500))
    short_squeeze_risk = min(100, max(0, (1 - ls_ratio) * 40 + max(0, -funding_rate) * 500))

    if ls_ratio > 1.05 and funding_rate > 0 and taker_buy_sell_ratio > 0.5:
        market_bias = "Bullish"
    elif ls_ratio < 0.95 and funding_rate < 0 and taker_buy_sell_ratio < 0.5:
        market_bias = "Bearish"
    else:
        market_bias = "Neutral"

    result = {
        "coin_id":             coin_id,
        "symbol":              symbol,
        "open_interest":       oi_usd,
        "funding_rate":        funding_rate,
        "ls_ratio":            ls_ratio,
        "taker_buy_sell_ratio": taker_buy_sell_ratio,
        "volume_24h":          volume_24h,
        "price_change_pct":    price_change_pct,
        "long_squeeze_risk":   long_squeeze_risk,
        "short_squeeze_risk":  short_squeeze_risk,
        "market_bias":         market_bias,
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
                r = await client.post(
                    "https://api-inference.huggingface.co/models/cardiffnlp/twitter-roberta-base-sentiment-latest",
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
                            "source": "hf-roberta",
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


@app.post("/chat")
async def chat(body: dict):
    message = (body.get("message") or "").strip()
    context = body.get("context") or {}

    if not message:
        return {"response": "Please send a message."}

    # Try rule-based first
    rule_resp = _rule_based_response(message, context)
    if rule_resp:
        return {"response": rule_resp}

    # Try HF Inference API (Qwen2.5-0.5B-Instruct)
    hf_token = os.environ.get("HF_TOKEN", "")
    if hf_token:
        coin_name = context.get("coinName", "cryptocurrency")
        price = context.get("currentPrice")
        system_prompt = (
            f"You are a concise crypto trading assistant. "
            f"Current coin: {coin_name}."
            + (f" Current price: ${price:,.2f}." if price else "")
            + " Keep answers under 120 words. Focus on trading concepts and risk management."
        )
        prompt = f"<|system|>{system_prompt}<|end|><|user|>{message}<|end|><|assistant|>"
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                r = await client.post(
                    "https://api-inference.huggingface.co/models/Qwen/Qwen2.5-0.5B-Instruct",
                    headers={"Authorization": f"Bearer {hf_token}"},
                    json={
                        "inputs": prompt,
                        "parameters": {
                            "max_new_tokens": 150,
                            "temperature": 0.7,
                            "do_sample": True,
                            "return_full_text": False,
                        },
                    },
                )
                if r.status_code == 200:
                    resp_json = r.json()
                    if isinstance(resp_json, list) and resp_json:
                        text = resp_json[0].get("generated_text", "").strip()
                        # Clean up any repeated prompt artifacts
                        if "<|" in text:
                            text = text.split("<|")[0].strip()
                        if text:
                            return {"response": text}
        except Exception:
            pass

    # Generic fallback
    return {
        "response": (
            "I can help explain crypto trading concepts! Try asking me about: "
            "RSI, MACD, Bollinger Bands, funding rates, open interest, "
            "long/short squeeze, ATR, VWAP, support and resistance levels."
        )
    }


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
