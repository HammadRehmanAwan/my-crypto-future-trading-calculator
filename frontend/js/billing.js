// @ts-check
// ═══════════════════════════════════════════════════════════════════
// FutureX accounts, plans & paywall (client side).
//
// The client NEVER decides what a user may access — the backend does
// (billing.py verifies the Firebase ID token and reads the subscription that
// only Lemon Squeezy webhooks can write). This module only:
//   • attaches the ID token to backend calls (FX.getIdToken, used by app.js)
//   • shows the user's plan, an Upgrade button and "Manage billing"
//   • shows a paywall instead of a broken card when a premium feature is hit
//   • starts Lemon Squeezy checkout and handles the post-checkout return
//
// While the backend reports paywall=false, every feature stays unlocked and
// nothing here changes how the app behaves.
// ═══════════════════════════════════════════════════════════════════
(function () {
  const cfg = window.FX_CONFIG;
  const API = (cfg && cfg.backendUrl) || '';
  const FX = /** @type {any} */ (window.FX || {});
  window.FX = FX;

  /** @typedef {{id: string, name: string, monthly: number, yearly: number, features: string[]}} Plan */
  /** @type {{paywall: boolean, checkout: boolean, plans: Plan[], alert_coin_limit?: Record<string, number>}} */
  let billingCfg = { paywall: false, checkout: false, plans: [] };
  /** @type {FxPlanInfo & {signed_in?: boolean, has_portal?: boolean, interval?: string|null}} */
  FX.plan = { plan: 'free', status: 'none', paywall: false };

  /** @type {Record<string, number>} */
  const RANK = { free: 0, pro: 1, trader: 2 };
  // Which parts of the app need which plan (mirrors billing.py PLANS copy).
  const GATED_TABS = /** @type {Record<string, 'pro'|'trader'>} */ ({ dash: 'pro', hub: 'pro' });
  const FREE_HORIZONS = new Set(['7d']);

  /** Current Firebase user (app.js owns the auth instance). */
  function currentUser() {
    try { return typeof _auth !== 'undefined' && _auth ? _auth.currentUser : null; } catch (_) { return null; }
  }

  FX.getIdToken = async function () {
    const u = currentUser();
    return u ? u.getIdToken() : null;
  };

  /** @param {'pro'|'trader'} p */
  FX.hasPlan = function (p) {
    if (!billingCfg.paywall) return true;
    return (RANK[FX.plan.plan] || 0) >= RANK[p];
  };

  /** @param {string} path @param {RequestInit} [opts] */
  async function api(path, opts = {}) {
    const tok = await FX.getIdToken().catch(() => null);
    /** @type {Record<string, string>} */
    const headers = { ...(/** @type {any} */ (opts.headers) || {}) };
    if (tok) headers.Authorization = `Bearer ${tok}`;
    if (opts.body) headers['Content-Type'] = 'application/json';
    const r = await fetch(API + path, { ...opts, headers });
    let data = null;
    try { data = await r.json(); } catch (_) { /* empty body */ }
    if (!r.ok) {
      const err = /** @type {any} */ (new Error((data && data.detail && data.detail.error) || `HTTP ${r.status}`));
      err.status = r.status;
      throw err;
    }
    return data;
  }

  async function loadConfig() {
    try {
      const cached = sessionStorage.getItem('fx_billing_cfg');
      if (cached) billingCfg = JSON.parse(cached);
    } catch (_) { /* ignore */ }
    try {
      billingCfg = await api('/billing/config');
      try { sessionStorage.setItem('fx_billing_cfg', JSON.stringify(billingCfg)); } catch (_) { /* ignore */ }
    } catch (_) { /* backend asleep: keep defaults (everything unlocked) */ }
    FX.plan.paywall = billingCfg.paywall;
  }

  async function refreshPlan() {
    try {
      const me = await api('/billing/me');
      FX.plan = { ...me, paywall: billingCfg.paywall };
    } catch (_) {
      FX.plan = { plan: 'free', status: 'none', paywall: billingCfg.paywall };
    }
    renderAccount();
    document.dispatchEvent(new CustomEvent('fx:plan', { detail: FX.plan }));
    return FX.plan;
  }

  // ── Account chip next to the Google sign-in pill ─────────────────
  function renderAccount() {
    const bar = document.getElementById('authBar');
    if (!bar) return;
    bar.querySelector('.fx-plan-chip')?.remove();
    if (!billingCfg.paywall && !billingCfg.checkout) return; // billing not live yet
    const chip = document.createElement('span');
    chip.className = 'fx-plan-chip';
    const p = FX.plan.plan;
    if (p === 'free') {
      chip.innerHTML = `<button class="fx-upgrade-btn" type="button">Upgrade</button>`;
      chip.querySelector('button')?.addEventListener('click', () => FX.showPaywall());
    } else {
      const label = p === 'trader' ? 'Trader' : 'Pro';
      const note = FX.plan.status === 'on_trial' ? ' · trial'
        : FX.plan.status === 'cancelled' ? ' · ends soon'
        : FX.plan.status === 'past_due' ? ' · payment due' : '';
      chip.innerHTML = `<span class="fx-plan-badge fx-plan-${p}">${label}${note}</span>` +
        (FX.plan.has_portal ? `<button class="fx-manage-btn" type="button">Manage billing</button>` : '');
      chip.querySelector('.fx-manage-btn')?.addEventListener('click', () => FX.openPortal());
    }
    bar.appendChild(chip);
  }

  // ── Paywall modal ────────────────────────────────────────────────
  let interval = 'yearly';
  /** @param {string} [feature] @param {'pro'|'trader'} [need] */
  FX.showPaywall = function (feature, need = 'pro') {
    FX.track('paywall_shown', { feature: feature || 'generic', need });
    document.getElementById('fxPaywall')?.remove();
    const plans = billingCfg.plans.filter(p => p.id !== 'free');
    const wrap = document.createElement('div');
    wrap.id = 'fxPaywall';
    wrap.className = 'fx-modal-backdrop';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-labelledby', 'fxPaywallTitle');
    const render = () => {
      wrap.innerHTML = `
        <div class="fx-modal">
          <button class="fx-modal-close" type="button" aria-label="Close">&times;</button>
          <h2 id="fxPaywallTitle">${feature ? `${escape(feature)} is a paid feature` : 'Upgrade FutureX'}</h2>
          <p class="fx-modal-sub">Cancel anytime. Prices in USD; tax calculated at checkout.</p>
          <div class="fx-interval" role="group" aria-label="Billing interval">
            <button type="button" data-int="monthly" class="${interval === 'monthly' ? 'active' : ''}">Monthly</button>
            <button type="button" data-int="yearly" class="${interval === 'yearly' ? 'active' : ''}">Yearly <span>save 20%</span></button>
          </div>
          <div class="fx-plan-grid">
            ${plans.map(p => {
              const price = interval === 'yearly' ? Math.round(p.yearly / 12) : p.monthly;
              const rec = p.id === need;
              return `<div class="fx-plan-card ${rec ? 'rec' : ''}">
                ${rec ? '<div class="fx-plan-tag">Unlocks this</div>' : ''}
                <h3>${escape(p.name)}</h3>
                <div class="fx-price"><b>$${price}</b>/mo${interval === 'yearly' ? `<small>billed $${p.yearly}/yr</small>` : ''}</div>
                <ul>${p.features.map(f => `<li>${escape(f)}</li>`).join('')}</ul>
                <button type="button" class="fx-cta" data-plan="${p.id}">Get ${escape(p.name)}</button>
              </div>`;
            }).join('')}
          </div>
          ${billingCfg.checkout ? '' : '<p class="fx-modal-note">Checkout is being set up — please check back soon.</p>'}
          <p class="fx-modal-fine">Educational tool, not financial advice. See <a href="terms.html">Terms</a>, <a href="risk.html">Risk disclosure</a> and <a href="refund.html">Refunds</a>.</p>
        </div>`;
      wrap.querySelector('.fx-modal-close')?.addEventListener('click', close);
      wrap.querySelectorAll('[data-int]').forEach(b => b.addEventListener('click', () => {
        interval = /** @type {HTMLElement} */ (b).dataset.int || 'yearly'; render();
      }));
      wrap.querySelectorAll('[data-plan]').forEach(b => b.addEventListener('click', () => {
        FX.upgrade(/** @type {HTMLElement} */ (b).dataset.plan, interval);
      }));
    };
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
    /** @param {KeyboardEvent} e */
    const onKey = e => { if (e.key === 'Escape') close(); };
    wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
    document.addEventListener('keydown', onKey);
    render();
    document.body.appendChild(wrap);
    /** @type {HTMLElement|null} */ (wrap.querySelector('.fx-cta'))?.focus();
  };

  /** @param {string} s */
  function escape(s) {
    return String(s).replace(/[&<>"']/g, c => /** @type {Record<string,string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  /** @param {string} msg @param {'ok'|'warn'} [kind] */
  function toast(msg, kind = 'ok') {
    const t = document.createElement('div');
    t.className = `fx-toast fx-toast-${kind}`;
    t.setAttribute('role', 'status');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 6000);
  }
  FX.toast = toast;

  // ── Checkout ─────────────────────────────────────────────────────
  FX.upgrade = async function (plan = 'pro', int = 'yearly') {
    FX.track('checkout_clicked', { plan, interval: int });
    if (!currentUser()) {
      // Remember the intent, sign in, then resume (see fx:auth below).
      try { sessionStorage.setItem('fx_pending_upgrade', JSON.stringify({ plan, int })); } catch (_) { /* ignore */ }
      const signIn = /** @type {any} */ (window).signInWithGoogle;
      if (typeof signIn === 'function') signIn();
      else toast('Please sign in first.', 'warn');
      return;
    }
    if (!billingCfg.checkout) { toast('Checkout is not live yet — check back soon.', 'warn'); return; }
    const btns = document.querySelectorAll('.fx-cta');
    btns.forEach(b => b.setAttribute('disabled', ''));
    try {
      const { url } = await api('/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ plan, interval: int, ref: FX.referral ? FX.referral() : '' }),
      });
      location.href = url;
    } catch (e) {
      toast('Could not start checkout. Please try again in a minute.', 'warn');
      btns.forEach(b => b.removeAttribute('disabled'));
    }
  };

  FX.openPortal = async function () {
    try {
      const { url } = await api('/billing/portal', { method: 'POST' });
      window.open(url, '_blank', 'noopener');
    } catch (_) {
      toast('Billing portal unavailable right now. Try again shortly.', 'warn');
    }
  };

  // After Lemon Squeezy redirects back, the webhook may land a few seconds
  // later — poll /billing/me briefly until the plan flips.
  async function handleCheckoutReturn() {
    const qs = new URLSearchParams(location.search);
    if (qs.get('checkout') !== 'success') return;
    history.replaceState(null, '', location.pathname + location.hash);
    toast('Payment received — activating your plan…');
    FX.track('checkout_completed');
    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 2500));
      const p = await refreshPlan();
      if (p.plan !== 'free') { toast(`Welcome to FutureX ${p.plan === 'trader' ? 'Trader' : 'Pro'}! All features unlocked.`); return; }
    }
    toast('Your plan will activate within a minute. Refresh if it doesn\'t.', 'warn');
  }

  // pricing.html links here as app.html#upgrade=pro-yearly. Firebase restores
  // the session asynchronously, so park the intent and act on fx:auth: a
  // signed-in user goes straight to checkout; a signed-out user gets the plan
  // picker (their click is the user gesture the Google sign-in popup needs).
  function handleUpgradeHash() {
    const m = /#upgrade=(pro|trader)-(monthly|yearly)/.exec(location.hash);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    interval = m[2];
    hashIntent = { plan: m[1], int: m[2] };
    // If auth never reports (backend asleep), still show the picker.
    setTimeout(() => {
      if (!hashIntent) return;
      const intent = hashIntent; hashIntent = null;
      FX.showPaywall(undefined, /** @type {'pro'|'trader'} */ (intent.plan));
    }, 5000);
  }
  /** @type {{plan: string, int: string}|null} */
  let hashIntent = null;

  // ── Feature gates (UI only; the backend enforces the real ones) ──
  function installGates() {
    const sw = /** @type {any} */ (window).switchTab;
    if (typeof sw === 'function' && !sw.__fxGated) {
      /** @this {any} @param {string} tab */
      const gated = function (tab) {
        const need = GATED_TABS[tab];
        if (need && !FX.hasPlan(need)) {
          FX.showPaywall(tab === 'hub' ? 'The Intelligence Hub' : 'The Portfolio Dashboard', need);
          return;
        }
        return sw.apply(this, arguments);
      };
      gated.__fxGated = true;
      /** @type {any} */ (window).switchTab = gated;
    }
    // Timeframe buttons: only 7-day is free. Capture phase runs before
    // app.js's own click handler, so a blocked click never reaches it.
    document.addEventListener('click', e => {
      const btn = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest?.('.hz-btn'));
      if (!btn || FREE_HORIZONS.has(btn.dataset.hz || '') || FX.hasPlan('pro')) return;
      e.preventDefault(); e.stopImmediatePropagation();
      FX.showPaywall(`The ${btn.textContent?.trim()} timeframe`, 'pro');
    }, true);
    // Lock icons so free users can see what's paid before clicking.
    const mark = () => {
      const lock = billingCfg.paywall && !FX.hasPlan('pro');
      document.querySelectorAll('.hz-btn').forEach(b => {
        const el = /** @type {HTMLElement} */ (b);
        el.classList.toggle('fx-locked', lock && !FREE_HORIZONS.has(el.dataset.hz || ''));
      });
      ['tabDash', 'tabHub'].forEach(id => document.getElementById(id)?.classList.toggle('fx-locked', lock));
      document.querySelectorAll('.bn-item[data-tab="dash"], .bn-item[data-tab="hub"]').forEach(b => b.classList.toggle('fx-locked', lock));
    };
    // Alert-coin limit note (the worker enforces it server-side).
    const alertNote = () => {
      const card = document.querySelector('.alert-card');
      if (!card) return;
      card.querySelector('.fx-alert-limit')?.remove();
      const limits = billingCfg.alert_coin_limit;
      if (!billingCfg.paywall || !limits) return;
      const n = limits[FX.plan.plan] ?? 1;
      if (n >= 15) return;
      const p = document.createElement('p');
      p.className = 'fx-alert-limit';
      p.style.cssText = 'font-size:13px;color:var(--text-lo);margin:10px 0 0';
      p.innerHTML = `Your plan monitors your first <b>${n}</b> watched coin${n > 1 ? 's' : ''}. <a href="#" class="fx-alert-up">Upgrade for more</a>`;
      p.querySelector('a')?.addEventListener('click', e => { e.preventDefault(); FX.showPaywall('More alert coins', 'pro'); });
      card.appendChild(p);
    };
    document.addEventListener('fx:plan', () => { mark(); alertNote(); });
    mark();
    alertNote();
  }

  // Backend said "upgrade required" (app.js dispatches this from backendFetch).
  let lastPaywallAt = 0;
  document.addEventListener('fx:paywall', e => {
    const d = /** @type {CustomEvent} */ (e).detail || {};
    if (Date.now() - lastPaywallAt < 20_000) return;
    lastPaywallAt = Date.now();
    if (d.status === 401) toast('Sign in to use this feature.', 'warn');
    else FX.showPaywall(undefined, d.plan === 'trader' ? 'trader' : 'pro');
  });

  // ── Profile doc for lifecycle emails (Firestore, owner-writable) ─
  /** @param {any} user */
  async function touchProfile(user) {
    try {
      if (typeof _db === 'undefined' || !_db) return;
      const ref = _db.collection('users').doc(user.uid).collection('data').doc('profile');
      const snap = await ref.get();
      /** @type {Record<string, unknown>} */
      const upd = { email: user.email || null, displayName: user.displayName || null, lastSeenAt: new Date().toISOString() };
      if (!snap.exists) {
        upd.createdAt = new Date().toISOString();
        upd.marketingConsent = false; // opt-in only (onboarding checkbox)
        const ref0 = FX.referral ? FX.referral() : '';
        if (ref0) upd.ref = ref0;
        FX.track('signed_up');
      }
      await ref.set(upd, { merge: true });
    } catch (e) { /* rules not deployed yet, offline, etc. — non-fatal */ }
  }

  document.addEventListener('fx:auth', async e => {
    const user = /** @type {CustomEvent} */ (e).detail?.user;
    await refreshPlan();
    if (hashIntent) {
      const intent = hashIntent; hashIntent = null;
      if (user && FX.plan.plan === 'free') FX.upgrade(intent.plan, intent.int);
      else if (!user) FX.showPaywall(undefined, /** @type {'pro'|'trader'} */ (intent.plan));
    }
    if (!user) return;
    touchProfile(user);
    if (window.posthog && window.posthog.identify) window.posthog.identify(user.uid);
    try {
      const raw = sessionStorage.getItem('fx_pending_upgrade');
      if (raw) {
        sessionStorage.removeItem('fx_pending_upgrade');
        const { plan, int } = JSON.parse(raw);
        FX.upgrade(plan, int);
      }
    } catch (_) { /* ignore */ }
  });

  async function boot() {
    await loadConfig();
    installGates();
    renderAccount();
    handleCheckoutReturn();
    handleUpgradeHash();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
