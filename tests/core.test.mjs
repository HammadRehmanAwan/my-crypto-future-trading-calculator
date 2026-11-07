// Unit tests for frontend/js/core.js — run with `npm test` (node --test).
// The calculator math IS the product: every number a trader sees comes from
// these functions, so each formula is pinned to a hand-computed value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../frontend/js/core.js');
const {
  calcFutures, calcRSI, ema, calcMACD, calcBollinger, holtForecast,
  calcATR, calcVWAP, calcSupportResistance, calcTrendStrength, FX_MMR,
} = core;

const close = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);

// ── Liquidation ───────────────────────────────────────────────────
test('long liquidation at 10x = entry × (1 − 1/10 + MMR)', () => {
  const r = calcFutures(100, 10, 1000, 'Long', null, null);
  close(r.liq, 100 * (1 - 0.1 + FX_MMR));
  close(r.liq, 90.5);
  close(r.liqDist, 9.5);
});

test('short liquidation at 10x = entry × (1 + 1/10 − MMR)', () => {
  const r = calcFutures(100, 10, 1000, 'Short', null, null);
  close(r.liq, 109.5);
  close(r.liqDist, 9.5);
});

test('100x long is liquidated after a 0.5% move (not the 1% textbook figure)', () => {
  const r = calcFutures(50_000, 100, 10_000, 'Long', null, null);
  close(r.liqDist, 0.5, 1e-9);
});

test('higher leverage always means a closer liquidation', () => {
  let prev = Infinity;
  for (const lev of [2, 5, 10, 25, 50, 100]) {
    const d = calcFutures(100, lev, 1000, 'Long', null, null).liqDist;
    assert.ok(d < prev, `liqDist at ${lev}x should shrink`);
    prev = d;
  }
});

// ── Margin, PnL, fees ─────────────────────────────────────────────
test('margin and contracts', () => {
  const r = calcFutures(100, 10, 1000, 'Long', null, null);
  close(r.margin, 100);
  close(r.contracts, 10);
});

test('long take-profit PnL is net of entry + exit taker fees', () => {
  const r = calcFutures(100, 10, 1000, 'Long', 110, null);
  close(r.pnlTpGross, 100);                 // 10 coins × $10
  const fees = 1000 * 0.0005 + 10 * 110 * 0.0005; // 0.50 + 0.55
  close(r.pnlTp, 100 - fees);
  close(r.roeTp, (100 - fees) / 100 * 100);
});

test('short stop-loss is a loss and includes fees', () => {
  const r = calcFutures(100, 5, 1000, 'Short', null, 105);
  close(r.pnlSlGross, -50);
  assert.ok(r.pnlSl < r.pnlSlGross, 'fees make a loss bigger');
});

test('positive funding: longs pay, shorts receive (3 payments per day)', () => {
  const long = calcFutures(100, 10, 1000, 'Long', 110, null, 0.0001, 1);
  const short = calcFutures(100, 10, 1000, 'Short', 90, null, 0.0001, 1);
  close(long.fundingCost, 0.3);
  close(short.fundingCost, -0.3);
  close(long.pnlTpGross - long.pnlTp, 0.3 + 1000 * 0.0005 + 10 * 110 * 0.0005);
});

test('reward-to-risk ratio', () => {
  const r = calcFutures(100, 10, 1000, 'Long', 115, 95);
  close(r.rr, 3);
});

test('custom taker fee is respected', () => {
  const r = calcFutures(100, 10, 1000, 'Long', 100, null, 0, 7, 0);
  close(r.pnlTp, 0);
});

// ── Indicators ────────────────────────────────────────────────────
test('RSI: only gains → 100, only losses → 0, flat → 50', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const down = Array.from({ length: 30 }, (_, i) => 100 - i);
  const flat = new Array(30).fill(100);
  close(calcRSI(up).at(-1), 100);
  close(calcRSI(down).at(-1), 0);
  close(calcRSI(flat).at(-1), 50);
});

test('RSI on too-short input is neutral, never NaN', () => {
  const r = calcRSI([1, 2, 3]);
  assert.deepEqual(r, [50, 50, 50]);
});

test('RSI is bounded 0–100', () => {
  const p = Array.from({ length: 200 }, (_, i) => 100 + 10 * Math.sin(i / 3) + i * 0.1);
  for (const v of calcRSI(p)) assert.ok(v >= 0 && v <= 100);
});

test('EMA of a constant series is that constant', () => {
  for (const v of ema(new Array(20).fill(7), 9)) close(v, 7);
  assert.deepEqual(ema([], 9), []);
});

test('MACD of a constant series is zero with null-padded signal', () => {
  const { macdLine, signalLine } = calcMACD(new Array(60).fill(10));
  for (const v of macdLine) close(v, 0);
  assert.equal(signalLine[0], null);
  close(signalLine.at(-1), 0);
  assert.equal(signalLine.length, 60);
});

test('Bollinger bands: constant series collapses to the mean', () => {
  const { upper, mid, lower } = calcBollinger(new Array(25).fill(50));
  assert.equal(upper[0], null);
  close(upper.at(-1), 50); close(mid.at(-1), 50); close(lower.at(-1), 50);
});

test('Bollinger bands: known stdev', () => {
  // 20 values alternating 9 and 11 → mean 10, population sd 1
  const p = Array.from({ length: 20 }, (_, i) => (i % 2 ? 11 : 9));
  const { upper, lower } = calcBollinger(p);
  close(upper.at(-1), 12); close(lower.at(-1), 8);
});

// ── Forecast ──────────────────────────────────────────────────────
test('Holt forecast extends a perfectly linear trend exactly', () => {
  const p = Array.from({ length: 40 }, (_, i) => 100 + 2 * i); // last = 178
  const { median, low, high } = holtForecast(p, 7);
  assert.equal(median.length, 7);
  median.forEach((v, i) => close(v, 178 + 2 * (i + 1), 1e-6));
  median.forEach((v, i) => assert.ok(low[i] <= v && v <= high[i]));
});

test('Holt band widens with the horizon', () => {
  const p = Array.from({ length: 60 }, (_, i) => 100 + 5 * Math.sin(i));
  const { low, high } = holtForecast(p, 7);
  for (let i = 1; i < 7; i++) assert.ok(high[i] - low[i] > high[i - 1] - low[i - 1]);
});

test('Holt handles degenerate input without NaN', () => {
  assert.deepEqual(holtForecast([], 3), { median: [], low: [], high: [] });
  const one = holtForecast([42], 2);
  assert.deepEqual(one.median, [42, 42]);
});

// ── Hub helpers ───────────────────────────────────────────────────
test('ATR, VWAP, trend and support/resistance basics', () => {
  close(calcATR([10, 10, 10]), 0);
  assert.equal(calcATR([5]), 0);
  close(calcVWAP([10, 20], [1, 3], 14), 17.5);
  close(calcVWAP([10, 20], null, 14), 15);
  assert.equal(calcTrendStrength(Array.from({ length: 20 }, (_, i) => 100 + i)).direction, 'Bullish');
  assert.equal(calcTrendStrength([1, 2, 3]).direction, 'Sideways');
  const zig = [10, 8, 10, 12, 10, 8, 10, 12, 10];
  const { supports, resistances } = calcSupportResistance(zig);
  close(supports[0], 8); close(resistances[0], 12);
});

test('toDaily keeps the last close of each UTC day', () => {
  const { toDaily } = core;
  const h = 3600e3, t0 = Date.UTC(2026, 0, 1);
  const dates = Array.from({ length: 72 }, (_, i) => new Date(t0 + i * h));
  const prices = dates.map((_, i) => i);
  const d = toDaily(dates, prices);
  assert.equal(d.prices.length, 3);
  assert.deepEqual(d.prices, [23, 47, 71]);
  // already-daily input is unchanged
  const dd = toDaily(d.dates, d.prices);
  assert.deepEqual(dd.prices, d.prices);
});

test('7-day forecast on daily closes spans 7 days, not 7 hours', () => {
  const { toDaily } = core;
  const h = 3600e3, t0 = Date.UTC(2026, 0, 1);
  // 30 days of hourly data rising $1/hour → $24/day
  const dates = Array.from({ length: 720 }, (_, i) => new Date(t0 + i * h));
  const prices = dates.map((_, i) => 100 + i);
  const hourly = holtForecast(prices, 7).median.at(-1) - prices.at(-1);
  const daily = toDaily(dates, prices);
  const d7 = holtForecast(daily.prices, 7).median.at(-1) - daily.prices.at(-1);
  close(hourly, 7, 1e-6);      // the old bug: 7 steps = +$7 (7 hours)
  close(d7, 7 * 24, 1e-6);     // fixed: 7 daily steps = +$168
});

test('forecastDaysAhead scales steps by points-per-day', () => {
  const { forecastDaysAhead, pointsPerDayFor } = core;
  const hourly = Array.from({ length: 168 }, (_, i) => 100 + i); // +$1/hour
  assert.equal(pointsPerDayFor(168, 7), 24);
  assert.equal(pointsPerDayFor(30, 30), 1);
  const r = forecastDaysAhead(hourly, 7, 24);
  close(r.price - hourly.at(-1), 168, 1e-6);
});
