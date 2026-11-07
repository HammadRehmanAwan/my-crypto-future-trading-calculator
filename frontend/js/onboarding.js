// @ts-check
// ═══════════════════════════════════════════════════════════════════
// FutureX first-run onboarding (3 short steps, shown once per browser)
// and the "Connect Telegram" control in the Volatility Alerts card.
// ═══════════════════════════════════════════════════════════════════
(function () {
  const FX = /** @type {any} */ (window.FX || {});
  const cfg = window.FX_CONFIG;

  /** @param {string} k */
  const lsGet = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  /** @param {string} k @param {string} v */
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* ignore */ } };

  const COINS = [
    ['bitcoin', 'BTC'], ['ethereum', 'ETH'], ['solana', 'SOL'],
    ['ripple', 'XRP'], ['binancecoin', 'BNB'], ['dogecoin', 'DOGE'],
  ];

  // ── Onboarding ───────────────────────────────────────────────────
  function startOnboarding() {
    if (lsGet('fx_onboarded') === '1') return;
    const qs = new URLSearchParams(location.search);
    if (qs.has('checkout') || location.hash.startsWith('#upgrade')) return;
    // The legal disclaimer banner comes first; wait until it's dismissed.
    const banner = document.getElementById('disclaimerBanner');
    if (banner && getComputedStyle(banner).display !== 'none') {
      const obs = new MutationObserver(() => {
        if (getComputedStyle(banner).display === 'none') { obs.disconnect(); setTimeout(show, 400); }
      });
      obs.observe(banner, { attributes: true, attributeFilter: ['style', 'class'] });
      return;
    }
    setTimeout(show, 800);
  }

  let step = 0;
  let coin = 'bitcoin';
  let consent = false;

  function show() {
    FX.track && FX.track('onboarding_started');
    const wrap = document.createElement('div');
    wrap.className = 'fx-modal-backdrop fx-onb';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-labelledby', 'fxOnbTitle');
    const finish = (/** @type {boolean} */ completed) => {
      lsSet('fx_onboarded', '1');
      wrap.remove();
      FX.track && FX.track(completed ? 'onboarding_completed' : 'onboarding_skipped', { step });
      if (consent) saveConsent(true);
    };
    const steps = [
      () => `
        <h2 id="fxOnbTitle">Welcome to FutureX</h2>
        <p>See exactly where a leveraged trade gets liquidated, what fees and funding cost you,
        and what the market data says, <b>before</b> you risk money.</p>
        <p>Which coin do you trade most?</p>
        <div class="fx-onb-coins">${COINS.map(([id, sym]) =>
          `<button type="button" data-coin="${id}" class="${id === coin ? 'active' : ''}">${sym}</button>`).join('')}</div>`,
      () => `
        <h2 id="fxOnbTitle">Plan a trade in 5 steps</h2>
        <p>The <b>Guided Trade Setup</b> walks you through direction, leverage, size and stop-loss.
        You'll get the liquidation price, net profit after fees and funding, and a plain-English
        risk check.</p>
        <p>Tip: keep leverage low. At 10× a 9.5% move against you liquidates the position; at 100× it takes just 0.5%.</p>`,
      () => `
        <h2 id="fxOnbTitle">Never miss a big move</h2>
        <p>Turn on <b>Volatility Alerts</b> (below the calculator) and we'll email you when a coin
        you watch makes an unusually sharp move${cfg && cfg.telegramBot ? ', or message you on Telegram' : ''}.</p>
        <label><input type="checkbox" id="fxOnbConsent" ${consent ? 'checked' : ''}>
          <span>Email me occasional trading guides and product updates. Unsubscribe anytime.</span></label>`,
    ];
    const render = () => {
      wrap.innerHTML = `<div class="fx-modal">
        <div class="fx-onb-steps" aria-hidden="true">${steps.map((_, i) => `<i class="${i <= step ? 'on' : ''}"></i>`).join('')}</div>
        ${steps[step]()}
        <div class="fx-onb-actions">
          <button type="button" class="fx-onb-skip">${step === 0 ? 'Skip intro' : 'Back'}</button>
          <button type="button" class="fx-cta">${step === steps.length - 1 ? 'Start using FutureX' : 'Next'}</button>
        </div></div>`;
      wrap.querySelectorAll('[data-coin]').forEach(b => b.addEventListener('click', () => {
        coin = /** @type {HTMLElement} */ (b).dataset.coin || 'bitcoin';
        const sel = /** @type {any} */ (window).selectCoin;
        if (typeof sel === 'function') sel(coin);
        render();
      }));
      const cb = /** @type {HTMLInputElement|null} */ (wrap.querySelector('#fxOnbConsent'));
      cb?.addEventListener('change', () => { consent = cb.checked; });
      wrap.querySelector('.fx-onb-skip')?.addEventListener('click', () => {
        if (step === 0) finish(false); else { step--; render(); }
      });
      wrap.querySelector('.fx-cta')?.addEventListener('click', () => {
        if (step < steps.length - 1) { step++; render(); return; }
        finish(true);
        document.querySelector('.calc-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      /** @type {HTMLElement|null} */ (wrap.querySelector('.fx-cta'))?.focus();
    };
    wrap.addEventListener('keydown', e => { if (e.key === 'Escape') finish(false); });
    render();
    document.body.appendChild(wrap);
  }

  // Marketing consent is stored on the user's profile doc (read by the
  // lifecycle-email worker). Signed-out visitors' choice waits for sign-in.
  /** @param {boolean} value */
  async function saveConsent(value) {
    lsSet('fx_marketing_consent', value ? '1' : '0');
    try {
      const u = typeof _auth !== 'undefined' && _auth ? _auth.currentUser : null;
      if (!u || typeof _db === 'undefined' || !_db) return;
      await _db.collection('users').doc(u.uid).collection('data').doc('profile')
        .set({ marketingConsent: value, consentAt: new Date().toISOString() }, { merge: true });
      lsSet('fx_marketing_consent_synced', '1');
    } catch (_) { /* rules not deployed / offline */ }
  }

  // ── Telegram connect ─────────────────────────────────────────────
  async function renderTelegram() {
    if (!cfg || !cfg.telegramBot) return;
    const card = document.querySelector('.alert-card');
    if (!card) return;
    let row = /** @type {HTMLElement|null} */ (card.querySelector('.fx-tg-row'));
    if (!row) {
      row = document.createElement('div');
      row.className = 'fx-tg-row';
      card.appendChild(row);
    }
    const u = typeof _auth !== 'undefined' && _auth ? _auth.currentUser : null;
    if (!u || typeof _db === 'undefined' || !_db) {
      row.innerHTML = '<span>Sign in to get alerts on Telegram too.</span>';
      return;
    }
    let linked = false;
    try {
      const snap = await _db.collection('users').doc(u.uid).collection('data').doc('telegram').get();
      linked = snap.exists && !!(snap.data() || {}).chatId;
    } catch (_) { /* ignore */ }
    if (linked) {
      row.innerHTML = '<span class="fx-tg-ok">✓ Telegram connected</span><span>Alerts go to your Telegram as well as email.</span>';
      return;
    }
    row.innerHTML = `<button type="button" class="fx-tg-btn">Connect Telegram</button>
      <span>Instant alerts in Telegram. Opens the FutureX bot; tap <b>Start</b>.</span>`;
    row.querySelector('button')?.addEventListener('click', connectTelegram);
  }

  async function connectTelegram() {
    const u = _auth && _auth.currentUser;
    if (!u || !_db) return;
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    const code = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    try {
      // Server-side worker (scripts/check_alerts.py) redeems this code when
      // the user presses Start in the bot, then deletes it.
      await _db.collection('telegram_links').doc(code).set({ uid: u.uid, createdAt: new Date().toISOString() });
    } catch (e) {
      FX.toast && FX.toast('Could not create a Telegram link. Try again shortly.', 'warn');
      return;
    }
    FX.track && FX.track('telegram_connect_clicked');
    window.open(`https://t.me/${encodeURIComponent(cfg.telegramBot)}?start=${code}`, '_blank', 'noopener');
    const row = document.querySelector('.fx-tg-row');
    if (row) row.innerHTML = '<span>Press <b>Start</b> in Telegram. Your connection is confirmed within a few minutes.</span>';
  }

  document.addEventListener('fx:auth', e => {
    renderTelegram();
    const user = /** @type {CustomEvent} */ (e).detail?.user;
    if (user && lsGet('fx_marketing_consent') === '1' && lsGet('fx_marketing_consent_synced') !== '1') saveConsent(true);
  });

  function boot() { startOnboarding(); renderTelegram(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
