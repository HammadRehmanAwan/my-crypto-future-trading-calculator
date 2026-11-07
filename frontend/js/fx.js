// @ts-check
// ═══════════════════════════════════════════════════════════════════
// FutureX shared runtime: error tracking (Sentry), product analytics
// (PostHog) and affiliate/referral capture. Loaded on every page, after
// js/config.js. Each integration is OFF until its key is set in config.js.
//
// Privacy defaults:
//   • Analytics never runs when the browser sends Do-Not-Track / Global
//     Privacy Control, or after the visitor opts out (FX.optOut()).
//   • PostHog runs cookieless (in-memory persistence), no session replay,
//     no autocaptured form values.
//   • Sentry sends no PII (no IPs, no user emails).
// ═══════════════════════════════════════════════════════════════════
(function () {
  const cfg = window.FX_CONFIG || /** @type {FxConfig} */ ({});

  /** @param {string} src @param {() => void} [onload] */
  function loadScript(src, onload) {
    const s = document.createElement('script');
    s.src = src; s.async = true; s.crossOrigin = 'anonymous';
    if (onload) s.onload = onload;
    document.head.appendChild(s);
  }

  /** @param {string} k */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  /** @param {string} k @param {string} v */
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } }

  const nav = /** @type {any} */ (navigator);
  const privacySignal = nav.doNotTrack === '1' || nav.globalPrivacyControl === true;
  const optedOut = lsGet('fx_analytics_optout') === '1';

  // ── Sentry (browser errors) ──────────────────────────────────────
  // The DSN's public key maps to Sentry's loader script, so no SDK version
  // has to be pinned here; the loader serves the version set in Sentry.
  if (cfg.sentryDsn) {
    const m = /^https:\/\/([0-9a-f]+)@/.exec(cfg.sentryDsn);
    if (m) {
      loadScript(`https://js.sentry-cdn.com/${m[1]}.min.js`, () => {
        const S = window.Sentry;
        if (!S || !S.onLoad) return;
        S.onLoad(() => S.init({
          dsn: cfg.sentryDsn,
          release: cfg.release,
          sendDefaultPii: false,
          tracesSampleRate: 0,
          // Third-party data APIs fail routinely (rate limits, ad-blockers);
          // the app already degrades gracefully, so don't page on those.
          ignoreErrors: ['Failed to fetch', 'NetworkError', 'Load failed', 'HTTP 429'],
        }));
      });
    }
  }

  // ── PostHog (product analytics) ──────────────────────────────────
  /** @type {Array<[string, Record<string, unknown>|undefined]>} */
  const queue = [];
  let phReady = false;
  if (cfg.posthogKey && !privacySignal && !optedOut) {
    const host = (cfg.posthogHost || 'https://us.i.posthog.com').replace(/\/$/, '');
    const assets = host.replace('://us.i.', '://us-assets.i.').replace('://eu.i.', '://eu-assets.i.');
    loadScript(`${assets}/static/array.js`, () => {
      const ph = window.posthog;
      if (!ph || !ph.init) return;
      ph.init(cfg.posthogKey, {
        api_host: host,
        persistence: 'memory',      // cookieless
        autocapture: { dom_event_allowlist: ['click'], element_allowlist: ['a', 'button'] },
        disable_session_recording: true,
        capture_pageview: true,
        mask_all_text: false,
        mask_all_element_attributes: true,
      });
      phReady = true;
      for (const [e, p] of queue.splice(0)) ph.capture(e, p);
    });
  }

  // ── Referral / affiliate capture ─────────────────────────────────
  // ?ref=CODE or ?aff=CODE is remembered for 30 days and attached to the
  // checkout (custom_data.ref) so every sale can be attributed.
  try {
    const qs = new URLSearchParams(location.search);
    const ref = (qs.get('ref') || qs.get('aff') || '').replace(/[^\w-]/g, '').slice(0, 64);
    if (ref) lsSet('fx_ref', JSON.stringify({ ref, ts: Date.now() }));
  } catch (_) { /* ignore */ }

  if (cfg.lemonStore) {
    window.lemonSqueezyAffiliateConfig = { store: cfg.lemonStore };
    loadScript('https://lmsqueezy.com/affiliate.js');
  }

  // ── Public API ───────────────────────────────────────────────────
  const FX = /** @type {any} */ (window.FX || {});
  /** @param {string} event @param {Record<string, unknown>} [props] */
  FX.track = function (event, props) {
    if (!cfg.posthogKey || privacySignal || lsGet('fx_analytics_optout') === '1') return;
    if (phReady && window.posthog) window.posthog.capture(event, props);
    else if (queue.length < 50) queue.push([event, props]);
  };
  FX.referral = function () {
    try {
      const raw = lsGet('fx_ref');
      if (!raw) return '';
      const { ref, ts } = JSON.parse(raw);
      return Date.now() - ts < 30 * 864e5 ? String(ref) : '';
    } catch (_) { return ''; }
  };
  FX.optOut = function () {
    lsSet('fx_analytics_optout', '1');
    if (window.posthog && window.posthog.opt_out_capturing) window.posthog.opt_out_capturing();
  };
  FX.loadScript = loadScript;
  window.FX = FX;
})();
