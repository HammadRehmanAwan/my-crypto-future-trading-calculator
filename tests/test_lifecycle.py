"""Lifecycle email rules: consent gating, ordering, once-only delivery."""
import os
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
sys.path.insert(0, os.path.dirname(__file__))

import lifecycle_emails as le  # noqa: E402
from fakefs import FakeDB  # noqa: E402

DAY = 86400


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).isoformat()


NOW = time.time()


def test_welcome_first_and_only_once():
    p = {"email": "a@b.c", "createdAt": iso(NOW - 60)}
    assert le.due_emails(p, None, NOW) == ["welcome"]
    p["lifecycle"] = {"welcome": "x"}
    assert le.due_emails(p, None, NOW) == []


def test_marketing_requires_consent():
    p = {"email": "a@b.c", "createdAt": iso(NOW - 8 * DAY), "lifecycle": {"welcome": "x"}}
    assert le.due_emails(p, None, NOW) == []
    p["marketingConsent"] = True
    assert le.due_emails(p, None, NOW) == ["tips"]
    p["lifecycle"]["tips"] = "x"
    assert le.due_emails(p, None, NOW) == ["pro_offer"]


def test_no_pro_offer_for_paying_users():
    p = {"email": "a@b.c", "createdAt": iso(NOW - 8 * DAY), "marketingConsent": True,
         "lifecycle": {"welcome": "x", "tips": "x"}}
    assert le.due_emails(p, {"plan": "pro", "status": "active"}, NOW) == []


def test_trial_end_reminder():
    p = {"email": "a@b.c", "createdAt": iso(NOW - 20 * DAY), "lifecycle": {"welcome": "x"}}
    sub = {"plan": "pro", "status": "on_trial", "trial_ends_at": iso(NOW + 2 * DAY)}
    assert le.due_emails(p, sub, NOW) == ["trial_end"]
    sub["trial_ends_at"] = iso(NOW + 6 * DAY)
    assert le.due_emails(p, sub, NOW) == []


def test_run_sends_and_records(monkeypatch):
    monkeypatch.setenv("EMAIL_LINK_SECRET", "k")
    db = FakeDB({
        "users/u1/data/profile": {"email": "a@b.c", "displayName": "Ada L", "createdAt": iso(NOW - 3600)},
        "users/u2/data/profile": {"createdAt": iso(NOW)},          # no email → skipped
        "users/u1/data/settings": {"enabled": True},
    })
    sent = []
    auth_emails = {"u1": "a@b.c"}                   # Firebase Auth is the source of truth
    le.run(db, NOW, send=lambda to, subj, h, t, headers: sent.append((to, subj, headers)), email_for=auth_emails.get)
    assert len(sent) == 1 and sent[0][0] == "a@b.c" and "Welcome" in sent[0][1]
    assert sent[0][2] is None                       # account email: no List-Unsubscribe
    assert "welcome" in db.store["users/u1/data/profile"]["lifecycle"]
    le.run(db, NOW, send=lambda *a: sent.append(a), email_for=auth_emails.get)
    assert len(sent) == 1                           # not sent twice


def test_profile_email_is_never_the_recipient():
    db = FakeDB({"users/u1/data/profile": {"email": "victim@x.com", "createdAt": iso(NOW)}})
    sent = []
    le.run(db, NOW, send=lambda to, *a: sent.append(to), email_for={"u1": "owner@y.com"}.get)
    assert sent == ["owner@y.com"]


def test_marketing_email_has_unsubscribe(monkeypatch):
    monkeypatch.setenv("EMAIL_LINK_SECRET", "k")
    subj, body, text, marketing = le.build_email("tips", "u1", "Ada")
    assert marketing and "/email/unsubscribe?u=u1&s=" in body and "Unsubscribe" in text
