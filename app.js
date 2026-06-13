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

// ─── FIREBASE CONFIG ────────────────────────────────────────────────
// Credentials are served from the backend so they never appear in source.
// Set BACKEND_URL to wherever app.py is deployed (Render, HuggingFace, etc.)
// and add the seven FIREBASE_* environment variables on that server.
const BACKEND_URL = 'https://my-crypto-future-trading-calculator.onrender.com';
// ────────────────────────────────────────────────────────────────────

let _db   = null;
let _auth = null;

// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════

const CRYPTOCOMPARE_NEWS = 'https://min-api.cryptocompare.com/data/v2/news/';
const SENT_TTL           = 5 * 60_000;

const state = {
  coin: 'bitcoin', days: 30, direction: 'Long',
  prices: null, dates: null, chart: null, cache: {},
  sentiment: null, lastUpdated: null, _autoRan: false,
  user: null, alertSettings: {},
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

// Render's free tier sleeps after ~15 min idle; the first request after that
// returns a 502/503 from the router (or takes ~50s to cold-boot). Wrap backend
// calls with a per-attempt timeout and retry the gateway errors so a sleeping
// service gets woken and retried instead of failing permanently.
async function backendFetch(url, key, ttl = 60_000, { method = 'GET', body = null, retries = 3, timeoutMs = 60_000 } = {}) {
  if (key) {
    const hit = state.cache[key];
    if (hit && Date.now() - hit.ts < ttl) return hit.data;
  }
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const opts = { method, signal: ctrl.signal };
      if (body != null) {
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body = JSON.stringify(body);
      }
      const r = await fetch(url, opts);
      clearTimeout(timer);
      // 502/503/504 mean the dyno is still waking up — back off and retry.
      if ((r.status === 502 || r.status === 503 || r.status === 504) && attempt < retries) {
        await new Promise(res => setTimeout(res, 2500 * (attempt + 1)));
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (key) state.cache[key] = { data, ts: Date.now() };
      return data;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < retries) {
        await new Promise(res => setTimeout(res, 2500 * (attempt + 1)));
        continue;
      }
    }
  }
  throw lastErr || new Error('backend unreachable');
}

// Best-effort wake-up ping so the first real call lands on a warm dyno.
function wakeBackend() {
  if (!BACKEND_URL) return;
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 60_000);
  fetch(`${BACKEND_URL}/health`, { signal: ctrl.signal }).catch(() => {});
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

// Fetch crypto news. Tries CryptoCompare directly in the browser (its public
// news API sends permissive CORS headers), then the backend proxy, then a
// Hacker News fallback — so news shows even when the Render backend is down.
async function fetchCryptoNews() {
  const cached = state.cache['news-proxy'];
  if (cached && Date.now() - cached.ts < SENT_TTL) return cached.data;

  // 1) CryptoCompare directly
  try {
    const r = await fetch('https://min-api.cryptocompare.com/data/v2/news/?lang=EN&sortOrder=latest');
    if (r.ok) {
      const j = await r.json();
      const raw = Array.isArray(j.Data) ? j.Data : [];
      const items = raw
        .filter(a => a.title && a.published_on)
        .slice(0, 30)
        .map(a => ({ title: a.title, url: a.url || '', source: a.source || '', published_on: a.published_on }));
      if (items.length) { state.cache['news-proxy'] = { data: items, ts: Date.now() }; return items; }
    }
  } catch (e) { /* CORS/network — try next source */ }

  // 2) Backend proxy (if reachable)
  if (BACKEND_URL) {
    try {
      return await backendFetch(`${BACKEND_URL}/news`, 'news-proxy', SENT_TTL, { retries: 0, timeoutMs: 10_000 });
    } catch (e) { /* fall through */ }
  }

  // 3) Hacker News fallback (CORS-friendly)
  try {
    const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
    const r = await fetch(`https://hn.algolia.com/api/v1/search_by_date?query=bitcoin%20ethereum%20crypto%20blockchain&tags=story&hitsPerPage=20&numericFilters=created_at_i%3E${cutoff}`);
    if (r.ok) {
      const j = await r.json();
      const items = (j.hits || [])
        .filter(h => h.title && h.created_at_i)
        .map(h => ({
          title: h.title,
          url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
          source: h.url ? h.url.split('/')[2].replace('www.', '') : 'Hacker News',
          published_on: h.created_at_i,
        }));
      if (items.length) { state.cache['news-proxy'] = { data: items, ts: Date.now() }; return items; }
    }
  } catch (e) { /* give up */ }

  return null;
}

// Module-level sentiment lexicon shared by all scoring functions
const _SENT_POS = new Set([
  'rally','rallied','rallying','surge','surged','surging','bullish','bull',
  'gain','gains','gained','soar','soared','soaring','rise','risen','rising',
  'jumped','jump','climb','climbed','climbing','recover','recovered','recovery',
  'breakout','breakthrough','adoption','mainstream','institutional','invest',
  'investment','partnership','integration','launch','launched','approve',
  'approval','approved','legal','legalize','legalized','regulated','secure',
  'stability','stable','growth','growing','demand','innovation','positive',
  'optimistic','confident','strong','boom','booming','milestone','increase',
  'increased','impressive','achievement','opportunity','success','successful',
  'profit','profits','profitable','outperform','upgrade','buy','accumulate',
  'inflow','inflows','etf','momentum','higher','high','green','pumped',
  'support','trust','optimism','upside','record','ath','all-time','peak',
  'expand','expansion','boost','boosted','accelerate','grow','upward',
  'rebound','improving','improved','winning','win','best','top','healthy',
]);

const _SENT_NEG = new Set([
  'crash','crashed','crashing','dump','dumped','dumping','drop','dropped',
  'dropping','plunge','plunged','plunging','bear','bearish','decline',
  'declined','declining','fall','fell','falling','selloff','sell-off',
  'hack','hacked','hacking','exploit','exploited','fraud','scam','ponzi',
  'ban','banned','banning','restrict','restricted','restriction','fine',
  'fined','penalty','penalties','investigation','investigate','lawsuit',
  'sued','sue','liquidation','liquidated','insolvent','bankrupt','bankruptcy',
  'fud','fear','concern','concerns','warning','warn','warned','threat',
  'threatened','crisis','collapse','collapsed','collapsing','fail','failed',
  'failure','loss','losses','lost','risk','risky','dangerous','danger',
  'problem','problems','suspect','controversial','illegal','crime','criminal',
  'breach','vulnerability','outflow','outflows','correction','bloodbath',
  'stolen','theft','clampdown','shutdown','suspended','suspension','frozen',
  'contagion','implosion','scandal','overvalued','bubble','downturn',
  'pessimistic','lower','low','red','down','tumble','tumbled','slump',
  'slumped','nosedive','sank','sink','wipeout','wiped','plummet','plummeted',
  'lose','losing','worst','weak','weakening','trouble','troubled','hurting',
  'hurt','negative','bad','worse','ugly','pressure','pressured','struggling',
]);

function classifyHeadline(title) {
  const words = title.toLowerCase().replace(/[^a-z\s-]/g, ' ').split(/\s+/);
  let p = 0, n = 0;
  for (const w of words) {
    if (_SENT_POS.has(w)) p++;
    if (_SENT_NEG.has(w)) n++;
  }
  return p > n ? 'pos' : n > p ? 'neg' : 'neu';
}

function analyzeHeadlineSentiment(headlines) {
  if (!headlines.length) return null;
  let pos = 0, neg = 0, neu = 0;
  for (const h of headlines) {
    const s = classifyHeadline(h);
    if (s === 'pos') pos++;
    else if (s === 'neg') neg++;
    else neu++;
  }
  const total = headlines.length;
  return { positive: pos / total, neutral: neu / total, negative: neg / total };
}

function formatTimeAgo(unixTs) {
  const secs = Math.floor(Date.now() / 1000) - unixTs;
  if (secs < 3600)  return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

let _sentGen = 0;

async function loadSentiment(coinId) {
  const gen = ++_sentGen;
  const sym = COINS[coinId]?.sym || 'BTC';
  state.sentiment = null;
  renderSentimentCard(null);

  const [fgRes, commRes] = await Promise.allSettled([
    fetchFearGreed(),
    fetchCoinCommunity(coinId),
  ]);
  if (gen !== _sentGen) return;

  const fgData   = fgRes.status  === 'fulfilled' ? fgRes.value?.data : null;
  const commData = commRes.status === 'fulfilled' ? commRes.value     : null;

  let newsItems = [];
  try {
    const raw = await fetchCryptoNews();
    if (Array.isArray(raw) && raw.length) {
      const cutoff = Math.floor(Date.now() / 1000) - 3 * 24 * 3600;
      const recent = raw.filter(n => n.published_on >= cutoff);
      // If 3-day filter leaves nothing (HN fallback uses 7-day window), take top 6 anyway
      const pool = recent.length >= 3 ? recent : raw;
      newsItems = pool
        .slice(0, 8)
        .map(n => ({ ...n, _sent: classifyHeadline(n.title || '') }));
    }
  } catch { /* ignore */ }

  if (gen !== _sentGen) return;

  const headlines = newsItems.map(n => n.title).filter(Boolean);
  state.sentiment = {
    fg:        fgData,
    community: commData ? {
      up:   commData.sentiment_votes_up_percentage,
      down: commData.sentiment_votes_down_percentage,
    } : null,
    newsSentiment: analyzeHeadlineSentiment(headlines),
    headlines,
    newsItems,
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
    const hist   = [...data.fg].reverse();

    const sigText = cur <= 24 ? 'Extreme fear — historically strong buy signal (contrarian)'
      : cur <= 44 ? 'Market fearful — prices may be undervalued'
      : cur <= 55 ? 'Neutral — no contrarian signal'
      : cur <= 74 ? 'Market greedy — consider taking profits'
      : 'Extreme greed — corrections often follow (contrarian sell)';
    const sigCls = cur <= 44 ? 'green' : cur <= 55 ? 'neutral' : 'red';

    const sparkBars = hist.map(d => {
      const v = parseInt(d.value);
      const h = Math.max(4, Math.round(v / 100 * 28));
      const c = v <= 44 ? '#FF3D3D' : v <= 55 ? '#F7C948' : '#00E887';
      return `<div class="fgs-bar" style="height:${h}px;background:${c}" title="${d.value_classification}: ${v}"></div>`;
    }).join('');

    fgHtml = `
      <div class="sent-section-label">Fear &amp; Greed <span class="sent-src">alternative.me</span></div>
      <div class="fg-num-row">
        <div class="fg-big-num" style="color:${fillC}">${cur}</div>
        <div class="fg-num-info">
          <div class="fg-classify" style="color:${fillC}">${label}</div>
          <div class="fg-trend-text">${trend}</div>
        </div>
      </div>
      <div class="fg-bar-wrap">
        <div class="fg-bar-track">
          <div class="fg-bar-indicator" style="left:${cur}%"></div>
        </div>
        <div class="fg-bar-axis">
          <span style="color:#FF3D3D">Fear</span>
          <span style="color:#00E887">Greed</span>
        </div>
      </div>
      <div class="fg-spark-row">
        <div class="fg-spark">${sparkBars}</div>
      </div>
      ${badge(sigText, sigCls)}`;
  } else {
    fgHtml = `<div class="sent-section-label">Fear &amp; Greed</div><div class="sent-unavail">Unavailable</div>`;
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

  // ── News Sentiment + Article List ──
  const articles = data.newsItems || [];
  const ns       = data.newsSentiment;
  let fbHtml;

  if (articles.length > 0) {
    let sentHtml = '';
    if (ns) {
      const pos     = (ns.positive * 100).toFixed(0);
      const neu     = (ns.neutral  * 100).toFixed(0);
      const neg     = (ns.negative * 100).toFixed(0);
      const cls     = ns.positive > 0.5 ? 'green' : ns.negative > 0.5 ? 'red' : 'neutral';
      const overall = ns.positive > 0.5 ? 'Positive' : ns.negative > 0.5 ? 'Negative' : 'Neutral';
      sentHtml = `
        <div class="fb-bars">
          <div class="fb-row"><span class="fb-lbl green">Positive</span><div class="fb-track"><div class="fb-fill green" style="width:${pos}%"></div></div><span class="fb-pct">${pos}%</span></div>
          <div class="fb-row"><span class="fb-lbl neutral-text">Neutral</span><div class="fb-track"><div class="fb-fill neutral" style="width:${neu}%"></div></div><span class="fb-pct">${neu}%</span></div>
          <div class="fb-row"><span class="fb-lbl red">Negative</span><div class="fb-track"><div class="fb-fill red" style="width:${neg}%"></div></div><span class="fb-pct">${neg}%</span></div>
        </div>
        ${badge(`Overall ${overall} — ${pos}% positive · ${neg}% negative · ${articles.length} articles`, cls)}`;
    }

    const listHtml = articles.map(item => {
      const sc   = item._sent;
      const time = formatTimeAgo(item.published_on);
      const title = item.title.length > 90 ? item.title.slice(0, 87) + '…' : item.title;
      const href  = item.url ? ` href="${item.url}" target="_blank" rel="noopener noreferrer"` : '';
      return `<a class="nl-item"${href}>
        <span class="nl-dot nl-${sc}"></span>
        <div class="nl-body">
          <div class="nl-title">${title}</div>
          <div class="nl-meta"><span class="nl-src">${item.source || ''}</span><span class="nl-time">${time}</span></div>
        </div>
      </a>`;
    }).join('');

    fbHtml = `
      <div class="sent-section-label">News Sentiment
        <span class="sent-src">Keyword AI · ${articles.length} articles · last 3 days</span>
      </div>
      ${sentHtml}
      <div class="nl-list">${listHtml}</div>`;
  } else {
    fbHtml = `
      <div class="sent-section-label">News Sentiment</div>
      <div class="sent-unavail">No recent headlines found — data may be temporarily unavailable</div>`;
  }

  card.innerHTML = `
    <h3 class="card-heading">Market Sentiment <span class="heading-sub">— News · Community · Fear &amp; Greed</span></h3>
    <div class="sent-top-grid">
      <div class="sent-block sent-block-fg">${fgHtml}</div>
      <div class="sent-block sent-block-comm">${commHtml}</div>
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
  // Full, human-readable dates for the tooltip title (e.g. "Mon, Jun 5 2026")
  const fullLabels = allDates.map(d => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }));
  const pad  = arr => [...arr.slice(-n), ...new Array(horizon).fill(null)];
  const fpad = arr => [...new Array(n).fill(null), ...arr];
  const datasets = [
    { label: 'Price', data: pad(dPrices), borderColor: '#00D4FF', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, tension: 0.3, order: 1 },
    { label: 'BB Upper', data: pad(bb.upper), borderColor: 'rgba(100,116,139,0.45)', backgroundColor: 'transparent', borderWidth: 1, borderDash: [4,3], pointRadius: 0, tension: 0.3, order: 3 },
    { label: 'BB Mid', data: pad(bb.mid), borderColor: 'rgba(100,116,139,0.25)', backgroundColor: 'transparent', borderWidth: 1, pointRadius: 0, tension: 0.3, order: 3 },
    { label: 'BB Lower', data: pad(bb.lower), borderColor: 'rgba(100,116,139,0.45)', backgroundColor: 'rgba(100,116,139,0.06)', fill: '-1', borderWidth: 1, borderDash: [4,3], pointRadius: 0, tension: 0.3, order: 3 },
    { label: 'Forecast CI High', data: fpad(forecast.high), borderColor: 'rgba(255,184,0,0.2)', backgroundColor: 'rgba(255,184,0,0.08)', fill: '+1', borderWidth: 1, pointRadius: 0, tension: 0.2, order: 4 },
    { label: 'Forecast CI Low',  data: fpad(forecast.low),  borderColor: 'rgba(255,184,0,0.2)', backgroundColor: 'transparent', borderWidth: 1, pointRadius: 0, tension: 0.2, order: 4 },
    { label: 'Forecast (Trend)', data: fpad(forecast.median), borderColor: '#FFB800', backgroundColor: 'transparent', borderWidth: 2, borderDash: [6,3], pointRadius: 4, pointHoverRadius: 6, pointBackgroundColor: '#FFB800', tension: 0.2, order: 2 },
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
          displayColors: true, usePointStyle: true,
          callbacks: {
            title: items => {
              if (!items.length) return '';
              const idx = items[0].dataIndex;
              const isForecast = idx >= n;
              return `${fullLabels[idx]}${isForecast ? '  ·  forecast' : ''}`;
            },
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
// FRESHNESS INDICATOR  ("last updated X ago")
// ═══════════════════════════════════════════════════════════════════

function updateFreshness() {
  const el = document.getElementById('freshness');
  if (!el) return;
  if (!state.lastUpdated) { el.textContent = ''; return; }
  const secs = Math.round((Date.now() - state.lastUpdated) / 1000);
  let txt;
  if (secs < 5)        txt = 'Updated just now';
  else if (secs < 60)  txt = `Updated ${secs}s ago`;
  else {
    const mins = Math.floor(secs / 60);
    txt = `Updated ${mins}m ${secs % 60}s ago`;
  }
  el.innerHTML = `<span class="fresh-dot"></span>${txt}`;
  el.className = 'freshness' + (secs > 120 ? ' stale' : '');
}

// ═══════════════════════════════════════════════════════════════════
// VOLATILITY ALERT SYSTEM
// ═══════════════════════════════════════════════════════════════════

const SENSITIVITY_CFG = {
  conservative: { rsiLo: 20, rsiHi: 80, changeAbs: 10, bbWidth: 20, hint: 'RSI < 20 or > 80 · price ±10% in 24h · BB width > 20%' },
  moderate:     { rsiLo: 30, rsiHi: 70, changeAbs: 5,  bbWidth: 12, hint: 'RSI < 30 or > 70 · price ±5% in 24h · BB width > 12%' },
  sensitive:    { rsiLo: 35, rsiHi: 65, changeAbs: 3,  bbWidth: 8,  hint: 'RSI < 35 or > 65 · price ±3% in 24h · BB width > 8%' },
};

function getAlertSettings() {
  return state.alertSettings;
}

function persistAlertSettings(s) {
  state.alertSettings = s;
  localStorage.setItem('cryptoAlertSettings', JSON.stringify(s));
  if (_db && state.user) {
    _db.collection('users').doc(state.user.uid).collection('data').doc('settings')
      .set(s).catch(e => console.warn('Firestore write:', e.message));
  }
}

function isOnCooldown(coinId) {
  const last = parseInt(localStorage.getItem(`alertCD_${coinId}`) || '0');
  return Date.now() - last < 2 * 60 * 60 * 1000;
}
function setCooldown(coinId) {
  localStorage.setItem(`alertCD_${coinId}`, String(Date.now()));
}

// Daily send-count tracking — resets automatically each calendar day.
function _alertDayKey() {
  const d = new Date();
  return `alertDay_${d.getFullYear()}_${d.getMonth()}_${d.getDate()}`;
}
function _alertDailyCount() {
  return parseInt(localStorage.getItem(_alertDayKey()) || '0');
}
function _alertDailyBump() {
  const k = _alertDayKey();
  localStorage.setItem(k, String(parseInt(localStorage.getItem(k) || '0') + 1));
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
  if (_alertDailyCount() >= 5) return;
  try {
    await emailjs.send(EJS_SERVICE_ID, EJS_TEMPLATE_ID, {
      to_email:      s.email,
      coin_name:     coinName,
      current_price: '$' + price.toLocaleString('en-US', { maximumFractionDigits: 2 }),
      alert_reasons: reasons.map((r, i) => `${i + 1}. ${r}`).join('\n'),
      alert_time:    new Date().toLocaleString(),
    }, EJS_PUBLIC_KEY);
    if (coinId !== '_test') setCooldown(coinId);
    _alertDailyBump();
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
      await new Promise(r => setTimeout(r, 1200));
    }
  }, 5 * 60 * 1000);
}

// ─── Alert UI helpers ───

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
  const email   = document.getElementById('alertEmail').value.trim();
  const enabled = document.getElementById('alertEnabled').checked;
  const consent = document.getElementById('gdprConsent')?.checked;

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showAlertStatus('Please enter a valid email address.', 'error'); return;
  }
  // GDPR: require explicit consent before storing an email address
  if (email && !consent) {
    showAlertStatus('Please tick the consent box before we store your email address.', 'error'); return;
  }
  const s = {
    enabled,
    email,
    consent: !!consent,
    consentAt: consent ? new Date().toISOString() : null,
    sensitivity: document.querySelector('.thresh-btn.active')?.dataset?.t || 'moderate',
    watchCoins:  [...document.querySelectorAll('.watch-coin-cb:checked')].map(c => c.value),
  };
  persistAlertSettings(s);
  showAlertStatus('Saved. Monitoring ' + s.watchCoins.length + ' coin(s) every 5 minutes.', 'success');
}

async function testAlert() {
  const email   = document.getElementById('alertEmail').value.trim();
  const consent = document.getElementById('gdprConsent')?.checked;
  if (!email) { showAlertStatus('Enter your email address first.', 'error'); return; }
  if (!consent) { showAlertStatus('Please tick the consent box before we send to your email.', 'error'); return; }
  saveAlerts();
  const s = getAlertSettings();
  if (!s.email) return;
  await sendVolatilityEmail(s, 'Bitcoin (BTC) — TEST', 65000, ['This is a test alert. Your email setup is working correctly!'], '_test');
}

function forgetAlertData() {
  state.alertSettings = {};
  localStorage.removeItem('cryptoAlertSettings');
  if (_db && state.user) {
    _db.collection('users').doc(state.user.uid).collection('data').doc('settings')
      .delete().catch(() => {});
  }
  document.getElementById('alertEmail').value = '';
  document.getElementById('alertEnabled').checked = false;
  const cb = document.getElementById('gdprConsent');
  if (cb) cb.checked = false;
  showAlertStatus('Your stored email and alert settings have been deleted.', 'success');
}

function initAlertUI() {
  const s = getAlertSettings();
  const container = document.getElementById('watchCoins');
  if (container) {
    container.innerHTML = '';
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
  const cb = document.getElementById('gdprConsent');
  if (cb && s.consent) cb.checked = true;
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

function showLoadError(coinId, days, message) {
  const wrap = document.querySelector('.chart-wrap');
  const loader = document.getElementById('chartLoader');
  if (loader) loader.classList.remove('visible');
  let banner = document.getElementById('loadErrorBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'loadErrorBanner';
    banner.className = 'load-error';
    wrap.appendChild(banner);
  }
  banner.innerHTML = `
    <div class="le-icon">!</div>
    <div class="le-text">${message}</div>
    <button class="le-retry" id="loadRetryBtn">Retry</button>`;
  banner.style.display = 'flex';
  document.getElementById('loadRetryBtn').onclick = () => loadCoin(coinId, days);
}

function clearLoadError() {
  const banner = document.getElementById('loadErrorBanner');
  if (banner) banner.style.display = 'none';
}

async function loadCoin(coinId, days) {
  const loader = document.getElementById('chartLoader');
  clearLoadError();
  loader.classList.add('visible');
  try {
    const { dates, prices, volumes } = await fetchHistory(coinId, days);
    state.prices = prices; state.dates = dates; state.volumes = volumes;
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

    renderCalcAdvTech(prices, volumes);

    const horizon  = parseInt(document.getElementById('horizon').value) || 7;
    const forecast = holtForecast(prices, horizon);
    buildChart(dates, prices, bb, forecast, days, horizon);
    runDeepVolatilityCheck(coinId, prices, rsiArr, bb);

    // Freshness indicator
    state.lastUpdated = Date.now();
    updateFreshness();

    // Auto-fill entry price with live price (unless the user typed their own)
    const entryEl = document.getElementById('entryPrice');
    if (entryEl && !entryEl.dataset.userSet) entryEl.value = curr.toFixed(2);

    loadSentiment(coinId).catch(e => console.warn('Sentiment:', e.message));

    // Auto-run the full analysis once on first successful load
    if (!state._autoRan) { state._autoRan = true; analyze(); }

  } catch (err) {
    const msg = err.message.includes('429')
      ? 'CoinGecko is rate-limiting free requests right now. Please wait ~60 seconds, then retry.'
      : `Couldn't load market data (${err.message}). Check your connection and retry.`;
    showLoadError(coinId, days, msg);
    return;
  }
  loader.classList.remove('visible');
}

// ═══════════════════════════════════════════════════════════════════
// ADVANCED TECHNICAL ANALYSIS (Calculator page)
// ═══════════════════════════════════════════════════════════════════

function renderCalcAdvTech(prices, volumes) {
  const body = document.getElementById('advTechBody');
  if (!body) return;
  if (!prices || prices.length < 20) {
    body.innerHTML = '<div class="hub-unavail">Not enough price history for advanced analysis.</div>';
    return;
  }

  const curr   = prices[prices.length - 1];
  const e20    = ema(prices, 20).slice(-1)[0];
  const e50    = ema(prices, 50).slice(-1)[0];
  const e200   = ema(prices, 200).slice(-1)[0];
  const atr    = calcATR(prices);
  const vwap   = calcVWAP(prices, volumes);
  const sr     = calcSupportResistance(prices);
  const trend  = calcTrendStrength(prices);

  const rsiArr = calcRSI(prices);
  const { macdLine, signalLine } = calcMACD(prices);
  const bb     = calcBollinger(prices);
  const techScore = calcHubTechScore(
    rsiArr.slice(-1)[0], macdLine.slice(-1)[0], signalLine.slice(-1)[0],
    curr, bb.upper.slice(-1)[0], bb.lower.slice(-1)[0], e20, e50, e200);

  const scoreColor = techScore.score >= 60 ? 'var(--green)' : techScore.score >= 45 ? 'var(--gold)' : 'var(--red)';
  const maRow = (label, val) => `<div class="adv-metric"><span class="adv-m-label">${label}</span><span class="adv-m-val ${curr > val ? 'green' : 'red'}">${fmtUSD(val)} <small>${curr > val ? '▲ above' : '▼ below'}</small></span></div>`;

  const srHtml = `
    <div class="adv-sr-grid">
      <div>
        <div class="adv-sr-head green">Support</div>
        ${sr.supports.length ? sr.supports.map(s => `<div class="adv-sr-lvl green">${fmtUSD(s)}</div>`).join('') : '<div class="adv-sr-lvl muted">—</div>'}
      </div>
      <div>
        <div class="adv-sr-head red">Resistance</div>
        ${sr.resistances.length ? sr.resistances.map(r => `<div class="adv-sr-lvl red">${fmtUSD(r)}</div>`).join('') : '<div class="adv-sr-lvl muted">—</div>'}
      </div>
    </div>`;

  body.innerHTML = `
    <div class="adv-score-row">
      <div class="adv-score-badge" style="border-color:${scoreColor};color:${scoreColor}">${techScore.score}<small>/100</small></div>
      <div class="adv-score-text">
        <div class="adv-score-title">Technical Score</div>
        <div class="adv-score-sub">${trend.direction} trend &middot; strength ${trend.strength}/100</div>
      </div>
    </div>
    <div class="adv-grid">
      ${maRow('EMA 20', e20)}
      ${maRow('EMA 50', e50)}
      ${maRow('EMA 200', e200)}
      <div class="adv-metric"><span class="adv-m-label">VWAP (14d)</span><span class="adv-m-val ${curr > vwap ? 'green' : 'red'}">${fmtUSD(vwap)}</span></div>
      <div class="adv-metric"><span class="adv-m-label">ATR (14)</span><span class="adv-m-val accent">${fmtUSD(atr)} <small>${(atr/curr*100).toFixed(2)}%</small></span></div>
      <div class="adv-metric"><span class="adv-m-label">Volatility</span><span class="adv-m-val ${(atr/curr*100) > 5 ? 'red' : (atr/curr*100) > 2.5 ? 'gold' : 'green'}">${(atr/curr*100) > 5 ? 'High' : (atr/curr*100) > 2.5 ? 'Moderate' : 'Low'}</span></div>
    </div>
    <div class="adv-divider"></div>
    ${srHtml}
    <div class="adv-divider"></div>
    <div class="adv-signals">${techScore.signals.map(s => `<span class="signal-pill-${s.c === 'green' ? 'bull' : s.c === 'red' ? 'bear' : 'neu'}">${s.k}: ${s.v}</span>`).join('')}</div>`;
}

// ═══════════════════════════════════════════════════════════════════
// ANALYZE
// ═══════════════════════════════════════════════════════════════════

async function analyze() {
  const btn = document.getElementById('analyzeBtn');
  btn.disabled = true; btn.textContent = 'Analyzing…';
  const coinId = document.getElementById('coinSelect').value;
  if (!state.prices || state.coin !== coinId) { state.coin = coinId; await loadCoin(coinId, state.days); }
  if (!state.prices) { btn.disabled = false; btn.textContent = 'Analyze Trade'; return; }
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
    hCls = 'green'; summaryEmoji = '▲';
    summary = 'Most indicators agree: conditions strongly favor the price going UP. This is a good environment for a Long trade, but always use a stop-loss.';
  } else if (score >= 1) {
    heading = 'Mild Bullish — Slight upward lean';
    hCls = 'yellow'; summaryEmoji = '↑';
    summary = 'Conditions lean upward, but signals are not strong. If trading Long, use a smaller position size and definitely set a stop-loss.';
  } else if (score <= -3) {
    heading = 'Strong Bearish — Good time to go Short';
    hCls = 'red'; summaryEmoji = '▼';
    summary = 'Most indicators agree: conditions strongly favor the price going DOWN. This is a good environment for a Short trade, but always use a stop-loss.';
  } else if (score <= -1) {
    heading = 'Mild Bearish — Slight downward lean';
    hCls = 'yellow'; summaryEmoji = '↓';
    summary = 'Conditions lean downward. Long trades carry higher risk right now. Consider waiting for a better entry or reducing your position size.';
  } else {
    heading = 'Neutral — No clear direction';
    hCls = 'neutral'; summaryEmoji = '—';
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
// COIN SELECTOR
// ═══════════════════════════════════════════════════════════════════

function selectCoin(coinId) {
  state.coin = coinId;
  document.getElementById('coinSelect').value = coinId;
  state._autoRan = false;
  loadCoin(coinId, state.days);
}

// ═══════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════

function init() {
  // Hydrate alert settings from localStorage so getAlertSettings() is sync from the start
  try { state.alertSettings = JSON.parse(localStorage.getItem('cryptoAlertSettings') || '{}'); }
  catch { state.alertSettings = {}; }

  // Show disclaimer banner on first visit
  if (!localStorage.getItem('disclaimerSeen')) {
    const banner = document.getElementById('disclaimerBanner');
    if (banner) banner.style.display = 'flex';
  }

  const sel = document.getElementById('coinSelect');
  Object.entries(COINS).forEach(([id, c]) => {
    const opt = document.createElement('option');
    opt.value = id; opt.textContent = c.name;
    sel.appendChild(opt);
  });
  sel.addEventListener('change', e => { state.coin = e.target.value; state._autoRan = false; loadCoin(e.target.value, state.days); });

  // Populate hub coin selector
  const hubSel = document.getElementById('hubCoinSelect');
  if (hubSel) {
    Object.entries(COINS).forEach(([id, c]) => {
      const opt = document.createElement('option');
      opt.value = id; opt.textContent = c.name;
      hubSel.appendChild(opt);
    });
    hubSel.addEventListener('change', e => { hubState.coinId = e.target.value; });
  }
  document.querySelectorAll('.tf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.days = parseInt(btn.dataset.days);
      loadCoin(state.coin, state.days);
    });
  });

  // Pre-populate defaults so the calculator is usable immediately
  document.getElementById('posSize').value = '1000';
  document.getElementById('leverage').value = '10';
  updateLeverage(10);

  loadCoin('bitcoin', 30);
  refreshTicker();
  setInterval(refreshTicker, 60_000);
  setInterval(updateFreshness, 1000); // tick the "updated X ago" label
  initAlertUI();
  startBackgroundAlertChecks();
  initFirebase();
}

// ═══════════════════════════════════════════════════════════════════
// FIREBASE AUTH + FIRESTORE
// ═══════════════════════════════════════════════════════════════════

async function initFirebase() {
  if (typeof firebase === 'undefined') return;
  if (!BACKEND_URL) {
    // Backend URL not configured — show a disabled sign-in button
    renderAuthUI(null, /* disabled */ true);
    return;
  }
  let config;
  try {
    const res = await fetch(`${BACKEND_URL}/firebase-config`);
    config = await res.json();
  } catch (e) {
    console.warn('Could not fetch Firebase config:', e.message);
    renderAuthUI(null, /* disabled */ true);
    return;
  }
  if (!config?.apiKey) {
    renderAuthUI(null, /* disabled */ true);
    return;
  }
  try {
    firebase.initializeApp(config);
    _auth = firebase.auth();
    _db   = firebase.firestore();

    renderAuthUI(null);

    _auth.onAuthStateChanged(async user => {
      state.user = user;
      renderAuthUI(user);
      if (user) {
        await loadUserSettingsFromFirestore(user.uid);
        // Re-populate alert UI with cloud settings
        const container = document.getElementById('watchCoins');
        if (container) container.innerHTML = '';
        initAlertUI();
        // Pre-fill email from Google profile if the field is empty
        const emailEl = document.getElementById('alertEmail');
        if (emailEl && !emailEl.value && user.email) emailEl.value = user.email;
        showAlertStatus('Signed in — settings loaded from cloud.', 'success');
      }
    });
  } catch (e) {
    console.warn('Firebase init failed:', e.message);
  }
}

async function loadUserSettingsFromFirestore(uid) {
  if (!_db) return;
  try {
    const doc = await _db.collection('users').doc(uid).collection('data').doc('settings').get();
    if (doc.exists) {
      state.alertSettings = doc.data();
      localStorage.setItem('cryptoAlertSettings', JSON.stringify(state.alertSettings));
    }
  } catch (e) {
    console.warn('Firestore read failed, using localStorage:', e.message);
  }
}

async function signInWithGoogle() {
  if (!_auth) {
    alert('Firebase is not configured yet. Fill in FIREBASE_CONFIG in app.js first.');
    return;
  }
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    await _auth.signInWithPopup(provider);
  } catch (e) {
    if (e.code !== 'auth/popup-closed-by-user') {
      showAlertStatus('Sign-in failed: ' + (e.message || e.code), 'error');
    }
  }
}

async function signOutUser() {
  if (!_auth) return;
  await _auth.signOut();
  state.user = null;
  renderAuthUI(null);
  showAlertStatus('Signed out. Settings are still saved locally on this device.', 'success');
}

function renderAuthUI(user, disabled = false) {
  const bar = document.getElementById('authBar');
  if (!bar) return;

  if (user) {
    const avatar = user.photoURL
      ? `<img class="user-avatar" src="${user.photoURL}" alt="" referrerpolicy="no-referrer">`
      : `<span class="user-avatar-placeholder">${(user.displayName || user.email || '?')[0].toUpperCase()}</span>`;
    bar.innerHTML = `
      <div class="user-pill">
        ${avatar}
        <span class="user-name">${user.displayName || user.email}</span>
        <button class="btn-signout" onclick="signOutUser()">Sign out</button>
      </div>`;
  } else {
    bar.innerHTML = `
      <button class="btn-google-signin" onclick="signInWithGoogle()" ${disabled ? 'disabled title="Add your Firebase config to enable login"' : ''}>
        <svg width="16" height="16" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
          <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.19 3.23l6.85-6.85C35.9 2.38 30.28 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.08 17.74 9.5 24 9.5z"/>
          <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
          <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
          <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-3.59-13.46-8.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
        </svg>
        Sign in with Google
      </button>`;
  }
}

function dismissDisclaimer() {
  localStorage.setItem('disclaimerSeen', '1');
  const banner = document.getElementById('disclaimerBanner');
  if (banner) banner.style.display = 'none';
}

document.addEventListener('DOMContentLoaded', init);

// ═══════════════════════════════════════════════════════════════════
// DASHBOARD — AI PORTFOLIO PLANNER
// ═══════════════════════════════════════════════════════════════════

function switchTab(tab) {
  const isCalc = tab === 'calc';
  const isDash = tab === 'dash';
  const isHub  = tab === 'hub';
  document.getElementById('calcView').style.display = isCalc ? '' : 'none';
  document.getElementById('dashView').style.display = isDash ? '' : 'none';
  document.getElementById('hubView').style.display  = isHub  ? '' : 'none';
  document.getElementById('tabCalc').classList.toggle('active', isCalc);
  document.getElementById('tabDash').classList.toggle('active', isDash);
  document.getElementById('tabHub').classList.toggle('active',  isHub);
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

// ═══════════════════════════════════════════════════════════════════
// INTELLIGENCE HUB — Complete AI Analysis System
// ═══════════════════════════════════════════════════════════════════

// ── Hub State ──────────────────────────────────────────────────────
const hubState = {
  coinId: 'bitcoin',
  prices: null,
  volumes: null,
  dates: null,
  futures: null,
  tokenomics: null,
  onchain: null,
  news: null,
  analysis: null,
};

// ── Cache TTLs ─────────────────────────────────────────────────────
const HUB_CACHE = {};
function hubCacheGet(key, ttl) {
  const hit = HUB_CACHE[key];
  if (hit && Date.now() - hit.ts < ttl) return hit.data;
  return null;
}
function hubCacheSet(key, data) {
  HUB_CACHE[key] = { data, ts: Date.now() };
}

// ── New Technical Indicators ───────────────────────────────────────

function calcATR(prices, period = 14) {
  if (prices.length < 2) return 0;
  const changes = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(Math.abs(prices[i] - prices[i - 1]));
  }
  if (changes.length === 0) return 0;
  // Smooth with EMA
  const smoothed = ema(changes, period);
  return smoothed[smoothed.length - 1] || 0;
}

function calcVWAP(prices, volumes, period = 14) {
  const n = Math.min(period, prices.length, volumes ? volumes.length : prices.length);
  if (n === 0) return prices[prices.length - 1] || 0;
  const pSlice = prices.slice(-n);
  const vSlice = volumes ? volumes.slice(-n) : new Array(n).fill(1);
  let totalPV = 0, totalV = 0;
  for (let i = 0; i < n; i++) {
    totalPV += pSlice[i] * vSlice[i];
    totalV  += vSlice[i];
  }
  return totalV > 0 ? totalPV / totalV : pSlice[pSlice.length - 1];
}

function calcSupportResistance(prices, lookback = 30) {
  const slice = prices.slice(-Math.min(lookback, prices.length));
  const locals = [];
  for (let i = 1; i < slice.length - 1; i++) {
    if (slice[i] < slice[i - 1] && slice[i] < slice[i + 1]) locals.push({ type: 'S', price: slice[i] });
    if (slice[i] > slice[i - 1] && slice[i] > slice[i + 1]) locals.push({ type: 'R', price: slice[i] });
  }
  // Cluster within 2%
  function cluster(arr) {
    const groups = [];
    for (const pt of arr) {
      const grp = groups.find(g => Math.abs(g.avg - pt.price) / g.avg < 0.02);
      if (grp) { grp.sum += pt.price; grp.count++; grp.avg = grp.sum / grp.count; }
      else groups.push({ sum: pt.price, count: 1, avg: pt.price });
    }
    return groups.sort((a, b) => b.count - a.count).slice(0, 3).map(g => g.avg);
  }
  const supports    = cluster(locals.filter(l => l.type === 'S').sort((a, b) => b.price - a.price));
  const resistances = cluster(locals.filter(l => l.type === 'R').sort((a, b) => a.price - b.price));
  return { supports, resistances };
}

function calcTrendStrength(prices) {
  if (prices.length < 10) return { strength: 50, direction: 'Sideways' };
  const recent = prices.slice(-20);
  const n = recent.length;
  const mid = recent[Math.floor(n / 2)];
  const last = recent[n - 1];
  const first = recent[0];
  const momentum = (last - first) / first * 100;
  const strength = Math.min(100, Math.max(0, Math.abs(momentum) * 5));
  const direction = momentum > 3 ? 'Bullish' : momentum < -3 ? 'Bearish' : 'Sideways';
  return { strength: Math.round(strength), direction };
}

function calcHubTechScore(rsi, macdVal, sigVal, curr, bbU, bbL, ema20, ema50, ema200) {
  let score = 50;
  const signals = [];

  // RSI (±15)
  if (rsi < 30)       { score += 15; signals.push({ k: 'RSI', v: rsi.toFixed(1), c: 'green' }); }
  else if (rsi < 45)  { score += 8;  signals.push({ k: 'RSI', v: rsi.toFixed(1), c: 'green' }); }
  else if (rsi > 70)  { score -= 15; signals.push({ k: 'RSI', v: rsi.toFixed(1), c: 'red' }); }
  else if (rsi > 55)  { score -= 8;  signals.push({ k: 'RSI', v: rsi.toFixed(1), c: 'red' }); }
  else                  signals.push({ k: 'RSI', v: rsi.toFixed(1), c: 'neutral' });

  // MACD (±10)
  if (macdVal > sigVal)  { score += 10; signals.push({ k: 'MACD', v: 'Bull cross', c: 'green' }); }
  else                   { score -= 10; signals.push({ k: 'MACD', v: 'Bear cross', c: 'red' }); }

  // Bollinger (±10)
  if (bbL && bbU) {
    if (curr < bbL)       { score += 10; signals.push({ k: 'Bollinger', v: 'Below lower', c: 'green' }); }
    else if (curr > bbU)  { score -= 10; signals.push({ k: 'Bollinger', v: 'Above upper', c: 'red' }); }
    else                    signals.push({ k: 'Bollinger', v: 'Mid-band', c: 'neutral' });
  }

  // EMA trend (±5 each)
  if (ema20 && ema50) {
    if (curr > ema20 && curr > ema50) { score += 5; signals.push({ k: 'EMA 20/50', v: 'Price above', c: 'green' }); }
    else if (curr < ema20 && curr < ema50) { score -= 5; signals.push({ k: 'EMA 20/50', v: 'Price below', c: 'red' }); }
    else signals.push({ k: 'EMA 20/50', v: 'Mixed', c: 'neutral' });
  }
  if (ema200) {
    if (curr > ema200) { score += 5; signals.push({ k: 'EMA 200', v: 'Above (bull)', c: 'green' }); }
    else               { score -= 5; signals.push({ k: 'EMA 200', v: 'Below (bear)', c: 'red' }); }
  }

  score = Math.min(100, Math.max(0, Math.round(score)));
  return { score, signals, raw: { rsi, macdVal, sigVal, curr, bbU, bbL, ema20, ema50, ema200 } };
}

// ── Narrative Detection ────────────────────────────────────────────

const NARRATIVES = {
  'AI Coins':       { coinIds: [], keywords: ['ai', 'artificial intelligence', 'machine learning', 'neural', 'llm', 'gpt'] },
  'DeFi':           { coinIds: ['uniswap', 'cosmos'], keywords: ['defi', 'decentralized finance', 'yield', 'liquidity', 'protocol', 'swap', 'amm'] },
  'Layer 1':        { coinIds: ['bitcoin', 'ethereum', 'solana', 'cardano', 'avalanche-2', 'cosmos'], keywords: ['layer 1', 'l1', 'blockchain', 'consensus', 'proof of stake', 'proof of work'] },
  'Layer 2':        { coinIds: ['matic-network'], keywords: ['layer 2', 'l2', 'scaling', 'rollup', 'zk', 'optimistic', 'sidechain'] },
  'Memecoins':      { coinIds: ['dogecoin'], keywords: ['meme', 'viral', 'community', 'dog', 'moon', 'doge', 'shib'] },
  'DePIN':          { coinIds: ['filecoin'], keywords: ['depin', 'physical infrastructure', 'storage', 'data', 'mining', 'fil'] },
  'Gaming / NFT':   { coinIds: [], keywords: ['gaming', 'gamefi', 'nft', 'metaverse', 'play-to-earn', 'web3 game'] },
  'RWA':            { coinIds: [], keywords: ['rwa', 'real world assets', 'tokenization', 'real estate', 'bonds', 'tokenized'] },
};

function detectNarratives(coinId, newsItems) {
  const results = [];
  const titleText = (newsItems || []).map(n => (n.title || '').toLowerCase()).join(' ');

  for (const [name, cfg] of Object.entries(NARRATIVES)) {
    let score = 0;
    if (cfg.coinIds.includes(coinId)) score += 30;
    for (const kw of cfg.keywords) {
      if (titleText.includes(kw)) score += 15;
    }
    if (score > 0) results.push({ name, score: Math.min(100, score) });
  }
  return results.sort((a, b) => b.score - a.score);
}

// ═══════════════════════════════════════════════════════════════════
// CLIENT-SIDE DATA (no backend needed — direct public APIs)
// These make the Intelligence Hub work even when the Render proxy is
// asleep or down. The backend remains an optional fallback.
// ═══════════════════════════════════════════════════════════════════

// Coin → OKX perpetual swap instId (public API, CORS-enabled, no geo-block)
const OKX_INST = {
  bitcoin: 'BTC-USDT-SWAP', ethereum: 'ETH-USDT-SWAP', binancecoin: 'BNB-USDT-SWAP',
  solana: 'SOL-USDT-SWAP', ripple: 'XRP-USDT-SWAP', cardano: 'ADA-USDT-SWAP',
  'avalanche-2': 'AVAX-USDT-SWAP', dogecoin: 'DOGE-USDT-SWAP', polkadot: 'DOT-USDT-SWAP',
  'matic-network': 'MATIC-USDT-SWAP', chainlink: 'LINK-USDT-SWAP', uniswap: 'UNI-USDT-SWAP',
  litecoin: 'LTC-USDT-SWAP', cosmos: 'ATOM-USDT-SWAP', filecoin: 'FIL-USDT-SWAP',
};

// Fetch futures intelligence straight from OKX in the browser.
async function fetchFuturesDirect(coinId) {
  const inst = OKX_INST[coinId];
  if (!inst) throw new Error('No futures market for this coin');
  const OKX = 'https://www.okx.com';
  const sf = (v, d = 0) => { const n = parseFloat(v); return isFinite(n) ? n : d; };
  const get = async (url) => {
    const r = await fetch(url);
    if (!r.ok) return null;
    const b = await r.json();
    return b.code === '0' ? (b.data || []) : null;
  };

  const [tk, fr, oi, ls] = await Promise.all([
    get(`${OKX}/api/v5/market/ticker?instId=${inst}`),
    get(`${OKX}/api/v5/public/funding-rate?instId=${inst}`),
    get(`${OKX}/api/v5/public/open-interest?instType=SWAP&instId=${inst}`),
    get(`${OKX}/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${inst.split('-')[0]}&period=5m&limit=1`).catch(() => null),
  ]);

  if (!tk || !tk[0]) throw new Error('OKX ticker unavailable');
  const t = tk[0], f = (fr && fr[0]) || {}, o = (oi && oi[0]) || {};

  // rubik long-short-account-ratio returns rows of [ts, ratio]
  let lsRatio = 1;
  if (ls && ls[0]) lsRatio = sf(Array.isArray(ls[0]) ? ls[0][1] : ls[0].longShortRatio, 1) || 1;

  const last     = sf(t.last);
  const vol      = sf(t.volCcy24h);
  const open24   = sf(t.open24h);
  const priceChg = open24 ? (last - open24) / open24 * 100 : 0;
  const funding  = sf(f.fundingRate);
  const oiUsd    = o.oiUsd ? sf(o.oiUsd) : sf(o.oiCcy) * last;
  const longPct  = lsRatio ? Math.round(lsRatio / (1 + lsRatio) * 100) : 50;
  const frPct    = funding * 100;
  const longSqueeze  = Math.round(Math.min(100, Math.max(0, (lsRatio - 1) * 40 + Math.max(0,  frPct) * 50)));
  const shortSqueeze = Math.round(Math.min(100, Math.max(0, (1 - lsRatio) * 40 + Math.max(0, -frPct) * 50)));
  const bias = (lsRatio > 1.1 && funding > 0) ? 'Bullish'
             : (lsRatio < 0.9 && funding < 0) ? 'Bearish' : 'Neutral';

  return {
    coin_id: coinId, source: 'OKX', open_interest: Math.round(oiUsd),
    funding_rate: funding, ls_ratio: +lsRatio.toFixed(3), long_pct: longPct,
    short_pct: 100 - longPct, volume_24h: Math.round(vol),
    price_change_pct: +priceChg.toFixed(2), long_squeeze_risk: longSqueeze,
    short_squeeze_risk: shortSqueeze, market_bias: bias,
  };
}

// Single CoinGecko call with everything we need (cached 10 min).
async function fetchCoinFull(coinId) {
  const url = `${BASE}/coins/${coinId}?localization=false&tickers=false&market_data=true&community_data=true&developer_data=true`;
  return apiFetch(url, `coinfull-${coinId}`, 600_000);
}

function deriveTokenomics(coinId, data) {
  const md = data.market_data || {};
  const market_cap = md.market_cap?.usd || 0;
  const fdv  = md.fully_diluted_valuation?.usd || 0;
  const circ = md.circulating_supply || 0;
  const total = md.total_supply || circ || 1;
  const max   = md.max_supply || total || 1;
  const circulation_ratio = max > 0 ? circ / max : 1;
  const fdv_mc_ratio = market_cap > 0 ? fdv / market_cap : 1;
  const ath_chg = md.ath_change_percentage?.usd || 0;
  let score = 70;
  if (fdv_mc_ratio > 5) score -= 25; else if (fdv_mc_ratio > 3) score -= 15; else if (fdv_mc_ratio > 2) score -= 8;
  if (circulation_ratio < 0.3) score -= 15; else if (circulation_ratio < 0.5) score -= 8;
  if ((md.price_change_percentage_1y || 0) < -50) score -= 10;
  score = Math.max(0, Math.min(100, score));
  return {
    coin_id: coinId, market_cap, fdv, circulating_supply: circ, total_supply: total,
    max_supply: max, circulation_ratio: +circulation_ratio.toFixed(4),
    fdv_mc_ratio: +fdv_mc_ratio.toFixed(4), ath_change_percentage: +ath_chg.toFixed(2),
    tokenomics_score: score,
  };
}

async function deriveOnchain(coinId, data) {
  const dev = data.developer_data || {}, comm = data.community_data || {}, md = data.market_data || {};
  const github = dev.commit_count_4_weeks || 0;
  const reddit = comm.reddit_active_accounts_48h || 0;
  const market_cap = md.market_cap?.usd || 1;
  const volume = md.total_volume?.usd || 0;
  const vmc = market_cap > 0 ? volume / market_cap : 0;
  let acc = 50, dist = 50;
  if (github > 100) acc += 15; else if (github > 30) acc += 8;
  if (reddit > 5000) acc += 10; else if (reddit > 1000) acc += 5;
  if (vmc > 0.15) { acc -= 10; dist += 15; } else if (vmc > 0.05) dist += 5;
  acc = Math.max(0, Math.min(100, acc)); dist = Math.max(0, Math.min(100, dist));

  let btcTx = null, btcHash = null;
  if (coinId === 'bitcoin') {
    try {
      const [tx, hr] = await Promise.all([
        fetch('https://blockchain.info/q/24hrtransactioncount?cors=true').then(r => r.ok ? r.text() : null),
        fetch('https://blockchain.info/q/hashrate?cors=true').then(r => r.ok ? r.text() : null),
      ]);
      if (tx) btcTx = parseInt(tx.trim());
      if (hr) btcHash = parseFloat(hr.trim()) * 1e9;
    } catch (e) { /* CORS or network — skip */ }
  }

  return {
    coin_id: coinId, github_commits_4w: github, reddit_active_48h: reddit,
    volume_mc_ratio: +vmc.toFixed(6), accumulation_score: acc, distribution_score: dist,
    btc_transactions_24h: btcTx, btc_hash_rate: btcHash,
  };
}

// ── Client-side AI assistant knowledge base ────────────────────────
const CHAT_KB = {
  rsi: 'RSI (Relative Strength Index) measures momentum on a 0–100 scale. Below 30 = oversold (possible bounce), above 70 = overbought (possible pullback). Best combined with trend and volume.',
  macd: 'MACD shows momentum direction. MACD line crossing above its signal line is bullish; crossing below is bearish. The histogram shows the gap between them.',
  funding: 'Funding rate is the periodic payment between longs and shorts in perpetual futures. Positive = longs pay shorts (bullish crowding); negative = shorts pay longs (short-squeeze risk). Extreme positive rates often precede corrections.',
  ema: 'EMA (Exponential Moving Average) weights recent prices more. Key periods: 20 (short), 50 (medium), 200 (macro). Price above all EMAs = strong uptrend; EMA20 crossing EMA50 up = golden cross.',
  bollinger: 'Bollinger Bands = 20-period SMA ± 2 standard deviations. Touching the upper band = potentially overbought, lower band = oversold. A band squeeze often precedes a big breakout.',
  support: 'Support is a price area where buyers historically step in. Strong support comes from high-volume zones, prior swing lows, or moving averages. Breaking below often triggers more selling.',
  resistance: 'Resistance is where sellers historically emerge. Breaking above it on high volume is bullish; old resistance often becomes new support after a breakout.',
  liquidation: 'Liquidation occurs when a leveraged position can no longer meet margin. Large liquidation clusters act as price magnets, and cascades cause rapid spikes.',
  'open interest': 'Open Interest is the total value of outstanding futures contracts. Rising OI + rising price = bullish; rising OI + falling price = bearish; falling OI = positions unwinding.',
  'long squeeze': 'A long squeeze forces over-leveraged longs to close, cascading the price down. Signs: very high L/S ratio, high positive funding, high OI.',
  'short squeeze': 'A short squeeze forces shorts to cover, rallying the price in a feedback loop. Signs: very low L/S ratio, negative funding, high OI.',
  atr: 'ATR (Average True Range) measures volatility as the average range over N periods. Higher ATR = more volatility. Common rule: place stops 1.5–2× ATR from entry.',
  vwap: 'VWAP (Volume Weighted Average Price) is the volume-weighted average. Price above VWAP = bullish intraday bias; below = bearish. It acts as dynamic support/resistance.',
};

function localChatResponse(message, context) {
  const m = (message || '').toLowerCase();
  for (const [kw, ex] of Object.entries(CHAT_KB)) {
    if (m.includes(kw)) return ex;
  }
  const coin = context?.coinName || '';
  const price = context?.currentPrice;
  const analysis = context?.analysis;
  if (coin && (m.includes('price') || m.includes('worth') || m.includes('trading'))) {
    if (price) return `${coin} is currently around $${Number(price).toLocaleString('en-US', { maximumFractionDigits: 2 })}. Trend: ${analysis?.trend || 'unknown'}. Always use risk management.`;
    return `Run the analysis first and I'll have ${coin}'s live price and trend.`;
  }
  if (m.includes('signal') || m.includes('should i') || m.includes('buy') || m.includes('sell')) {
    if (analysis) return `For ${coin}: RSI ${analysis.rsi != null ? Number(analysis.rsi).toFixed(1) : 'n/a'}, MACD ${analysis.macd || 'n/a'}, trend ${analysis.trend || 'n/a'}. Educational only — not financial advice.`;
    return 'Run a full analysis on the Intelligence Hub first, then I can give coin-specific signals. Meanwhile, ask me about RSI, MACD, funding rates, support/resistance, and more.';
  }
  if (m.includes('hi') || m.includes('hello') || m.includes('hey')) {
    return 'Hi! Ask me about RSI, MACD, Bollinger Bands, funding rates, open interest, long/short squeezes, ATR, VWAP, or support & resistance — or run an analysis for coin-specific insight.';
  }
  return 'I can explain crypto trading concepts — try: RSI, MACD, Bollinger Bands, funding rates, open interest, long/short squeeze, ATR, VWAP, or support and resistance levels.';
}

// ── Hub Analysis Orchestrator ──────────────────────────────────────

// Recompute and render the master AI Trading Score from whatever data is in.
function renderHubMasterScore() {
  const techData = hubState.analysis;
  let masterScore = 50;
  const breakdown = [];
  if (techData) {
    masterScore = (masterScore + techData.techScore.score) / 2;
    breakdown.push({ label: 'Technical', score: techData.techScore.score });
  }
  if (hubState.futures) {
    const f = hubState.futures;
    const futScore = f.ls_ratio > 1.1 && f.funding_rate > 0
      ? Math.min(80, 50 + (f.ls_ratio - 1) * 30)
      : f.ls_ratio < 0.9 && f.funding_rate < 0
      ? Math.max(20, 50 - (1 - f.ls_ratio) * 30)
      : 50;
    masterScore = (masterScore + futScore) / 2;
    breakdown.push({ label: 'Futures', score: Math.round(futScore) });
  }
  masterScore = Math.min(100, Math.max(0, Math.round(masterScore)));
  breakdown.push({ label: 'Master', score: masterScore });
  renderTradingScore(masterScore, breakdown);
}

async function runHubAnalysis() {
  const btn = document.getElementById('hubAnalyzeBtn');
  const statusLbl = document.getElementById('hubStatusLabel');
  if (btn) { btn.disabled = true; btn.textContent = 'Analyzing…'; }
  if (statusLbl) statusLbl.textContent = 'Computing technicals…';
  wakeBackend();

  const coinId = document.getElementById('hubCoinSelect')?.value || 'bitcoin';
  hubState.coinId = coinId;

  // Reset cards to loading state
  ['hubTechCard','hubFuturesCard','hubSentHubCard','hubNewsCard',
   'hubNarrCard','hubTokCard','hubOnChainCard','hubRiskCard'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      const heading = el.querySelector('.card-heading');
      const headingHTML = heading ? heading.outerHTML : '';
      el.innerHTML = headingHTML + '<div class="hub-card-loader"><div class="spin"></div><span>Loading…</span></div>';
    }
  });

  // ── Phase 1: price history + technicals (fast, no slow backend) ──
  try {
    const hist = await fetchHistory(coinId, 90);
    hubState.prices  = hist.prices;
    hubState.volumes = hist.volumes;
    hubState.dates   = hist.dates;
  } catch (e) {
    if (statusLbl) statusLbl.textContent = `Could not load price data: ${e.message}`;
    if (btn) { btn.disabled = false; btn.textContent = '⚡ Run Full Analysis'; }
    return;
  }

  const prices  = hubState.prices  || [];
  const volumes = hubState.volumes || [];

  let techData = null;
  if (prices.length >= 20) {
    const rsiArr              = calcRSI(prices);
    const { macdLine, signalLine } = calcMACD(prices);
    const bb                  = calcBollinger(prices);
    const ema20Arr            = ema(prices, 20);
    const ema50Arr            = ema(prices, 50);
    const ema200Arr           = ema(prices, 200);
    const atr                 = calcATR(prices);
    const vwap                = calcVWAP(prices, volumes);
    const sr                  = calcSupportResistance(prices);
    const trend               = calcTrendStrength(prices);

    const curr    = prices[prices.length - 1];
    const rsiNow  = rsiArr[rsiArr.length - 1];
    const macdNow = macdLine[macdLine.length - 1];
    const sigNow  = signalLine[signalLine.length - 1];
    const bbU     = bb.upper[bb.upper.length - 1];
    const bbL     = bb.lower[bb.lower.length - 1];
    const bbM     = bb.mid[bb.mid.length - 1];
    const e20     = ema20Arr[ema20Arr.length - 1];
    const e50     = ema50Arr[ema50Arr.length - 1];
    const e200    = ema200Arr[ema200Arr.length - 1];

    const techScore = calcHubTechScore(rsiNow, macdNow, sigNow, curr, bbU, bbL, e20, e50, e200);
    techData = {
      curr, rsi: rsiNow, macd: macdNow, sig: sigNow,
      bbU, bbL, bbM, ema20: e20, ema50: e50, ema200: e200,
      atr, vwap, sr, trend, techScore, prices, volumes,
    };
  }
  hubState.analysis = techData;

  // Render everything that does NOT depend on the slow backend right away.
  renderHubMasterScore();
  if (techData) renderHubTechCard(techData);
  renderRiskCard(techData);
  renderHubSentCard({
    fg: state.sentiment?.fg,
    community: state.sentiment?.community,
    newsSentiment: state.sentiment?.newsSentiment,
  });
  // Narratives without news yet (category match); refreshed when news lands.
  renderNarrativeCard(detectNarratives(coinId, []), coinId);

  if (statusLbl) statusLbl.textContent = 'Loading live market data…';

  // ── Phase 2: live data direct from public APIs (backend = fallback) ──
  const backendOpts = { retries: 0, timeoutMs: 12_000 };

  // Futures: OKX directly in the browser; fall back to the Render proxy.
  const futuresP = fetchFuturesDirect(coinId)
    .catch(() => backendFetch(`${BACKEND_URL}/futures/${coinId}`, `hub-fut-${coinId}`, 60_000, backendOpts))
    .then(d => { hubState.futures = d; renderHubFuturesCard(d); renderHubMasterScore(); })
    .catch(() => { hubState.futures = null; renderHubFuturesCard(null); });

  // Tokenomics + on-chain: one CoinGecko call, derived locally.
  const coinFullP = fetchCoinFull(coinId);
  const tokP = coinFullP
    .then(d => deriveTokenomics(coinId, d))
    .catch(() => backendFetch(`${BACKEND_URL}/tokenomics/${coinId}`, `hub-tok-${coinId}`, 600_000, backendOpts))
    .then(d => { hubState.tokenomics = d; renderTokenomicsCard(d); })
    .catch(() => { hubState.tokenomics = null; renderTokenomicsCard(null); });

  const onchainP = coinFullP
    .then(d => deriveOnchain(coinId, d))
    .catch(() => backendFetch(`${BACKEND_URL}/onchain/${coinId}`, `hub-onchain-${coinId}`, 600_000, backendOpts))
    .then(d => { hubState.onchain = d; renderOnChainCard(d); })
    .catch(() => { hubState.onchain = null; renderOnChainCard(null); });

  const newsP = fetchCryptoNews()
    .then(d => {
      hubState.news = d;
      const processed = Array.isArray(d) ? d.slice(0, 6).map(n => ({ ...n, _sent: classifyHeadline(n.title || '') })) : [];
      renderNewsImpactCard(processed);
      renderNarrativeCard(detectNarratives(coinId, processed), coinId);
    })
    .catch(() => { hubState.news = null; renderNewsImpactCard([]); });

  await Promise.allSettled([futuresP, tokP, onchainP, newsP]);
  if (statusLbl) statusLbl.textContent = `Analysis complete for ${COINS[coinId]?.name || coinId}`;
  if (btn) { btn.disabled = false; btn.textContent = '⚡ Run Full Analysis'; }
}

// ── Render: Trading Score ──────────────────────────────────────────

function renderTradingScore(score, breakdown) {
  const card = document.getElementById('hubScoreCard');
  if (!card) return;

  let signal, sigClass;
  if (score >= 75)      { signal = 'Strong Buy';  sigClass = 'bull'; }
  else if (score >= 60) { signal = 'Buy';         sigClass = 'bull'; }
  else if (score >= 45) { signal = 'Neutral';     sigClass = 'neu'; }
  else if (score >= 30) { signal = 'Sell';        sigClass = 'bear'; }
  else                  { signal = 'Strong Sell'; sigClass = 'bear'; }

  const color = score >= 60 ? '#00E887' : score >= 45 ? '#FFB800' : '#FF3D3D';

  const barsHtml = breakdown.filter(b => b.label !== 'Master').map(b => `
    <div class="score-breakdown-row">
      <span class="score-bd-label">${b.label}</span>
      <div class="score-bd-track">
        <div class="score-bd-fill" style="width:${b.score}%;background:${b.score>=60?'#00E887':b.score>=45?'#FFB800':'#FF3D3D'}"></div>
      </div>
      <span class="score-bd-val">${b.score}</span>
    </div>`).join('');

  card.innerHTML = `
    <div class="hub-score-layout">
      <div class="score-ring-wrap">
        <div class="score-ring" style="--score-color:${color}">
          <div class="score-ring-inner">
            <div class="score-number" style="color:${color}">${score}</div>
            <div class="score-ring-label">/ 100</div>
          </div>
        </div>
        <div class="score-signal signal-pill-${sigClass}">${signal}</div>
      </div>
      <div class="score-breakdown">
        <div class="score-bd-title">Score Breakdown</div>
        ${barsHtml}
        <div class="score-note">AI Trading Score combines technical indicators, futures data, and market sentiment. Educational use only.</div>
      </div>
    </div>`;
}

// ── Render: Technical Analysis Card ───────────────────────────────

function renderHubTechCard(data) {
  const card = document.getElementById('hubTechCard');
  if (!card) return;
  const { curr, rsi, macd, sig, bbU, bbL, bbM, ema20, ema50, ema200, atr, vwap, sr, trend, techScore } = data;

  const bbW = bbM ? ((bbU - bbL) / bbM * 100).toFixed(1) : '—';
  const bbPos = bbL && bbU ? ((curr - bbL) / (bbU - bbL) * 100).toFixed(0) : 50;

  const srHtml = `
    <div class="hub-sr-row">
      <div>
        <div class="hub-sr-label green">Support Levels</div>
        ${sr.supports.length ? sr.supports.map(s => `<div class="hub-metric-row"><span>S</span><span class="green">${fmtUSD(s)}</span></div>`).join('') : '<div class="hub-metric-row"><span>—</span></div>'}
      </div>
      <div>
        <div class="hub-sr-label red">Resistance Levels</div>
        ${sr.resistances.length ? sr.resistances.map(r => `<div class="hub-metric-row"><span>R</span><span class="red">${fmtUSD(r)}</span></div>`).join('') : '<div class="hub-metric-row"><span>—</span></div>'}
      </div>
    </div>`;

  card.innerHTML = `
    <h3 class="card-heading">Technical Analysis <span class="heading-sub">— ${COINS[hubState.coinId]?.name || ''}</span></h3>
    <div class="hub-metric-row"><span>RSI (14)</span><span class="${rsi > 70 ? 'red' : rsi < 30 ? 'green' : 'accent'}">${rsi.toFixed(1)}</span></div>
    <div class="hub-metric-row"><span>MACD</span><span class="${macd > sig ? 'green' : 'red'}">${macd > sig ? 'Bullish Cross' : 'Bearish Cross'} (${macd.toFixed(4)})</span></div>
    <div class="hub-metric-row"><span>Bollinger Width</span><span class="accent">${bbW}%</span></div>
    <div class="hub-metric-row"><span>BB Position</span><span class="${parseInt(bbPos) > 80 ? 'red' : parseInt(bbPos) < 20 ? 'green' : 'neutral-text'}">${bbPos}% of channel</span></div>
    <div class="hub-metric-row"><span>EMA 20</span><span class="${curr > ema20 ? 'green' : 'red'}">${fmtUSD(ema20)} (price ${curr > ema20 ? 'above' : 'below'})</span></div>
    <div class="hub-metric-row"><span>EMA 50</span><span class="${curr > ema50 ? 'green' : 'red'}">${fmtUSD(ema50)}</span></div>
    <div class="hub-metric-row"><span>EMA 200</span><span class="${curr > ema200 ? 'green' : 'red'}">${fmtUSD(ema200)}</span></div>
    <div class="hub-metric-row"><span>ATR (14)</span><span class="accent">${fmtUSD(atr)} (${(atr/curr*100).toFixed(2)}%)</span></div>
    <div class="hub-metric-row"><span>VWAP (14d)</span><span class="${curr > vwap ? 'green' : 'red'}">${fmtUSD(vwap)}</span></div>
    <div class="hub-metric-row"><span>Trend</span><span class="${trend.direction === 'Bullish' ? 'green' : trend.direction === 'Bearish' ? 'red' : 'neutral-text'}">${trend.direction} (strength: ${trend.strength}/100)</span></div>
    <div class="hub-divider"></div>
    ${srHtml}
    <div class="hub-divider"></div>
    <div class="hub-metric-row"><span>Tech Score</span><span style="color:${techScore.score>=60?'#00E887':techScore.score>=45?'#FFB800':'#FF3D3D'};font-weight:700">${techScore.score}/100</span></div>
    <div class="hub-signals-list">${techScore.signals.map(s => `<span class="signal-pill-${s.c === 'green' ? 'bull' : s.c === 'red' ? 'bear' : 'neu'}">${s.k}: ${s.v}</span>`).join('')}</div>`;
}

// ── Render: Futures Intelligence Card ─────────────────────────────

function renderHubFuturesCard(futures) {
  const card = document.getElementById('hubFuturesCard');
  if (!card) return;

  if (!futures) {
    card.innerHTML = `<h3 class="card-heading">Futures Intelligence</h3>
      <div class="hub-unavail">Futures data unavailable — backend may be starting up. Try again in 30 seconds.</div>`;
    return;
  }

  const f = futures;
  const lsRatio = f.ls_ratio || 1;
  const longPct = Math.round((lsRatio / (1 + lsRatio)) * 100);
  const shortPct = 100 - longPct;
  const fundColor = f.funding_rate > 0 ? '#00E887' : f.funding_rate < 0 ? '#FF3D3D' : '#FFB800';
  const biasClass = f.market_bias === 'Bullish' ? 'green' : f.market_bias === 'Bearish' ? 'red' : 'neutral-text';

  card.innerHTML = `
    <h3 class="card-heading">Futures Intelligence <span class="heading-sub">— OKX Perpetuals</span></h3>
    <div class="hub-metric-row"><span>Open Interest</span><span class="accent">${f.open_interest ? '$' + (f.open_interest / 1e9).toFixed(2) + 'B' : '—'}</span></div>
    <div class="hub-metric-row"><span>Funding Rate</span><span style="color:${fundColor}">${f.funding_rate != null ? (f.funding_rate * 100).toFixed(4) + '%' : '—'}</span></div>
    <div class="hub-metric-row"><span>Market Bias</span><span class="${biasClass}">${f.market_bias || '—'}</span></div>
    <div class="hub-metric-row"><span>24h Volume</span><span class="accent">${f.volume_24h ? '$' + (f.volume_24h / 1e9).toFixed(2) + 'B' : '—'}</span></div>
    <div class="hub-metric-row"><span>Price Change 24h</span><span class="${f.price_change_pct >= 0 ? 'green' : 'red'}">${f.price_change_pct != null ? fmtPct(f.price_change_pct) : '—'}</span></div>
    <div class="hub-divider"></div>
    <div class="ls-bar-label">Long / Short Ratio <span class="accent">${lsRatio.toFixed(2)}</span></div>
    <div class="ls-bar">
      <div class="ls-bar-long" style="width:${longPct}%">${longPct}% Long</div>
      <div class="ls-bar-short" style="width:${shortPct}%">${shortPct}% Short</div>
    </div>
    <div class="hub-divider"></div>
    <div class="futures-metric">
      <div class="fm-label">Long Squeeze Risk</div>
      <div class="fm-bar-wrap"><div class="fm-bar red" style="width:${Math.min(100,f.long_squeeze_risk||0)}%"></div></div>
      <div class="fm-val red">${(f.long_squeeze_risk || 0).toFixed(0)}/100</div>
    </div>
    <div class="futures-metric">
      <div class="fm-label">Short Squeeze Risk</div>
      <div class="fm-bar-wrap"><div class="fm-bar green" style="width:${Math.min(100,f.short_squeeze_risk||0)}%"></div></div>
      <div class="fm-val green">${(f.short_squeeze_risk || 0).toFixed(0)}/100</div>
    </div>`;
}

// ── Render: Market Sentiment Card (Hub) ───────────────────────────

function renderHubSentCard(data) {
  const card = document.getElementById('hubSentHubCard');
  if (!card) return;

  const fgData = data?.fg;
  const commData = data?.community;
  const ns = data?.newsSentiment;

  let fgHtml = '<div class="hub-unavail">Fear &amp; Greed: run calculator first</div>';
  if (fgData?.length) {
    const cur = parseInt(fgData[0].value);
    const label = fgData[0].value_classification;
    const color = cur <= 44 ? '#FF3D3D' : cur <= 55 ? '#F7C948' : '#00E887';
    fgHtml = `
      <div class="hub-metric-row"><span>Fear &amp; Greed</span><span style="color:${color};font-weight:700">${cur} — ${label}</span></div>
      <div class="fg-bar-track" style="margin:6px 0">
        <div class="fg-bar-indicator" style="left:${cur}%"></div>
      </div>`;
  }

  let commHtml = '<div class="hub-metric-row"><span>Community</span><span class="neutral-text">No data</span></div>';
  if (commData?.up != null) {
    commHtml = `<div class="hub-metric-row"><span>Community Bull</span><span class="green">${commData.up.toFixed(1)}%</span></div>
      <div class="hub-metric-row"><span>Community Bear</span><span class="red">${commData.down.toFixed(1)}%</span></div>`;
  }

  let newsHtml = '<div class="hub-metric-row"><span>News Sentiment</span><span class="neutral-text">No data</span></div>';
  if (ns) {
    const pos = (ns.positive * 100).toFixed(0);
    const neg = (ns.negative * 100).toFixed(0);
    const cls = ns.positive > 0.5 ? 'green' : ns.negative > 0.5 ? 'red' : 'neutral-text';
    newsHtml = `<div class="hub-metric-row"><span>News Positive</span><span class="green">${pos}%</span></div>
      <div class="hub-metric-row"><span>News Negative</span><span class="red">${neg}%</span></div>
      <div class="hub-metric-row"><span>Overall</span><span class="${cls}">${ns.positive > 0.5 ? 'Positive' : ns.negative > 0.5 ? 'Negative' : 'Neutral'}</span></div>`;
  }

  card.innerHTML = `
    <h3 class="card-heading">Market Sentiment</h3>
    <div class="hub-sent-section-label">Fear &amp; Greed</div>
    ${fgHtml}
    <div class="hub-divider"></div>
    <div class="hub-sent-section-label">Community</div>
    ${commHtml}
    <div class="hub-divider"></div>
    <div class="hub-sent-section-label">News Analysis</div>
    ${newsHtml}
    <div class="hub-note">Run analysis on Calculator tab first to load sentiment data.</div>`;
}

// ── Render: News Impact Card ───────────────────────────────────────

function renderNewsImpactCard(newsItems) {
  const card = document.getElementById('hubNewsCard');
  if (!card) return;

  if (!newsItems || newsItems.length === 0) {
    card.innerHTML = `<h3 class="card-heading">News Impact</h3><div class="hub-unavail">No recent news available.</div>`;
    return;
  }

  const items = newsItems.slice(0, 6).map(item => {
    const sc = item._sent || classifyHeadline(item.title || '');
    const impactCls = sc === 'pos' ? 'green' : sc === 'neg' ? 'red' : 'neutral-text';
    const impactLabel = sc === 'pos' ? 'Bullish' : sc === 'neg' ? 'Bearish' : 'Neutral';
    const impactScore = sc === 'pos' ? Math.floor(Math.random() * 30 + 50) : sc === 'neg' ? Math.floor(Math.random() * 30 + 50) : Math.floor(Math.random() * 20 + 20);
    const title = (item.title || '').slice(0, 75) + ((item.title || '').length > 75 ? '…' : '');
    const href = item.url ? ` href="${item.url}" target="_blank" rel="noopener noreferrer"` : '';
    const time = formatTimeAgo(item.published_on || 0);
    return `<a class="hub-news-item"${href}>
      <div class="hub-news-top">
        <span class="hub-news-impact ${impactCls}">${impactLabel}</span>
        <span class="hub-news-source">${item.source || ''}</span>
        <span class="hub-news-time">${time}</span>
      </div>
      <div class="hub-news-title">${title}</div>
    </a>`;
  }).join('');

  card.innerHTML = `<h3 class="card-heading">News Impact <span class="heading-sub">— Last 3 days</span></h3>${items}`;
}

// ── Render: Narrative Detection Card ──────────────────────────────

function renderNarrativeCard(narratives, coinId) {
  const card = document.getElementById('hubNarrCard');
  if (!card) return;

  if (!narratives || narratives.length === 0) {
    card.innerHTML = `<h3 class="card-heading">Narrative Detection</h3><div class="hub-unavail">No active narratives detected for ${COINS[coinId]?.name || coinId}.</div>`;
    return;
  }

  const tagsHtml = narratives.map(n => {
    const intensity = n.score >= 70 ? 'hot' : n.score >= 40 ? 'warm' : 'cool';
    return `<span class="narrative-tag narrative-${intensity}">${n.name} <span class="narr-score">${n.score}</span></span>`;
  }).join('');

  const coinName = COINS[coinId]?.name || coinId;
  card.innerHTML = `
    <h3 class="card-heading">Narrative Detection <span class="heading-sub">— ${coinName}</span></h3>
    <div class="narrative-intro">Active narratives driving ${coinName} interest:</div>
    <div class="narrative-tags">${tagsHtml}</div>
    <div class="hub-note">Score reflects coin-category match + recent news coverage. Higher = stronger narrative momentum.</div>`;
}

// ── Render: Tokenomics Card ────────────────────────────────────────

function renderTokenomicsCard(data) {
  const card = document.getElementById('hubTokCard');
  if (!card) return;

  if (!data) {
    card.innerHTML = `<h3 class="card-heading">Tokenomics</h3><div class="hub-unavail">Tokenomics data unavailable.</div>`;
    return;
  }

  const mcap = data.market_cap ? '$' + (data.market_cap / 1e9).toFixed(2) + 'B' : '—';
  const fdv  = data.fdv        ? '$' + (data.fdv        / 1e9).toFixed(2) + 'B' : '—';
  const fdvMcRatio = data.fdv && data.market_cap ? (data.fdv / data.market_cap).toFixed(2) : '—';
  const circPct = data.circulation_ratio != null ? (data.circulation_ratio * 100).toFixed(1) + '%' : '—';
  const score = data.tokenomics_score ?? 50;
  const scoreColor = score >= 65 ? '#00E887' : score >= 45 ? '#FFB800' : '#FF3D3D';
  const athDist = data.ath_change_percentage != null ? data.ath_change_percentage.toFixed(1) + '%' : '—';
  const athColor = data.ath_change_percentage != null && data.ath_change_percentage > -20 ? '#00E887' : '#FF3D3D';

  card.innerHTML = `
    <h3 class="card-heading">Tokenomics <span class="heading-sub">— CoinGecko</span></h3>
    <div class="hub-metric-row"><span>Market Cap</span><span class="accent">${mcap}</span></div>
    <div class="hub-metric-row"><span>FDV</span><span class="neutral-text">${fdv}</span></div>
    <div class="hub-metric-row"><span>FDV / MC Ratio</span><span class="${parseFloat(fdvMcRatio) > 3 ? 'red' : parseFloat(fdvMcRatio) > 1.5 ? 'gold' : 'green'}">${fdvMcRatio}</span></div>
    <div class="hub-metric-row"><span>Circulating Supply</span><span class="accent">${circPct}</span></div>
    <div class="hub-metric-row"><span>From ATH</span><span style="color:${athColor}">${athDist}</span></div>
    <div class="hub-divider"></div>
    <div class="hub-sent-section-label">Tokenomics Score</div>
    <div class="tok-meter-wrap">
      <div class="tok-meter"><div class="tok-meter-fill" style="width:${score}%;background:${scoreColor}"></div></div>
      <span class="tok-score" style="color:${scoreColor}">${score}/100</span>
    </div>
    <div class="hub-note">${score >= 65 ? 'Healthy tokenomics — good supply distribution.' : score >= 45 ? 'Average tokenomics — some dilution risk.' : 'Weak tokenomics — high inflation or dilution risk.'}</div>`;
}

// ── Render: On-Chain Analytics Card ───────────────────────────────

function renderOnChainCard(data) {
  const card = document.getElementById('hubOnChainCard');
  if (!card) return;

  if (!data) {
    card.innerHTML = `<h3 class="card-heading">On-Chain Analytics</h3><div class="hub-unavail">On-chain data unavailable.</div>`;
    return;
  }

  const accScore = data.accumulation_score ?? 50;
  const distScore = data.distribution_score ?? 50;
  const accColor = accScore >= 60 ? '#00E887' : accScore >= 40 ? '#FFB800' : '#FF3D3D';
  const distColor = distScore >= 60 ? '#FF3D3D' : distScore >= 40 ? '#FFB800' : '#00E887';

  const githubHtml = data.github_commits_4w != null
    ? `<div class="hub-metric-row"><span>GitHub Commits (4w)</span><span class="accent">${data.github_commits_4w}</span></div>` : '';
  const redditHtml = data.reddit_active_48h != null
    ? `<div class="hub-metric-row"><span>Reddit Active 48h</span><span class="accent">${data.reddit_active_48h}</span></div>` : '';
  const txHtml = data.btc_transactions_24h != null
    ? `<div class="hub-metric-row"><span>BTC Transactions 24h</span><span class="accent">${(data.btc_transactions_24h / 1000).toFixed(1)}k</span></div>` : '';
  const hashHtml = data.btc_hash_rate != null
    ? `<div class="hub-metric-row"><span>BTC Hash Rate</span><span class="accent">${(data.btc_hash_rate / 1e18).toFixed(2)} EH/s</span></div>` : '';

  card.innerHTML = `
    <h3 class="card-heading">On-Chain Analytics</h3>
    <div class="onchain-scores-row">
      <div class="onchain-stat">
        <div class="os-label">Accumulation Score</div>
        <div class="os-val" style="color:${accColor}">${accScore}/100</div>
        <div class="os-bar-track"><div class="os-bar-fill" style="width:${accScore}%;background:${accColor}"></div></div>
      </div>
      <div class="onchain-stat">
        <div class="os-label">Distribution Score</div>
        <div class="os-val" style="color:${distColor}">${distScore}/100</div>
        <div class="os-bar-track"><div class="os-bar-fill" style="width:${distScore}%;background:${distColor}"></div></div>
      </div>
    </div>
    <div class="hub-divider"></div>
    ${githubHtml}${redditHtml}${txHtml}${hashHtml}
    <div class="hub-metric-row"><span>Volume/MC Ratio</span><span class="accent">${data.volume_mc_ratio != null ? data.volume_mc_ratio.toFixed(4) : '—'}</span></div>`;
}

// ── Render: Risk Dashboard Card ────────────────────────────────────

function renderRiskCard(techData) {
  const card = document.getElementById('hubRiskCard');
  if (!card) return;

  if (!techData) {
    card.innerHTML = `<h3 class="card-heading">Risk Dashboard</h3><div class="hub-unavail">Price data needed for risk analysis.</div>`;
    return;
  }

  const { curr, atr, prices } = techData;
  const volScore = Math.min(100, Math.round(atr / curr * 100 * 20));
  const slRecommended = curr - 1.5 * atr;
  const tpRecommended = curr + 2.0 * atr;
  const riskRating = volScore < 30 ? 'Low' : volScore < 60 ? 'Medium' : 'High';
  const riskColor  = riskRating === 'Low' ? '#00E887' : riskRating === 'Medium' ? '#FFB800' : '#FF3D3D';

  // Position sizing: risk 2% of portfolio per trade
  const posSize2pct = curr > 0 ? (1000 * 0.02 / (1.5 * atr / curr * 100) * 100).toFixed(0) : '—';

  card.innerHTML = `
    <h3 class="card-heading">Risk Dashboard</h3>
    <div class="hub-metric-row"><span>Current Price</span><span class="accent">${fmtUSD(curr)}</span></div>
    <div class="hub-metric-row"><span>ATR (Volatility)</span><span class="accent">${fmtUSD(atr)} (${(atr/curr*100).toFixed(2)}%/day)</span></div>
    <div class="hub-divider"></div>
    <div class="risk-meter-wrap">
      <div class="hub-sent-section-label">Volatility Score</div>
      <div class="risk-meter"><div class="risk-meter-fill" style="width:${volScore}%;background:${riskColor}"></div></div>
      <div class="hub-metric-row"><span>Risk Level</span><span style="color:${riskColor};font-weight:700">${riskRating} (${volScore}/100)</span></div>
    </div>
    <div class="hub-divider"></div>
    <div class="hub-metric-row"><span>Rec. Stop Loss</span><span class="red">${fmtUSD(slRecommended)} (1.5× ATR below)</span></div>
    <div class="hub-metric-row"><span>Rec. Take Profit</span><span class="green">${fmtUSD(tpRecommended)} (2× ATR above)</span></div>
    <div class="hub-metric-row"><span>Risk:Reward</span><span class="accent">1 : 1.33</span></div>
    <div class="hub-divider"></div>
    <div class="hub-metric-row"><span>Position Size (2% risk, $1k)</span><span class="accent">$${posSize2pct}</span></div>
    <div class="hub-note">Position sizing based on 2% portfolio risk rule. Adjust for your capital.</div>`;
}

// ── AI Chat ────────────────────────────────────────────────────────

function addChatMessage(text, isUser) {
  const container = document.getElementById('chatMessages');
  if (!container) return;
  const div = document.createElement('div');
  div.className = `chat-msg ${isUser ? 'user' : 'assistant'}`;
  div.innerHTML = `<div class="chat-bubble">${text}</div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

async function sendChat() {
  const input = document.getElementById('chatInput');
  if (!input) return;
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  addChatMessage(msg, true);

  // Loading indicator
  const loadId = 'chat-load-' + Date.now();
  const container = document.getElementById('chatMessages');
  if (container) {
    const loadDiv = document.createElement('div');
    loadDiv.className = 'chat-msg assistant';
    loadDiv.id = loadId;
    loadDiv.innerHTML = '<div class="chat-bubble"><div class="spin" style="width:14px;height:14px;border-width:2px;display:inline-block"></div></div>';
    container.appendChild(loadDiv);
    container.scrollTop = container.scrollHeight;
  }

  try {
    const context = {
      coin: hubState.coinId,
      coinName: COINS[hubState.coinId]?.name || hubState.coinId,
      currentPrice: hubState.prices ? hubState.prices[hubState.prices.length - 1] : null,
      analysis: hubState.analysis ? {
        rsi: hubState.analysis.rsi,
        macd: hubState.analysis.macd > hubState.analysis.sig ? 'Bullish' : 'Bearish',
        trend: hubState.analysis.trend?.direction,
      } : null,
    };

    // Always have an instant client-side answer ready.
    const local = localChatResponse(msg, context);
    let reply = local;
    // Optionally enhance with the backend LLM if it's reachable (short timeout).
    try {
      const data = await backendFetch(`${BACKEND_URL}/chat`, null, 0, {
        method: 'POST', body: { message: msg, context }, retries: 0, timeoutMs: 6_000,
      });
      reply = data.response || data.message || local;
    } catch (e) { /* backend down — use local KB answer */ }

    const loadEl = document.getElementById(loadId);
    if (loadEl) loadEl.remove();
    addChatMessage(reply, false);
  } catch (e) {
    const loadEl = document.getElementById(loadId);
    if (loadEl) loadEl.remove();
    addChatMessage(localChatResponse(msg, context), false);
  }
}

