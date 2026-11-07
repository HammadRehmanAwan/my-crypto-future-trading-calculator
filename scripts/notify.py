"""
Delivery helpers shared by the scheduled workers (check_alerts.py,
lifecycle_emails.py): email via Resend (preferred) or EmailJS (legacy), and
Telegram Bot API messages.

Environment:
  RESEND_API_KEY        Resend API key — preferred email provider
  EMAIL_FROM            e.g. "FutureX <alerts@yourdomain.com>" (domain verified in Resend)
  EMAILJS_*             legacy fallback (service/template/public/private keys)
  TELEGRAM_BOT_TOKEN    from @BotFather
"""

from __future__ import annotations

import html
import os

import requests

RESEND_URL = "https://api.resend.com/emails"
EMAILJS_URL = "https://api.emailjs.com/api/v1.0/email/send"
TG_API = "https://api.telegram.org"


def email_provider() -> str | None:
    if os.environ.get("RESEND_API_KEY") and os.environ.get("EMAIL_FROM"):
        return "resend"
    if all(os.environ.get(k) for k in ("EMAILJS_SERVICE_ID", "EMAILJS_TEMPLATE_ID",
                                        "EMAILJS_PUBLIC_KEY", "EMAILJS_PRIVATE_KEY")):
        return "emailjs"
    return None


def send_email_resend(to: str, subject: str, html_body: str, text_body: str,
                      headers: dict | None = None) -> None:
    payload = {
        "from": os.environ["EMAIL_FROM"],
        "to": [to],
        "subject": subject,
        "html": html_body,
        "text": text_body,
    }
    if headers:
        payload["headers"] = headers
    r = requests.post(RESEND_URL, json=payload, timeout=20,
                      headers={"Authorization": f"Bearer {os.environ['RESEND_API_KEY']}"})
    if r.status_code >= 300:
        raise RuntimeError(f"Resend {r.status_code}: {r.text[:200]}")


def send_alert_email(to: str, coin_name: str, price: float, reasons: list[str],
                     alert_time: str, app_url: str) -> None:
    provider = email_provider()
    if provider is None:
        raise RuntimeError("no email provider configured")
    price_s = "$" + f"{price:,.2f}"
    if provider == "emailjs":
        payload = {
            "service_id": os.environ["EMAILJS_SERVICE_ID"],
            "template_id": os.environ["EMAILJS_TEMPLATE_ID"],
            "user_id": os.environ["EMAILJS_PUBLIC_KEY"],
            "accessToken": os.environ["EMAILJS_PRIVATE_KEY"],
            "template_params": {
                "to_email": to, "coin_name": coin_name, "current_price": price_s,
                "alert_reasons": "\n".join(f"{i + 1}. {r}" for i, r in enumerate(reasons)),
                "alert_time": alert_time,
            },
        }
        r = requests.post(EMAILJS_URL, json=payload, timeout=20)
        if r.status_code != 200:
            raise RuntimeError(f"EmailJS {r.status_code}: {r.text[:200]}")
        return
    items = "".join(f"<li style='margin:6px 0'>{html.escape(r)}</li>" for r in reasons)
    body = f"""<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:auto;color:#1a2235">
<h2 style="margin:0 0 4px">⚡ {html.escape(coin_name)} volatility alert</h2>
<p style="color:#5b6b88;margin:0 0 16px">{html.escape(alert_time)} · price {html.escape(price_s)}</p>
<ol style="padding-left:20px">{items}</ol>
<p><a href="{html.escape(app_url)}" style="background:#4F8CFF;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;display:inline-block">Open FutureX</a></p>
<p style="color:#8a97ad;font-size:12px">You get this because you turned on Volatility Alerts. Turn them off in the app.
FutureX is an educational tool, not financial advice.</p></div>"""
    text = (f"{coin_name} volatility alert — {alert_time}\nPrice: {price_s}\n\n"
            + "\n".join(f"{i + 1}. {r}" for i, r in enumerate(reasons))
            + f"\n\nOpen FutureX: {app_url}\nNot financial advice.")
    send_email_resend(to, f"{coin_name}: volatility alert", body, text)


# ── Telegram ─────────────────────────────────────────────────────────

def telegram_enabled() -> bool:
    return bool(os.environ.get("TELEGRAM_BOT_TOKEN"))


def tg_call(method: str, **params):
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    r = requests.post(f"{TG_API}/bot{token}/{method}", json=params, timeout=20)
    data = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    if not data.get("ok"):
        raise RuntimeError(f"Telegram {method} failed: {str(data)[:200]}")
    return data.get("result")


def send_telegram(chat_id: int | str, text: str) -> None:
    tg_call("sendMessage", chat_id=chat_id, text=text, parse_mode="HTML",
            disable_web_page_preview=True)


def alert_telegram_text(coin_name: str, price: float, reasons: list[str], app_url: str) -> str:
    lines = "\n".join(f"• {html.escape(r)}" for r in reasons)
    return (f"⚡ <b>{html.escape(coin_name)}</b> volatility alert\n"
            f"Price: <b>${price:,.2f}</b>\n\n{lines}\n\n"
            f"<a href=\"{html.escape(app_url)}\">Open FutureX</a> · not financial advice")
