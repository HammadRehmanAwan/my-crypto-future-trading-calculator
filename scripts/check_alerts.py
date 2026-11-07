#!/usr/bin/env python3
"""
Server-side Volatility Alert worker for FutureX.

Runs on a schedule (GitHub Actions cron), independent of any browser:
  1. Redeems pending Telegram links (users who pressed Start in the bot).
  2. Reads every signed-in user's alert subscription from Firestore.
  3. Fetches each watched coin's prices from CoinGecko ONCE per run (shared
     across users), evaluates the same volatility conditions the UI shows.
  4. Notifies by email (Resend, or EmailJS fallback) and/or Telegram.
Per-coin cooldown (2 h) and a daily cap (5/day) are tracked in Firestore, so
each event is delivered once. When PAYWALL_ENABLED=true the number of
watched coins is capped by plan (plans.ALERT_COIN_LIMIT).

Environment (GitHub Actions secrets — never commit):
  FIREBASE_SERVICE_ACCOUNT   service-account JSON (required)
  RESEND_API_KEY, EMAIL_FROM email via Resend (recommended)
  EMAILJS_SERVICE_ID / EMAILJS_TEMPLATE_ID / EMAILJS_PUBLIC_KEY / EMAILJS_PRIVATE_KEY
                             legacy email fallback
  TELEGRAM_BOT_TOKEN         Telegram alerts (optional)
  CG_DEMO_API_KEY            CoinGecko Demo key (optional, higher limits)
  PAYWALL_ENABLED            "true" to enforce per-plan coin limits
  SITE_URL                   public site origin, used for links in messages
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import notify  # noqa: E402
from plans import ALERT_COIN_LIMIT, effective_plan  # noqa: E402

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
DAILY_CAP = 5                    # max alerts per user per UTC day
TG_LINK_MAX_AGE = 24 * 60 * 60   # Telegram link codes expire after a day

CG_BASE = "https://api.coingecko.com/api/v3"


def site_url() -> str:
    return os.environ.get("SITE_URL", "https://hammadrehmanawan.github.io/my-crypto-future-trading-calculator").rstrip("/")


# ── Indicators (parity with frontend/js/core.js) ─────────────────────

def _rsi_value(ag: float, al: float) -> float:
    if ag == 0 and al == 0:
        return 50.0
    return 100.0 if al == 0 else 100 - 100 / (1 + ag / al)


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
    rsi = _rsi_value(ag, al)
    for i in range(period + 1, len(prices)):
        d = prices[i] - prices[i - 1]
        ag = (ag * (period - 1) + max(0.0, d)) / period
        al = (al * (period - 1) + max(0.0, -d)) / period
        rsi = _rsi_value(ag, al)
    return rsi


def calc_bb_width(prices, period=20, mult=2):
    if len(prices) < period:
        return None
    window = prices[-period:]
    m = sum(window) / period
    sd = (sum((b - m) ** 2 for b in window) / period) ** 0.5
    upper, lower = m + mult * sd, m - mult * sd
    return (upper - lower) / m * 100 if m else None


def price_24h_ago(series):
    """series: [[ts_ms, price], ...] sorted. Price closest to 24 h before the last point.

    CoinGecko returns hourly points for 2–90 day ranges, so the previous point
    is ~1 h old, not 24 h — comparing against it under-reports daily moves.
    """
    if len(series) < 2:
        return None
    target = series[-1][0] - 24 * 3600 * 1000
    best = min(series[:-1], key=lambda p: abs(p[0] - target))
    return best[1]


def evaluate(prices, cfg, prev24=None):
    """Return (reasons, current_price). reasons == [] means nothing triggers.

    prev24: price 24 h ago (see price_24h_ago); defaults to the previous point
    for daily series.
    """
    if len(prices) < 21:
        return [], (prices[-1] if prices else 0.0)
    curr = prices[-1]
    prev = prev24 if prev24 else prices[-2]
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


# ── CoinGecko (cached per run) ───────────────────────────────────────

def cg_headers():
    key = os.environ.get("CG_DEMO_API_KEY", "")
    h = {"User-Agent": "FutureX-AlertWorker/1.1"}
    if key:
        h["x-cg-demo-api-key"] = key
    return h


_PRICE_CACHE: dict[str, list | None] = {}


def fetch_prices(coin_id, days=30):
    """Return [[ts_ms, price], ...] for the coin (cached for this run)."""
    if coin_id in _PRICE_CACHE:
        cached = _PRICE_CACHE[coin_id]
        if cached is None:
            raise RuntimeError("previous fetch failed this run")
        return cached
    try:
        r = requests.get(f"{CG_BASE}/coins/{coin_id}/market_chart",
                         params={"vs_currency": "usd", "days": str(days)},
                         headers=cg_headers(), timeout=20)
        if r.status_code == 429:
            time.sleep(20)
            r = requests.get(f"{CG_BASE}/coins/{coin_id}/market_chart",
                             params={"vs_currency": "usd", "days": str(days)},
                             headers=cg_headers(), timeout=20)
        r.raise_for_status()
        prices = [p for p in r.json().get("prices", []) if len(p) == 2 and p[1]]
    except Exception:
        _PRICE_CACHE[coin_id] = None
        raise
    _PRICE_CACHE[coin_id] = prices
    time.sleep(1.5)  # stay well under CoinGecko's rate limit
    return prices


# ── Firestore ────────────────────────────────────────────────────────

def init_firestore():
    raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT", "")
    if not raw:
        print("FIREBASE_SERVICE_ACCOUNT secret not configured — skipping alert run.")
        print("To enable alerts: add the required secrets in GitHub → Settings → Secrets and variables → Actions (see SETUP.md).")
        sys.exit(0)
    import firebase_admin
    from firebase_admin import credentials, firestore
    firebase_admin.initialize_app(credentials.Certificate(json.loads(raw)))
    return firestore.client()


def utc_day_key():
    return datetime.now(timezone.utc).strftime("%Y%m%d")


def paywall_enabled() -> bool:
    return os.environ.get("PAYWALL_ENABLED", "").strip().lower() == "true"


# ── Telegram linking ─────────────────────────────────────────────────
# The app writes telegram_links/{code} = {uid, createdAt} and opens
# t.me/<bot>?start=<code>. Telegram then delivers "/start <code>" to the bot;
# we read it with getUpdates (no public webhook needed) and store
# users/{uid}/data/telegram = {chatId, ...} (server-only per firestore.rules).

def parse_start(text: str) -> str | None:
    parts = (text or "").strip().split()
    if len(parts) == 2 and parts[0].split("@")[0] == "/start" and parts[1].isalnum() and len(parts[1]) <= 64:
        return parts[1]
    return None


def process_telegram_updates(db, now: float | None = None) -> int:
    if not notify.telegram_enabled():
        return 0
    now = now or time.time()
    sys_ref = db.collection("system").document("telegram")
    snap = sys_ref.get()
    offset = (snap.to_dict() or {}).get("offset", 0) if snap.exists else 0
    try:
        updates = notify.tg_call("getUpdates", offset=offset, timeout=0,
                                 allowed_updates=["message"]) or []
    except Exception as e:
        print(f"  telegram getUpdates failed: {e}", file=sys.stderr)
        return 0
    linked = 0
    max_id = offset - 1
    for upd in updates:
        max_id = max(max_id, upd.get("update_id", 0))
        msg = upd.get("message") or {}
        chat_id = (msg.get("chat") or {}).get("id")
        text = msg.get("text", "")
        if not chat_id:
            continue
        try:
            if text.strip().split("@")[0] == "/stop":
                chat_ref = db.collection("telegram_chats").document(str(chat_id))
                c = chat_ref.get()
                if c.exists:
                    uid = (c.to_dict() or {}).get("uid")
                    if uid:
                        db.collection("users").document(uid).collection("data").document("telegram").delete()
                    chat_ref.delete()
                notify.send_telegram(chat_id, "Telegram alerts turned off. Connect again from the FutureX app anytime.")
                continue
            code = parse_start(text)
            if not code:
                notify.send_telegram(chat_id, "Hi! To get FutureX alerts here, open the app → Volatility Alerts → <b>Connect Telegram</b>.")
                continue
            link_ref = db.collection("telegram_links").document(code)
            link = link_ref.get()
            data = link.to_dict() if link.exists else None
            created = datetime.fromisoformat(data["createdAt"].replace("Z", "+00:00")).timestamp() if data and data.get("createdAt") else 0
            if not data or not data.get("uid") or now - created > TG_LINK_MAX_AGE:
                notify.send_telegram(chat_id, "That link has expired. Press <b>Connect Telegram</b> in the app again.")
                if link.exists:
                    link_ref.delete()
                continue
            uid = data["uid"]
            frm = msg.get("from") or {}
            db.collection("users").document(uid).collection("data").document("telegram").set({
                "chatId": chat_id,
                "username": frm.get("username"),
                "linkedAt": datetime.now(timezone.utc).isoformat(),
            })
            db.collection("telegram_chats").document(str(chat_id)).set({"uid": uid})
            link_ref.delete()
            notify.send_telegram(chat_id, "✅ Connected! You'll get FutureX volatility alerts here. Send /stop to turn them off.")
            linked += 1
        except Exception as e:
            print(f"  telegram update {upd.get('update_id')} failed: {e}", file=sys.stderr)
    if updates:
        sys_ref.set({"offset": max_id + 1, "updatedAt": datetime.now(timezone.utc).isoformat()})
    return linked


# ── Main loop ────────────────────────────────────────────────────────

def watch_limit_for(db, uid: str) -> int:
    if not paywall_enabled():
        return 15
    snap = db.collection("subscriptions").document(uid).get()
    plan = effective_plan(snap.to_dict() if snap.exists else None)
    return ALERT_COIN_LIMIT.get(plan, 1)


def main():
    db = init_firestore()
    now = time.time()
    day = utc_day_key()
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    email_ok = notify.email_provider() is not None
    tg_ok = notify.telegram_enabled()

    linked = process_telegram_updates(db, now)
    if linked:
        print(f"Linked {linked} Telegram chat(s).")

    sent_total = 0
    # Collection-group query: every users/{uid}/data/settings document.
    for snap in db.collection_group("data").stream():
        if snap.id != "settings":
            continue
        s = snap.to_dict() or {}
        if not s.get("enabled"):
            continue
        watch = list(s.get("watchCoins") or [])
        if not watch:
            continue
        user_ref = snap.reference.parent  # users/{uid}/data
        uid = user_ref.parent.id

        email = s.get("email") if (s.get("consent") and email_ok) else None
        chat_id = None
        if tg_ok:
            tg = user_ref.document("telegram").get()
            chat_id = (tg.to_dict() or {}).get("chatId") if tg.exists else None
        if not email and not chat_id:
            continue

        watch = watch[:watch_limit_for(db, uid)]
        cfg = SENSITIVITY.get(s.get("sensitivity", "moderate"), SENSITIVITY["moderate"])

        # Per-user alert state (cooldowns + daily count) lives next to settings.
        state_ref = user_ref.document("alert_state")
        st_snap = state_ref.get()
        st = st_snap.to_dict() if st_snap.exists else {}
        if st.get("day") != day:
            st = {"day": day, "count": 0, "cooldowns": st.get("cooldowns", {})}
        cooldowns = st.get("cooldowns", {})
        count = st.get("count", 0)

        dirty = False
        for coin_id in watch:
            if count >= DAILY_CAP:
                break
            if now - cooldowns.get(coin_id, 0) < COOLDOWN_SECONDS:
                continue
            try:
                series = fetch_prices(coin_id)
            except Exception as e:
                print(f"  price fetch failed for {coin_id}: {e}", file=sys.stderr)
                continue
            reasons, curr = evaluate([p[1] for p in series], cfg, price_24h_ago(series))
            if not reasons:
                continue

            name = COIN_NAMES.get(coin_id, coin_id)
            app_url = f"{site_url()}/app.html"
            delivered = False
            if email:
                try:
                    notify.send_alert_email(email, name, curr, reasons, stamp, app_url)
                    delivered = True
                except Exception as e:
                    print(f"  email failed for {uid}/{coin_id}: {e}", file=sys.stderr)
            if chat_id:
                try:
                    notify.send_telegram(chat_id, notify.alert_telegram_text(name, curr, reasons, app_url))
                    delivered = True
                except Exception as e:
                    print(f"  telegram failed for {uid}/{coin_id}: {e}", file=sys.stderr)
            if delivered:
                cooldowns[coin_id] = now
                count += 1
                sent_total += 1
                dirty = True
                print(f"  alert: {uid} / {coin_id} ({len(reasons)} reason[s])")

        if dirty:
            st.update({"day": day, "count": count, "cooldowns": cooldowns,
                       "updatedAt": datetime.now(timezone.utc).isoformat()})
            state_ref.set(st)

    print(f"Done. {sent_total} alert(s) sent. Coins fetched: {len(_PRICE_CACHE)}.")


if __name__ == "__main__":
    main()
