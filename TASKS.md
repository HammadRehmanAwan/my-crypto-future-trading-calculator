You are working on FutureX, a crypto futures trading calculator. The repo is one project with two deployment targets:


Static frontend → GitHub Pages (index.html, app.js, style.css). This is the live user-facing site.
FastAPI backend (backend.py) → currently on Render free tier (onrender.com). The frontend calls it via BACKEND_URL in app.js.
A separate Gradio app (app.py) runs on a Hugging Face Space (Docker, port 7860) and already loads real Amazon Chronos.


Read the actual code before editing — file/function names below are stable, but do not trust any line numbers; verify against the current source.


⛔ PRIME DIRECTIVES (do not violate)


Honesty about models is non-negotiable. Today backend.py defines _model_chronos_bolt, _model_timesfm, _model_lstm, _model_xgboost, _model_chronos_2 — these are pure-Python heuristics (exponential smoothing, OLS slope, weighted averages) named after real deep-learning models. Every model name shown in the UI must correspond to a genuinely-running model of that type. If a model cannot be made real within resource limits, RENAME it to what it actually is (e.g., "ETS Baseline", "Holt-Winters Trend") — never keep a branded name on a heuristic. This rule overrides "make it look impressive."
Never break graceful degradation. The frontend currently works when the backend is asleep (price/chart data comes straight from CoinGecko; news has a 3-tier fallback). Preserve this. Every backend-dependent feature must fail soft with a clear state, never a broken UI.
No secrets in the frontend. CoinGecko key, HF token, and EmailJS private key live in backend env vars only. Firebase config stays served from /firebase-config.
Test before you commit. After each phase: run the backend locally, exercise the changed feature, and confirm the frontend still loads with the backend unreachable. Commit per phase with a clear message.
Keep all existing risk disclaimers. Add new ones where new features warrant them.



🔴 DECISION POINTS — ask the user these FIRST, before Phase 2

Real ML models will not fit Render's free tier (512 MB RAM; PyTorch + a transformer can exceed that and make cold-starts multi-minute). Resolve these before writing model code:


Where do heavy models run?

(Recommended) Consolidate ML onto the HF Space (16 GB RAM, 2 vCPU, already loads Chronos). Either run backend.py on the Space and mount FastAPI alongside Gradio (gr.mount_gradio_app), or keep Render thin and have it proxy /ensemble-forecast to the Space. Then point the frontend BACKEND_URL accordingly.
(Alt) Upgrade the Render instance to a paid tier with enough RAM.
Ask the user which path. Do not attempt to load PyTorch models on Render free tier.



Which models become genuinely real? The honest minimum is Chronos-Bolt (real) + XGBoost (real) plus clearly-labeled statistical baselines. TimesFM (real Google model, ~200–500 M params, RAM-heavy) and LSTM (needs a real trained/shipped model) are optional — only keep those labels if the user wants to ship real ones. Note: "Chronos-2" is not a released model name — map it to a real Chronos variant or drop it. Confirm the final model list with the user.
Secrets/keys to provide: CoinGecko Demo API key (free, 30 req/min), HF_TOKEN (for chat + any HF-hosted inference), and EmailJS private key (only if doing real server-side alerts). Ask the user to set these as env vars on the chosen host.



PHASE 1 — Backend foundation & data reliability

1.1 CoinGecko proxy with server-side Demo key.
apiFetch in app.js hits the keyless public CoinGecko endpoint with no 429 handling — under real traffic and the "Analyze 15 coins" feature this will rate-limit constantly. Add backend routes that proxy CoinGecko using the Demo key server-side (header x-cg-demo-api-key), with TTL caching:


GET /cg/price?ids=... and GET /cg/history/{coin}/{days} (base stays api.coingecko.com/api/v3).
Frontend: route these calls through the backend, but keep a direct-CoinGecko fallback if the backend is unreachable (preserve degradation).


1.2 Frontend fetch hardening. In apiFetch: add 429 retry with exponential backoff + jitter, a concurrency-limited request queue (e.g., max 2 in flight, min ~300 ms spacing), and persist the cache to localStorage so repeat visits don't re-hit the API.

1.3 Cold-start UX. Add an external keep-warm pinger (uptime cron hitting /health) — document it in the README. In the UI, show a "Waking the AI engine…" state for backend-dependent features instead of silent failure. Keep wakeBackend().

1.4 Remove deprecated param. interval=daily on /coins/{id}/market_chart is now Enterprise-only and ignored on free tier — remove it.

✅ Done when: prices/charts load via the proxy, a forced 429 retries gracefully, the frontend still works with the backend down, and no interval=daily remains.


PHASE 2 — Wire REAL models (the core task)

Replace the heuristic ensemble in backend.py with genuinely-running models. Implement on the host chosen in Decision Point 1.

2.1 Chronos-Bolt (real, the flagship).

pip install chronos-forecasting torch

pythonfrom chronos import BaseChronosPipeline
import torch
pipe = BaseChronosPipeline.from_pretrained(
    "amazon/chronos-bolt-small",        # use -tiny if RAM-constrained
    device_map="cpu", torch_dtype=torch.float32,
)
q, mean = pipe.predict_quantiles(
    context=torch.tensor(prices, dtype=torch.float32),
    prediction_length=7, quantile_levels=[0.1, 0.5, 0.9],
)

Load the pipeline once at startup (module-level), not per request. Use the real quantiles for the forecast band.

2.2 XGBoost (real, ties to the user's dissertation).

pip install xgboost

Build a supervised dataset from historical daily prices: features = [RSI, MACD, MACD-signal, EMA9/21/50 ratios, ATR, returns 1/7/14d, rolling volatility], target = forward 7-day return. Fetch ~1–2 yrs history per coin, engineer features per row, train XGBRegressor. Pre-train offline and ship a saved model (model.json loaded at boot) so cold-start stays fast; predict on current features → forward return → price. This is genuine ML — make it real, not a weighted formula.

2.3 Statistical baselines (kept, but renamed honestly). The existing ETS / damped Holt-Winters / OLS code is fine to keep as labeled statistical baselines ("ETS Baseline", "Holt-Winters Trend", "Linear Trend") — just stop calling them Chronos/TimesFM/LSTM.

2.4 Optional real models (only if user opts in):


TimesFM: pip install timesfm, google/timesfm-2.0-500m — real but heavy; only on the Space, only if RAM/cold-start budget allows.
LSTM: ship a small PyTorch LSTM trained offline (saved state_dict, loaded at boot). If not shipping a real one, remove the LSTM label entirely.


2.5 Model-status transparency. Add GET /model-status returning which models actually loaded (e.g., {"chronos_bolt": true, "xgboost": true, "timesfm": false}). Log model load at startup. This guarantees the UI can't silently show a model that isn't running.

2.6 Frontend + copy. Update renderEnsembleForecast and ENS_MODEL_META to match the real model set. Update the hero badge — if the live forecast is statistical, say so honestly; if Chronos genuinely runs, the "Amazon Chronos AI" claim is now true. Have the UI read /model-status and only render models that loaded.

✅ Done when: /model-status shows real models loaded, changing the input meaningfully changes each real model's output, startup logs show the pipelines loading, and no UI label names a model that isn't genuinely running.


PHASE 3 — Calculator correctness (expert-trader gaps)

3.1 Fees & funding in PnL. calcFutures currently computes pure price PnL — no fees, no funding. Real perps charge taker fees and funding every 8h, which materially changes PnL at high leverage. Add optional inputs: taker fee % (default 0.05%), funding rate (auto-fill from the real OKX rate the backend already fetches), and holding period (hours). Compute:
net PnL = gross PnL − entry_notional×fee − exit_notional×fee − notional×funding_rate×(hours/8).
Show gross vs net PnL and net ROE side by side.

3.2 Fix the liquidation-copy inconsistency. The Learn section says 100× ≈ 1% to liquidation, but the calculator (correctly, with 0.5% MMR) gives 0.5%. Either align the copy or clarify that "≈1%" is the no-fee textbook approximation (1/leverage).

✅ Done when: PnL reflects fees+funding, gross and net are both shown, and the educational copy matches the math.


PHASE 4 — Compliance & social assets (currently 404s)

4.1 Create privacy.html (referenced from the email-consent checkbox and footer but missing — a real GDPR gap since emails are collected). Static page, styled to match, covering: data collected (email, alert prefs), purpose (volatility alerts), legal basis (consent), storage (browser localStorage + Firestore when signed in + EmailJS), third parties (EmailJS, Firebase, CoinGecko, OKX, alternative.me, CryptoCompare), retention, user rights (access/delete — reference the in-app delete button), cookies (Firebase auth), and a contact method. Verify every privacy.html link resolves.

4.2 Create the OG preview image. Meta references /frontend/og-preview.png but there is no frontend/ dir — fix the path mismatch (create the file at the referenced path or update the meta to a root path). Generate a 1200×630 PNG using brand colors + logo + tagline (a small PIL or SVG→PNG script is fine).

✅ Done when: the privacy link and OG image both load, and the social card previews correctly.


PHASE 5 — Chat assistant: migrate or downgrade honestly

backend.py's /chat calls api-inference.huggingface.co/models/{model}, which HF has largely deprecated — the LLM path likely dead, silently falling back to the KB. Either:


Migrate to the OpenAI-compatible HF router: POST https://router.huggingface.co/v1/chat/completions (header Authorization: Bearer $HF_TOKEN, body in OpenAI chat format, model like meta-llama/Llama-3.1-8B-Instruct), or point it at a real provider. Keep the rule-based KB as fallback.
Or, if the user doesn't want to maintain an LLM, present "Zorion" honestly as a rule-based assistant and drop the live-LLM implication.


✅ Done when: the chat either genuinely reaches an LLM or is honestly described as rule-based — no dead code pretending to be live.


PHASE 6 — Volatility alerts: make real or reword

The UI says coins are "monitored every 5 min" and alerts "sent automatically," but a static site only checks while the tab is open. Either:


Real fix: a backend cron loop that reads each subscriber's watched coins from Firestore (already wired), computes indicators, and on a threshold breach sends via the EmailJS REST API (POST https://api.emailjs.com/api/v1.0/email/send with service/template/public-key + private accessToken). This delivers true always-on monitoring.
Or, reword the UI honestly ("alerts run while this tab is open") and keep client-side checks.


Pick based on the user's appetite — ask if unsure.

✅ Done when: the alert behavior matches what the copy claims.


PHASE 7 — Performance, a11y & SEO polish


JS size: app.js is ~244 KB unminified and monolithic. Add a minimal build step (esbuild/terser → app.min.js, referenced in prod) or split into ES modules. Don't regress load behavior.
Accessibility: add type="button" to all <button>s (currently 44 without it), aria-labels on icon/emoji buttons (mic, audio toggle, nav emoji), aria-hidden="true" on decorative emoji/SVG, and visible focus states.
SEO: add robots.txt (allow all + sitemap ref) and sitemap.xml (index + privacy).
(Optional, needs user OK) privacy-friendly analytics (e.g., GoatCounter/Plausible) so usage is measurable — adds a third party, so confirm first.


✅ Done when: Lighthouse a11y/SEO improve, the minified bundle loads, and robots/sitemap are present.


Suggested execution order (for efficiency)


Phase 0: read code, confirm the 3 decision points, set env vars.
Phase 1 (data reliability) → test → commit.
Phase 2 (real models — the heart) → test via /model-status → commit.
Phase 3 (calculator) → test numerically → commit.
Phase 4 (privacy + OG) → verify links → commit.
Phase 5 (chat) → commit. Phase 6 (alerts) → commit.
Phase 7 (polish) → commit.


Work one phase at a time. After each: run the backend, exercise the change, confirm the frontend survives a dead backend, then commit. Pause at decision points rather than guessing.

Final verification checklist


 /model-status lists only genuinely-loaded models; UI shows no model that isn't running.
 Every branded model name = a real model of that type, or it's been renamed honestly.
 Frontend fully works with BACKEND_URL unreachable.
 CoinGecko calls are proxied + keyed + 429-resilient; no rate-limit failures under the 15-coin run.
 PnL includes fees + funding; gross and net both shown; Learn copy matches the math.
 privacy.html and the OG image load; all links resolve.
 Chat is either real-LLM or honestly labeled rule-based.
 Alert copy matches actual behavior.
 No secrets in the frontend; all keys server-side.
 Disclaimers intact; new features carry appropriate ones.
