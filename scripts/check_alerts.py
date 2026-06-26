#!/usr/bin/env python3
"""
Server-side Volatility Alert worker for FutureX.

Runs on a schedule (GitHub Actions cron) — independent of any browser. Reads
every user's alert subscription from Firestore, fetches live prices from
CoinGecko, evaluates the same volatility conditions the UI describes, and
sends an email via the EmailJS REST API when a watched coin crosses a
threshold. Per-coin cooldown (2 h) and a daily cap (5/day) are tracked
server-side in Firestore so alerts fire exactly once per event, whether or
not the user has the page open.

Required environment variables (set as GitHub Actions secrets — never commit):
  FIREBASE_SERVICE_ACCOUNT   JSON service-account key for the Firebase project
  EMAILJS_SERVICE_ID         EmailJS service id      (e.g. service_xxxx)
  EMAILJS_TEMPLATE_ID        EmailJS template id     (e.g. template_xxxx)
  EMAILJS_PUBLIC_KEY         EmailJS public key      (user id)
  EMAILJS_PRIVATE_KEY        EmailJS private key     (server access token)
  CG_DEMO_API_KEY            CoinGecko Demo key       (optional, higher limits)
"""

import json
import os
import sys
import time
from datetime import datetime, timezone

import requests

# ── Config ───────────────────────────────────────────────────────────

COIN_NAMES = {
    "bitcoin": "Bitcoin (BTC)", "ethereum": "Ethereum (ETH)",
    "binancecoin": "BNB (BNB)", "solana": "Solana (SOL)",
    "ripple": "XRP (XRP)", "cardano": "Cardano (ADA)",
    "avalanche-2": "Avalanche (AVAX)", "dogecoin": "Dogecoin (DOGE)",
    "polkadot": "Polkadot (DOT)", "matic-network": "Polygon (MATIC)",
    "chainlink": "Chainlink (LINK)", "uniswap": "Uniswap (UNI)",
    "litecoin": "Litecoin (LTC)", "cosmos": "Cosmos (ATOM)",
    "filecoin": "Filecoin (FIL)",
}

# Mirrors SENSITIVITY_CFG in app.js — keep these in sync.
SENSITIVITY = {
    "conservative": {"rsi_lo": 20, "rsi_hi": 80, "change_abs": 10, "bb_width": 20},
    "moderate":     {"rsi_lo": 30, "rsi_hi": 70, "change_abs": 5,  "bb_width": 12},
    "sensitive":    {"rsi_lo": 35, "rsi_hi": 65, "change_abs": 3,  "bb_width": 8},
}

COOLDOWN_SECONDS = 2 * 60 * 60   # 2 hours per coin, matching the client
DAILY_CAP = 5                    # max emails per user per UTC day

CG_BASE = "https://api.coingecko.com/api/v3"
EMAILJS_URL = "https://api.emailjs.com/api/v1.0/email/send"


# ── Indicators (parity with app.js calcRSI / calcBollinger) ──────────

def calc_rsi(prices, period=14):
    if len(prices) <= period:
        return 50.0
    ag = al = 0.0
    for i in range(1, period + 1):
        d = prices[i] - prices[i - 1]
        ag += max(0.0, d)
        al += max(0.0, -d)
    ag /= period
    al /= period
    rsi = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    for i in range(period + 1, len(prices)):
        d = prices[i] - prices[i - 1]
        ag = (ag * (period - 1) + max(0.0, d)) / period
        al = (al * (period - 1) + max(0.0, -d)) / period
        rsi = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    return rsi


def calc_bb_width(prices, period=20, mult=2):
    if len(prices) < period:
        return None
    window = prices[-period:]
    m = sum(window) / period
    sd = (sum((b - m) ** 2 for b in window) / period) ** 0.5
    upper, lower = m + mult * sd, m - mult * sd
    return (upper - lower) / m * 100 if m else None


# ── CoinGecko ────────────────────────────────────────────────────────

def cg_headers():
    key = os.environ.get("CG_DEMO_API_KEY", "")
    h = {"User-Agent": "FutureX-AlertWorker/1.0"}
    if key:
        h["x-cg-demo-api-key"] = key
    return h


def fetch_prices(coin_id, days=30):
    r = requests.get(
        f"{CG_BASE}/coins/{coin_id}/market_chart",
        params={"vs_currency": "usd", "days": str(days)},
        headers=cg_headers(),
        timeout=20,
    )
    r.raise_for_status()
    return [p[1] for p in r.json().get("prices", [])]


# ── EmailJS (server-side send with private access token) ─────────────

def send_email(to_email, coin_name, price, reasons):
    payload = {
        "service_id": os.environ["EMAILJS_SERVICE_ID"],
        "template_id": os.environ["EMAILJS_TEMPLATE_ID"],
        "user_id": os.environ["EMAILJS_PUBLIC_KEY"],
        "accessToken": os.environ["EMAILJS_PRIVATE_KEY"],
        "template_params": {
            "to_email": to_email,
            "coin_name": coin_name,
            "current_price": "$" + f"{price:,.2f}",
            "alert_reasons": "\n".join(f"{i + 1}. {r}" for i, r in enumerate(reasons)),
            "alert_time": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        },
    }
    r = requests.post(EMAILJS_URL, json=payload, timeout=20)
    if r.status_code != 200:
        raise RuntimeError(f"EmailJS {r.status_code}: {r.text[:200]}")


# ── Volatility evaluation ────────────────────────────────────────────

def evaluate(coin_id, prices, cfg):
    """Return a list of human-readable reasons, or [] if nothing triggers."""
    if len(prices) < 21:
        return []
    curr = prices[-1]
    prev = prices[-2]
    chg24 = (curr - prev) / prev * 100 if prev else 0.0
    rsi = calc_rsi(prices)
    bbw = calc_bb_width(prices)

    reasons = []
    if rsi < cfg["rsi_lo"]:
        reasons.append(f"RSI is {rsi:.1f} — price fell very fast, a bounce upward is likely")
    elif rsi > cfg["rsi_hi"]:
        reasons.append(f"RSI is {rsi:.1f} — price rose very fast, a pullback may be coming")
    if abs(chg24) >= cfg["change_abs"]:
        sign = "+" if chg24 >= 0 else ""
        reasons.append(f"Price moved {sign}{chg24:.2f}% in the last 24 hours — high volatility")
    if bbw is not None and bbw >= cfg["bb_width"]:
        reasons.append(f"Bollinger Band width is {bbw:.1f}% — the price channel is unusually wide")
    return reasons, curr


# ── Firestore ────────────────────────────────────────────────────────

def init_firestore():
    import firebase_admin
    from firebase_admin import credentials, firestore

    raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT", "")
    if not raw:
        print("FIREBASE_SERVICE_ACCOUNT secret not configured — skipping alert run.")
        print("To enable alerts: add all required secrets in GitHub → Settings → Secrets and variables → Actions.")
        sys.exit(0)
    cred = credentials.Certificate(json.loads(raw))
    firebase_admin.initialize_app(cred)
    return firestore.client()


def utc_day_key():
    return datetime.now(timezone.utc).strftime("%Y%m%d")


def main():
    db = init_firestore()
    now = time.time()
    day = utc_day_key()

    # Collection-group query: every users/{uid}/data/settings document.
    sent_total = 0
    for snap in db.collection_group("data").stream():
        if snap.id != "settings":
            continue
        s = snap.to_dict() or {}
        if not s.get("enabled") or not s.get("email") or not s.get("consent"):
            continue
        watch = s.get("watchCoins") or []
        if not watch:
            continue
        email = s["email"]
        cfg = SENSITIVITY.get(s.get("sensitivity", "moderate"), SENSITIVITY["moderate"])

        # Per-user alert state (cooldowns + daily count) lives next to settings.
        state_ref = snap.reference.parent.document("alert_state")
        st = (state_ref.get().to_dict() or {})
        if st.get("day") != day:
            st = {"day": day, "count": 0, "cooldowns": {}}
        cooldowns = st.get("cooldowns", {})
        count = st.get("count", 0)

        dirty = False
        for coin_id in watch:
            if count >= DAILY_CAP:
                break
            last = cooldowns.get(coin_id, 0)
            if now - last < COOLDOWN_SECONDS:
                continue
            try:
                prices = fetch_prices(coin_id)
            except Exception as e:
                print(f"  price fetch failed for {coin_id}: {e}", file=sys.stderr)
                time.sleep(1.5)
                continue

            reasons, curr = evaluate(coin_id, prices, cfg)
            if not reasons:
                time.sleep(1.5)
                continue

            try:
                send_email(email, COIN_NAMES.get(coin_id, coin_id), curr, reasons)
                cooldowns[coin_id] = now
                count += 1
                sent_total += 1
                dirty = True
                print(f"  sent alert: {email} / {coin_id} ({len(reasons)} reason[s])")
            except Exception as e:
                print(f"  email send failed for {email}/{coin_id}: {e}", file=sys.stderr)
            time.sleep(1.5)  # gentle on CoinGecko + EmailJS rate limits

        if dirty:
            st.update({"day": day, "count": count, "cooldowns": cooldowns,
                       "updatedAt": datetime.now(timezone.utc).isoformat()})
            state_ref.set(st)

    print(f"Done. {sent_total} alert email(s) sent.")


if __name__ == "__main__":
    main()
