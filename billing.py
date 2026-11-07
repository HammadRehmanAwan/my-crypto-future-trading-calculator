"""
FutureX billing, accounts and entitlements (Lemon Squeezy + Firebase).

Mounted into backend.py with `app.include_router(billing.router)`.

How it fits together
--------------------
1. The browser signs in with Firebase (Google) and sends its Firebase ID token
   as `Authorization: Bearer <token>` on every backend request.
2. `current_user()` verifies that token against Google's public keys — the
   backend never trusts a uid sent by the client.
3. Subscription state lives in Firestore at `subscriptions/{uid}` and is written
   ONLY by this server (from Lemon Squeezy webhooks). firestore.rules denies all
   client writes to it, so a user cannot grant themselves a plan.
4. Premium endpoints declare `Depends(require_plan("pro"))`. While
   PAYWALL_ENABLED is not "true" every check passes, so the live site keeps
   working exactly as before until you flip the switch.

Environment variables (Render → Environment; never commit values)
------------------------------------------------------------------
  PAYWALL_ENABLED              "true" to enforce plans (default: off)
  FIREBASE_PROJECT_ID          already set — used to verify ID tokens
  FIREBASE_SERVICE_ACCOUNT     service-account JSON — needed to read/write Firestore
  LEMONSQUEEZY_API_KEY         Lemon Squeezy → Settings → API
  LEMONSQUEEZY_STORE_ID        numeric store id
  LEMONSQUEEZY_WEBHOOK_SECRET  signing secret you set on the webhook
  LS_VARIANT_PRO_MONTHLY       variant ids for each plan/interval
  LS_VARIANT_PRO_YEARLY
  LS_VARIANT_TRADER_MONTHLY
  LS_VARIANT_TRADER_YEARLY
  SITE_URL                     e.g. https://futurex.app (checkout redirect target)
  EMAIL_LINK_SECRET            random string; signs one-click unsubscribe links
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import time
from datetime import datetime, timezone
from typing import Any, Callable

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse

from plans import ALERT_COIN_LIMIT, PLAN_RANK, PLANS, effective_plan, parse_ts as _parse_ts  # noqa: E402

router = APIRouter()

LS_API = "https://api.lemonsqueezy.com/v1"

def paywall_enabled() -> bool:
    return os.environ.get("PAYWALL_ENABLED", "").strip().lower() == "true"


def _variant_map() -> dict[str, tuple[str, str]]:
    """variant_id → (plan, interval)."""
    out = {}
    for plan in ("pro", "trader"):
        for interval in ("monthly", "yearly"):
            vid = os.environ.get(f"LS_VARIANT_{plan.upper()}_{interval.upper()}", "").strip()
            if vid:
                out[vid] = (plan, interval)
    return out


def _variant_for(plan: str, interval: str) -> str:
    return os.environ.get(f"LS_VARIANT_{plan.upper()}_{interval.upper()}", "").strip()


# ════════════════════════════════════════════════════════════════════
# Firestore (lazy; absent service account → billing storage disabled)
# ════════════════════════════════════════════════════════════════════

_fs_client = None
_fs_failed = False


def firestore_client():
    """Return a Firestore client, or None if no service account is configured."""
    global _fs_client, _fs_failed
    if _fs_client is not None or _fs_failed:
        return _fs_client
    raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT", "").strip()
    if not raw:
        _fs_failed = True
        return None
    try:
        import firebase_admin
        from firebase_admin import credentials, firestore
        if not firebase_admin._apps:
            firebase_admin.initialize_app(credentials.Certificate(json.loads(raw)))
        _fs_client = firestore.client()
    except Exception as e:  # pragma: no cover - depends on deployment
        print(f"[billing] Firestore init failed: {e}")
        _fs_failed = True
    return _fs_client


_SUB_CACHE: dict[str, tuple[float, dict | None]] = {}
_SUB_TTL = 60.0


async def get_subscription(uid: str) -> dict | None:
    hit = _SUB_CACHE.get(uid)
    if hit and time.time() - hit[0] < _SUB_TTL:
        return hit[1]
    db = firestore_client()
    if db is None:
        return None

    def _read():
        snap = db.collection("subscriptions").document(uid).get()
        return snap.to_dict() if snap.exists else None

    sub = await asyncio.to_thread(_read)
    _SUB_CACHE[uid] = (time.time(), sub)
    return sub


# ════════════════════════════════════════════════════════════════════
# Firebase ID-token verification
# ════════════════════════════════════════════════════════════════════

_TOKEN_CACHE: dict[str, dict] = {}
_google_request = None


def _verify_token_sync(token: str) -> dict:
    global _google_request
    from google.oauth2 import id_token
    from google.auth.transport import requests as g_requests

    project = os.environ.get("FIREBASE_PROJECT_ID", "").strip()
    if not project:
        raise ValueError("FIREBASE_PROJECT_ID not set")
    if _google_request is None:
        import requests
        session = requests.Session()
        try:  # cache Google's signing certs between calls
            import cachecontrol
            session = cachecontrol.CacheControl(session)
        except ImportError:
            pass
        _google_request = g_requests.Request(session=session)
    claims = id_token.verify_firebase_token(token, _google_request, audience=project)
    if not claims or not claims.get("sub"):
        raise ValueError("invalid token")
    return claims


async def current_user(request: Request) -> dict | None:
    """Verified Firebase claims for the caller, or None if not signed in."""
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        return None
    token = auth[7:].strip()
    if not token:
        return None
    hit = _TOKEN_CACHE.get(token)
    if hit and hit.get("exp", 0) > time.time() + 30:
        return hit
    try:
        claims = await asyncio.to_thread(_verify_token_sync, token)
    except Exception:
        return None
    if len(_TOKEN_CACHE) > 5000:
        _TOKEN_CACHE.clear()
    _TOKEN_CACHE[token] = claims
    return claims


async def plan_for_request(request: Request) -> tuple[dict | None, str, dict | None]:
    user = await current_user(request)
    if not user:
        return None, "free", None
    sub = await get_subscription(user["sub"])
    return user, effective_plan(sub), sub


def require_plan(min_plan: str) -> Callable:
    """FastAPI dependency: 401 if signed out, 402 if the plan is too low."""
    need = PLAN_RANK[min_plan]

    async def _dep(request: Request):
        if not paywall_enabled():
            return None
        user, plan, _ = await plan_for_request(request)
        if user is None:
            raise HTTPException(401, detail={"error": "auth_required", "plan": min_plan})
        if PLAN_RANK.get(plan, 0) < need:
            raise HTTPException(402, detail={"error": "upgrade_required", "plan": min_plan,
                                             "current": plan})
        return user

    return _dep


# ════════════════════════════════════════════════════════════════════
# Public endpoints
# ════════════════════════════════════════════════════════════════════

@router.get("/billing/config")
def billing_config():
    checkout_ready = bool(os.environ.get("LEMONSQUEEZY_API_KEY") and
                          os.environ.get("LEMONSQUEEZY_STORE_ID") and _variant_map())
    return {
        "paywall": paywall_enabled(),
        "checkout": checkout_ready,
        "plans": PLANS,
        "alert_coin_limit": ALERT_COIN_LIMIT,
    }


@router.get("/billing/me")
async def billing_me(request: Request):
    user, plan, sub = await plan_for_request(request)
    sub = sub or {}
    return {
        "signed_in": user is not None,
        "plan": plan,
        "paywall": paywall_enabled(),
        "status": sub.get("status", "none"),
        "interval": sub.get("interval"),
        "renews_at": sub.get("renews_at"),
        "ends_at": sub.get("ends_at"),
        "trial_ends_at": sub.get("trial_ends_at"),
        "has_portal": bool(sub.get("ls_subscription_id")),
    }


def _ls_headers() -> dict:
    return {
        "Accept": "application/vnd.api+json",
        "Content-Type": "application/vnd.api+json",
        "Authorization": f"Bearer {os.environ.get('LEMONSQUEEZY_API_KEY', '')}",
    }


def _site_url() -> str:
    return os.environ.get("SITE_URL", "https://hammadrehmanawan.github.io/my-crypto-future-trading-calculator").rstrip("/")


@router.post("/billing/checkout")
async def billing_checkout(request: Request, body: dict):
    user = await current_user(request)
    if not user:
        raise HTTPException(401, detail={"error": "auth_required"})
    plan = str(body.get("plan", "pro")).lower()
    interval = str(body.get("interval", "monthly")).lower()
    if plan not in ("pro", "trader") or interval not in ("monthly", "yearly"):
        raise HTTPException(400, detail={"error": "bad_plan"})
    variant = _variant_for(plan, interval)
    store = os.environ.get("LEMONSQUEEZY_STORE_ID", "").strip()
    if not (variant and store and os.environ.get("LEMONSQUEEZY_API_KEY")):
        raise HTTPException(503, detail={"error": "checkout_not_configured"})

    ref = str(body.get("ref", ""))[:64]
    custom = {"uid": user["sub"], "plan": plan, "interval": interval}
    if ref:
        custom["ref"] = ref
    checkout_data: dict[str, Any] = {"custom": custom}
    if user.get("email"):
        checkout_data["email"] = user["email"]
    if user.get("name"):
        checkout_data["name"] = user["name"]

    payload = {
        "data": {
            "type": "checkouts",
            "attributes": {
                "checkout_data": checkout_data,
                "product_options": {
                    "redirect_url": f"{_site_url()}/app.html?checkout=success",
                },
            },
            "relationships": {
                "store": {"data": {"type": "stores", "id": store}},
                "variant": {"data": {"type": "variants", "id": variant}},
            },
        }
    }
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(f"{LS_API}/checkouts", headers=_ls_headers(), json=payload)
    if r.status_code not in (200, 201):
        print(f"[billing] checkout create failed {r.status_code}: {r.text[:300]}")
        raise HTTPException(502, detail={"error": "checkout_failed"})
    url = r.json().get("data", {}).get("attributes", {}).get("url")
    if not url:
        raise HTTPException(502, detail={"error": "checkout_failed"})
    return {"url": url}


@router.post("/billing/portal")
async def billing_portal(request: Request):
    user, _, sub = await plan_for_request(request)
    if not user:
        raise HTTPException(401, detail={"error": "auth_required"})
    sub_id = (sub or {}).get("ls_subscription_id")
    if not sub_id:
        raise HTTPException(404, detail={"error": "no_subscription"})
    # Signed portal URLs expire after 24 h, so always fetch a fresh one.
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(f"{LS_API}/subscriptions/{sub_id}", headers=_ls_headers())
    if r.status_code != 200:
        raise HTTPException(502, detail={"error": "portal_unavailable"})
    urls = r.json().get("data", {}).get("attributes", {}).get("urls", {}) or {}
    url = urls.get("customer_portal") or urls.get("update_payment_method")
    if not url:
        raise HTTPException(502, detail={"error": "portal_unavailable"})
    return {"url": url}


# ════════════════════════════════════════════════════════════════════
# Lemon Squeezy webhook
# ════════════════════════════════════════════════════════════════════

def verify_signature(raw: bytes, signature: str, secret: str) -> bool:
    if not secret or not signature:
        return False
    digest = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(digest, signature.strip())


def subscription_doc_from_event(event: dict) -> tuple[str | None, str | None, dict | None]:
    """Turn a subscription_* webhook payload into (uid, ls_sub_id, doc)."""
    meta = event.get("meta", {}) or {}
    name = meta.get("event_name", "")
    data = event.get("data", {}) or {}
    if not name.startswith("subscription_") or data.get("type") != "subscriptions":
        return None, None, None
    attrs = data.get("attributes", {}) or {}
    custom = meta.get("custom_data") or {}
    uid = custom.get("uid")
    vmap = _variant_map()
    plan, interval = vmap.get(str(attrs.get("variant_id")), (custom.get("plan"), custom.get("interval")))
    if plan not in ("pro", "trader"):
        plan = "pro"  # unknown variant: safest paid default is the lower tier
    doc = {
        "plan": plan,
        "interval": interval,
        "status": attrs.get("status"),
        "ls_subscription_id": str(data.get("id")),
        "ls_customer_id": str(attrs.get("customer_id") or ""),
        "variant_id": str(attrs.get("variant_id") or ""),
        "email": attrs.get("user_email"),
        "renews_at": attrs.get("renews_at"),
        "ends_at": attrs.get("ends_at"),
        "trial_ends_at": attrs.get("trial_ends_at"),
        "ls_updated_at": attrs.get("updated_at"),
        "test_mode": bool(attrs.get("test_mode")),
        "last_event": name,
    }
    if custom.get("ref"):
        doc["affiliate_ref"] = str(custom["ref"])[:64]
    return uid, str(data.get("id")), doc


@router.post("/billing/webhook")
async def billing_webhook(request: Request):
    raw = await request.body()
    secret = os.environ.get("LEMONSQUEEZY_WEBHOOK_SECRET", "")
    if not verify_signature(raw, request.headers.get("x-signature", ""), secret):
        raise HTTPException(401, detail={"error": "bad_signature"})
    try:
        event = json.loads(raw)
    except ValueError:
        raise HTTPException(400, detail={"error": "bad_json"})

    uid, sub_id, doc = subscription_doc_from_event(event)
    if doc is None:
        return {"ok": True, "ignored": (event.get("meta") or {}).get("event_name")}
    db = firestore_client()
    if db is None:
        # Fail loudly so Lemon Squeezy retries once storage is configured.
        raise HTTPException(503, detail={"error": "storage_not_configured"})

    def _write():
        idx = db.collection("ls_subscriptions").document(sub_id)
        nonlocal uid
        if not uid:
            snap = idx.get()
            uid = (snap.to_dict() or {}).get("uid") if snap.exists else None
        if not uid:
            return False
        ref = db.collection("subscriptions").document(uid)
        cur = ref.get()
        cur_doc = cur.to_dict() if cur.exists else {}
        # Ignore out-of-order deliveries: keep the newest LS state.
        new_ts = _parse_ts(doc.get("ls_updated_at")) or 0
        old_ts = _parse_ts(cur_doc.get("ls_updated_at")) or 0
        if cur_doc.get("ls_subscription_id") == sub_id and new_ts < old_ts:
            return True
        doc["updated_at"] = datetime.now(timezone.utc).isoformat()
        ref.set(doc, merge=True)
        idx.set({"uid": uid})
        return True

    ok = await asyncio.to_thread(_write)
    if not ok:
        # No uid: a checkout made outside the app. Acknowledge so LS stops
        # retrying; it can be linked manually from the LS dashboard.
        print(f"[billing] webhook for subscription {sub_id} has no uid")
        return {"ok": True, "linked": False}
    _SUB_CACHE.pop(uid, None)
    return {"ok": True}


# ════════════════════════════════════════════════════════════════════
# One-click email unsubscribe (lifecycle emails)
# ════════════════════════════════════════════════════════════════════

def email_link_sig(uid: str) -> str:
    secret = os.environ.get("EMAIL_LINK_SECRET", "")
    return hmac.new(secret.encode(), uid.encode(), hashlib.sha256).hexdigest()[:32]


@router.get("/email/unsubscribe", response_class=HTMLResponse)
@router.post("/email/unsubscribe", response_class=HTMLResponse)  # RFC 8058 one-click
async def email_unsubscribe(u: str = "", s: str = ""):
    if not os.environ.get("EMAIL_LINK_SECRET") or not u or not hmac.compare_digest(email_link_sig(u), s):
        return HTMLResponse("<p>This unsubscribe link is invalid or expired.</p>", status_code=400)
    db = firestore_client()
    if db is None:
        return HTMLResponse("<p>Temporarily unavailable — please try again later.</p>", status_code=503)

    def _write():
        db.collection("users").document(u).collection("data").document("profile").set(
            {"marketingConsent": False,
             "unsubscribedAt": datetime.now(timezone.utc).isoformat()}, merge=True)

    await asyncio.to_thread(_write)
    return HTMLResponse(
        "<!doctype html><meta charset=utf-8><title>Unsubscribed</title>"
        "<body style='font-family:system-ui;background:#0B1220;color:#E6EDF7;"
        "display:grid;place-items:center;height:100vh;margin:0'>"
        "<div style='text-align:center'><h1>You're unsubscribed</h1>"
        "<p>You won't receive FutureX tips or offers. Price alerts you set up are unaffected.</p>"
        "</div></body>")
