"""Tests for scripts/check_alerts.py (no network: CoinGecko/Telegram/email faked)."""
import os
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
sys.path.insert(0, os.path.dirname(__file__))

import check_alerts as ca  # noqa: E402
from fakefs import FakeDB  # noqa: E402

MOD = ca.SENSITIVITY["moderate"]


def test_evaluate_short_series_returns_tuple():
    # Regression: used to `return []`, crashing `reasons, curr = evaluate(...)`.
    reasons, curr = ca.evaluate([1.0, 2.0, 3.0], MOD)
    assert reasons == [] and curr == 3.0
    assert ca.evaluate([], MOD) == ([], 0.0)


def test_evaluate_flat_market_is_quiet():
    reasons, _ = ca.evaluate([100.0] * 40, MOD)
    assert reasons == []


def test_evaluate_crash_triggers():
    prices = [100.0] * 30 + [100 - 3 * i for i in range(1, 11)]   # 100 → 70
    reasons, curr = ca.evaluate(prices, MOD, prev24=100.0)
    assert curr == prices[-1]
    assert any("RSI" in r for r in reasons)
    assert any("24 hours" in r for r in reasons)


def test_24h_change_uses_timestamps_not_previous_point():
    hour = 3600 * 1000
    series = [[i * hour, 100.0] for i in range(48)] + [[48 * hour, 93.0]]
    assert ca.price_24h_ago(series) == 100.0
    # Hourly drift of 0.5% each hour looks calm point-to-point but is -11% on the day.
    drift = [[i * hour, 100.0 * (0.995 ** i)] for i in range(49)]
    prev = ca.price_24h_ago(drift)
    _, curr = ca.evaluate([p[1] for p in drift], MOD, prev)
    reasons, _ = ca.evaluate([p[1] for p in drift], MOD, prev)
    assert any("24 hours" in r for r in reasons)
    reasons_wrong, _ = ca.evaluate([p[1] for p in drift], MOD)  # old behaviour
    assert not any("24 hours" in r for r in reasons_wrong)


def test_rsi_parity_with_frontend():
    assert ca.calc_rsi([100.0] * 30) == 50.0
    assert ca.calc_rsi([float(i) for i in range(30)]) == 100.0


def test_parse_start():
    assert ca.parse_start("/start abc123") == "abc123"
    assert ca.parse_start("/start@FutureXBot abc123") == "abc123"
    assert ca.parse_start("/start") is None
    assert ca.parse_start("hello") is None
    assert ca.parse_start("/start a-b") is None


def _now_iso(offset=0):
    return datetime.fromtimestamp(time.time() + offset, timezone.utc).isoformat()


def test_telegram_link_flow(monkeypatch):
    sent = []
    updates = [
        {"update_id": 10, "message": {"chat": {"id": 555}, "from": {"username": "trader"}, "text": "/start goodcode"}},
        {"update_id": 11, "message": {"chat": {"id": 777}, "text": "/start oldcode"}},
        {"update_id": 12, "message": {"chat": {"id": 888}, "text": "hi"}},
    ]
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "x")
    monkeypatch.setattr(ca.notify, "tg_call", lambda method, **kw: updates if method == "getUpdates" else None)
    monkeypatch.setattr(ca.notify, "send_telegram", lambda chat, text: sent.append((chat, text)))
    db = FakeDB({
        "telegram_links/goodcode": {"uid": "u1", "createdAt": _now_iso()},
        "telegram_links/oldcode": {"uid": "u2", "createdAt": _now_iso(-3 * 86400)},
    })
    assert ca.process_telegram_updates(db) == 1
    assert db.store["users/u1/data/telegram"]["chatId"] == 555
    assert db.store["telegram_chats/555"] == {"uid": "u1"}
    assert "telegram_links/goodcode" not in db.store
    assert "telegram_links/oldcode" not in db.store          # expired → removed
    assert "users/u2/data/telegram" not in db.store
    assert db.store["system/telegram"]["offset"] == 13
    assert {c for c, _ in sent} == {555, 777, 888}


def test_telegram_stop_unlinks(monkeypatch):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "x")
    monkeypatch.setattr(ca.notify, "tg_call", lambda m, **kw: [{"update_id": 1, "message": {"chat": {"id": 555}, "text": "/stop"}}])
    monkeypatch.setattr(ca.notify, "send_telegram", lambda c, t: None)
    db = FakeDB({"users/u1/data/telegram": {"chatId": 555}, "telegram_chats/555": {"uid": "u1"}})
    ca.process_telegram_updates(db)
    assert "users/u1/data/telegram" not in db.store
    assert "telegram_chats/555" not in db.store


def test_main_sends_once_and_respects_plan_limit(monkeypatch):
    hour = 3600 * 1000
    closes = [100.0] * 30 + [100 - 3 * i for i in range(1, 11)]
    crash = [[i * hour, p] for i, p in enumerate(closes)]
    db = FakeDB({
        "users/u1/data/settings": {"enabled": True, "consent": True, "email": "a@b.c",
                                   "watchCoins": ["bitcoin", "ethereum", "solana"], "sensitivity": "moderate"},
        "users/u1/data/telegram": {"chatId": 42},
    })
    emails, tgs, fetched = [], [], []
    monkeypatch.setenv("FIREBASE_SERVICE_ACCOUNT", "{}")
    monkeypatch.setenv("PAYWALL_ENABLED", "true")          # u1 has no subscription → free → 1 coin
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "x")
    monkeypatch.setattr(ca, "init_firestore", lambda: db)
    monkeypatch.setattr(ca, "process_telegram_updates", lambda db, now=None: 0)
    monkeypatch.setattr(ca.notify, "email_provider", lambda: "resend")
    monkeypatch.setattr(ca.notify, "send_alert_email", lambda *a, **k: emails.append(a))
    monkeypatch.setattr(ca.notify, "send_telegram", lambda c, t: tgs.append(c))
    ca._PRICE_CACHE.clear()
    monkeypatch.setattr(ca, "fetch_prices", lambda coin: fetched.append(coin) or crash)

    ca.main()
    assert fetched == ["bitcoin"]            # free plan: first coin only
    assert len(emails) == 1 and tgs == [42]
    assert db.store["users/u1/data/alert_state"]["count"] == 1

    ca.main()                                # cooldown: no duplicate alert
    assert len(emails) == 1


def test_relink_cleans_stale_mappings(monkeypatch):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "x")
    monkeypatch.setattr(ca.notify, "send_telegram", lambda c, t: None)
    db = FakeDB({
        # u1 was on chat 111; chat 222 used to belong to u2
        "users/u1/data/telegram": {"chatId": 111}, "telegram_chats/111": {"uid": "u1"},
        "users/u2/data/telegram": {"chatId": 222}, "telegram_chats/222": {"uid": "u2"},
        "telegram_links/newcode": {"uid": "u1", "createdAt": _now_iso()},
    })
    monkeypatch.setattr(ca.notify, "tg_call", lambda m, **kw: [{"update_id": 5, "message": {"chat": {"id": 222}, "text": "/start newcode"}}])
    ca.process_telegram_updates(db)
    assert db.store["users/u1/data/telegram"]["chatId"] == 222
    assert "telegram_chats/111" not in db.store          # u1's old chat unmapped
    assert "users/u2/data/telegram" not in db.store       # u2 no longer gets u1's chat
    # /stop from the OLD chat must not unlink u1's new chat
    db.store["telegram_chats/111"] = {"uid": "u1"}
    monkeypatch.setattr(ca.notify, "tg_call", lambda m, **kw: [{"update_id": 6, "message": {"chat": {"id": 111}, "text": "/stop"}}])
    ca.process_telegram_updates(db)
    assert db.store["users/u1/data/telegram"]["chatId"] == 222
