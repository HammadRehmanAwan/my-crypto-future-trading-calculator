"""
FutureX plan catalogue and entitlement rules — dependency-free so it can be
shared by the API (billing.py) and the scheduled workers in scripts/.
Edit prices/features HERE; the pricing page and paywall read them from
GET /billing/config. Prices must match your Lemon Squeezy variants.
"""

from __future__ import annotations

import time
from datetime import datetime
from typing import Any

PLAN_RANK = {"free": 0, "pro": 1, "trader": 2}

# Public plan catalogue — the pricing page and the in-app paywall read this
# from GET /billing/config, so prices and feature lists live in ONE place.
# Prices must match the variants you create in Lemon Squeezy.
PLANS = [
    {
        "id": "free", "name": "Free", "monthly": 0, "yearly": 0,
        "features": [
            "Futures calculator with fees, funding & liquidation",
            "Live price chart with 7-day statistical forecast",
            "RSI, MACD & Bollinger Bands explained in plain English",
            "Volatility email alerts for 1 coin",
        ],
    },
    {
        "id": "pro", "name": "Pro", "monthly": 15, "yearly": 144,
        "features": [
            "Everything in Free",
            "Every timeframe: 5 min → 7 days with AI forecast",
            "AI Portfolio Dashboard & daily briefing",
            "Full Analysis Hub: ensemble forecast, on-chain, tokenomics",
            "AI copilot chat with live market context",
            "Alerts for up to 5 coins by email + Telegram",
        ],
    },
    {
        "id": "trader", "name": "Trader", "monthly": 39, "yearly": 374,
        "features": [
            "Everything in Pro",
            "Live liquidation stream (OKX perpetuals)",
            "Order-flow & whale intelligence cards",
            "Alerts for all 15 coins",
            "Priority support",
        ],
    },
]

# Alert coin limits per plan (enforced server-side by scripts/check_alerts.py).
ALERT_COIN_LIMIT = {"free": 1, "pro": 5, "trader": 15}

# Lemon Squeezy statuses that grant access. "cancelled" keeps access until
# ends_at (the user paid for the period); "past_due" is LS's dunning grace.
_ACTIVE = {"on_trial", "active", "past_due"}



def parse_ts(s: Any) -> float | None:
    if not s or not isinstance(s, str):
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def effective_plan(sub: dict | None, now: float | None = None) -> str:
    """Map a stored subscription document to the plan the user may use now."""
    if not sub:
        return "free"
    plan = sub.get("plan", "free")
    if plan not in PLAN_RANK:
        return "free"
    status = sub.get("status", "")
    now = now or time.time()
    if status in _ACTIVE:
        return plan
    if status == "cancelled":
        ends = parse_ts(sub.get("ends_at"))
        if ends and ends > now:
            return plan
    return "free"


SUMMARY_FIELDS = ("plan", "interval", "status", "ls_subscription_id", "renews_at",
                  "ends_at", "trial_ends_at", "variant_id", "test_mode")


def summarize_subscriptions(items: dict, now: float | None = None) -> dict:
    """A user can end up with several Lemon Squeezy subscriptions (e.g. an
    upgrade bought before the old one lapsed). Pick the one that should drive
    access: the highest plan that is currently effective; if none is, the
    most recently updated one (so the UI can show e.g. "expired")."""
    now = now or time.time()
    if not items:
        return {"plan": "free", "status": "none"}

    def key(it):
        eff = effective_plan(it, now)
        return (PLAN_RANK.get(eff, 0), parse_ts(it.get("ls_updated_at")) or 0)

    best = max(items.values(), key=key)
    return {k: best.get(k) for k in SUMMARY_FIELDS}
