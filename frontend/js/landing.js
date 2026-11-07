// @ts-check
// Landing page: live mini calculator (uses the same calcFutures as the app)
// and the accuracy teaser (reads data/accuracy.json from the weekly backtest).
(function () {
  /** @param {string} id */
  const $ = id => /** @type {HTMLInputElement} */ (document.getElementById(id));
  /** @param {number} v @param {number} [d] */
  const usd = (v, d = 2) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

  // core.js defines calcFutures as a browser global (loaded before this file).
  const calcFutures = /** @type {typeof import('./core.js').calcFutures} */ (/** @type {any} */ (window).calcFutures);

  function recalc() {
    const entry = parseFloat($('dEntry').value);
    const lev = Math.min(125, Math.max(1, parseFloat($('dLev').value) || 1));
    const size = parseFloat($('dSize').value);
    const dir = /** @type {'Long'|'Short'} */ ($('dDir').value === 'Short' ? 'Short' : 'Long');
    if (!(entry > 0) || !(size > 0)) return;
    const r = calcFutures(entry, lev, size, dir, null, null);
    const digits = entry < 1 ? 6 : entry < 100 ? 4 : 2;
    $('oLiq').textContent = usd(r.liq, digits);
    $('oDist').textContent = `${dir === 'Long' ? '−' : '+'}${r.liqDist.toFixed(2)}%`;
    $('oMargin').textContent = usd(r.margin);
    $('oFees').textContent = usd(r.totalFees);
  }
  let tracked = false;
  ['dEntry', 'dLev', 'dSize', 'dDir'].forEach(id => $(id)?.addEventListener('input', () => {
    recalc();
    if (!tracked && window.FX && window.FX.track) { tracked = true; window.FX.track('landing_demo_used'); }
  }));
  recalc();

  // Accuracy teaser
  fetch('data/accuracy.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : null).then(d => {
    if (!d || !d.overall || !d.overall.holt) return;
    const o = d.overall.holt;
    /** @param {string} id @param {string} v */
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('accDir', `${(o.direction_accuracy * 100).toFixed(0)}%`);
    set('accMape', `${o.mape.toFixed(1)}%`);
    set('accCov', `${(o.band_coverage * 100).toFixed(0)}%`);
    set('accN', o.n.toLocaleString('en-US'));
  }).catch(() => { /* teaser stays as dashes */ });
})();
