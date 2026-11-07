#!/usr/bin/env python3
"""
Walk-forward backtest of FutureX's 7-day forecasts → frontend/data/accuracy.json

For each of the 15 coins:
  * fetch ~365 daily closes from CoinGecko
  * for every origin day t (after a warm-up), forecast t+H using ONLY data up
    to t, with the same Holt model and the same context length the app uses
  * compare with the realised price; also score a naive "no change" baseline
  * optionally (CHRONOS_URL set) score Amazon Chronos-Bolt via the HF Space on
    a weekly sample of origins

Run weekly by .github/workflows/backtest.yml. Nothing is tuned on the test
period: the Holt parameters are the fixed app defaults.

    python scripts/backtest.py                       # real data → frontend/data/accuracy.json
    CHRONOS_URL=https://<space>.hf.space python scripts/backtest.py
"""

from __future__ import annotations

import json
import math
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "frontend" / "data" / "accuracy.json"

COINS = {
    "bitcoin": "BTC", "ethereum": "ETH", "binancecoin": "BNB", "solana": "SOL",
    "ripple": "XRP", "cardano": "ADA", "avalanche-2": "AVAX", "dogecoin": "DOGE",
    "polkadot": "DOT", "matic-network": "MATIC", "chainlink": "LINK", "uniswap": "UNI",
    "litecoin": "LTC", "cosmos": "ATOM", "filecoin": "FIL",
}

HORIZON = 7          # days ahead
WINDOW_DAYS = 365    # history fetched
WARMUP = 60          # first origin index
APP_CONTEXT = 31     # the app's 7-day forecast sees ~31 daily closes (30-day chart)
CHRONOS_CONTEXT = 90
CHRONOS_EVERY = 7    # evaluate Chronos on every 7th origin (it is slower)


# ── Model: identical to frontend/js/core.js holtForecast ─────────────

def holt_forecast(prices, horizon=7, alpha=0.35, beta=0.08):
    if not prices:
        return [], [], []
    level = prices[0]
    trend = prices[1] - prices[0] if len(prices) > 1 else 0.0
    for i in range(1, len(prices)):
        prev_l = level
        level = alpha * prices[i] + (1 - alpha) * (level + trend)
        trend = beta * (level - prev_l) + (1 - beta) * trend
    recent = prices[-20:]
    s = recent[0]
    res = []
    for i in range(1, len(recent)):
        res.append(abs(recent[i] - s))
        s = alpha * recent[i] + (1 - alpha) * s
    avg_res = sum(res) / len(res) if res else 0.0
    median = [level + trend * (i + 1) for i in range(horizon)]
    low = [v - avg_res * math.sqrt(i + 1) * 1.8 for i, v in enumerate(median)]
    high = [v + avg_res * math.sqrt(i + 1) * 1.8 for i, v in enumerate(median)]
    return median, low, high


# ── Data ─────────────────────────────────────────────────────────────

def cg_headers():
    h = {"User-Agent": "FutureX-Backtest/1.0"}
    if os.environ.get("CG_DEMO_API_KEY"):
        h["x-cg-demo-api-key"] = os.environ["CG_DEMO_API_KEY"]
    return h


def daily_closes(raw_prices):
    """[[ts_ms, price], ...] → one close per UTC day (last point of the day),
    dropping today's partial day."""
    by_day: dict[str, float] = {}
    for ts, p in raw_prices:
        if p is None:
            continue
        day = datetime.fromtimestamp(ts / 1000, timezone.utc).strftime("%Y-%m-%d")
        by_day[day] = float(p)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    by_day.pop(today, None)
    return [by_day[d] for d in sorted(by_day)]


def fetch_daily(coin_id):
    for attempt in range(4):
        r = requests.get(f"https://api.coingecko.com/api/v3/coins/{coin_id}/market_chart",
                         params={"vs_currency": "usd", "days": str(WINDOW_DAYS)},
                         headers=cg_headers(), timeout=30)
        if r.status_code == 429:
            time.sleep(15 * (attempt + 1))
            continue
        r.raise_for_status()
        return daily_closes(r.json().get("prices", []))
    raise RuntimeError(f"CoinGecko rate-limited for {coin_id}")


def chronos_pct(url, context):
    try:
        r = requests.post(f"{url.rstrip('/')}/api/ml-forecast", json={"prices": context}, timeout=60)
        if r.status_code == 200:
            v = r.json().get("chronos_bolt_pct")
            return float(v) if v is not None else None
    except Exception:
        pass
    return None


# ── Scoring ──────────────────────────────────────────────────────────

def _summary(rows):
    if not rows:
        return None
    n = len(rows)
    out = {
        "n": n,
        "direction_accuracy": round(sum(r["hit"] for r in rows) / n, 4),
        "mape": round(sum(r["ape"] for r in rows) / n, 3),
    }
    cov = [r["in_band"] for r in rows if r.get("in_band") is not None]
    if cov:
        out["band_coverage"] = round(sum(cov) / len(cov), 4)
    return out


def score_series(prices, chronos_url=None):
    holt, naive, chronos = [], [], []
    for t in range(WARMUP, len(prices) - HORIZON):
        curr = prices[t]
        actual = prices[t + HORIZON]
        if curr <= 0 or actual <= 0:
            continue
        actual_up = actual >= curr
        ctx = prices[max(0, t - APP_CONTEXT + 1): t + 1]
        med, lo, hi = holt_forecast(ctx, HORIZON)
        pred = med[-1]
        holt.append({
            "hit": (pred >= curr) == actual_up,
            "ape": abs(pred - actual) / actual * 100,
            "in_band": lo[-1] <= actual <= hi[-1],
        })
        # Naive: price unchanged. Its "direction" is undefined, so it is not
        # scored on direction (50% is the coin-flip reference).
        naive.append({"hit": actual_up, "ape": abs(curr - actual) / actual * 100})
        if chronos_url and (t - WARMUP) % CHRONOS_EVERY == 0:
            pct = chronos_pct(chronos_url, prices[max(0, t - CHRONOS_CONTEXT + 1): t + 1])
            if pct is not None:
                cp = curr * (1 + pct / 100)
                chronos.append({"hit": (cp >= curr) == actual_up, "ape": abs(cp - actual) / actual * 100})
    res = {"holt": _summary(holt), "naive": _summary(naive)}
    res["naive"].pop("direction_accuracy", None)
    res["naive"]["up_share"] = round(sum(r["hit"] for r in naive) / len(naive), 4)
    if chronos:
        res["chronos"] = _summary(chronos)
    return res, holt, naive, chronos


def main():
    chronos_url = os.environ.get("CHRONOS_URL", "").strip() or None
    coins_out = {}
    all_h, all_n, all_c = [], [], []
    for coin_id, sym in COINS.items():
        try:
            prices = fetch_daily(coin_id)
        except Exception as e:
            print(f"skip {coin_id}: {e}", file=sys.stderr)
            continue
        if len(prices) < WARMUP + HORIZON + 20:
            print(f"skip {coin_id}: only {len(prices)} days", file=sys.stderr)
            continue
        res, h, n, c = score_series(prices, chronos_url)
        res["symbol"] = sym
        coins_out[coin_id] = res
        all_h += h; all_n += n; all_c += c
        print(f"{sym:5s} holt dir {res['holt']['direction_accuracy']:.1%}  mape {res['holt']['mape']:.2f}%  "
              f"naive mape {res['naive']['mape']:.2f}%" + (f"  chronos dir {res['chronos']['direction_accuracy']:.1%}" if "chronos" in res else ""))
        time.sleep(2.5)
    if not coins_out:
        raise SystemExit("no coins scored — not overwriting accuracy.json")
    overall = {"holt": _summary(all_h), "naive": _summary(all_n)}
    overall["naive"].pop("direction_accuracy", None)
    if all_c:
        overall["chronos"] = _summary(all_c)
    doc = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "horizon_days": HORIZON,
        "window_days": WINDOW_DAYS,
        "context_days": APP_CONTEXT,
        "model": "Holt double-exponential smoothing (alpha=0.35, beta=0.08)",
        "chronos_evaluated": bool(all_c),
        "overall": overall,
        "coins": coins_out,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, indent=1) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
