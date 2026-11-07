// @ts-check
// Renders data/accuracy.json (written weekly by scripts/backtest.py) and
// asks the backend which models are live (/model-status).
(function () {
  /** @param {number} v */ const pct = v => `${(v * 100).toFixed(1)}%`;
  /** @param {string} s */
  const esc = s => String(s).replace(/[&<>"]/g, c => /** @type {Record<string,string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  /** @param {number|undefined} dir */
  function dirClass(dir) { return dir == null ? '' : dir >= 0.55 ? 'good' : dir >= 0.5 ? 'meh' : 'bad'; }

  fetch('data/accuracy.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : Promise.reject(r.status)).then(d => {
    const meta = document.getElementById('accMeta');
    if (meta) meta.textContent = `Last run ${new Date(d.generated_at).toUTCString()} · ${d.window_days}-day window · ${d.horizon_days}-day horizon · ${Object.keys(d.coins).length} coins${d.synthetic ? ' · SAMPLE DATA (backtest has not run yet)' : ''}`;
    const o = d.overall.holt;
    const naive = d.overall.naive;
    const ch = d.overall.chronos;
    const kpis = document.getElementById('accKpis');
    if (kpis) kpis.innerHTML = [
      ['Direction hit rate', pct(o.direction_accuracy), dirClass(o.direction_accuracy)],
      ['MAPE (7-day)', `${o.mape.toFixed(2)}%`, ''],
      ['Naive baseline MAPE', `${naive.mape.toFixed(2)}%`, ''],
      ['Band coverage', pct(o.band_coverage), ''],
      ['Forecasts tested', o.n.toLocaleString('en-US'), ''],
      ...(ch ? [['Chronos-Bolt hit rate', pct(ch.direction_accuracy), dirClass(ch.direction_accuracy)]] : []),
    ].map(([k, v, c]) => `<div class="kpi"><small>${k}</small><b class="${c}">${v}</b></div>`).join('');

    const hasChronos = Object.values(d.coins).some((/** @type {any} */ c) => c.chronos);
    if (!hasChronos) document.getElementById('thChronos')?.remove();
    const tbody = document.querySelector('#accTable tbody');
    if (tbody) tbody.innerHTML = Object.entries(d.coins).map(([id, /** @type {any} */ c]) => {
      const rel = c.naive.mape > 0 ? (c.holt.mape - c.naive.mape) / c.naive.mape : 0;
      return `<tr><td>${esc(c.symbol || id)}</td><td class="num">${c.holt.n}</td>
        <td class="num ${dirClass(c.holt.direction_accuracy)}">${pct(c.holt.direction_accuracy)}</td>
        <td class="num">${c.holt.mape.toFixed(2)}%</td><td class="num">${c.naive.mape.toFixed(2)}%</td>
        <td class="num ${rel < 0 ? 'good' : 'bad'}">${rel < 0 ? '' : '+'}${(rel * 100).toFixed(0)}%</td>
        <td class="num">${pct(c.holt.band_coverage)}</td>
        ${hasChronos ? `<td class="num ${dirClass(c.chronos?.direction_accuracy)}">${c.chronos ? pct(c.chronos.direction_accuracy) : '—'}</td>` : ''}</tr>`;
    }).join('');
  }).catch(() => {
    const meta = document.getElementById('accMeta');
    if (meta) meta.textContent = 'The first backtest has not been published yet. Check back soon.';
  });

  const api = window.FX_CONFIG && window.FX_CONFIG.backendUrl;
  const ms = document.getElementById('modelStatus');
  if (api && ms) {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20000);
    fetch(`${api}/model-status`, { signal: ctrl.signal }).then(r => r.json()).then(s => {
      if (!s || !Object.keys(s).length) throw new Error('empty');
      const row = (/** @type {string} */ name, /** @type {boolean} */ on) => `${on ? '🟢' : '⚪'} ${name}: <strong>${on ? 'running' : 'offline'}</strong>`;
      ms.innerHTML = [row('Amazon Chronos-Bolt-Small', !!s.chronos_bolt), row('XGBoost', !!s.xgboost), row('Holt statistical forecast (in your browser)', true)].join('<br>');
    }).catch(() => { ms.textContent = 'The model server is asleep or unreachable right now; the in-browser statistical forecast is always available.'; });
  }
})();
