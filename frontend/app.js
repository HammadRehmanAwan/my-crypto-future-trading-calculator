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

const CRYPTOCOMPARE_NEWS = 'https://min-api.cryptocompare.com/data/v2/news/';
const FINBERT_URL        = 'https://api-inference.huggingface.co/models/ProsusAI/finbert';
const SENT_TTL           = 5 * 60_000; // 5-minute cache for sentiment data

const state = {
  coin: 'bitcoin', days: 30, direction: 'Long',
  prices: null, dates: null, chart: null, cache: {},
  sentiment: null,
};

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
// SENTIMENT  APIS
// ═══════════════════════════════════════════════════════════════════

async function fetchFearGreed() {
  return apiFetch('https://api.alternative.me/fng/?limit=7', 'fg', SENT_TTL);
}

async function fetchCoinCommunity(coinId) {
  const url = `${BASE}/coins/${coinId}?localization=false&tickers=false&market_data=false&community_data=true&developer_data=false`;
  return apiFetch(url, `comm-${coinId}`, SENT_TTL);
}

async function fetchCryptoNews(sym) {
  const url = `${CRYPTOCOMPARE_NEWS}?lang=EN&categories=${sym},Crypto&sortOrder=latest&limit=5`;
  return apiFetch(url, `news-${sym}`, SENT_TTL);
}

async function classifyFinBERT(headlines) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000); // abort after 12 s
  try {
    const res = await fetch(FINBERT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: headlines }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.error ? null : data;
  } catch {
    return null;
  }
}

function parseFinBERT(data) {
  if (!Array.isArray(data)) return null;
  // Batch → [[{label,score},...], ...], single → [{label,score},...]
  const results = Array.isArray(data[0]) ? data : [data];
  let pos = 0, neg = 0, neu = 0, count = 0;
  for (const r of results) {
    if (!Array.isArray(r)) continue;
    r.forEach(({ label, score }) => {
      if (label === 'positive') pos += score;
      else if (label === 'negative') neg += score;
      else neu += score;
    });
    count++;
  }
  return count ? { positive: pos / count, negative: neg / count, neutral: neu / count } : null;
}

let _sentGen = 0;

async function loadSentiment(coinId) {
  const gen = ++_sentGen;
  const sym = COINS[coinId]?.sym || 'BTC';
  state.sentiment = null;
  renderSentimentCard(null);

  // ── Phase 1: fast APIs (renders quickly) ──────────────────────────
  const [fgRes, commRes] = await Promise.allSettled([
    fetchFearGreed(),
    fetchCoinCommunity(coinId),
  ]);
  if (gen !== _sentGen) return;

  const fgData   = fgRes.status  === 'fulfilled' ? fgRes.value?.data : null;
  const commData = commRes.status === 'fulfilled' ? commRes.value     : null;

  state.sentiment = {
    fg:        fgData,
    community: commData ? {
      up:   commData.sentiment_votes_up_percentage,
      down: commData.sentiment_votes_down_percentage,
    } : null,
    finbert:   null,
    headlines: [],
    finbertLoading: true,
  };
  try { renderSentimentCard(state.sentiment); } catch (e) { console.error('Sentiment render error:', e); }

  // ── Phase 2: slow FinBERT (updates card when ready) ───────────────
  let newsItems = [];
  try {
    const newsRes = await fetchCryptoNews(sym);
    newsItems = (newsRes?.Data || []).slice(0, 5);
  } catch { /* ignore */ }

  let finbert = null;
  if (newsItems.length) {
    finbert = await classifyFinBERT(newsItems.map(n => n.title).filter(Boolean)).catch(() => null);
  }

  if (gen !== _sentGen) return;

  state.sentiment = {
    ...state.sentiment,
    finbert:        parseFinBERT(finbert),
    headlines:      newsItems.map(n => n.title),
    finbertLoading: false,
  };
  try { renderSentimentCard(state.sentiment); } catch (e) { console.error('Sentiment render error:', e); }
}

// ─── Render Sentiment Card ───────────────────────────────────────────

function renderSentimentCard(data) {
  const card = document.getElementById('sentimentCard');
  if (!card) return;

  if (!data) {
    card.innerHTML = `<h3 class="card-heading">Market Sentiment <span class="heading-sub">— Loading…</span></h3>
      <div class="sent-loading"><div class="spin"></div><span>Fetching fear &amp; greed, news and community data…</span></div>`;
    return;
  }

  // ── Fear & Greed ──
  let fgHtml;
  if (data.fg?.length) {
    const cur    = parseInt(data.fg[0].value);
    const label  = data.fg[0].value_classification;
    const prev   = data.fg[1] ? parseInt(data.fg[1].value) : null;
    const diff   = prev != null ? cur - prev : 0;
    const trend  = prev != null ? (diff > 0 ? `↑ ${diff} from yesterday` : diff < 0 ? `↓ ${Math.abs(diff)} from yesterday` : 'Unchanged from yesterday') : '';
    const fillC  = cur <= 44 ? '#FF3D3D' : cur <= 55 ? '#F7C948' : '#00E887';
    const valCls = cur <= 44 ? 'red' : cur <= 55 ? 'gold' : 'green';
    const hist   = [...data.fg].reverse();

    const sigText = cur <= 24 ? 'Extreme fear — historically strong buy signal (contrarian)'
      : cur <= 44 ? 'Market fearful — prices may be undervalued'
      : cur <= 55 ? 'Neutral — no contrarian signal'
      : cur <= 74 ? 'Market greedy — consider taking profits'
      : 'Extreme greed — corrections often follow (contrarian sell)';
    const sigCls = cur <= 44 ? 'green' : cur <= 55 ? 'neutral' : 'red';

    // Arc gauge geometry: semicircle from left (180°) to right (0°) through top
    const gR = 60;
    const arcEndDeg = 180 - (cur / 100 * 180);
    const arcEndRad = arcEndDeg * Math.PI / 180;
    const arcEx = (80 + gR * Math.cos(arcEndRad)).toFixed(1);
    const arcEy = (80 - gR * Math.sin(arcEndRad)).toFixed(1);

    const sparkBars = hist.map(d => {
      const v = parseInt(d.value);
      const h = Math.max(4, Math.round(v / 100 * 28));
      const c = v <= 44 ? '#FF3D3D' : v <= 55 ? '#F7C948' : '#00E887';
      return `<div class="fgs-bar" style="height:${h}px;background:${c}" title="${d.value_classification}: ${v}"></div>`;
    }).join('');

    fgHtml = `<div class="sent-section-label">Fear & Greed <span class="sent-src">alternative.me</span></div>
      <div class="fg-arc-outer">
        <svg viewBox="0 0 160 92" xmlns="http://www.w3.org/2000/svg" class="fg-arc-svg">
          <defs>
            <linearGradient id="fgg" x1="20" y1="0" x2="140" y2="0" gradientUnits="userSpaceOnUse">
              <stop offset="0%"   stop-color="#FF3D3D"/>
              <stop offset="44%"  stop-color="#F7C948"/>
              <stop offset="100%" stop-color="#00E887"/>
            </linearGradient>
          </defs>
          <path d="M 20 80 A 60 60 0 0 0 140 80" fill="none" stroke="url(#fgg)" stroke-width="8" stroke-linecap="round" opacity="0.18"/>
          ${cur > 0 ? `<path d="M 20 80 A 60 60 0 0 0 ${arcEx} ${arcEy}" fill="none" stroke="url(#fgg)" stroke-width="8" stroke-linecap="round"/>` : ''}
          ${cur > 0 ? `<circle cx="${arcEx}" cy="${arcEy}" r="4.5" fill="${fillC}" stroke="#0F1828" stroke-width="1.5"/>` : ''}
          <circle cx="20" cy="80" r="3.5" fill="#FF3D3D" opacity="0.35"/>
          <circle cx="140" cy="80" r="3.5" fill="#00E887" opacity="0.35"/>
          <text x="80" y="67" text-anchor="middle" font-size="30" font-weight="800" fill="${fillC}" font-family="JetBrains Mono,monospace">${cur}</text>
          <text x="80" y="79" text-anchor="middle" font-size="10" font-weight="700" fill="${fillC}" letter-spacing="0.06em" font-family="Inter,sans-serif">${label.toUpperCase()}</text>
        </svg>
      </div>
      <div class="fg-bottom-row">
        <div class="fg-spark">${sparkBars}</div>
        <div class="fg-trend">${trend}</div>
      </div>
      ${badge(sigText, sigCls)}`;
  } else {
    fgHtml = `<div class="sent-section-label">Fear & Greed</div><div class="sent-unavail">Unavailable</div>`;
  }

  // ── Community Sentiment ──
  let commHtml;
  if (data.community?.up != null) {
    const up  = data.community.up.toFixed(1);
    const dn  = data.community.down.toFixed(1);
    const cls = data.community.up > 60 ? 'green' : data.community.down > 60 ? 'red' : 'neutral';
    const sigText = data.community.up > 70  ? `${up}% bullish — strong positive sentiment`
      : data.community.up > 55  ? `${up}% bullish — mild positive lean`
      : data.community.down > 70 ? `${dn}% bearish — strong negative sentiment`
      : data.community.down > 55 ? `${dn}% bearish — mild negative lean`
      : `${up}% vs ${dn}% — community is split`;

    commHtml = `<div class="sent-section-label">Community <span class="sent-src">CoinGecko votes</span></div>
      <div class="comm-bar-row">
        <span class="comm-side green">Bull</span>
        <div class="comm-track"><div class="comm-fill green" style="width:${up}%"></div></div>
        <span class="comm-pct green">${up}%</span>
      </div>
      <div class="comm-bar-row">
        <span class="comm-side red">Bear</span>
        <div class="comm-track"><div class="comm-fill red" style="width:${dn}%"></div></div>
        <span class="comm-pct red">${dn}%</span>
      </div>
      ${badge(sigText, cls)}`;
  } else {
    commHtml = `<div class="sent-section-label">Community</div><div class="sent-unavail">Unavailable</div>`;
  }

  // ── FinBERT News Sentiment ──
  let fbHtml;
  if (data.finbert) {
    const pos = (data.finbert.positive * 100).toFixed(0);
    const neu = (data.finbert.neutral  * 100).toFixed(0);
    const neg = (data.finbert.negative * 100).toFixed(0);
    const cls = data.finbert.positive > 0.55 ? 'green' : data.finbert.negative > 0.55 ? 'red' : 'neutral';
    const overall = data.finbert.positive > 0.55 ? 'Positive' : data.finbert.negative > 0.55 ? 'Negative' : 'Neutral';
    const headlineHtml = data.headlines.length ? data.headlines.slice(0, 3)
      .map(h => `<div class="fb-headline">• ${h.length > 90 ? h.slice(0, 87) + '…' : h}</div>`).join('') : '';

    fbHtml = `<div class="sent-section-label">News Sentiment <span class="sent-src">FinBERT AI · ${data.headlines.length} headlines</span></div>
      <div class="fb-bars">
        <div class="fb-row"><span class="fb-lbl green">Positive</span><div class="fb-track"><div class="fb-fill green" style="width:${pos}%"></div></div><span class="fb-pct">${pos}%</span></div>
        <div class="fb-row"><span class="fb-lbl neutral-text">Neutral</span><div class="fb-track"><div class="fb-fill neutral" style="width:${neu}%"></div></div><span class="fb-pct">${neu}%</span></div>
        <div class="fb-row"><span class="fb-lbl red">Negative</span><div class="fb-track"><div class="fb-fill red" style="width:${neg}%"></div></div><span class="fb-pct">${neg}%</span></div>
      </div>
      ${badge(`Overall ${overall} — ${pos}% positive, ${neg}% negative across recent headlines`, cls)}
      ${headlineHtml ? `<div class="fb-headlines">${headlineHtml}</div>` : ''}`;
  } else if (data.finbertLoading) {
    fbHtml = `<div class="sent-section-label">News Sentiment <span class="sent-src">FinBERT AI</span></div>
      <div class="sent-loading" style="padding:6px 0"><div class="spin" style="width:14px;height:14px;border-width:2px"></div><span>Fetching headlines and running AI analysis…</span></div>`;
  } else {
    fbHtml = `<div class="sent-section-label">News Sentiment <span class="sent-src">FinBERT AI</span></div>
      <div class="sent-unavail">Model warming up — reload the page in 20 seconds to try again</div>`;
  }

  card.innerHTML = `
    <h3 class="card-heading">Market Sentiment <span class="heading-sub">— News · Community · Fear & Greed</span></h3>
    <div class="sent-top-grid">
      <div class="sent-block">${fgHtml}</div>
      <div class="sent-block">${commHtml}</div>
    </div>
    <div class="sent-block sent-block-full">${fbHtml}</div>`;
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
    showAlertStatus('EmailJS library not loaded — check your internet connection.', 'error'); return;
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
    showAlertStatus(`Alert email sent for ${coinName}!`, 'success');
  } catch (e) {
    showAlertStatus(`Email failed: ${e?.text || e?.message || 'Unknown error — is your email address correct?'}`, 'error');
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
    showAlertStatus('Please enter a valid email address.', 'error'); return;
  }
  const s = {
    enabled:     document.getElementById('alertEnabled').checked,
    email,
    sensitivity: document.querySelector('.thresh-btn.active')?.dataset?.t || 'moderate',
    watchCoins:  [...document.querySelectorAll('.watch-coin-cb:checked')].map(c => c.value),
  };
  persistAlertSettings(s);
  showAlertStatus('Saved. Monitoring ' + s.watchCoins.length + ' coin(s) every 5 minutes.', 'success');
}

async function testAlert() {
  saveAlerts();
  const s = getAlertSettings();
  if (!s.email) { showAlertStatus('Enter your email address first.', 'error'); return; }
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
  else              { risk = 'Extreme Risk'; hint = `${v}× leverage — price only needs to move ${(100/v).toFixed(1)}% against you to lose everything. Not recommended for beginners.`; }
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
    loadSentiment(coinId).catch(e => console.warn('Sentiment:', e.message));
  } catch (err) {
    loader.innerHTML = `<span style="color:#FF3D3D">${
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
  btn.disabled = true; btn.textContent = 'Analyzing…';
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
  if (m.liqDist < 5)  { signals.push({ t:`DANGER: Your forced-close price is only ${m.liqDist.toFixed(1)}% away — very high risk!`, c:'red' }); score -= 1; }
  else if (m.liqDist < 10) signals.push({ t:`Caution: Your forced-close price is ${m.liqDist.toFixed(1)}% away — moderate risk`, c:'yellow' });
  else                      signals.push({ t:`Safe buffer: Your forced-close price is ${m.liqDist.toFixed(1)}% away`, c:'green' });

  // Sentiment signals (from pre-loaded state.sentiment)
  if (state.sentiment?.fg?.length) {
    const fgV = parseInt(state.sentiment.fg[0].value);
    const fgL = state.sentiment.fg[0].value_classification;
    if      (fgV <= 24) { signals.push({ t:`Fear & Greed ${fgV} (${fgL}) — historically a strong buying opportunity`, c:'green' }); score += 1; }
    else if (fgV <= 44) { signals.push({ t:`Fear & Greed ${fgV} (${fgL}) — market fearful, mild contrarian bullish lean`, c:'green' }); }
    else if (fgV >= 75) { signals.push({ t:`Fear & Greed ${fgV} (${fgL}) — extreme greed often precedes corrections`, c:'red' }); score -= 1; }
    else if (fgV >= 56) { signals.push({ t:`Fear & Greed ${fgV} (${fgL}) — market greedy, mild contrarian bearish lean`, c:'red' }); }
    else                  signals.push({ t:`Fear & Greed ${fgV} (${fgL}) — no strong contrarian signal`, c:'neutral' });
  }
  if (state.sentiment?.community?.up != null) {
    const up = state.sentiment.community.up;
    if      (up > 70) { signals.push({ t:`Community: ${up.toFixed(0)}% bullish votes — strong positive sentiment`, c:'green' }); score += 1; }
    else if (up > 55) { signals.push({ t:`Community: ${up.toFixed(0)}% bullish — mild positive lean`, c:'green' }); }
    else if (up < 30) { signals.push({ t:`Community: ${(100-up).toFixed(0)}% bearish votes — strong negative sentiment`, c:'red' }); score -= 1; }
    else if (up < 45) { signals.push({ t:`Community: ${(100-up).toFixed(0)}% bearish — mild negative lean`, c:'red' }); }
    else                signals.push({ t:`Community: ${up.toFixed(0)}% bullish vs ${(100-up).toFixed(0)}% bearish — split`, c:'neutral' });
  }
  if (state.sentiment?.finbert) {
    const fb = state.sentiment.finbert;
    if      (fb.positive > 0.6) { signals.push({ t:`News (FinBERT AI): ${(fb.positive*100).toFixed(0)}% of headlines positive — bullish news flow`, c:'green' }); score += 1; }
    else if (fb.negative > 0.6) { signals.push({ t:`News (FinBERT AI): ${(fb.negative*100).toFixed(0)}% of headlines negative — bearish news flow`, c:'red' }); score -= 1; }
    else                          signals.push({ t:`News (FinBERT AI): Mixed headlines — no strong directional signal`, c:'neutral' });
  }

  renderResults(m, curr, fcst, horizon, chgF);
  renderSignal(score, signals, dir);
  btn.disabled = false; btn.textContent = 'Analyze Trade';
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
    ${row('Forced Close Price', fmtUSD(m.liq), m.liqDist < 10 ? 'red' : '', `${m.liqDist.toFixed(2)}% from entry — you lose all your capital if price reaches here`, m.liqDist < 10 ? 'hl-red' : '')}
    ${m.tp != null ? row('Take Profit Target', fmtUSD(m.tp), 'green', `Your profit at this price: +${fmtUSD(m.pnlTp)} · Return on your capital: ${fmtPct(m.roeTp)}`, 'hl-green') : ''}
    ${m.sl ? row('Stop Loss', fmtUSD(m.sl), 'red', `Max loss if triggered: ${fmtUSD(m.pnlSl)} · That is ${fmtPct(m.roeSl)} of your capital`, 'hl-red') : ''}
    ${m.rr != null ? row('Risk / Reward Ratio', `1 : ${m.rr.toFixed(2)}`, m.rr >= 2 ? 'green' : m.rr >= 1 ? 'gold' : 'red', m.rr >= 2 ? `Good — for every $1 risked you could gain $${m.rr.toFixed(2)}` : m.rr >= 1 ? 'Fair — aim for 1:2 or better for quality trades' : 'Poor — you risk more than your potential gain', m.rr >= 2 ? 'hl-green' : m.rr >= 1 ? 'hl-gold' : 'hl-red') : ''}
  </div>`;
}

// ═══════════════════════════════════════════════════════════════════
// RENDER SIGNAL
// ═══════════════════════════════════════════════════════════════════

function renderSignal(score, signals, dir) {
  let heading, hCls, summary, summaryEmoji;
  if (score >= 3) {
    heading = 'Strong Bullish — Good time to go Long';
    hCls = 'green';
    summaryEmoji = '▲';
    summary = 'Most indicators agree: conditions strongly favor the price going UP. This is a good environment for a Long trade, but always use a stop-loss.';
  } else if (score >= 1) {
    heading = 'Mild Bullish — Slight upward lean';
    hCls = 'yellow';
    summaryEmoji = '↑';
    summary = 'Conditions lean upward, but signals are not strong. If trading Long, use a smaller position size and definitely set a stop-loss.';
  } else if (score <= -3) {
    heading = 'Strong Bearish — Good time to go Short';
    hCls = 'red';
    summaryEmoji = '▼';
    summary = 'Most indicators agree: conditions strongly favor the price going DOWN. This is a good environment for a Short trade, but always use a stop-loss.';
  } else if (score <= -1) {
    heading = 'Mild Bearish — Slight downward lean';
    hCls = 'yellow';
    summaryEmoji = '↓';
    summary = 'Conditions lean downward. Long trades carry higher risk right now. Consider waiting for a better entry or reducing your position size.';
  } else {
    heading = 'Neutral — No clear direction';
    hCls = 'neutral';
    summaryEmoji = '—';
    summary = 'No clear direction. The market is undecided. Best practice: wait for stronger signals before entering a trade to improve your odds.';
  }
  const aligned = (score > 0 && dir === 'Long') || (score < 0 && dir === 'Short');
  const alignHtml = score !== 0 ? `<div class="align-msg ${aligned ? 'green' : 'red'}">${
    aligned
      ? `Your chosen direction (${dir}) matches the signals — good alignment.`
      : `You chose ${dir} but signals lean the other way. This is a counter-trend trade — higher risk.`
  }</div>` : '';
  document.getElementById('signalCard').style.display = 'block';
  document.getElementById('signalBody').innerHTML = `
    <div class="signal-heading ${hCls}">
      <span>${heading}</span>
      <span class="sig-score">${score > 0 ? '+' : ''}${score} / ±8</span>
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
  btn.disabled = true; btn.textContent = 'Analyzing…';
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
      btn.disabled = false; btn.textContent = 'Analyze Now'; return;
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
      ? 'CoinGecko rate limit hit — please wait 60 seconds and try again.'
      : `Failed to load data: ${e.message}`;
  }
  btn.disabled = false; btn.textContent = 'Analyze Now';
}

function renderDashboard(trades, capital, riskProfile) {
  const totalPnlTp  = trades.reduce((s, t) => s + t.pnlTp, 0);
  const totalPnlSl  = trades.reduce((s, t) => s + t.pnlSl, 0);
  const roePct      = totalPnlTp / capital * 100;
  const riskLabels  = { conservative: 'Safe', moderate: 'Balanced', aggressive: 'Aggressive' };

  document.getElementById('dashSummary').innerHTML = `
    <div class="dash-sum-grid">
      <div class="dsi"><div class="dsi-label">Your Capital</div><div class="dsi-val accent">${fmtUSD(capital)}</div></div>
      <div class="dsi"><div class="dsi-label">Trades</div><div class="dsi-val">${trades.length} coins</div></div>
      <div class="dsi"><div class="dsi-label">If All Targets Hit</div><div class="dsi-val green">+${fmtUSD(totalPnlTp)} (+${roePct.toFixed(1)}%)</div></div>
      <div class="dsi"><div class="dsi-label">If All Stops Hit</div><div class="dsi-val red">${fmtUSD(totalPnlSl)}</div></div>
      <div class="dsi"><div class="dsi-label">Risk Profile</div><div class="dsi-val">${riskLabels[riskProfile]}</div></div>
    </div>`;

  document.getElementById('dashTradesGrid').innerHTML = trades.map(t => {
    const isLong   = t.dir === 'Long';
    const allocPct = (t.alloc / capital * 100).toFixed(0);
    const stars    = '◆'.repeat(Math.min(5, Math.abs(t.score)));
    const tpDist   = (Math.abs(t.tp - t.price) / t.price * 100).toFixed(1);
    const slDist   = (Math.abs(t.sl - t.price) / t.price * 100).toFixed(1);
    const pd       = t.price < 1 ? 5 : t.price < 10 ? 3 : 2;

    return `<div class="trade-card ${isLong ? 'tc-long' : 'tc-short'}">

      <div class="tc-head">
        <span class="tc-dir ${isLong ? 'long' : 'short'}">${isLong ? '▲ LONG' : '▼ SHORT'}</span>
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
          <div class="tcp-label">Take Profit</div>
          <div class="tcp-val green">${fmtUSD(t.tp, pd)}</div>
          <div class="tcp-sub">+${tpDist}% from entry</div>
        </div>
        <div class="tcp">
          <div class="tcp-label">Stop Loss</div>
          <div class="tcp-val red">${fmtUSD(t.sl, pd)}</div>
          <div class="tcp-sub">-${slDist}% from entry</div>
        </div>
      </div>

      <div class="tc-outcome-row">
        <div class="tc-outcome good">Target hit → <strong>+${fmtUSD(t.pnlTp)} profit</strong></div>
        <div class="tc-outcome bad">Stop hit → <strong>${fmtUSD(t.pnlSl)} loss</strong></div>
      </div>

      <div class="tc-why">
        <div class="tc-why-title">Why this trade:</div>
        ${t.why.map(w => `<div class="tc-why-item">• ${w}</div>`).join('')}
      </div>

    </div>`;
  }).join('');

  document.getElementById('dashResults').style.display = 'block';
}

