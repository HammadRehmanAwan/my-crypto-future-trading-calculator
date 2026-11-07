#!/usr/bin/env python3
"""
Lifecycle emails for FutureX (runs daily from .github/workflows/lifecycle-emails.yml).

Sequence (each sent at most once per user, tracked in profile.lifecycle):
  welcome      day 0+   all signed-up users (account email: how to get started)
  tips         day 3+   only with marketingConsent: 3 habits that avoid liquidation
  pro_offer    day 7+   only with marketingConsent and still on Free
  trial_end    2 days before a Lemon Squeezy trial ends (transactional)

Marketing emails carry a one-click unsubscribe link (backend /email/unsubscribe,
HMAC-signed) and a List-Unsubscribe header. Payment receipts and dunning are
sent by Lemon Squeezy itself, not here.

Environment: FIREBASE_SERVICE_ACCOUNT, RESEND_API_KEY, EMAIL_FROM,
EMAIL_LINK_SECRET, SITE_URL, BACKEND_URL
"""

from __future__ import annotations

import hashlib
import hmac
import html
import json
import os
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import notify  # noqa: E402
from plans import effective_plan, parse_ts  # noqa: E402

DAY = 86400
MAX_PER_RUN = 400  # stay well inside Resend's free-tier daily limit


def site_url() -> str:
    return os.environ.get("SITE_URL", "https://hammadrehmanawan.github.io/my-crypto-future-trading-calculator").rstrip("/")


def backend_url() -> str:
    return os.environ.get("BACKEND_URL", "https://my-crypto-future-trading-calculator.onrender.com").rstrip("/")


def unsubscribe_url(uid: str) -> str:
    secret = os.environ.get("EMAIL_LINK_SECRET", "")
    sig = hmac.new(secret.encode(), uid.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{backend_url()}/email/unsubscribe?u={uid}&s={sig}"


def _wrap(title: str, paragraphs: list[str], cta: tuple[str, str] | None, footer: str) -> str:
    body = "".join(f"<p style='margin:0 0 14px;line-height:1.6'>{p}</p>" for p in paragraphs)
    button = (f"<p><a href='{html.escape(cta[1])}' style='background:#4F8CFF;color:#fff;padding:12px 18px;"
              f"border-radius:8px;text-decoration:none;display:inline-block;font-weight:600'>{html.escape(cta[0])}</a></p>") if cta else ""
    return (f"<div style='font-family:Inter,Arial,sans-serif;max-width:560px;margin:auto;color:#1a2235;font-size:15px'>"
            f"<h2 style='margin:0 0 16px'>{html.escape(title)}</h2>{body}{button}"
            f"<p style='color:#8a97ad;font-size:12px;margin-top:28px;line-height:1.5'>{footer}</p></div>")


def _text(paragraphs: list[str], cta: tuple[str, str] | None, footer: str) -> str:
    import re
    strip = lambda s: re.sub(r"<[^>]+>", "", html.unescape(s))  # noqa: E731
    out = "\n\n".join(strip(p) for p in paragraphs)
    if cta:
        out += f"\n\n{cta[0]}: {cta[1]}"
    return out + "\n\n--\n" + strip(footer)


def build_email(kind: str, uid: str, name: str | None) -> tuple[str, str, str, bool]:
    """Return (subject, html, text, is_marketing)."""
    hi = f"Hi {html.escape(name.split()[0])}," if name else "Hi,"
    app = f"{site_url()}/app.html"
    base_footer = "FutureX is an educational and analytical tool, not financial advice. Leveraged trading can lose more than you expect."
    unsub = f" <a href='{unsubscribe_url(uid)}'>Unsubscribe from tips &amp; offers</a>."
    if kind == "welcome":
        paras = [hi, "Welcome to FutureX. Three things worth doing first:",
                 "1. <b>Check a liquidation price</b>: pick a coin, enter leverage and size, and see exactly where the trade gets force-closed.",
                 "2. <b>Turn on Volatility Alerts</b>: we'll message you when a coin you watch moves sharply, even with the app closed.",
                 f"3. <b>Look at the <a href='{site_url()}/accuracy.html'>accuracy report</a></b>: it shows how far to trust the forecast.",
                 "Reply to this email if anything is unclear. A real person reads it."]
        cta = ("Open FutureX", app)
        return "Welcome to FutureX: start here", _wrap("Welcome to FutureX", paras, cta, base_footer), _text(paras, cta, base_footer), False
    if kind == "tips":
        paras = [hi, "Most liquidations come from the same three habits. Here's how to avoid them:",
                 "<b>Pick leverage from your stop-loss.</b> If your stop is 4% away, anything above ~20× puts liquidation before your stop.",
                 "<b>Count funding.</b> A 10× long held a week at +0.01% funding costs ~2% of your margin with zero price movement.",
                 "<b>Risk a fixed % per trade.</b> Size the position so your stop-loss loses 0.5–2% of your account, not more.",
                 f"More in our guides: <a href='{site_url()}/learn/liquidation-price.html'>liquidation price</a> · <a href='{site_url()}/learn/funding-rates.html'>funding rates</a>."]
        cta = ("Plan your next trade", app)
        return "3 habits that prevent most liquidations", _wrap("3 habits that prevent most liquidations", paras, cta, base_footer + unsub), _text(paras, cta, base_footer + unsub), True
    if kind == "pro_offer":
        paras = [hi, "You've been using FutureX for a week. If it's helping, Pro unlocks the rest:",
                 "• Every timeframe from 5 minutes to 7 days, with forecasts<br>• The ML ensemble (Chronos-Bolt + XGBoost) and the full Analysis Hub<br>• Alerts for 5 coins, on Telegram as well as email",
                 "Cancel anytime, and there's a 14-day money-back guarantee on your first payment."]
        cta = ("See Pro", f"{site_url()}/pricing.html")
        return "Unlock every timeframe in FutureX", _wrap("Ready for the full picture?", paras, cta, base_footer + unsub), _text(paras, cta, base_footer + unsub), True
    if kind == "trial_end":
        paras = [hi, "Your FutureX trial ends in about 2 days. If you do nothing, your plan continues and your card is charged automatically.",
                 "To change or cancel, open the app and click <b>Manage billing</b> next to your name."]
        cta = ("Manage billing", app)
        return "Your FutureX trial ends in 2 days", _wrap("Your trial ends soon", paras, cta, base_footer), _text(paras, cta, base_footer), False
    raise ValueError(kind)


def due_emails(profile: dict, sub: dict | None, now: float) -> list[str]:
    """Which lifecycle emails this user should get now (at most one per run)."""
    sent = profile.get("lifecycle") or {}
    created = parse_ts(profile.get("createdAt")) or now
    age = now - created
    consent = bool(profile.get("marketingConsent"))
    plan = effective_plan(sub, now)
    out = []
    if sub and sub.get("status") == "on_trial":
        ends = parse_ts(sub.get("trial_ends_at"))
        key = f"trial_end_{(sub.get('trial_ends_at') or '')[:10]}"
        if ends and 0 < ends - now <= 2.5 * DAY and key not in sent:
            out.append("trial_end")
    if "welcome" not in sent and age < 14 * DAY:
        out.append("welcome")
    elif consent and "tips" not in sent and age >= 3 * DAY and age < 30 * DAY:
        out.append("tips")
    elif consent and "pro_offer" not in sent and age >= 7 * DAY and age < 45 * DAY and plan == "free":
        out.append("pro_offer")
    return out[:1]


def main():
    raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT", "")
    if not raw or not (os.environ.get("RESEND_API_KEY") and os.environ.get("EMAIL_FROM")):
        print("Lifecycle emails not configured (need FIREBASE_SERVICE_ACCOUNT, RESEND_API_KEY, EMAIL_FROM) — skipping.")
        return
    if not os.environ.get("EMAIL_LINK_SECRET"):
        print("EMAIL_LINK_SECRET not set — refusing to send marketing email without a working unsubscribe link.")
        return
    import firebase_admin
    from firebase_admin import auth, credentials, firestore
    firebase_admin.initialize_app(credentials.Certificate(json.loads(raw)))
    db = firestore.client()

    def auth_email(uid: str) -> str | None:
        try:
            u = auth.get_user(uid)
            return u.email  # Google sign-in emails are verified by Google
        except Exception:
            return None

    run(db, time.time(), email_for=auth_email)


def run(db, now: float, send=None, email_for=None) -> int:
    """email_for(uid) returns the address from Firebase Auth. The profile doc
    is client-writable, so its `email` field is never used as a recipient."""
    send = send or notify.send_email_resend
    sent_count = 0
    for snap in db.collection_group("data").stream():
        if snap.id != "profile" or sent_count >= MAX_PER_RUN:
            continue
        p = snap.to_dict() or {}
        uid = snap.reference.parent.parent.id
        if email_for is None:
            continue
        email = email_for(uid)
        if not email:
            continue
        sub_snap = db.collection("subscriptions").document(uid).get()
        sub = sub_snap.to_dict() if sub_snap.exists else None
        for kind in due_emails(p, sub, now):
            subject, body_html, body_text, marketing = build_email(kind, uid, p.get("displayName"))
            headers = {"List-Unsubscribe": f"<{unsubscribe_url(uid)}>",
                       "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"} if marketing else None
            try:
                send(email, subject, body_html, body_text, headers)
            except Exception as e:
                print(f"  {kind} to {uid} failed: {e}", file=sys.stderr)
                continue
            key = kind if kind != "trial_end" else f"trial_end_{(sub.get('trial_ends_at') or '')[:10]}"
            snap.reference.set({"lifecycle": {key: datetime.now(timezone.utc).isoformat()}}, merge=True)
            sent_count += 1
            print(f"  sent {kind} → {uid}")
    print(f"Done. {sent_count} lifecycle email(s) sent.")
    return sent_count


if __name__ == "__main__":
    main()
