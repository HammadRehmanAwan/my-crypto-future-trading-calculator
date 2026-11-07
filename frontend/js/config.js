// @ts-check
// ═══════════════════════════════════════════════════════════════════
// FutureX public site configuration — the ONE file to edit per deployment.
//
// Everything here is public by design (it ships to every browser). Secrets
// never go here: API keys for Lemon Squeezy, Resend, Telegram, Firebase
// Admin, etc. live only in backend / GitHub Actions secrets. See SETUP.md.
// ═══════════════════════════════════════════════════════════════════
window.FX_CONFIG = {
  // FastAPI backend (backend.py on Render). Change if you move hosts.
  backendUrl: 'https://my-crypto-future-trading-calculator.onrender.com',

  // Public origin of this site. Update when you connect a custom domain
  // (also update canonical/og URLs, sitemap.xml and robots.txt — SETUP.md §4).
  siteUrl: 'https://hammadrehmanawan.github.io/my-crypto-future-trading-calculator',

  // Sentry → Project → Client Keys (DSN). '' disables error tracking.
  sentryDsn: '',

  // PostHog → Project settings → Project API key. '' disables analytics.
  posthogKey: '',
  posthogHost: 'https://us.i.posthog.com',

  // Telegram bot username without the @ (create with @BotFather). '' hides
  // the "Connect Telegram" button.
  telegramBot: '',

  // Lemon Squeezy store slug (the "xxx" in xxx.lemonsqueezy.com) — enables
  // affiliate tracking. '' disables it.
  lemonStore: '',

  release: 'futurex@2026.11',
};
