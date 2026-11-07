"""Tests for billing.py — entitlements, webhook verification and gating.

Run: python -m pytest tests/
No network or Firebase is needed: token verification and Firestore are
monkeypatched, so these exercise the real decision logic only.
"""
import hashlib
import hmac
import json
import os
import sys
import time

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import billing  # noqa: E402
import backend  # noqa: E402


# ── effective_plan ────────────────────────────────────────────────

def test_no_subscription_is_free():
    assert billing.effective_plan(None) == "free"
    assert billing.effective_plan({}) == "free"


@pytest.mark.parametrize("status", ["active", "on_trial", "past_due"])
def test_active_statuses_grant_plan(status):
    assert billing.effective_plan({"plan": "pro", "status": status}) == "pro"


@pytest.mark.parametrize("status", ["expired", "unpaid", "paused", "", None])
def test_inactive_statuses_are_free(status):
    assert billing.effective_plan({"plan": "trader", "status": status}) == "free"


def test_cancelled_keeps_access_until_period_end():
    future = "2999-01-01T00:00:00.000000Z"
    past = "2000-01-01T00:00:00.000000Z"
    assert billing.effective_plan({"plan": "pro", "status": "cancelled", "ends_at": future}) == "pro"
    assert billing.effective_plan({"plan": "pro", "status": "cancelled", "ends_at": past}) == "free"
    assert billing.effective_plan({"plan": "pro", "status": "cancelled"}) == "free"


def test_unknown_plan_is_free():
    assert billing.effective_plan({"plan": "platinum", "status": "active"}) == "free"


# ── webhook signature + parsing ───────────────────────────────────

def _sign(raw: bytes, secret: str) -> str:
    return hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()


def test_signature_verification():
    raw = b'{"a":1}'
    assert billing.verify_signature(raw, _sign(raw, "s3cret"), "s3cret")
    assert not billing.verify_signature(raw, _sign(raw, "other"), "s3cret")
    assert not billing.verify_signature(raw, "", "s3cret")
    assert not billing.verify_signature(raw, _sign(raw, ""), "")  # no secret → reject


def _event(name="subscription_created", status="active", variant="111", uid="user-1",
           updated="2026-01-01T00:00:00.000000Z"):
    return {
        "meta": {"event_name": name, "custom_data": {"uid": uid, "plan": "pro", "interval": "monthly"}},
        "data": {
            "type": "subscriptions", "id": "sub_9",
            "attributes": {
                "status": status, "variant_id": int(variant), "customer_id": 5,
                "user_email": "a@b.c", "renews_at": "2026-02-01T00:00:00Z",
                "ends_at": None, "trial_ends_at": None, "updated_at": updated,
                "test_mode": True,
            },
        },
    }


def test_event_maps_variant_to_plan(monkeypatch):
    monkeypatch.setenv("LS_VARIANT_TRADER_YEARLY", "111")
    uid, sub_id, doc = billing.subscription_doc_from_event(_event())
    assert uid == "user-1" and sub_id == "sub_9"
    assert doc["plan"] == "trader" and doc["interval"] == "yearly"
    assert doc["status"] == "active"


def test_non_subscription_events_are_ignored():
    ev = _event()
    ev["meta"]["event_name"] = "order_created"
    assert billing.subscription_doc_from_event(ev) == (None, None, None)


# ── HTTP: paywall gating ──────────────────────────────────────────

@pytest.fixture
def client():
    return TestClient(backend.app)


def test_paywall_off_lets_everyone_through(client, monkeypatch):
    monkeypatch.delenv("PAYWALL_ENABLED", raising=False)
    dep = billing.require_plan("pro")
    import asyncio
    assert asyncio.run(dep(None)) is None


def test_paywall_on_requires_sign_in(client, monkeypatch):
    monkeypatch.setenv("PAYWALL_ENABLED", "true")
    r = client.post("/chat", json={"message": "hi"})
    assert r.status_code == 401
    assert r.json()["detail"]["error"] == "auth_required"


def test_paywall_on_free_user_gets_402(client, monkeypatch):
    monkeypatch.setenv("PAYWALL_ENABLED", "true")

    async def fake_user(_req):
        return {"sub": "u1", "exp": time.time() + 3600}

    async def fake_sub(_uid):
        return None

    monkeypatch.setattr(billing, "current_user", fake_user)
    monkeypatch.setattr(billing, "get_subscription", fake_sub)
    r = client.get("/ensemble-forecast/bitcoin")
    assert r.status_code == 402
    assert r.json()["detail"] == {"error": "upgrade_required", "plan": "pro", "current": "free"}


def test_paywall_on_pro_user_passes_gate(client, monkeypatch):
    monkeypatch.setenv("PAYWALL_ENABLED", "true")

    async def fake_user(_req):
        return {"sub": "u1", "exp": time.time() + 3600}

    async def fake_sub(_uid):
        return {"plan": "pro", "status": "active"}

    monkeypatch.setattr(billing, "current_user", fake_user)
    monkeypatch.setattr(billing, "get_subscription", fake_sub)
    # Gate passes → the chat handler runs (rule-based KB answers offline).
    r = client.post("/chat", json={"message": "what is rsi"})
    assert r.status_code == 200


def test_billing_config_is_public(client, monkeypatch):
    monkeypatch.delenv("PAYWALL_ENABLED", raising=False)
    r = client.get("/billing/config")
    assert r.status_code == 200
    body = r.json()
    assert body["paywall"] is False
    assert [p["id"] for p in body["plans"]] == ["free", "pro", "trader"]


def test_webhook_rejects_bad_signature(client, monkeypatch):
    monkeypatch.setenv("LEMONSQUEEZY_WEBHOOK_SECRET", "whsec")
    r = client.post("/billing/webhook", content=b"{}", headers={"X-Signature": "nope"})
    assert r.status_code == 401


def test_webhook_writes_subscription(client, monkeypatch):
    monkeypatch.setenv("LEMONSQUEEZY_WEBHOOK_SECRET", "whsec")
    monkeypatch.setenv("LS_VARIANT_PRO_MONTHLY", "111")
    store: dict = {}

    class Snap:
        def __init__(self, d):
            self._d = d
            self.exists = d is not None

        def to_dict(self):
            return self._d

    class Doc:
        def __init__(self, path):
            self.path = path

        def get(self):
            return Snap(store.get(self.path))

        def set(self, d, merge=False):
            store[self.path] = {**(store.get(self.path) or {}), **d} if merge else d

    class Coll:
        def __init__(self, name):
            self.name = name

        def document(self, did):
            return Doc(f"{self.name}/{did}")

    class DB:
        def collection(self, name):
            return Coll(name)

    monkeypatch.setattr(billing, "firestore_client", lambda: DB())
    raw = json.dumps(_event()).encode()
    r = client.post("/billing/webhook", content=raw, headers={"X-Signature": _sign(raw, "whsec")})
    assert r.status_code == 200, r.text
    assert store["subscriptions/user-1"]["plan"] == "pro"
    assert store["subscriptions/user-1"]["status"] == "active"
    assert store["ls_subscriptions/sub_9"] == {"uid": "user-1"}

    # An older, out-of-order "expired" delivery must not overwrite newer state.
    old = _event(status="expired", updated="2025-01-01T00:00:00.000000Z")
    raw2 = json.dumps(old).encode()
    client.post("/billing/webhook", content=raw2, headers={"X-Signature": _sign(raw2, "whsec")})
    assert store["subscriptions/user-1"]["status"] == "active"

    # A later event without custom_data is linked through the index doc.
    later = _event(status="cancelled", updated="2026-03-01T00:00:00.000000Z")
    later["meta"]["custom_data"] = {}
    raw3 = json.dumps(later).encode()
    client.post("/billing/webhook", content=raw3, headers={"X-Signature": _sign(raw3, "whsec")})
    assert store["subscriptions/user-1"]["status"] == "cancelled"


def test_unsubscribe_signature(monkeypatch):
    monkeypatch.setenv("EMAIL_LINK_SECRET", "k")
    sig = billing.email_link_sig("uid-1")
    assert len(sig) == 32
    assert sig != billing.email_link_sig("uid-2")
