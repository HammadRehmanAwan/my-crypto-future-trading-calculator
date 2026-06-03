'use strict';

// ═══════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════

// EmailJS credentials — safe to expose here because allowed origins are
// restricted to hammadrehmanawan.github.io in the EmailJS dashboard.
const EJS_PUBLIC_KEY  = 'umm68O9D3twguzpjd';
const EJS_SERVICE_ID  = 'service_cf3llwp';
const EJS_TEMPLATE_ID = 'template_2544kb6';

const COINS = {
  'bitcoin':      { name: 'Bitcoin (BTC)',    sym: 'BTC'  },
  'ethereum':     { name: 'Ethereum (ETH)',   sym: 'ETH'  },
  'binancecoin':  { name: 'BNB (BNB)',        sym: 'BNB'  },
  'solana':       { name: 'Solana (SOL)',      sym: 'SOL'  },
  'ripple':       { name: 'XRP (XRP)',         sym: 'XRP'  },
  'cardano':      { name: 'Cardano (ADA)',     sym: 'ADA'  },
  'avalanche-2':  { name: 'Avalanche (AVAX)',  sym: 'AVAX' },
  'dogecoin':     { name: 'Dogecoin (DOGE)',   sym: 'DOGE' },
  'polkadot':     { name: 'Polkadot (DOT)',    sym: 'DOT'  },
  'matic-network':{ name: 'Polygon (MATIC)',   sym: 'MATIC'},
  'chainlink':    { name: 'Chainlink (LINK)',  sym: 'LINK' },
  'uniswap':      { name: 'Uniswap (UNI)',     sym: 'UNI'  },
  'litecoin':     { name: 'Litecoin (LTC)',    sym: 'LTC'  },
  'cosmos':       { name: 'Cosmos (ATOM)',     sym: 'ATOM' },
  'filecoin':     { name: 'Filecoin (FIL)',    sym: 'FIL'  },
};

const TICKER_IDS = ['bitcoin','ethereum','binancecoin','solana','ripple','cardano','avalanche-2'];
const BASE = 'https://api.coingecko.com/api/v3';

// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════

const state = {
  coin: 'bitcoin', days: 30, direction: 'Long',
  prices: null, dates: null, chart: null, cache: {},
};

let _currentPlans = [];

// ═══════════════════════════════════════════════════════════════════
// API  (60 s in-memory cache)
// ═══════════════════════════════════════════════════════════════════

async function apiFetch(url, key, ttl = 60_000) {
  const hit = state.cache[key];
  if (hit && Date.now() - hit.ts < ttl) return hit.data;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  state.cache[key] = { data, ts: Date.now() };
  return data;
}

async function fetchHistory(coinId, days) {
  const url = `${BASE}/coins/${coinId}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
  const raw = await apiFetch(url, `h-${coinId}-${days}`);
  return {
    dates:   raw.prices.map(p => new Date(p[0])),
    prices:  raw.prices.map(p => p[1]),
    volumes: raw.total_volumes.map(v => v[1]),
  };
}

async function fetchTicker(ids) {
  const url = `${BASE}/simple/price?ids=${ids.join(',')}&vs_currencies=usd&include_24hr_change=true`;
  return apiFetch(url, `tick-${ids.join(',')}`, 30_000);
}

// ═══════════════════════════════════════════════════════════════════
// TECHNICAL INDICATORS
// ═══════════════════════════════════════════════════════════════════

function calcRSI(prices, period = 14) {
  const rsi = new Array(prices.length).fill(50);
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = prices[i] - prices[i - 1];
    ag += Math.max(0, d); al += Math.max(0, -d);
  }
  ag /= period; al /= period;
  rsi[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    ag = (ag * (period - 1) + Math.max(0, d)) / period;
    al = (al * (period - 1) + Math.max(0, -d)) / period;
    rsi[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return rsi;
}

function ema(prices, period) {
  const k = 2 / (period + 1);
  const out = [prices[0]];
  for (let i = 1; i < prices.length; i++)
    out.push(prices[i] * k + out[i - 1] * (1 - k));
  return out;
}

function calcMACD(prices, fast = 12, slow = 26, sig = 9) {
  const ef = ema(prices, fast);
  const es = ema(prices, slow);
  const macdLine   = ef.map((v, i) => v - es[i]);
  const sigArr     = ema(macdLine.slice(slow - 1), sig);
  const signalLine = [...new Array(slow - 1).fill(null), ...sigArr];
  const hist       = macdLine.map((v, i) => signalLine[i] != null ? v - signalLine[i] : null);
  return { macdLine, signalLine, hist };
}

function calcBollinger(prices, period = 20, mult = 2) {
  const upper = [], mid = [], lower = [];
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) { upper.push(null); mid.push(null); lower.push(null); continue; }
    const sl = prices.slice(i - period + 1, i + 1);
    const m  = sl.reduce((a, b) => a + b) / period;
    const sd = Math.sqrt(sl.reduce((a, b) => a + (b - m) ** 2, 0) / period);
    upper.push(m + mult * sd); mid.push(m); lower.push(m - mult * sd);
  }
  return { upper, mid, lower };
}

// ═══════════════════════════════════════════════════════════════════
// STATISTICAL FORECAST  (Holt double-exponential smoothing)
// ═══════════════════════════════════════════════════════════════════

function holtForecast(prices, horizon = 7, alpha = 0.35, beta = 0.08) {
  let level = prices[0], trend = prices[1] - prices[0];
  for (let i = 1; i < prices.length; i++) {
    const prevL = level;
    level = alpha * prices[i] + (1 - alpha) * (level + trend);
    trend = beta * (level - prevL) + (1 - beta) * trend;
  }
  const recent = prices.slice(-20);
  let s = recent[0];
  const res = [];
  for (let i = 1; i < recent.length; i++) {
    res.push(Math.abs(recent[i] - s));
    s = alpha * recent[i] + (1 - alpha) * s;
  }
  const avgRes = res.reduce((a, b) => a + b, 0) / res.length;
  const median = Array.from({ length: horizon }, (_, i) => level + trend * (i + 1));
  const low    = median.map((v, i) => v - avgRes * Math.sqrt(i + 1) * 1.8);
  const high   = median.map((v, i) => v + avgRes * Math.sqrt(i + 1) * 1.8);
  return { median, low, high };
}

// ═══════════════════════════════════════════════════════════════════
// FUTURES CALCULATOR
// ═══════════════════════════════════════════════════════════════════

function calcFutures(entry, leverage, size, dir, tp, sl) {
  const margin = size / leverage;
  const contracts = size / entry;
  const mmr = 0.005;
  let liq, liqDist, pnlFn;
  if (dir === 'Long') {
    liq = entry * (1 - 1 / leverage + mmr);
    liqDist = (entry - liq) / entry * 100;
    pnlFn = px => contracts * (px - entry);
  } else {
    liq = entry * (1 + 1 / leverage - mmr);
    liqDist = (liq - entry) / entry * 100;
    pnlFn = px => contracts * (entry - px);
  }
  const res = { entry, leverage, size, margin, contracts, liq, liqDist, dir };
  if (tp) { const p = pnlFn(tp); res.tp = tp; res.pnlTp = p; res.roeTp = p / margin * 100; }
  if (sl) { const p = pnlFn(sl); res.sl = sl; res.pnlSl = p; res.roeSl = p / margin * 100; }
  if (tp && sl) res.rr = Math.abs(tp - entry) / Math.abs(sl - entry);
  return res;
}

// ═══════════════════════════════════════════════════════════════════
// CHART
// ═══════════════════════════════════════════════════════════════════

function buildChart(dates, prices, bb, forecast, days, horizon) {
  if (state.chart) { state.chart.destroy(); state.chart = null; }
  const n = Math.min(dates.length, days);
  const dDates = dates.slice(-n);
  const dPrices = prices.slice(-n);
  const last = dates[dates.length - 1];
  const fDates = Array.from({ length: horizon }, (_, i) => {
    const d = new Date(last); d.setDate(d.getDate() + i + 1); return d;
  });
  const allDates = [...dDates, ...fDates];
  const labels = allDates.map(d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
  const pad  = arr => [...arr.slice(-n), ...new Array(horizon).fill(null)];
  const fpad = arr => [...new Array(n).fill(null), ...arr];
  const datasets = [
    { label: 'Price', data: pad(dPrices), borderColor: '#00D4FF', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.3, order: 1 },
    { label: 'BB Upper', data: pad(bb.upper), borderColor: 'rgba(100,116,139,0.45)', backgroundColor: 'transparent', borderWidth: 1, borderDash: [4,3], pointRadius: 0, tension: 0.3, order: 3 },
    { label: 'BB Mid', data: pad(bb.mid), borderColor: 'rgba(100,116,139,0.25)', backgroundColor: 'transparent', borderWidth: 1, pointRadius: 0, tension: 0.3, order: 3 },
    { label: 'BB Lower', data: pad(bb.lower), borderColor: 'rgba(100,116,139,0.45)', backgroundColor: 'rgba(100,116,139,0.06)', fill: '-1', borderWidth: 1, borderDash: [4,3], pointRadius: 0, tension: 0.3, order: 3 },
    { label: 'Forecast CI High', data: fpad(forecast.high), borderColor: 'rgba(255,184,0,0.2)', backgroundColor: 'rgba(255,184,0,0.08)', fill: '+1', borderWidth: 1, pointRadius: 0, tension: 0.2, order: 4 },
    { label: 'Forecast CI Low',  data: fpad(forecast.low),  borderColor: 'rgba(255,184,0,0.2)', backgroundColor: 'transparent', borderWidth: 1, pointRadius: 0, tension: 0.2, order: 4 },
    { label: 'Forecast (Trend)', data: fpad(forecast.median), borderColor: '#FFB800', backgroundColor: 'transparent', borderWidth: 2, borderDash: [6,3], pointRadius: 4, pointBackgroundColor: '#FFB800', tension: 0.2, order: 2 },
  ];
  const ctx = document.getElementById('priceChart').getContext('2d');
  state.chart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      animation: { duration: 400 },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0F1828', borderColor: '#1A2540', borderWidth: 1,
          titleColor: '#00D4FF', bodyColor: '#CBD5E1', padding: 10,
          callbacks: {
            label: ctx => ctx.parsed.y == null ? null : ` ${ctx.dataset.label}: $${fmt(ctx.parsed.y)}`,
          },
        },
      },
      scales: {
        x: { grid: { color: 'rgba(26,37,64,0.7)' }, ticks: { color: '#4B6280', maxTicksLimit: 8, maxRotation: 0, font: { size: 11 } } },
        y: { position: 'right', grid: { color: 'rgba(26,37,64,0.7)' }, ticks: { color: '#4B6280', font: { size: 11 }, callback: v => v >= 1000 ? `$${(v/1000).toFixed(1)}k` : `$${v.toFixed(2)}` } },
      },
    },
  });
}

// ═══════════════════════════════════════════════════════════════════
// FORMATTERS
// ═══════════════════════════════════════════════════════════════════

function fmt(v, d = 2) {
  if (v == null) return '—';
  return Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtUSD(v, d = 2) { return v == null ? '—' : `$${fmt(v, d)}`; }
function fmtPct(v) { return v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`; }
function badge(text, type) { return `<span class="badge badge-${type}">${text}</span>`; }

// ═══════════════════════════════════════════════════════════════════
// VOLATILITY ALERT SYSTEM
// ═══════════════════════════════════════════════════════════════════

const SENSITIVITY_CFG = {
  conservative: { rsiLo: 20, rsiHi: 80, changeAbs: 10, bbWidth: 20, hint: 'RSI < 20 or > 80 · price ±10% in 24h · BB width > 20%' },
  moderate:     { rsiLo: 30, rsiHi: 70, changeAbs: 5,  bbWidth: 12, hint: 'RSI < 30 or > 70 · price ±5% in 24h · BB width > 12%' },
  sensitive:    { rsiLo: 35, rsiHi: 65, changeAbs: 3,  bbWidth: 8,  hint: 'RSI < 35 or > 65 · price ±3% in 24h · BB width > 8%' },
};

function getAlertSettings() {
  try { return JSON.parse(localStorage.getItem('cryptoAlertSettings') || '{}'); }
  catch { return {}; }
}
function persistAlertSettings(s) { localStorage.setItem('cryptoAlertSettings', JSON.stringify(s)); }

function isOnCooldown(coinId) {
  const last = parseInt(localStorage.getItem(`alertCD_${coinId}`) || '0');
  return Date.now() - last < 2 * 60 * 60 * 1000; // 2-hour cooldown per coin
}
function setCooldown(coinId) {
  localStorage.setItem(`alertCD_${coinId}`, String(Date.now()));
}

function checkVolatilityConditions(coinId, coinName, currPrice, rsi, change24h, bbWidth) {
  const s = getAlertSettings();
  if (!s.enabled || !s.email) return;
  const watched = s.watchCoins || [];
  if (!watched.includes(coinId)) return;
  if (isOnCooldown(coinId)) return;

  const cfg = SENSITIVITY_CFG[s.sensitivity || 'moderate'];
  const reasons = [];
  if (rsi != null) {
    if (rsi < cfg.rsiLo) reasons.push(`RSI is ${rsi.toFixed(1)} — price fell very fast, a bounce upward is likely`);
    else if (rsi > cfg.rsiHi) reasons.push(`RSI is ${rsi.toFixed(1)} — price rose very fast, a pullback may be coming`);
  }
  if (change24h != null && Math.abs(change24h) >= cfg.changeAbs)
    reasons.push(`Price moved ${change24h >= 0 ? '+' : ''}${change24h.toFixed(2)}% in the last 24 hours — high volatility`);
  if (bbWidth != null && bbWidth >= cfg.bbWidth)
    reasons.push(`Bollinger Band width is ${bbWidth.toFixed(1)}% — the price channel is unusually wide`);

  if (reasons.length === 0) return;
  sendVolatilityEmail(s, coinName, currPrice, reasons, coinId);
}

async function sendVolatilityEmail(s, coinName, price, reasons, coinId) {
  if (typeof emailjs === 'undefined') {
    showAlertStatus('❌ EmailJS library not loaded — check your internet connection.', 'error'); return;
  }
  try {
    await emailjs.send(EJS_SERVICE_ID, EJS_TEMPLATE_ID, {
      to_email:      s.email,
      coin_name:     coinName,
      current_price: '$' + price.toLocaleString('en-US', { maximumFractionDigits: 2 }),
      alert_reasons: reasons.map((r, i) => `${i + 1}. ${r}`).join('\n'),
      alert_time:    new Date().toLocaleString(),
    }, EJS_PUBLIC_KEY);
    if (coinId !== '_test') setCooldown(coinId);
    showAlertStatus(`✅ Alert email sent for ${coinName}!`, 'success');
  } catch (e) {
    showAlertStatus(`❌ Email failed: ${e?.text || e?.message || 'Unknown error — is your email address correct?'}`, 'error');
  }
}

function showAlertStatus(msg, type) {
  const el = document.getElementById('alertStatus');
  if (!el) return;
  el.style.display = 'block';
  el.className = `alert-status ${type}`;
  el.textContent = msg;
  setTimeout(() => { if (el) el.style.display = 'none'; }, 6000);
}

function runDeepVolatilityCheck(coinId, prices, rsiArr, bb) {
  const coin = COINS[coinId];
  if (!coin) return;
  const curr    = prices[prices.length - 1];
  const prev    = prices[Math.max(0, prices.length - 2)];
  const chg24h  = (curr - prev) / prev * 100;
  const rsi     = rsiArr[rsiArr.length - 1];
  const bbU     = bb.upper[bb.upper.length - 1];
  const bbL     = bb.lower[bb.lower.length - 1];
  const bbM     = bb.mid[bb.mid.length - 1];
  const bbWidth = bbM ? (bbU - bbL) / bbM * 100 : null;
  checkVolatilityConditions(coinId, coin.name, curr, rsi, chg24h, bbWidth);
}

let _deepCheckTimer = null;
function startBackgroundAlertChecks() {
  if (_deepCheckTimer) return;
  _deepCheckTimer = setInterval(async () => {
    const s = getAlertSettings();
    if (!s.enabled || !s.watchCoins?.length) return;
    for (const coinId of s.watchCoins) {
      try {
        const { prices } = await fetchHistory(coinId, 30);
        const rsiArr = calcRSI(prices);
        const bb     = calcBollinger(prices);
        runDeepVolatilityCheck(coinId, prices, rsiArr, bb);
      } catch { /* ignore per-coin errors */ }
      await new Promise(r => setTimeout(r, 1200)); // stagger to respect rate limits
    }
  }, 5 * 60 * 1000); // every 5 minutes
}

// ─── Alert UI helpers (called from HTML) ───

function showEmailjsHelp() {
  const el = document.getElementById('emailjsHelp');
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function setAlertSensitivity(val) {
  document.querySelectorAll('.thresh-btn').forEach(b => b.classList.toggle('active', b.dataset.t === val));
  const hint = document.getElementById('threshHint');
  if (hint) hint.textContent = SENSITIVITY_CFG[val]?.hint || '';
}

function saveAlerts() {
  const email = document.getElementById('alertEmail').value.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showAlertStatus('❌ Please enter a valid email address.', 'error'); return;
  }
  const s = {
    enabled:     document.getElementById('alertEnabled').checked,
    email,
    sensitivity: document.querySelector('.thresh-btn.active')?.dataset?.t || 'moderate',
    watchCoins:  [...document.querySelectorAll('.watch-coin-cb:checked')].map(c => c.value),
  };
  persistAlertSettings(s);
  showAlertStatus('✅ Saved! Monitoring ' + s.watchCoins.length + ' coin(s) every 5 minutes.', 'success');
}

async function testAlert() {
  saveAlerts();
  const s = getAlertSettings();
  if (!s.email) { showAlertStatus('❌ Enter your email address first.', 'error'); return; }
  await sendVolatilityEmail(s, 'Bitcoin (BTC) — TEST', 65000, ['This is a test alert. Your email setup is working correctly!'], '_test');
}

function initAlertUI() {
  const s = getAlertSettings();
  const container = document.getElementById('watchCoins');
  if (container) {
    Object.entries(COINS).forEach(([id, c]) => {
      const checked = (s.watchCoins || ['bitcoin']).includes(id);
      const lbl = document.createElement('label');
      lbl.className = 'watch-coin-item';
      lbl.innerHTML = `<input type="checkbox" class="watch-coin-cb" value="${id}" ${checked ? 'checked' : ''}><span>${c.sym}</span>`;
      container.appendChild(lbl);
    });
  }
  if (s.email)    document.getElementById('alertEmail').value    = s.email;
  if (s.enabled)  document.getElementById('alertEnabled').checked = true;
  setAlertSensitivity(s.sensitivity || 'moderate');
}

// ═══════════════════════════════════════════════════════════════════
// DIRECTION TOGGLE
// ═══════════════════════════════════════════════════════════════════

function setDir(dir) {
  state.direction = dir;
  document.getElementById('btnLong').classList.toggle('active',  dir === 'Long');
  document.getElementById('btnShort').classList.toggle('active', dir === 'Short');
}

function updateLeverage(val) {
  const v = parseInt(val);
  document.getElementById('levDisplay').textContent = v + '×';
  let risk, hint;
  if (v <= 3)       { risk = 'Low Risk';       hint = `${v}× leverage — profits and losses are ${v}× your capital. Good for beginners.`; }
  else if (v <= 10) { risk = 'Moderate Risk';  hint = `${v}× leverage — a ${(100/v).toFixed(0)}% price move against you wipes your capital. Use a stop-loss.`; }
  else if (v <= 25) { risk = 'High Risk';       hint = `${v}× leverage — only a ${(100/v).toFixed(1)}% move against you wipes your capital. Experienced traders only.`; }
  else if (v <= 50) { risk = 'Very High Risk';  hint = `${v}× leverage — a tiny ${(100/v).toFixed(1)}% move against you wipes your capital. Extreme caution.`; }
  else              { risk = '⚠️ Extreme Risk'; hint = `${v}× leverage — price only needs to move ${(100/v).toFixed(1)}% against you to lose everything. Not recommended for beginners.`; }
  const badge = document.getElementById('levRiskBadge');
  badge.textContent = risk;
  badge.className = `lev-risk-badge ${v <= 3 ? 'lev-low' : v <= 10 ? 'lev-mod' : v <= 25 ? 'lev-high' : 'lev-extreme'}`;
  document.getElementById('levHint').textContent = hint;
}

// ═══════════════════════════════════════════════════════════════════
// TICKER
// ═══════════════════════════════════════════════════════════════════

async function refreshTicker() {
  try {
    const data = await fetchTicker(TICKER_IDS);
    document.getElementById('ticker').innerHTML = TICKER_IDS.map(id => {
      const c = COINS[id], p = data[id], chg = p.usd_24h_change || 0;
      return `<div class="ticker-item" onclick="selectCoin('${id}')">
        <span class="ticker-sym">${c.sym}</span>
        <span class="ticker-price">$${p.usd.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
        <span class="ticker-chg ${chg >= 0 ? 'green' : 'red'}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</span>
      </div>`;
    }).join('');
  } catch (e) { console.warn('Ticker:', e.message); }
}

// ═══════════════════════════════════════════════════════════════════
// LOAD COIN
// ═══════════════════════════════════════════════════════════════════

async function loadCoin(coinId, days) {
  const loader = document.getElementById('chartLoader');
  loader.classList.add('visible');
  try {
    const { dates, prices } = await fetchHistory(coinId, days);
    state.prices = prices; state.dates = dates;
    const curr   = prices[prices.length - 1];
    const wkAgo  = prices[Math.max(0, prices.length - 8)];
    const chg7d  = (curr - wkAgo) / wkAgo * 100;
    const chgCls = chg7d >= 0 ? 'green' : 'red';
    document.getElementById('livePriceVal').textContent =
      '$' + curr.toLocaleString('en-US', { maximumFractionDigits: 2 });
    const chgEl = document.getElementById('livePriceChg');
    chgEl.textContent = fmtPct(chg7d) + ' 7d';
    chgEl.className   = `lp-chg ${chgCls}`;

    const rsiArr = calcRSI(prices);
    const { macdLine, signalLine } = calcMACD(prices);
    const bb = calcBollinger(prices);
    const rsiNow  = rsiArr[rsiArr.length - 1];
    const macdNow = macdLine[macdLine.length - 1];
    const sigNow  = signalLine[signalLine.length - 1];
    const bbU     = bb.upper[bb.upper.length - 1];
    const bbL     = bb.lower[bb.lower.length - 1];
    const bbM     = bb.mid[bb.mid.length - 1];

    document.getElementById('rsiVal').textContent = rsiNow.toFixed(1);
    const rsiBar = document.getElementById('rsiBar');
    rsiBar.style.width      = `${Math.min(100, rsiNow)}%`;
    rsiBar.style.background = rsiNow > 70 ? '#FF3D3D' : rsiNow < 30 ? '#00E887' : '#00D4FF';
    document.getElementById('rsiSig').innerHTML =
      rsiNow > 70 ? badge('Overbought — price may be due for a dip soon', 'red')
      : rsiNow < 30 ? badge('Oversold — price may be due for a bounce up', 'green')
      : badge('Normal range — no strong signal yet', 'neutral');

    document.getElementById('macdVal').textContent = macdNow.toFixed(4);
    document.getElementById('macdSig').innerHTML =
      macdNow > sigNow ? badge('Buyers are gaining control ↑', 'green')
      : badge('Sellers are gaining control ↓', 'red');

    const bbW = ((bbU - bbL) / bbM * 100).toFixed(1);
    document.getElementById('bbVal').textContent = `Channel width: ${bbW}%`;
    document.getElementById('bbSig').innerHTML =
      curr > bbU ? badge('Above upper band — possibly overpriced', 'red')
      : curr < bbL ? badge('Below lower band — possibly underpriced', 'green')
      : badge(`Normal price range · ${((curr - bbL) / (bbU - bbL) * 100).toFixed(0)}% of channel`, 'neutral');

    document.getElementById('trendVal').textContent = fmtPct(chg7d);
    document.getElementById('trendSig').innerHTML =
      chg7d >= 0 ? badge('Price trended UP this week ↑', 'green')
      : badge('Price trended DOWN this week ↓', 'red');

    const horizon  = parseInt(document.getElementById('horizon').value) || 7;
    const forecast = holtForecast(prices, horizon);
    buildChart(dates, prices, bb, forecast, days, horizon);
    runDeepVolatilityCheck(coinId, prices, rsiArr, bb);
  } catch (err) {
    loader.innerHTML = `<span style="color:#FF3D3D">⚠️ ${
      err.message.includes('429') ? 'Rate-limited — wait 60 s then try again.'
      : `Load failed: ${err.message}`
    }</span>`;
    return;
  }
  loader.classList.remove('visible');
}

// ═══════════════════════════════════════════════════════════════════
// ANALYZE
// ═══════════════════════════════════════════════════════════════════

async function analyze() {
  const btn = document.getElementById('analyzeBtn');
  btn.disabled = true; btn.textContent = '⏳ Analyzing…';
  const coinId = document.getElementById('coinSelect').value;
  if (!state.prices || state.coin !== coinId) { state.coin = coinId; await loadCoin(coinId, state.days); }
  const prices  = state.prices;
  const curr    = prices[prices.length - 1];
  const entry   = parseFloat(document.getElementById('entryPrice').value)  || curr;
  const lev     = parseFloat(document.getElementById('leverage').value)    || 10;
  const size    = parseFloat(document.getElementById('posSize').value)     || 1000;
  const horizon = parseInt(document.getElementById('horizon').value)       || 7;
  const dir     = state.direction;
  const fcst    = holtForecast(prices, horizon);
  const tp      = parseFloat(document.getElementById('takeProfit').value)  || fcst.median[fcst.median.length - 1];
  const sl      = parseFloat(document.getElementById('stopLoss').value)    || 0;
  const m       = calcFutures(entry, lev, size, dir, tp, sl);

  const rsiArr = calcRSI(prices);
  const { macdLine, signalLine } = calcMACD(prices);
  const bb  = calcBollinger(prices);
  const rsi = rsiArr[rsiArr.length - 1];
  const mac = macdLine[macdLine.length - 1];
  const sig = signalLine[signalLine.length - 1];
  const bbU = bb.upper[bb.upper.length - 1];
  const bbL = bb.lower[bb.lower.length - 1];

  let score = 0;
  const signals = [];
  if (rsi < 30)       { signals.push({ t:`RSI ${rsi.toFixed(1)}: Price fell too fast — a bounce back up is likely`, c:'green' }); score += 1; }
  else if (rsi > 70)  { signals.push({ t:`RSI ${rsi.toFixed(1)}: Price rose too fast — a pullback may be coming`, c:'red' }); score -= 1; }
  else                  signals.push({ t:`RSI ${rsi.toFixed(1)}: Price momentum is normal — no strong signal`, c:'neutral' });
  if (mac > sig)      { signals.push({ t:'MACD: Buying pressure is building — upward momentum', c:'green' }); score += 1; }
  else                { signals.push({ t:'MACD: Selling pressure is building — downward momentum', c:'red' }); score -= 1; }
  if (curr < bbL)     { signals.push({ t:'Bollinger: Price hit the bottom of its normal range — bounce often follows', c:'green' }); score += 1; }
  else if (curr > bbU){ signals.push({ t:'Bollinger: Price hit the top of its normal range — reversal risk is high', c:'red' }); score -= 1; }
  else                  signals.push({ t:'Bollinger: Price is comfortably within its normal trading range', c:'neutral' });
  const chgF = (fcst.median[fcst.median.length-1] - curr) / curr * 100;
  if (chgF > 2)       { signals.push({ t:`Forecast: Model predicts price rises +${chgF.toFixed(1)}% over ${horizon} days`, c:'green' }); score += 1; }
  else if (chgF < -2) { signals.push({ t:`Forecast: Model predicts price falls ${chgF.toFixed(1)}% over ${horizon} days`, c:'red' }); score -= 1; }
  else                  signals.push({ t:`Forecast: Price expected to stay roughly flat (${chgF.toFixed(1)}% change)`, c:'neutral' });
  if (m.liqDist < 5)  { signals.push({ t:`⚠️ DANGER: Your forced-close price is only ${m.liqDist.toFixed(1)}% away — very high risk!`, c:'red' }); score -= 1; }
  else if (m.liqDist < 10) signals.push({ t:`Caution: Your forced-close price is ${m.liqDist.toFixed(1)}% away — moderate risk`, c:'yellow' });
  else                      signals.push({ t:`Safe buffer: Your forced-close price is ${m.liqDist.toFixed(1)}% away`, c:'green' });

  renderResults(m, curr, fcst, horizon, chgF);
  renderSignal(score, signals, dir);
  btn.disabled = false; btn.textContent = '🚀 Analyze Trade';
}

// ═══════════════════════════════════════════════════════════════════
// RENDER RESULTS
// ═══════════════════════════════════════════════════════════════════

function row(label, value, cls = '', sub = '', hl = '') {
  return `<div class="result-row ${hl}">
    <div><div class="res-label">${label}</div>${sub ? `<div class="res-sub">${sub}</div>` : ''}</div>
    <div class="res-val ${cls}">${value}</div>
  </div>`;
}

function renderResults(m, curr, fcst, horizon, chgF) {
  const pred    = fcst.median[fcst.median.length - 1];
  const predCls = chgF >= 0 ? 'green' : 'red';
  const predDesc = chgF >= 0
    ? `Model expects price to rise ${fmtPct(chgF)} over the next ${horizon} days`
    : `Model expects price to fall ${Math.abs(chgF).toFixed(2)}% over the next ${horizon} days`;
  document.getElementById('resultsCard').style.display = 'block';
  document.getElementById('resultsBody').innerHTML = `<div class="results-grid">
    ${row('Current Market Price', fmtUSD(curr), 'accent', 'Live price of the coin right now')}
    ${row(`Price Forecast (${horizon} days)`, fmtUSD(pred) + ` <span style="font-size:11px">${fmtPct(chgF)}</span>`, predCls, predDesc)}
    ${row('Your Entry Price', fmtUSD(m.entry), '', 'The price at which you open this trade')}
    ${row('Your Capital at Risk', fmtUSD(m.margin), '', `Real money you put in — your $${fmt(m.size)} trade size ÷ ${m.leverage}× leverage`)}
    ${row('💥 Forced Close Price', fmtUSD(m.liq), m.liqDist < 10 ? 'red' : '', `${m.liqDist.toFixed(2)}% from entry — you lose all your capital if price reaches here`, m.liqDist < 10 ? 'hl-red' : '')}
    ${m.tp != null ? row('🎯 Take Profit Target', fmtUSD(m.tp), 'green', `Your profit at this price: +${fmtUSD(m.pnlTp)} · Return on your capital: ${fmtPct(m.roeTp)}`, 'hl-green') : ''}
    ${m.sl ? row('🛑 Stop Loss', fmtUSD(m.sl), 'red', `Max loss if triggered: ${fmtUSD(m.pnlSl)} · That is ${fmtPct(m.roeSl)} of your capital`, 'hl-red') : ''}
    ${m.rr != null ? row('Risk / Reward Ratio', `1 : ${m.rr.toFixed(2)}`, m.rr >= 2 ? 'green' : m.rr >= 1 ? 'gold' : 'red', m.rr >= 2 ? `✅ Good — for every $1 risked you could gain $${m.rr.toFixed(2)}` : m.rr >= 1 ? 'Fair — aim for 1:2 or better for quality trades' : '❌ Poor — you risk more than your potential gain', m.rr >= 2 ? 'hl-green' : m.rr >= 1 ? 'hl-gold' : 'hl-red') : ''}
  </div>`;
}

// ═══════════════════════════════════════════════════════════════════
// RENDER SIGNAL
// ═══════════════════════════════════════════════════════════════════

function renderSignal(score, signals, dir) {
  let heading, hCls, summary, summaryEmoji;
  if (score >= 3) {
    heading = '🟢 STRONG BULLISH — Good time to go Long';
    hCls = 'green';
    summaryEmoji = '📈';
    summary = 'Most indicators agree: conditions strongly favor the price going UP. This is a good environment for a Long trade, but always use a stop-loss.';
  } else if (score >= 1) {
    heading = '🟡 MILDLY BULLISH — Slight upward lean';
    hCls = 'yellow';
    summaryEmoji = '↗️';
    summary = 'Conditions lean upward, but signals are not strong. If trading Long, use a smaller position size and definitely set a stop-loss.';
  } else if (score <= -3) {
    heading = '🔴 STRONG BEARISH — Good time to go Short';
    hCls = 'red';
    summaryEmoji = '📉';
    summary = 'Most indicators agree: conditions strongly favor the price going DOWN. This is a good environment for a Short trade, but always use a stop-loss.';
  } else if (score <= -1) {
    heading = '🟡 MILDLY BEARISH — Slight downward lean';
    hCls = 'yellow';
    summaryEmoji = '↘️';
    summary = 'Conditions lean downward. Long trades carry higher risk right now. Consider waiting for a better entry or reducing your position size.';
  } else {
    heading = '⚪ NEUTRAL — No clear direction';
    hCls = 'neutral';
    summaryEmoji = '↔️';
    summary = 'No clear direction. The market is undecided. Best practice: wait for stronger signals before entering a trade to improve your odds.';
  }
  const aligned = (score > 0 && dir === 'Long') || (score < 0 && dir === 'Short');
  const alignHtml = score !== 0 ? `<div class="align-msg ${aligned ? 'green' : 'red'}">${
    aligned
      ? `✅ Your chosen direction (${dir}) matches the signals — good alignment.`
      : `⚠️ You chose ${dir} but signals lean the other way. This is a counter-trend trade — higher risk.`
  }</div>` : '';
  document.getElementById('signalCard').style.display = 'block';
  document.getElementById('signalBody').innerHTML = `
    <div class="signal-heading ${hCls}">
      <span>${heading}</span>
      <span class="sig-score">${score > 0 ? '+' : ''}${score} / ±5</span>
    </div>
    <div class="beginner-summary">
      <span class="bs-emoji">${summaryEmoji}</span>
      <div class="bs-text">${summary}</div>
    </div>
    ${alignHtml}
    <div class="sig-section-title">Why? — Full Signal Breakdown</div>
    <div class="sig-list">${
      signals.map(s => `<div class="sig-item ${s.c}"><span class="sig-dot"></span><span>${s.t}</span></div>`).join('')
    }</div>`;
}

// ═══════════════════════════════════════════════════════════════════
// COIN SELECTOR  (from ticker)
// ═══════════════════════════════════════════════════════════════════

function selectCoin(coinId) {
  state.coin = coinId;
  document.getElementById('coinSelect').value = coinId;
  loadCoin(coinId, state.days);
}

// ═══════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════

function init() {
  const sel = document.getElementById('coinSelect');
  Object.entries(COINS).forEach(([id, c]) => {
    const opt = document.createElement('option');
    opt.value = id; opt.textContent = c.name;
    sel.appendChild(opt);
  });
  sel.addEventListener('change', e => { state.coin = e.target.value; loadCoin(e.target.value, state.days); });
  document.querySelectorAll('.tf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.days = parseInt(btn.dataset.days);
      loadCoin(state.coin, state.days);
    });
  });
  loadCoin('bitcoin', 30);
  refreshTicker();
  setInterval(refreshTicker, 60_000);
  initAlertUI();
  startBackgroundAlertChecks();

  // Restore bot state across page refreshes
  const bs = loadBotState();
  if (bs.running) {
    const tog = document.getElementById('botToggle');
    if (tog) tog.checked = true;
    if (bs.capital) document.getElementById('dashCapital').value = bs.capital;
    if (bs.profile) setRiskProfile(bs.profile);
    document.getElementById('botCapitalDisplay').textContent = (bs.capital || 1000).toFixed(0);
    document.getElementById('botRiskDisplay').textContent =
      { conservative: 'Safe', moderate: 'Balanced', aggressive: 'Aggressive' }[bs.profile] || 'Balanced';
    startBotTimers();
  }
  renderBotStatus();
  renderPositions();
  renderHistory();
}

document.addEventListener('DOMContentLoaded', init);

// ═══════════════════════════════════════════════════════════════════
// DASHBOARD — AI PORTFOLIO PLANNER
// ═══════════════════════════════════════════════════════════════════

function switchTab(tab) {
  const isCalc = tab === 'calc';
  document.getElementById('calcView').style.display = isCalc ? '' : 'none';
  document.getElementById('dashView').style.display = isCalc ? 'none' : '';
  document.getElementById('tabCalc').classList.toggle('active', isCalc);
  document.getElementById('tabDash').classList.toggle('active', !isCalc);
}

function setRiskProfile(profile) {
  document.querySelectorAll('.risk-btn').forEach(b => b.classList.toggle('active', b.dataset.r === profile));
  document.querySelectorAll('.re-item').forEach(el => el.classList.remove('active'));
  document.getElementById(`re-${profile}`)?.classList.add('active');
}

async function runDashboard() {
  const capital = parseFloat(document.getElementById('dashCapital').value);
  if (!capital || capital < 10) { alert('Please enter at least $10'); return; }
  const riskProfile = document.querySelector('.risk-btn.active')?.dataset?.r || 'moderate';

  const btn = document.getElementById('dashBtn');
  btn.disabled = true; btn.textContent = '⏳ Analyzing…';
  document.getElementById('dashResults').style.display    = 'none';
  document.getElementById('dashNoSignal').style.display   = 'none';
  document.getElementById('dashError').style.display      = 'none';
  document.getElementById('dashLoader').style.display     = 'flex';

  try {
    const coinIds = Object.keys(COINS).join(',');
    const url = `${BASE}/coins/markets?vs_currency=usd&ids=${coinIds}&sparkline=true&price_change_percentage=24h`;
    const markets = await apiFetch(url, `mkts-spark`, 5 * 60_000);

    const scored = markets.map(coin => {
      const prices = coin.sparkline_in_7d?.price;
      if (!prices || prices.length < 30) return null;
      const curr  = coin.current_price;
      const chg24 = coin.price_change_percentage_24h || 0;

      const rsiArr              = calcRSI(prices);
      const { macdLine, signalLine } = calcMACD(prices);
      const bb                  = calcBollinger(prices);

      const rsi = rsiArr[rsiArr.length - 1];
      const mac = macdLine[macdLine.length - 1];
      const sig = signalLine[signalLine.length - 1];
      const bbU = bb.upper[bb.upper.length - 1];
      const bbL = bb.lower[bb.lower.length - 1];
      const bbM = bb.mid[bb.mid.length - 1];
      const bbW = bbM ? (bbU - bbL) / bbM * 100 : 10;

      let score = 0;
      const why = [];

      if      (rsi < 25) { score += 2; why.push(`RSI very oversold (${rsi.toFixed(0)}) — strong bounce likely`); }
      else if (rsi < 35) { score += 1; why.push(`RSI oversold (${rsi.toFixed(0)}) — price may bounce up`); }
      else if (rsi > 75) { score -= 2; why.push(`RSI very overbought (${rsi.toFixed(0)}) — sharp drop possible`); }
      else if (rsi > 65) { score -= 1; why.push(`RSI overbought (${rsi.toFixed(0)}) — upside is limited`); }

      if (mac > sig) { score += 1; why.push('Buyers are in control (MACD bullish)'); }
      else           { score -= 1; why.push('Sellers are in control (MACD bearish)'); }

      if      (curr < bbL) { score += 1; why.push('Price hit the bottom of its normal range — bounce expected'); }
      else if (curr > bbU) { score -= 1; why.push('Price hit the top of its normal range — pullback expected'); }

      if      (chg24 >  2) { score += 1; why.push(`Up ${chg24.toFixed(1)}% today — strong upward momentum`); }
      else if (chg24 < -2) { score -= 1; why.push(`Down ${Math.abs(chg24).toFixed(1)}% today — selling pressure`); }

      const fcst    = holtForecast(prices, 7);
      const fcstChg = (fcst.median[6] - curr) / curr * 100;
      if      (fcstChg >  3) { score += 1; why.push(`AI model forecasts +${fcstChg.toFixed(1)}% over 7 days`); }
      else if (fcstChg < -3) { score -= 1; why.push(`AI model forecasts ${fcstChg.toFixed(1)}% over 7 days`); }

      return { id: coin.id, sym: coin.symbol.toUpperCase(),
               name: `${coin.name} (${coin.symbol.toUpperCase()})`,
               price: curr, chg24, score, bbW, fcstChg, why: why.slice(0, 3) };
    }).filter(c => c && Math.abs(c.score) >= 2)
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
      .slice(0, 4);

    document.getElementById('dashLoader').style.display = 'none';

    if (scored.length === 0) {
      document.getElementById('dashNoSignal').style.display = 'block';
      btn.disabled = false; btn.textContent = '🔍 Analyze Now'; return;
    }

    const levTable = {
      conservative: { hi: 2,  mid: 3,  lo: 5  },
      moderate:     { hi: 4,  mid: 6,  lo: 10 },
      aggressive:   { hi: 8,  mid: 12, lo: 20 },
    };
    const tpPcts = { conservative: 0.04,  moderate: 0.07, aggressive: 0.12 };
    const slPcts = { conservative: 0.025, moderate: 0.04, aggressive: 0.07 };
    const totalScore = scored.reduce((s, c) => s + Math.abs(c.score), 0);

    const trades = scored.map(coin => {
      const dir  = coin.score > 0 ? 'Long' : 'Short';
      const alloc = Math.max(50, Math.round((Math.abs(coin.score) / totalScore) * capital));
      const lvl   = levTable[riskProfile];
      const lev   = coin.bbW > 15 ? lvl.hi : coin.bbW > 8 ? lvl.mid : lvl.lo;
      const margin     = alloc / lev;
      const contracts  = alloc / coin.price;
      const tp = dir === 'Long' ? coin.price * (1 + tpPcts[riskProfile]) : coin.price * (1 - tpPcts[riskProfile]);
      const sl = dir === 'Long' ? coin.price * (1 - slPcts[riskProfile]) : coin.price * (1 + slPcts[riskProfile]);
      const pnlTp = contracts * (dir === 'Long' ? tp - coin.price : coin.price - tp);
      const pnlSl = contracts * (dir === 'Long' ? sl - coin.price : coin.price - sl);
      return { ...coin, dir, alloc, lev, margin, tp, sl, pnlTp, pnlSl };
    });

    // Normalize allocations to exactly equal capital
    const allocSum = trades.reduce((s, t) => s + t.alloc, 0);
    trades.forEach(t => { t.alloc = Math.round(t.alloc / allocSum * capital); });

    renderDashboard(trades, capital, riskProfile);

  } catch (e) {
    document.getElementById('dashLoader').style.display = 'none';
    const errEl = document.getElementById('dashError');
    errEl.style.display = 'block';
    errEl.textContent = e.message.includes('429')
      ? '⚠️ CoinGecko rate limit hit — please wait 60 seconds and try again.'
      : `⚠️ Failed to load data: ${e.message}`;
  }
  btn.disabled = false; btn.textContent = '🔍 Analyze Now';
}

function renderDashboard(trades, capital, riskProfile) {
  const totalPnlTp  = trades.reduce((s, t) => s + t.pnlTp, 0);
  const totalPnlSl  = trades.reduce((s, t) => s + t.pnlSl, 0);
  const roePct      = totalPnlTp / capital * 100;
  const riskLabels  = { conservative: '🛡️ Safe', moderate: '⚖️ Balanced', aggressive: '🚀 Aggressive' };

  document.getElementById('dashSummary').innerHTML = `
    <div class="dash-sum-grid">
      <div class="dsi"><div class="dsi-label">Your Capital</div><div class="dsi-val accent">${fmtUSD(capital)}</div></div>
      <div class="dsi"><div class="dsi-label">Trades</div><div class="dsi-val">${trades.length} coins</div></div>
      <div class="dsi"><div class="dsi-label">If All Targets Hit</div><div class="dsi-val green">+${fmtUSD(totalPnlTp)} (+${roePct.toFixed(1)}%)</div></div>
      <div class="dsi"><div class="dsi-label">If All Stops Hit</div><div class="dsi-val red">${fmtUSD(totalPnlSl)}</div></div>
      <div class="dsi"><div class="dsi-label">Risk Profile</div><div class="dsi-val">${riskLabels[riskProfile]}</div></div>
    </div>`;

  _currentPlans = trades;
  document.getElementById('dashTradesGrid').innerHTML = trades.map((t, i) => {
    const isLong   = t.dir === 'Long';
    const allocPct = (t.alloc / capital * 100).toFixed(0);
    const stars    = '⭐'.repeat(Math.min(5, Math.abs(t.score)));
    const tpDist   = (Math.abs(t.tp - t.price) / t.price * 100).toFixed(1);
    const slDist   = (Math.abs(t.sl - t.price) / t.price * 100).toFixed(1);
    const pd       = t.price < 1 ? 5 : t.price < 10 ? 3 : 2;

    return `<div class="trade-card ${isLong ? 'tc-long' : 'tc-short'}">

      <div class="tc-head">
        <span class="tc-dir ${isLong ? 'long' : 'short'}">${isLong ? '📈 LONG' : '📉 SHORT'}</span>
        <span class="tc-name">${t.name}</span>
        <span class="tc-stars" title="Signal strength: ${Math.abs(t.score)}/6">${stars}</span>
      </div>

      <div class="tc-alloc-row">
        <span class="tc-alloc-amt">${fmtUSD(t.alloc)}</span>
        <span class="tc-alloc-pct">${allocPct}% of your capital</span>
        <span class="tc-lev-badge">${t.lev}× leverage</span>
      </div>
      <div class="tc-margin-note">Your money at risk: ${fmtUSD(t.margin)} · Position controls: ${fmtUSD(t.alloc)} worth</div>

      <div class="tc-prices-grid">
        <div class="tcp">
          <div class="tcp-label">Enter at</div>
          <div class="tcp-val accent">${fmtUSD(t.price, pd)}</div>
          <div class="tcp-sub">Current price</div>
        </div>
        <div class="tcp">
          <div class="tcp-label">🎯 Take Profit</div>
          <div class="tcp-val green">${fmtUSD(t.tp, pd)}</div>
          <div class="tcp-sub">+${tpDist}% from entry</div>
        </div>
        <div class="tcp">
          <div class="tcp-label">🛑 Stop Loss</div>
          <div class="tcp-val red">${fmtUSD(t.sl, pd)}</div>
          <div class="tcp-sub">-${slDist}% from entry</div>
        </div>
      </div>

      <div class="tc-outcome-row">
        <div class="tc-outcome good">✅ Target hit → <strong>+${fmtUSD(t.pnlTp)} profit</strong></div>
        <div class="tc-outcome bad">❌ Stop hit → <strong>${fmtUSD(t.pnlSl)} loss</strong></div>
      </div>

      <div class="tc-why">
        <div class="tc-why-title">📌 Why this trade:</div>
        ${t.why.map(w => `<div class="tc-why-item">• ${w}</div>`).join('')}
      </div>

      <div class="tc-execute">
        <button class="tc-btn-paper"  onclick="openTrade(${i},'paper')">📄 Paper Trade</button>
        <button class="tc-btn-manual" onclick="openTrade(${i},'manual')">🔗 Open on Exchange</button>
      </div>

    </div>`;
  }).join('');

  document.getElementById('dashResults').style.display = 'block';
}

// ═══════════════════════════════════════════════════════════════════
// BOT — STORAGE
// ═══════════════════════════════════════════════════════════════════

const BOT_KEY  = 'cfBot_v1';
const POS_KEY  = 'cfPos_v1';
const HIST_KEY = 'cfHist_v1';

function loadBotState()  { try { return JSON.parse(localStorage.getItem(BOT_KEY)  || '{}'); } catch { return {}; } }
function saveBotState(s) { localStorage.setItem(BOT_KEY,  JSON.stringify(s)); }
function loadPositions() { try { return JSON.parse(localStorage.getItem(POS_KEY)  || '[]'); } catch { return []; } }
function savePositions(p){ localStorage.setItem(POS_KEY,  JSON.stringify(p)); }
function loadHistory()   { try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch { return []; } }
function saveHistory(h)  { localStorage.setItem(HIST_KEY, JSON.stringify(h)); }

// ═══════════════════════════════════════════════════════════════════
// BOT — LIFECYCLE
// ═══════════════════════════════════════════════════════════════════

let _botAnalysisTimer  = null;
let _botMonitorTimer   = null;
let _botCountdownTimer = null;
let _botNextRun        = null;

function toggleBot() {
  const on      = document.getElementById('botToggle').checked;
  const capital = parseFloat(document.getElementById('dashCapital').value) || 1000;
  const profile = document.querySelector('.risk-btn.active')?.dataset?.r || 'moderate';
  const s = loadBotState();
  s.running = on; s.capital = capital; s.profile = profile;
  saveBotState(s);
  if (on) {
    document.getElementById('botCapitalDisplay').textContent = capital.toFixed(0);
    document.getElementById('botRiskDisplay').textContent =
      { conservative: 'Safe', moderate: 'Balanced', aggressive: 'Aggressive' }[profile];
    startBotTimers();
    runBotAnalysis();
  } else {
    stopBotTimers();
  }
  renderBotStatus();
}

function startBotTimers() {
  stopBotTimers();
  const interval = 4 * 60 * 60 * 1000;
  _botNextRun = Date.now() + interval;
  _botAnalysisTimer  = setInterval(() => { _botNextRun = Date.now() + interval; runBotAnalysis(); }, interval);
  _botMonitorTimer   = setInterval(monitorPositions, 30_000);
  _botCountdownTimer = setInterval(updateCountdown, 1000);
}

function stopBotTimers() {
  clearInterval(_botAnalysisTimer);
  clearInterval(_botMonitorTimer);
  clearInterval(_botCountdownTimer);
  _botAnalysisTimer = _botMonitorTimer = _botCountdownTimer = null;
  _botNextRun = null;
}

function updateCountdown() {
  const el = document.getElementById('botCountdown');
  if (!el || !_botNextRun) return;
  const ms = Math.max(0, _botNextRun - Date.now());
  const h  = Math.floor(ms / 3_600_000);
  const m  = Math.floor((ms % 3_600_000) / 60_000);
  const s  = Math.floor((ms % 60_000) / 1000);
  el.textContent = `${h}h ${m.toString().padStart(2,'0')}m ${s.toString().padStart(2,'0')}s`;
}

function renderBotStatus() {
  const s   = loadBotState();
  const bar = document.getElementById('botStatusBar');
  const lbl = document.getElementById('botToggleLabel');
  if (bar) bar.style.display = s.running ? 'flex' : 'none';
  if (lbl) lbl.textContent = s.running ? 'Bot Running' : 'Start Bot';
}

// ═══════════════════════════════════════════════════════════════════
// BOT — AUTO ANALYSIS (runs every 4 hours when bot is on)
// ═══════════════════════════════════════════════════════════════════

async function runBotAnalysis() {
  const s = loadBotState();
  document.getElementById('dashCapital').value = s.capital || 1000;
  setRiskProfile(s.profile || 'moderate');
  await runDashboard();
  // Auto-open paper trades for strong signals (score >= 3)
  const positions = loadPositions();
  const openIds   = new Set(positions.map(p => p.coinId));
  let opened = 0;
  for (const plan of _currentPlans) {
    if (Math.abs(plan.score) >= 3 && !openIds.has(plan.id)) {
      openPosition(plan, 'auto');
      openIds.add(plan.id);
      opened++;
    }
  }
  if (opened > 0) showToast(`🤖 Bot auto-opened ${opened} paper trade${opened > 1 ? 's' : ''}`);
}

// ═══════════════════════════════════════════════════════════════════
// BOT — POSITIONS
// ═══════════════════════════════════════════════════════════════════

function openTrade(idx, mode) {
  const plan = _currentPlans[idx];
  if (!plan) return;
  if (mode === 'paper') openPosition(plan, 'manual');
  else showTradeInstructions(idx);
}

function openPosition(plan, source = 'manual') {
  const positions = loadPositions();
  if (positions.find(p => p.coinId === plan.id)) {
    if (source === 'manual') showToast(`⚠️ Already tracking ${plan.sym}. Close the existing position first.`);
    return;
  }
  const pos = {
    id: Date.now() + Math.random(),
    coinId: plan.id, sym: plan.sym, name: plan.name, dir: plan.dir,
    entry: plan.price, size: plan.alloc, margin: plan.margin,
    tp: plan.tp, sl: plan.sl, lev: plan.lev, openTime: Date.now(),
  };
  positions.push(pos);
  savePositions(positions);
  renderPositions();
  document.getElementById('positionsCard').style.display = 'block';
  if (source === 'manual')
    showToast(`📄 Paper trade opened: ${plan.sym} ${plan.dir} @ ${fmtUSD(plan.price)}`);
}

async function monitorPositions() {
  const positions = loadPositions();
  if (positions.length === 0) { renderPositions(); return; }
  try {
    const ids       = [...new Set(positions.map(p => p.coinId))].join(',');
    const priceData = await apiFetch(`${BASE}/simple/price?ids=${ids}&vs_currencies=usd`, `live-${ids}`, 15_000);
    const toClose   = [];
    positions.forEach(pos => {
      const curr = priceData[pos.coinId]?.usd;
      if (!curr) return;
      if      (pos.dir === 'Long'  && curr >= pos.tp) toClose.push({ id: pos.id, reason: '🎯 Take Profit', price: curr });
      else if (pos.dir === 'Short' && curr <= pos.tp) toClose.push({ id: pos.id, reason: '🎯 Take Profit', price: curr });
      else if (pos.dir === 'Long'  && curr <= pos.sl) toClose.push({ id: pos.id, reason: '🛑 Stop Loss',   price: curr });
      else if (pos.dir === 'Short' && curr >= pos.sl) toClose.push({ id: pos.id, reason: '🛑 Stop Loss',   price: curr });
    });
    toClose.forEach(({ id, reason, price }) => closePosition(id, reason, price));
    renderPositions(priceData);
  } catch (e) { console.warn('Monitor:', e.message); }
}

function closePosition(id, reason, currentPrice) {
  const positions = loadPositions();
  const idx = positions.findIndex(p => p.id === id);
  if (idx < 0) return;
  const pos       = positions[idx];
  const contracts = pos.size / pos.entry;
  const pnl       = pos.dir === 'Long'
    ? contracts * (currentPrice - pos.entry)
    : contracts * (pos.entry - currentPrice);
  const roePct    = pnl / pos.margin * 100;
  positions.splice(idx, 1);
  savePositions(positions);
  const history = loadHistory();
  history.unshift({ ...pos, closeTime: Date.now(), closePrice: currentPrice, pnl, roePct, reason });
  saveHistory(history);
  renderPositions();
  renderHistory();
  showToast(`${reason} — ${pos.sym} closed · P&L: ${pnl >= 0 ? '+' : ''}${fmtUSD(pnl)}`);
}

async function manualClosePosition(id) {
  const positions = loadPositions();
  const pos = positions.find(p => p.id === id);
  if (!pos) return;
  try {
    const priceData = await apiFetch(`${BASE}/simple/price?ids=${pos.coinId}&vs_currencies=usd`, `close-${pos.coinId}`, 0);
    closePosition(id, 'Manual Close', priceData[pos.coinId]?.usd || pos.entry);
  } catch { closePosition(id, 'Manual Close', pos.entry); }
}

function renderPositions(priceMap = {}) {
  const positions = loadPositions();
  const card = document.getElementById('positionsCard');
  const body = document.getElementById('positionsBody');
  if (!card || !body) return;
  if (positions.length === 0) { card.style.display = 'none'; body.innerHTML = ''; return; }
  card.style.display = 'block';
  body.innerHTML = positions.map(pos => {
    const curr      = priceMap[pos.coinId]?.usd || pos.entry;
    const contracts = pos.size / pos.entry;
    const pnl       = pos.dir === 'Long'
      ? contracts * (curr - pos.entry)
      : contracts * (pos.entry - curr);
    const roePct  = pnl / pos.margin * 100;
    const pnlCls  = pnl >= 0 ? 'pos' : 'neg';
    const pd      = pos.entry < 1 ? 5 : pos.entry < 10 ? 3 : 2;
    const range   = Math.abs(pos.tp - pos.sl);
    const progress = range > 0
      ? Math.max(0, Math.min(100, pos.dir === 'Long'
          ? (curr - pos.sl) / range * 100
          : (pos.sl - curr) / range * 100))
      : 50;
    const elapsed    = Math.floor((Date.now() - pos.openTime) / 60_000);
    const elapsedStr = elapsed < 60 ? `${elapsed}m ago` : `${Math.floor(elapsed / 60)}h ${elapsed % 60}m ago`;
    return `<div class="pos-row">
      <div class="pos-main">
        <div>
          <span class="pos-name">${pos.sym}</span>
          <span class="pos-dir ${pos.dir === 'Long' ? 'long' : 'short'}">${pos.dir === 'Long' ? '📈 Long' : '📉 Short'}</span>
          <div class="pos-meta">Opened ${elapsedStr} · ${pos.lev}× leverage · ${fmtUSD(pos.size)} position</div>
        </div>
        <div style="text-align:right">
          <div class="pos-pnl ${pnlCls}">${pnl >= 0 ? '+' : ''}${fmtUSD(pnl)}</div>
          <div class="pos-meta">${roePct >= 0 ? '+' : ''}${roePct.toFixed(1)}% ROE · Live: ${fmtUSD(curr, pd)}</div>
        </div>
      </div>
      <div class="pos-prices">
        <span>Entry: <strong>${fmtUSD(pos.entry, pd)}</strong></span>
        <span>Take Profit: <strong style="color:var(--green)">${fmtUSD(pos.tp, pd)}</strong></span>
        <span>Stop Loss: <strong style="color:var(--red)">${fmtUSD(pos.sl, pd)}</strong></span>
      </div>
      <div class="pos-progress-track">
        <div class="pos-progress-fill" style="width:${progress}%"></div>
      </div>
      <div class="pos-actions">
        <button class="pos-close-btn" onclick="manualClosePosition(${pos.id})">✕ Close Position</button>
      </div>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════════
// BOT — HISTORY
// ═══════════════════════════════════════════════════════════════════

function renderHistory() {
  const history = loadHistory();
  const card    = document.getElementById('historyCard');
  const body    = document.getElementById('historyBody');
  if (!card || !body) return;
  if (history.length === 0) { card.style.display = 'none'; body.innerHTML = ''; return; }
  card.style.display = 'block';
  const wins     = history.filter(h => h.pnl > 0).length;
  const totalPnl = history.reduce((s, h) => s + h.pnl, 0);
  const winRate  = Math.round(wins / history.length * 100);
  body.innerHTML = `
    <div class="hist-summary">
      <div class="hsi"><div class="hsi-label">Trades</div><div class="hsi-val">${history.length}</div></div>
      <div class="hsi"><div class="hsi-label">Win Rate</div><div class="hsi-val ${winRate >= 50 ? 'green' : 'red'}">${winRate}%</div></div>
      <div class="hsi"><div class="hsi-label">Total P&L</div><div class="hsi-val ${totalPnl >= 0 ? 'green' : 'red'}">${totalPnl >= 0 ? '+' : ''}${fmtUSD(totalPnl)}</div></div>
    </div>
    <table class="hist-table">
      <thead><tr>
        <th>Coin</th><th>Dir</th><th>Entry</th><th>Exit</th><th>P&L</th><th>ROE</th><th>Result</th>
      </tr></thead>
      <tbody>${history.map(h => {
        const pd  = h.entry < 1 ? 5 : h.entry < 10 ? 3 : 2;
        const cls = h.pnl >= 0 ? 'win' : 'loss';
        return `<tr>
          <td><strong>${h.sym}</strong></td>
          <td><span class="pos-dir ${h.dir === 'Long' ? 'long' : 'short'}" style="font-size:10px">${h.dir}</span></td>
          <td style="font-family:var(--mono)">${fmtUSD(h.entry, pd)}</td>
          <td style="font-family:var(--mono)">${fmtUSD(h.closePrice, pd)}</td>
          <td class="${cls}" style="font-family:var(--mono)">${h.pnl >= 0 ? '+' : ''}${fmtUSD(h.pnl)}</td>
          <td class="${cls}">${h.roePct >= 0 ? '+' : ''}${h.roePct.toFixed(1)}%</td>
          <td style="font-size:11px;color:var(--text-lo)">${h.reason}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
}

function clearHistory() {
  if (!confirm('Clear all trade history?')) return;
  saveHistory([]);
  renderHistory();
}

// ═══════════════════════════════════════════════════════════════════
// BOT — EXCHANGE MODAL
// ═══════════════════════════════════════════════════════════════════

function showTradeInstructions(idx) {
  const t = _currentPlans[idx];
  if (!t) return;
  const pd     = t.price < 1 ? 5 : t.price < 10 ? 3 : 2;
  const isLong = t.dir === 'Long';
  document.getElementById('modalContent').innerHTML = `
    <div class="modal-coin">${t.name}</div>
    <div class="modal-dir">
      ${badge(isLong ? '📈 Long' : '📉 Short', isLong ? 'green' : 'red')}
      ${badge(t.lev + '× Leverage', 'accent')}
    </div>
    <div class="modal-step"><span class="modal-step-num">1</span>
      <div>Open <strong>Binance</strong> or <strong>Bybit</strong> and navigate to <strong>Futures → USDT-M Perpetual</strong>.</div></div>
    <div class="modal-step"><span class="modal-step-num">2</span>
      <div>Search for <strong>${t.sym}/USDT</strong> in the contract list.</div></div>
    <div class="modal-step"><span class="modal-step-num">3</span>
      <div>Set leverage to <span class="modal-val">${t.lev}×</span> using the leverage button near the order panel.</div></div>
    <div class="modal-step"><span class="modal-step-num">4</span>
      <div>Place a <strong>${isLong ? 'Buy / Long' : 'Sell / Short'} Market Order</strong> with position size <span class="modal-val">${fmtUSD(t.alloc)}</span>.</div></div>
    <div class="modal-step"><span class="modal-step-num">5</span>
      <div>After entry, set <strong>Take Profit</strong> → <span class="modal-val" style="color:var(--green)">${fmtUSD(t.tp, pd)}</span> and <strong>Stop Loss</strong> → <span class="modal-val" style="color:var(--red)">${fmtUSD(t.sl, pd)}</span>.</div></div>
    <div class="modal-links">
      <a class="modal-link" href="https://www.binance.com/en/futures/${t.sym}USDT" target="_blank" rel="noopener">🔗 Binance Futures</a>
      <a class="modal-link" href="https://www.bybit.com/trade/usdt/${t.sym}USDT"   target="_blank" rel="noopener">🔗 Bybit Futures</a>
    </div>`;
  document.getElementById('modalOverlay').style.display = 'flex';
}

function closeModal() {
  document.getElementById('modalOverlay').style.display = 'none';
}

// ─── Toast notification ───
function showToast(msg) {
  let toast = document.getElementById('_toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = '_toast';
    toast.style.cssText = [
      'position:fixed', 'bottom:24px', 'right:24px', 'z-index:2000',
      'background:var(--card)', 'border:1px solid var(--border2)',
      'border-radius:var(--r-sm)', 'padding:12px 16px',
      'font-size:13px', 'color:var(--text-hi)',
      'max-width:320px', 'box-shadow:0 4px 20px rgba(0,0,0,.5)',
      'transition:opacity .3s', 'pointer-events:none',
    ].join(';');
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toast.style.opacity = '0'; }, 3500);
}
