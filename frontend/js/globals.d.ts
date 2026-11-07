// Ambient declarations for the type-checked browser modules in frontend/js/.
// These describe globals provided by app.js, CDN scripts or js/config.js.

/** CommonJS shim so core.js can export for Node tests. */
declare var module: { exports: any } | undefined;

interface FxConfig {
  /** FastAPI backend (Render). */
  backendUrl: string;
  /** Public site origin, e.g. https://futurex.app — used for canonical links. */
  siteUrl: string;
  /** Sentry DSN for browser error tracking ('' = disabled). */
  sentryDsn: string;
  /** PostHog project API key ('' = analytics disabled). */
  posthogKey: string;
  posthogHost: string;
  /** Telegram bot username without @ ('' = Telegram alerts hidden). */
  telegramBot: string;
  /** Lemon Squeezy store slug, for the affiliate tracking script ('' = off). */
  lemonStore: string;
  /** Release tag reported to Sentry. */
  release: string;
}

interface FxPlanInfo {
  plan: 'free' | 'pro' | 'trader';
  status: string;
  paywall: boolean;
  renewsAt?: string | null;
  endsAt?: string | null;
  trialEndsAt?: string | null;
}

interface Window {
  FX_CONFIG: FxConfig;
  FX: {
    [key: string]: any;
    plan: FxPlanInfo;
    hasPlan(p: 'pro' | 'trader'): boolean;
    track(event: string, props?: Record<string, unknown>): void;
    upgrade(plan?: string, interval?: string): void;
    openPortal(): void;
    showPaywall(feature?: string): void;
    getIdToken(): Promise<string | null>;
  };
  Sentry?: any;
  posthog?: any;
  firebase?: any;
  lemonSqueezyAffiliateConfig?: { store: string };
}

// Legacy top-level `let` bindings from app.js, visible to later classic scripts.
declare let _auth: any;
declare let _db: any;
declare let state: any;
