// End-to-end smoke test: loads every page of the static site in headless
// Chromium with ALL third-party traffic stubbed (deterministic, offline),
// and fails on any uncaught JS error, missing local file or broken layout.
//
//   npm run smoke            (needs Playwright + Chromium installed)
//
// Stubs: CoinGecko returns a synthetic 30-day hourly series; the backend is
// "asleep" (connection refused) so the graceful-degradation paths run.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend');
const CHART_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.js');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  // GitHub Pages project sites live under /<repo>/ — 404.html uses that base.
  const pathname = u.pathname.replace(/^\/my-crypto-future-trading-calculator\//, '/');
  let p = path.join(ROOT, decodeURIComponent(pathname));
  if (p.endsWith('/')) p += 'index.html';
  if (!p.startsWith(ROOT) || !fs.existsSync(p)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;

function series(days, stepMs, start = 60000) {
  const now = Date.now(), n = Math.floor(days * 864e5 / stepMs);
  const prices = [], vols = [];
  for (let i = 0; i <= n; i++) {
    const t = now - (n - i) * stepMs;
    const p = start * (1 + 0.0004 * i + 0.01 * Math.sin(i / 9));
    prices.push([t, p]); vols.push([t, 1e9]);
  }
  return { prices, total_volumes: vols, market_caps: vols };
}

const failures = [];
const browser = await chromium.launch();

async function check(pagePath, { mobile = false, actions, init } = {}) {
  const ctx = await browser.newContext(mobile
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
    : { viewport: { width: 1280, height: 900 } });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(`console: ${m.text()}`); });
  // data/accuracy.json only exists after the first weekly backtest; pages must cope without it.
  page.on('response', r => { if (r.url().startsWith(BASE) && r.status() === 404 && !r.url().includes('/data/accuracy.json')) errors.push(`404: ${r.url().slice(BASE.length)}`); });

  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(BASE)) return route.continue();
    if (url.includes('chart.js') || url.includes('chart.umd')) return route.fulfill({ path: CHART_JS, contentType: 'text/javascript' });
    if (/gstatic\.com\/firebasejs|emailjs|posthog|sentry|lmsqueezy/.test(url)) return route.fulfill({ body: '', contentType: 'text/javascript' });
    if (/fonts\.googleapis|fonts\.gstatic/.test(url)) return route.fulfill({ body: '', contentType: 'text/css' });
    if (url.includes('api.coingecko.com')) {
      if (url.includes('/market_chart')) {
        const days = Number(new URL(url).searchParams.get('days') || 30);
        const step = days <= 1 ? 5 * 60e3 : days <= 90 ? 3600e3 : 864e5;
        return route.fulfill({ json: series(days, step) });
      }
      if (url.includes('/simple/price')) {
        const ids = new URL(url).searchParams.get('ids').split(',');
        return route.fulfill({ json: Object.fromEntries(ids.map(id => [id, { usd: 100, usd_24h_change: 1.2, usd_24h_vol: 1e9, usd_market_cap: 1e11 }])) });
      }
      return route.fulfill({ json: [] });
    }
    if (url.includes('alternative.me')) return route.fulfill({ json: { data: [{ value: '55', value_classification: 'Greed' }] } });
    return route.abort('connectionrefused'); // backend asleep, OKX, news, etc.
  });

  await page.goto(BASE + pagePath, { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  if (actions) await actions(page, errors);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 2) errors.push(`horizontal overflow ${overflow}px`);
  await ctx.close();
  if (errors.length) failures.push(`${pagePath}${mobile ? ' (mobile)' : ''}\n  ` + errors.join('\n  '));
  else console.log(`ok  ${pagePath}${mobile ? ' (mobile)' : ''}`);
}

const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html')).map(f => '/' + f);
for (const sub of ['learn']) {
  const dir = path.join(ROOT, sub);
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (f.endsWith('.html')) pages.push(`/${sub}/${f}`);
}

for (const p of pages) {
  if (p === '/app.html') continue;
  await check(p);
  await check(p, { mobile: true });
}

// The app itself: chart renders, 7-day forecast spans ~7 days, paywall off.
const appChecks = async (page, errors) => {
  // Backend is "asleep": the app retries it once, then falls back to CoinGecko.
  await page.waitForFunction(() => typeof state !== 'undefined' && state.chart, null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const info = await page.evaluate(() => {
    // `state` is a top-level const in app.js (global lexical scope).
    const c = typeof state !== 'undefined' ? state.chart : null;
    return c ? { labels: c.data.labels.length, fc: c.data.datasets.find(d => d.label === 'Forecast (Trend)')?.data.filter(v => v != null).length } : null;
  });
  if (!info) errors.push('price chart did not render');
  else if (info.fc !== 7) errors.push(`7-day forecast should have 7 points, got ${info.fc}`);
  // The OKX socket can't connect offline; the pill must still show "delayed".
  const pill = await page.waitForSelector('#fxLivePill', { timeout: 15000 }).catch(() => null);
  if (!pill) errors.push('live price pill missing');
  // Switching to the hub must work while the paywall is off (backend asleep).
  await page.evaluate(() => /** @type {any} */ (window).switchTab('hub'));
  await page.waitForTimeout(300);
  const hubVisible = await page.evaluate(() => document.getElementById('hubView')?.style.display !== 'none');
  if (!hubVisible) errors.push('hub tab did not open with paywall off');
  if (await page.$('#fxPaywall')) errors.push('paywall shown while paywall is disabled');
};
const returning = () => { localStorage.setItem('fx_onboarded', '1'); localStorage.setItem('disclaimerSeen', '1'); };
await check('/app.html', { actions: appChecks, init: returning });
await check('/app.html', { mobile: true, init: returning });
// First visit: onboarding appears after the disclaimer is dismissed.
await check('/app.html', {
  actions: async (page, errors) => {
    await page.evaluate(() => /** @type {any} */ (window).dismissDisclaimer?.());
    await page.waitForTimeout(1500);
    if (!(await page.$('.fx-onb'))) errors.push('onboarding did not appear on first visit');
    await page.click('.fx-onb .fx-cta'); await page.click('.fx-onb .fx-cta'); await page.click('.fx-onb .fx-cta');
    if (await page.$('.fx-onb')) errors.push('onboarding did not close after 3 steps');
  },
});

await browser.close();
server.close();
if (failures.length) {
  console.error('\nSMOKE FAILURES:\n' + failures.join('\n'));
  process.exit(1);
}
console.log(`\nAll ${pages.length} pages passed.`);
