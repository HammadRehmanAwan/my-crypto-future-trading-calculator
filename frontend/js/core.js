// @ts-check
// ═══════════════════════════════════════════════════════════════════
// FutureX core math — indicators, forecast and the futures calculator.
//
// Pure functions only (no DOM, no network) so they can be unit-tested in
// Node (tests/core.test.mjs) and type-checked with `tsc --checkJs`.
// Loaded as a classic <script> before app.js, so every function below is a
// global that app.js calls directly; in Node it is exported via module.exports.
// ═══════════════════════════════════════════════════════════════════

/** Maintenance-margin rate used for liquidation (0.5%, typical for majors). */
const FX_MMR = 0.005;
/** Default taker fee per side (0.05%). */
const FX_TAKER_FEE = 0.0005;

/**
 * Wilder RSI. Returns an array the same length as `prices`; entries before
 * the first full period are 50 (neutral).
 * @param {number[]} prices
 * @param {number} [period]
 * @returns {number[]}
 */
function calcRSI(prices, period = 14) {
  const rsi = new Array(prices.length).fill(50);
  if (prices.length <= period) return rsi;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = prices[i] - prices[i - 1];
    ag += Math.max(0, d); al += Math.max(0, -d);
  }
  ag /= period; al /= period;
  // Flat market (no gains, no losses) is neutral, not "overbought".
  const value = (/** @type {number} */ g, /** @type {number} */ l) =>
    g === 0 && l === 0 ? 50 : l === 0 ? 100 : 100 - 100 / (1 + g / l);
  rsi[period] = value(ag, al);
  for (let i = period + 1; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    ag = (ag * (period - 1) + Math.max(0, d)) / period;
    al = (al * (period - 1) + Math.max(0, -d)) / period;
    rsi[i] = value(ag, al);
  }
  return rsi;
}

/**
 * Exponential moving average seeded with the first value.
 * @param {number[]} prices
 * @param {number} period
 * @returns {number[]}
 */
function ema(prices, period) {
  if (!prices.length) return [];
  const k = 2 / (period + 1);
  const out = [prices[0]];
  for (let i = 1; i < prices.length; i++)
    out.push(prices[i] * k + out[i - 1] * (1 - k));
  return out;
}

/**
 * MACD line, signal line and histogram (null where the signal is undefined).
 * @param {number[]} prices
 * @param {number} [fast]
 * @param {number} [slow]
 * @param {number} [sig]
 * @returns {{ macdLine: number[], signalLine: (number|null)[], hist: (number|null)[] }}
 */
function calcMACD(prices, fast = 12, slow = 26, sig = 9) {
  const ef = ema(prices, fast);
  const es = ema(prices, slow);
  const macdLine = ef.map((v, i) => v - es[i]);
  const sigArr = ema(macdLine.slice(slow - 1), sig);
  /** @type {(number|null)[]} */
  const signalLine = [...new Array(Math.min(slow - 1, macdLine.length)).fill(null), ...sigArr];
  const hist = macdLine.map((v, i) => {
    const s = signalLine[i];
    return s != null ? v - s : null;
  });
  return { macdLine, signalLine, hist };
}

/**
 * Bollinger Bands (population standard deviation).
 * @param {number[]} prices
 * @param {number} [period]
 * @param {number} [mult]
 * @returns {{ upper: (number|null)[], mid: (number|null)[], lower: (number|null)[] }}
 */
function calcBollinger(prices, period = 20, mult = 2) {
  /** @type {(number|null)[]} */ const upper = [];
  /** @type {(number|null)[]} */ const mid = [];
  /** @type {(number|null)[]} */ const lower = [];
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) { upper.push(null); mid.push(null); lower.push(null); continue; }
    const sl = prices.slice(i - period + 1, i + 1);
    const m = sl.reduce((a, b) => a + b) / period;
    const sd = Math.sqrt(sl.reduce((a, b) => a + (b - m) ** 2, 0) / period);
    upper.push(m + mult * sd); mid.push(m); lower.push(m - mult * sd);
  }
  return { upper, mid, lower };
}

/**
 * Holt double-exponential smoothing forecast with a widening error band.
 * This is the statistical model the public accuracy page backtests
 * (scripts/backtest.py mirrors it exactly — keep the two in sync).
 * @param {number[]} prices
 * @param {number} [horizon]
 * @param {number} [alpha]
 * @param {number} [beta]
 * @returns {{ median: number[], low: number[], high: number[] }}
 */
function holtForecast(prices, horizon = 7, alpha = 0.35, beta = 0.08) {
  if (!prices.length) return { median: [], low: [], high: [] };
  let level = prices[0];
  let trend = prices.length > 1 ? prices[1] - prices[0] : 0;
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
  const avgRes = res.length ? res.reduce((a, b) => a + b, 0) / res.length : 0;
  const median = Array.from({ length: horizon }, (_, i) => level + trend * (i + 1));
  const low = median.map((v, i) => v - avgRes * Math.sqrt(i + 1) * 1.8);
  const high = median.map((v, i) => v + avgRes * Math.sqrt(i + 1) * 1.8);
  return { median, low, high };
}

/**
 * @typedef {Object} FuturesResult
 * @property {number} entry
 * @property {number} leverage
 * @property {number} size          Position notional in USD
 * @property {number} margin        Initial margin = size / leverage
 * @property {number} contracts     Size in coins
 * @property {number} liq           Estimated liquidation price
 * @property {number} liqDist       % distance from entry to liquidation
 * @property {'Long'|'Short'} dir
 * @property {number} totalFees     Open + close taker fees at the TP price (or entry×2 if no TP)
 * @property {number} fundingCost   Positive = you pay, negative = you receive
 * @property {number} [tp]
 * @property {number} [pnlTpGross]
 * @property {number} [pnlTp]       Net of fees and funding
 * @property {number} [roeTp]
 * @property {number} [sl]
 * @property {number} [pnlSlGross]
 * @property {number} [pnlSl]
 * @property {number} [roeSl]
 * @property {number} [rr]          Reward-to-risk ratio
 */

/**
 * Isolated-margin perpetual futures calculator.
 *
 * Liquidation uses the standard isolated-margin approximation
 *   long:  entry × (1 − 1/L + MMR)     short: entry × (1 + 1/L − MMR)
 * Fees are charged on the entry notional and on the exit notional at the
 * exit price. Funding is charged every 8 h (3×/day) on the entry notional;
 * a positive rate means longs pay and shorts receive.
 *
 * @param {number} entry
 * @param {number} leverage
 * @param {number} size            Position notional (USD)
 * @param {'Long'|'Short'} dir
 * @param {number|null|undefined} tp
 * @param {number|null|undefined} sl
 * @param {number} [fundingRate]   Per-8h rate as a fraction (0.0001 = 0.01%)
 * @param {number} [horizon]       Holding period in days
 * @param {number} [takerFee]      Per-side fee as a fraction
 * @returns {FuturesResult}
 */
function calcFutures(entry, leverage, size, dir, tp, sl, fundingRate = 0, horizon = 7, takerFee = FX_TAKER_FEE) {
  const margin = size / leverage;
  const contracts = size / entry;
  const fee = (/** @type {number} */ exitPx) => size * takerFee + contracts * exitPx * takerFee;
  const fundingPeriods = horizon * 3;
  const fundingCost = fundingRate * size * fundingPeriods * (dir === 'Long' ? 1 : -1);

  let liq, liqDist, pnlFn;
  if (dir === 'Long') {
    liq = entry * (1 - 1 / leverage + FX_MMR);
    liqDist = (entry - liq) / entry * 100;
    pnlFn = (/** @type {number} */ px) => contracts * (px - entry);
  } else {
    liq = entry * (1 + 1 / leverage - FX_MMR);
    liqDist = (liq - entry) / entry * 100;
    pnlFn = (/** @type {number} */ px) => contracts * (entry - px);
  }
  /** @type {FuturesResult} */
  const res = {
    entry, leverage, size, margin, contracts, liq, liqDist, dir,
    totalFees: fee(tp || entry), fundingCost,
  };
  if (tp) {
    const gross = pnlFn(tp);
    const net = gross - fee(tp) - fundingCost;
    res.tp = tp; res.pnlTpGross = gross; res.pnlTp = net; res.roeTp = net / margin * 100;
  }
  if (sl) {
    const gross = pnlFn(sl);
    const net = gross - fee(sl) - fundingCost;
    res.sl = sl; res.pnlSlGross = gross; res.pnlSl = net; res.roeSl = net / margin * 100;
  }
  if (tp && sl) res.rr = Math.abs(tp - entry) / Math.abs(sl - entry);
  return res;
}

/**
 * Average true range approximated from closes (EMA of absolute changes).
 * @param {number[]} prices
 * @param {number} [period]
 * @returns {number}
 */
function calcATR(prices, period = 14) {
  if (prices.length < 2) return 0;
  const changes = [];
  for (let i = 1; i < prices.length; i++) changes.push(Math.abs(prices[i] - prices[i - 1]));
  const smoothed = ema(changes, period);
  return smoothed[smoothed.length - 1] || 0;
}

/**
 * Volume-weighted average price over the last `period` points.
 * @param {number[]} prices
 * @param {number[]|null|undefined} volumes
 * @param {number} [period]
 * @returns {number}
 */
function calcVWAP(prices, volumes, period = 14) {
  const n = Math.min(period, prices.length, volumes ? volumes.length : prices.length);
  if (n === 0) return prices[prices.length - 1] || 0;
  const pSlice = prices.slice(-n);
  const vSlice = volumes ? volumes.slice(-n) : new Array(n).fill(1);
  let totalPV = 0, totalV = 0;
  for (let i = 0; i < n; i++) { totalPV += pSlice[i] * vSlice[i]; totalV += vSlice[i]; }
  return totalV > 0 ? totalPV / totalV : pSlice[pSlice.length - 1];
}

/**
 * Up to three clustered support and resistance levels from local extrema.
 * @param {number[]} prices
 * @param {number} [lookback]
 * @returns {{ supports: number[], resistances: number[] }}
 */
function calcSupportResistance(prices, lookback = 30) {
  const slice = prices.slice(-Math.min(lookback, prices.length));
  /** @type {{type: 'S'|'R', price: number}[]} */
  const locals = [];
  for (let i = 1; i < slice.length - 1; i++) {
    if (slice[i] < slice[i - 1] && slice[i] < slice[i + 1]) locals.push({ type: 'S', price: slice[i] });
    if (slice[i] > slice[i - 1] && slice[i] > slice[i + 1]) locals.push({ type: 'R', price: slice[i] });
  }
  /** @param {{price: number}[]} arr */
  function cluster(arr) {
    /** @type {{sum: number, count: number, avg: number}[]} */
    const groups = [];
    for (const pt of arr) {
      const grp = groups.find(g => Math.abs(g.avg - pt.price) / g.avg < 0.02);
      if (grp) { grp.sum += pt.price; grp.count++; grp.avg = grp.sum / grp.count; }
      else groups.push({ sum: pt.price, count: 1, avg: pt.price });
    }
    return groups.sort((a, b) => b.count - a.count).slice(0, 3).map(g => g.avg);
  }
  const supports = cluster(locals.filter(l => l.type === 'S').sort((a, b) => b.price - a.price));
  const resistances = cluster(locals.filter(l => l.type === 'R').sort((a, b) => a.price - b.price));
  return { supports, resistances };
}

/**
 * Simple 20-point momentum trend classification.
 * @param {number[]} prices
 * @returns {{ strength: number, direction: 'Bullish'|'Bearish'|'Sideways' }}
 */
function calcTrendStrength(prices) {
  if (prices.length < 10) return { strength: 50, direction: 'Sideways' };
  const recent = prices.slice(-20);
  const last = recent[recent.length - 1];
  const first = recent[0];
  const momentum = (last - first) / first * 100;
  const strength = Math.min(100, Math.max(0, Math.abs(momentum) * 5));
  const direction = momentum > 3 ? 'Bullish' : momentum < -3 ? 'Bearish' : 'Sideways';
  return { strength: Math.round(strength), direction };
}

/**
 * Resample a price series to one close per UTC day (the last point of each
 * day). CoinGecko returns hourly points for 2–90-day ranges, so a "7-day"
 * forecast must run on daily closes — 7 hourly steps would be 7 hours.
 * Series that are already daily pass through unchanged.
 * @param {Date[]} dates
 * @param {number[]} prices
 * @returns {{ dates: Date[], prices: number[] }}
 */
function toDaily(dates, prices) {
  /** @type {Date[]} */ const outD = [];
  /** @type {number[]} */ const outP = [];
  let lastKey = '';
  for (let i = 0; i < dates.length; i++) {
    const key = dates[i].toISOString().slice(0, 10);
    if (key === lastKey) { outD[outD.length - 1] = dates[i]; outP[outP.length - 1] = prices[i]; }
    else { outD.push(dates[i]); outP.push(prices[i]); lastKey = key; }
  }
  return { dates: outD, prices: outP };
}

/**
 * Holt forecast N *days* ahead regardless of the series' granularity.
 * pointsPerDay: 24 for hourly series (CoinGecko 2–90-day ranges and the
 * 7-day sparkline), 1 for daily. Returns the projected price and % change.
 * @param {number[]} prices
 * @param {number} days
 * @param {number} pointsPerDay
 * @returns {{ price: number, pct: number, forecast: { median: number[], low: number[], high: number[] } }}
 */
function forecastDaysAhead(prices, days, pointsPerDay) {
  const steps = Math.max(1, Math.round(days * pointsPerDay));
  const f = holtForecast(prices, steps);
  const curr = prices[prices.length - 1];
  const price = f.median[f.median.length - 1];
  return { price, pct: curr ? (price - curr) / curr * 100 : 0, forecast: f };
}

/**
 * Infer points-per-day for CoinGecko market_chart / sparkline series.
 * @param {number} n  number of points
 * @param {number} spanDays  days the series covers
 */
function pointsPerDayFor(n, spanDays) {
  return spanDays > 0 ? Math.max(1, Math.round(n / spanDays)) : 1;
}

// Node / test export (ignored in the browser).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    FX_MMR, FX_TAKER_FEE,
    calcRSI, ema, calcMACD, calcBollinger, holtForecast, calcFutures,
    calcATR, calcVWAP, calcSupportResistance, calcTrendStrength, toDaily,
    forecastDaysAhead, pointsPerDayFor,
  };
}
