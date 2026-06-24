# Server-side Volatility Alerts

`check_alerts.py` is a scheduled worker that delivers FutureX volatility alerts
**24/7, independent of any browser**. It runs from
`.github/workflows/volatility-alerts.yml` (GitHub Actions cron, ~every 30 min).

## How it works

1. Reads every user's alert subscription from Firestore via a collection-group
   query on the `data` collection (the `settings` document the web app writes to
   `users/{uid}/data/settings` when a signed-in user saves alerts).
2. For each enabled subscription with consent + email + watched coins, fetches
   live prices from CoinGecko and computes RSI(14), Bollinger-band width and the
   24h change — the same formulas the web UI uses.
3. Sends an email through the EmailJS REST API when a threshold for the user's
   chosen sensitivity is crossed.
4. Tracks a 2-hour per-coin cooldown and a 5/day cap in
   `users/{uid}/data/alert_state` so each event is emailed once.

Only **signed-in** users are monitored server-side — anonymous users keep their
settings in `localStorage` only (no server record exists to read).

## Required GitHub Actions secrets

Set these under **Settings → Secrets and variables → Actions**. None of them are
ever committed to the repository.

| Secret | What it is |
| --- | --- |
| `FIREBASE_SERVICE_ACCOUNT` | The full service-account JSON from the Firebase console (Project settings → Service accounts → Generate new private key). |
| `EMAILJS_SERVICE_ID` | EmailJS service id (e.g. `service_cf3llwp`). |
| `EMAILJS_TEMPLATE_ID` | EmailJS template id (e.g. `template_2544kb6`). |
| `EMAILJS_PUBLIC_KEY` | EmailJS public key / user id. |
| `EMAILJS_PRIVATE_KEY` | EmailJS **private** key — enables server-side sends. Keep secret. |
| `CG_DEMO_API_KEY` | CoinGecko Demo key (optional; raises the rate limit). |

The EmailJS template must accept the params: `to_email`, `coin_name`,
`current_price`, `alert_reasons`, `alert_time` (the existing template already
does). For server-side calls to succeed, enable **"Allow EmailJS API for
non-browser applications"** in the EmailJS dashboard (Account → Security).

## Running manually

Use the **Run workflow** button on the Actions tab (`workflow_dispatch`), or
locally with the env vars exported:

```bash
pip install -r scripts/requirements.txt
python scripts/check_alerts.py
```
