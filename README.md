# FutureX — AI Crypto Futures Calculator

Know your liquidation price, real profit after fees and funding, and what the
market data says before you open a leveraged crypto trade.

**Live:** https://hammadrehmanawan.github.io/my-crypto-future-trading-calculator/ · **App:** `/app.html`

> **Launching / configuring?** See **[SETUP.md](SETUP.md)** for every account, key and switch, in order.

## Plans

| Free | Pro ($15/mo) | Trader ($39/mo) |
|---|---|---|
| Futures calculator (liquidation, fees, funding, net PnL), live chart, 7-day forecast, indicators, alerts for 1 coin | Every timeframe 5 min → 7 days, ML ensemble, Analysis Hub, portfolio dashboard, AI copilot, alerts for 5 coins + Telegram | Live liquidation stream, order-flow & whale cards, alerts for 15 coins |

Plans are defined once in `plans.py`. The paywall is controlled by `PAYWALL_ENABLED` and is off by default.

## Architecture

| Part | Where | What |
|---|---|---|
| Static site | `frontend/` → GitHub Pages | Landing, pricing, legal, guides (generated from `site_src/`), and the app (`app.html` + `app.js`) |
| Browser modules | `frontend/js/` | `core.js` math (unit-tested) · `billing.js` plans & paywall · `live.js` OKX WebSocket · `onboarding.js` · `fx.js` Sentry/PostHog |
| API | `backend.py` + `billing.py` → Render | CoinGecko/OKX proxies, news, sentiment, chat, ensemble forecast, accounts & Lemon Squeezy billing |
| Model server | `app.py` → Hugging Face Docker Space | Real Amazon Chronos-Bolt-Small + XGBoost (`/api/ml-forecast`, `/api/model-status`) |
| Workers | `scripts/` → GitHub Actions | Volatility alerts (email + Telegram, every 15 min), lifecycle emails (daily), forecast backtest (weekly) |
| Data | Firebase Auth + Firestore | Accounts, alert settings, subscriptions (server-written only, see `firestore.rules`) |

## Forecast honesty

- The chart forecast is **Holt double-exponential smoothing** (statistical), computed in your browser.
- The Hub ensemble adds **Chronos-Bolt** and **XGBoost** when the model server is up; `/model-status` reports what's actually running.
- Accuracy is **backtested weekly** and published at `/accuracy.html`, against a naive no-change baseline.

## Development

```bash
npm install                 # TypeScript, Playwright, Chart.js (for tests)
npm run check               # type-check + JS unit tests + browser smoke test
pip install -r requirements-backend.txt -r scripts/requirements.txt pytest
python -m pytest tests      # billing, alerts, lifecycle, backtest, site checks
python scripts/build_site.py   # regenerate marketing pages after editing site_src/
uvicorn backend:app --reload   # run the API locally
```

Edit marketing pages in `site_src/`, never the generated copies in `frontend/`. CI fails if they're out of date.

---
⚠️ *Educational and analytical tool. Not financial advice. Leveraged crypto trading carries a high risk of loss.*
