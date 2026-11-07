# FutureX — launch setup guide

Everything in the code is built and tested. What's left needs **your accounts,
keys or decisions**: nothing here can be done from the repository alone.
Work top to bottom; each step says how to check it worked.

The paywall ships **OFF** (`PAYWALL_ENABLED=false`), so merging changes nothing
for users until step 11.

---

## 1. Merge and first deploy

1. Merge the PR into `main`. Three deploys start automatically:
   - **GitHub Pages** (`deploy-pages.yml`): landing page at `/`, app at `/app.html`.
   - **Hugging Face Space** (`deploy-hf-spaces.yml`): now a **Docker** Space running the real Chronos-Bolt + XGBoost model server.
   - **CI** (`ci.yml`): type-check, unit tests, smoke test, Python tests.
2. **Hugging Face:** the workflow switches the Space to `sdk: docker` through its README. If the Space page still says "Static" after ~2 minutes, open the Space → **Settings → Change SDK → Docker**.
   The first Docker build takes 5–10 minutes (it downloads PyTorch and the model).
   ✅ Check: the **verify** job in the "Deploy to Hugging Face Spaces" run turns green, or open
   `https://hammadrehman-crypto-futures-calculator.hf.space/api/model-status` and see `"chronos_bolt": true`.
3. **Render:** if your service wasn't created from `render.yaml`, set **Settings → Build Command** to
   `pip install -r requirements-backend.txt`. (Billing needs `google-auth` and `firebase-admin`.)
   ✅ Check: `https://my-crypto-future-trading-calculator.onrender.com/billing/config` returns JSON with three plans.

## 2. Firebase

1. **Security rules:** Firebase console → Firestore → **Rules** → paste `firestore.rules` → **Publish**.
   These stop users from writing their own subscription. **Don't take payments before this is done.**
2. **Service account:** Project settings → Service accounts → **Generate new private key**. You'll paste the whole JSON as `FIREBASE_SERVICE_ACCOUNT` in Render (step 3) and GitHub (step 5).
3. **Authorized domains:** Authentication → Settings → Authorized domains: make sure your site's domain is listed (and your custom domain later).

## 3. Render environment variables

Render → your service → **Environment**. `render.yaml` lists them all.

| Variable | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | the JSON from step 2.2 |
| `SITE_URL` | `https://hammadrehmanawan.github.io/my-crypto-future-trading-calculator` (or your domain) |
| `ALLOWED_ORIGINS` | your custom domain(s), comma-separated, e.g. `https://futurex.app,https://www.futurex.app` |
| `EMAIL_LINK_SECRET` | any long random string, also set as a GitHub secret (step 5) |
| `SENTRY_DSN` | optional, step 9 |
| `LEMONSQUEEZY_*`, `LS_VARIANT_*` | step 8 |
| `PAYWALL_ENABLED` | leave `false` until step 11 |

Recommended: upgrade Render to the **Starter** plan (~$7/mo) before launch. The free
instance sleeps, and the first request after that takes ~50 s. The `uptime.yml`
workflow pings it every 10 min to reduce sleeps, but GitHub's scheduler isn't exact.

## 4. Custom domain (recommended before advertising)

1. Buy a domain (e.g. Cloudflare Registrar, Namecheap).
2. GitHub → repo **Settings → Pages → Custom domain** → enter it, then add the DNS records GitHub shows. Tick **Enforce HTTPS**.
3. Update the domain in these places, then commit:
   - `frontend/js/config.js` → `siteUrl`
   - Rebuild static pages with the new canonical URLs: `SITE_URL=https://yourdomain python scripts/build_site.py`
   - `frontend/app.html` → the `canonical` and `og:*` URLs at the top
   - `site_src/404.html` uses the path from `SITE_URL` automatically (rebuild above)
4. Render: `SITE_URL` and `ALLOWED_ORIGINS`. GitHub variable `SITE_URL` (step 5). Firebase authorized domains (step 2.3).

## 5. GitHub secrets and variables

Repo → **Settings → Secrets and variables → Actions**.

**Secrets**

| Name | Used by | Notes |
|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | alerts, lifecycle emails | same JSON as Render |
| `RESEND_API_KEY` | alerts, lifecycle emails | step 6 |
| `EMAIL_LINK_SECRET` | lifecycle emails | same value as Render |
| `TELEGRAM_BOT_TOKEN` | alerts | step 7 |
| `CG_DEMO_API_KEY` | alerts, backtest | free CoinGecko Demo key, raises rate limits |
| `HF_TOKEN` | Space deploy | already set (deploys were succeeding) |
| `EMAILJS_*` | alerts | optional legacy fallback if you skip Resend |

**Variables** (Variables tab)

| Name | Example |
|---|---|
| `EMAIL_FROM` | `FutureX <alerts@yourdomain.com>` |
| `SITE_URL` | your site URL |
| `BACKEND_URL` | `https://my-crypto-future-trading-calculator.onrender.com` |
| `PAYWALL_ENABLED` | `false` now; `true` at launch |

✅ Check: Actions → **Volatility Alerts** → *Run workflow*. The log should end with `Done. N alert(s) sent.`

## 6. Email (Resend)

1. Create a Resend account → **Domains** → add your domain → add the DNS records (SPF/DKIM) → wait for "Verified".
2. **API Keys** → create → save as `RESEND_API_KEY` (GitHub secret).
3. Set `EMAIL_FROM` (GitHub variable) to an address on that domain.

Without a verified domain, emails land in spam or are rejected.

## 7. Telegram bot

1. In Telegram, message **@BotFather** → `/newbot` → pick a name and username (e.g. `FutureXAlertsBot`).
2. Save the token as the `TELEGRAM_BOT_TOKEN` GitHub secret.
3. Put the username (without `@`) in `frontend/js/config.js` → `telegramBot`. Commit.

✅ Check: sign in on the app → Volatility Alerts → **Connect Telegram** → press Start. Within 15 minutes the bot replies "✅ Connected".

## 8. Lemon Squeezy (payments)

1. **Check eligibility first.** Read Lemon Squeezy's acceptable-use policy and confirm a trading-analysis SaaS is allowed. Describe FutureX accurately as an analytics/education tool, not "signals" or advice. If they decline, Paddle is the closest alternative (billing.py's webhook handling would need adapting).
2. Create the store, then two **products** with subscription **variants** matching `plans.py`:
   - Pro: $15/month and $144/year
   - Trader: $39/month and $374/year
   Optional: add a free trial on the variants (the trial-ending email is already handled).
3. Copy each variant's ID into Render: `LS_VARIANT_PRO_MONTHLY`, `LS_VARIANT_PRO_YEARLY`, `LS_VARIANT_TRADER_MONTHLY`, `LS_VARIANT_TRADER_YEARLY`.
4. **Settings → API** → create key → Render `LEMONSQUEEZY_API_KEY`. Your **store ID** (number) → `LEMONSQUEEZY_STORE_ID`.
5. **Settings → Webhooks** → add:
   - URL: `https://my-crypto-future-trading-calculator.onrender.com/billing/webhook`
   - Signing secret: a random string → Render `LEMONSQUEEZY_WEBHOOK_SECRET`
   - Events: all `subscription_*` events (created, updated, cancelled, resumed, expired, paused, unpaused, payment_success, payment_failed, payment_recovered)
6. **Customer portal:** enable it (Settings → General), so "Manage billing" works.
7. **Affiliates:** enable the affiliate program, set the commission (20–30% recurring is common), and copy the signup URL into `site_src/affiliates.html` (replace `[AFFILIATE SIGNUP URL]`), then run `python scripts/build_site.py`. Put your store slug in `frontend/js/config.js` → `lemonStore`.
8. **Test end-to-end in Test mode** (step 11).

Changing prices later: edit `plans.py` **and** `site_src/pricing.html` (a test fails if they disagree), rebuild, and create matching LS variants.

## 9. Monitoring and analytics

- **Sentry** (sentry.io, free tier): create a Browser JavaScript project → copy the DSN into `frontend/js/config.js` → `sentryDsn`. Create a Python/FastAPI project → DSN into Render `SENTRY_DSN`.
- **PostHog** (posthog.com, free tier): copy the Project API key into `config.js` → `posthogKey` (and `posthogHost` if you chose the EU region: `https://eu.i.posthog.com`).
  Useful funnel once live: `$pageview (pricing)` → `paywall_shown` → `checkout_clicked` → `checkout_completed`.

## 10. Legal (needs you and ideally a lawyer)

Replace these placeholders in `site_src/` (then run `python scripts/build_site.py`):

- `[OPERATOR NAME]`, `[REGISTERED ADDRESS]`: you or your company
- `[CONTACT EMAIL]`: a monitored support address
- `[JURISDICTION]`: governing law in the Terms
- `[AFFILIATE SIGNUP URL]`: step 8.7

Also decide and confirm:

- **Refund terms:** the policy offers a 14-day money-back guarantee on the first payment. Change `site_src/refund.html` if you want something else.
- **Regulation:** selling trading tools is generally fine, but "signals", "verdicts" and AI trade suggestions can fall under investment-advice rules in some countries, and retail crypto derivatives are **banned in the UK**. Get a short legal review of the copy and target countries before running ads.
- Keep the trading-bot code (`trading_bot/`) self-hosted only; never hold users' exchange keys.

## 11. Go-live checklist

1. Lemon Squeezy in **Test mode**. Render `PAYWALL_ENABLED=true`, GitHub variable `PAYWALL_ENABLED=true`.
2. As a test user: sign in → open the Hub → paywall appears → **Get Pro** → pay with LS test card `4242 4242 4242 4242` → redirected back → "Welcome to FutureX Pro" toast → Hub opens.
   ✅ Firestore has `subscriptions/<uid>` with `status: active`.
3. Click **Manage billing** → cancel → plan shows "ends soon" and stays active until period end.
4. Switch Lemon Squeezy to **Live mode** (live API key, live variant IDs and webhook secret in Render).
5. Actions → **Weekly forecast backtest** → *Run workflow*. Then check `/accuracy.html` shows real numbers.
   Read them before advertising. If the forecast doesn't beat the naive baseline, say so in your marketing; the landing copy already frames it that way.
6. Google Search Console: add the site, submit `sitemap.xml`.

## 12. Advertising notes

- Google Ads and Meta restrict crypto-related ads: you'll likely need their financial-services / crypto certification, and some countries are excluded. Start with SEO (the `learn/` guides), X/Telegram/YouTube creators via the affiliate program, and crypto-native ad networks.
- Never advertise guaranteed returns or accuracy figures beyond what `accuracy.html` shows.

## Deferred: Next.js / TypeScript migration

Not done in this pass, by decision: payments don't need it, and a rewrite of the
5,000-line `app.js` risks the working product. The path is set up instead:

- New code lives in typed modules under `frontend/js/` (`tsc --checkJs`, strict).
- Core math is isolated and unit-tested (`js/core.js`), so it can move to a
  TypeScript package unchanged.
- Suggested order: port `core.js` → `.ts`; scaffold Next.js on a branch serving
  the marketing pages; then move the app one view at a time (Calculator → Hub →
  Dashboard), keeping the smoke test green throughout.
