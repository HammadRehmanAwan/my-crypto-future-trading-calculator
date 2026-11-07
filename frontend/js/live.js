// @ts-check
// ═══════════════════════════════════════════════════════════════════
// FutureX live market data over OKX public WebSockets (no API key).
//
//  • Live price: streams the selected coin's perpetual-swap ticker into the
//    chart header (replaces the 60-second CoinGecko poll for that number).
//  • Live liquidations (Trader plan): real forced-liquidation orders from
//    OKX's `liquidation-orders` channel, aggregated into a rolling feed.
//    OKX publishes a sample of liquidations (not every single fill), so the
//    card labels totals as "observed".
//
// Everything fails soft: if the socket can't connect (network, firewall,
// ad-blocker) the page keeps its CoinGecko-polled values.
// ═══════════════════════════════════════════════════════════════════
(function () {
  const WS_URL = 'wss://ws.okx.com:8443/ws/v5/public';
  const API = (window.FX_CONFIG && window.FX_CONFIG.backendUrl) || '';
  const FX = /** @type {any} */ (window.FX || {});
  window.FX = FX;

  /** @type {Record<string, string>} CoinGecko id → OKX swap instId */
  const INST = {
    bitcoin: 'BTC-USDT-SWAP', ethereum: 'ETH-USDT-SWAP', binancecoin: 'BNB-USDT-SWAP',
    solana: 'SOL-USDT-SWAP', ripple: 'XRP-USDT-SWAP', cardano: 'ADA-USDT-SWAP',
    'avalanche-2': 'AVAX-USDT-SWAP', dogecoin: 'DOGE-USDT-SWAP', polkadot: 'DOT-USDT-SWAP',
    'matic-network': 'MATIC-USDT-SWAP', chainlink: 'LINK-USDT-SWAP', uniswap: 'UNI-USDT-SWAP',
    litecoin: 'LTC-USDT-SWAP', cosmos: 'ATOM-USDT-SWAP', filecoin: 'FIL-USDT-SWAP',
  };
  const OUR_INSTS = new Set(Object.values(INST));

  /** @type {WebSocket|null} */ let ws = null;
  let retry = 0;
  /** @type {ReturnType<typeof setInterval>|undefined} */ let pingTimer;
  /** @type {string|null} */ let tickerInst = null;
  let wantLiqs = false;
  /** @type {Record<string, number>} */ let ctVal = {};

  function send(/** @type {object} */ msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function subscribeAll() {
    /** @type {object[]} */
    const args = [];
    if (tickerInst) args.push({ channel: 'tickers', instId: tickerInst });
    if (wantLiqs) args.push({ channel: 'liquidation-orders', instType: 'SWAP' });
    if (args.length) send({ op: 'subscribe', args });
  }

  function connect() {
    if (ws || typeof WebSocket === 'undefined') return;
    try { ws = new WebSocket(WS_URL); } catch (_) { return; }
    ws.onopen = () => {
      retry = 0;
      subscribeAll();
      // OKX closes idle connections after 30 s without traffic.
      pingTimer = setInterval(() => { if (ws && ws.readyState === 1) ws.send('ping'); }, 25_000);
      setPill(true);
    };
    ws.onmessage = ev => {
      if (ev.data === 'pong') return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      const ch = msg.arg && msg.arg.channel;
      if (!msg.data) return;
      if (ch === 'tickers') onTicker(msg.data[0]);
      else if (ch === 'liquidation-orders') msg.data.forEach(onLiquidation);
    };
    ws.onclose = () => {
      clearInterval(pingTimer);
      ws = null;
      setPill(false);
      if (!tickerInst && !wantLiqs) return;
      // Exponential back-off, capped at 60 s; pause while the tab is hidden.
      const delay = Math.min(60_000, 1000 * 2 ** retry++) + Math.random() * 500;
      setTimeout(() => { if (!document.hidden) connect(); }, delay);
    };
    ws.onerror = () => { /* onclose handles reconnect */ };
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !ws && (tickerInst || wantLiqs)) connect();
  });

  // ── Live price in the chart header ───────────────────────────────
  /** @param {boolean} on */
  function setPill(on) {
    const box = document.getElementById('livePriceBox');
    if (!box) return;
    let pill = document.getElementById('fxLivePill');
    if (!pill) {
      pill = document.createElement('span');
      pill.id = 'fxLivePill';
      pill.className = 'fx-live-pill';
      pill.title = 'Streaming from OKX perpetual swaps';
      pill.innerHTML = '<span class="fx-live-dot"></span><span class="fx-live-txt">LIVE</span>';
      box.appendChild(pill);
    }
    pill.classList.toggle('on', on);
    const t = pill.querySelector('.fx-live-txt');
    if (t) t.textContent = on ? 'LIVE' : 'delayed';
  }

  let lastPaint = 0;
  /** @param {{instId: string, last: string, open24h: string}} t */
  function onTicker(t) {
    if (!t || t.instId !== tickerInst) return;
    const now = Date.now();
    if (now - lastPaint < 400) return; // ~2.5 fps is plenty for a price label
    lastPaint = now;
    const last = parseFloat(t.last), open = parseFloat(t.open24h);
    if (!isFinite(last)) return;
    const valEl = document.getElementById('livePriceVal');
    const chgEl = document.getElementById('livePriceChg');
    const digits = last >= 100 ? 2 : last >= 1 ? 4 : 6;
    if (valEl) valEl.textContent = '$' + last.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits });
    if (chgEl && isFinite(open) && open > 0) {
      const chg = (last - open) / open * 100;
      chgEl.textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`;
      chgEl.className = `lp-chg ${chg >= 0 ? 'green' : 'red'}`;
    }
    FX.livePrice = { instId: t.instId, price: last, ts: now };
    document.dispatchEvent(new CustomEvent('fx:live-price', { detail: FX.livePrice }));
  }

  /** @param {string} coinId */
  function watchCoin(coinId) {
    const inst = INST[coinId];
    if (!inst || inst === tickerInst) return;
    if (tickerInst) send({ op: 'unsubscribe', args: [{ channel: 'tickers', instId: tickerInst }] });
    tickerInst = inst;
    if (ws && ws.readyState === 1) send({ op: 'subscribe', args: [{ channel: 'tickers', instId: inst }] });
    else connect();
  }

  document.addEventListener('fx:coin', e => watchCoin(/** @type {CustomEvent} */ (e).detail.coinId));

  // ── Live liquidation feed (Analysis Hub, Trader plan) ────────────
  /** @typedef {{inst: string, sym: string, side: 'long'|'short', usd: number|null, px: number, ts: number}} Liq */
  /** @type {Liq[]} */ const liqs = [];
  const WINDOW_MS = 60 * 60 * 1000;

  /** @param {any} row */
  function onLiquidation(row) {
    if (!row || !OUR_INSTS.has(row.instId)) return;
    for (const d of row.details || []) {
      const px = parseFloat(d.bkPx), sz = parseFloat(d.sz);
      const cv = ctVal[row.instId];
      liqs.unshift({
        inst: row.instId,
        sym: row.instId.split('-')[0],
        side: d.posSide === 'short' ? 'short' : 'long',
        usd: cv ? sz * cv * px : null,
        px, ts: Number(d.ts) || Date.now(),
      });
    }
    const cutoff = Date.now() - WINDOW_MS;
    while (liqs.length && (liqs.length > 300 || liqs[liqs.length - 1].ts < cutoff)) liqs.pop();
    scheduleRender();
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderLiqCard(); });
  }

  /** @param {number} v */
  function fmtUsd(v) {
    if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
    return `$${v.toFixed(0)}`;
  }

  function ensureLiqCard() {
    let card = document.getElementById('fxLiveLiqCard');
    if (card) return card;
    const anchor = document.getElementById('hubLiqCard');
    if (!anchor || !anchor.parentNode) return null;
    card = document.createElement('div');
    card.id = 'fxLiveLiqCard';
    card.className = 'card fx-liq-card';
    anchor.parentNode.insertBefore(card, anchor.nextSibling);
    return card;
  }

  function renderLiqCard() {
    const card = ensureLiqCard();
    if (!card) return;
    const head = `<div class="fx-liq-head"><h3 class="card-heading">Live Liquidations
      <span class="heading-sub">&mdash; real forced closures on OKX perpetuals, last hour</span></h3></div>`;
    if (FX.hasPlan && !FX.hasPlan('trader')) {
      card.innerHTML = head + `<div class="fx-liq-locked">Stream real-time liquidations across all 15 coins with the Trader plan.<br>
        <button class="fx-cta" type="button">See Trader plan</button></div>`;
      card.querySelector('button')?.addEventListener('click', () => FX.showPaywall('Live liquidations', 'trader'));
      return;
    }
    const now = Date.now();
    const recent = liqs.filter(l => now - l.ts < WINDOW_MS);
    const sum = (/** @type {'long'|'short'} */ side) => recent.filter(l => l.side === side && l.usd != null).reduce((a, l) => a + /** @type {number} */ (l.usd), 0);
    const rows = recent.slice(0, 40).map(l => `<li>
        <span>${l.sym}</span>
        <span class="side-${l.side}">${l.side === 'long' ? 'Long liquidated' : 'Short liquidated'}</span>
        <span>${l.usd != null ? fmtUsd(l.usd) : '—'} @ ${l.px.toLocaleString('en-US', { maximumFractionDigits: l.px < 1 ? 6 : 2 })}</span>
        <time>${new Date(l.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
      </li>`).join('');
    card.innerHTML = head + `
      <div class="fx-liq-totals">
        <div class="fx-liq-total long"><small>Longs liquidated (observed)</small><b>${fmtUsd(sum('long'))}</b></div>
        <div class="fx-liq-total short"><small>Shorts liquidated (observed)</small><b>${fmtUsd(sum('short'))}</b></div>
      </div>
      ${rows ? `<ul class="fx-liq-list">${rows}</ul>` : `<div class="fx-liq-empty">${ws && ws.readyState === 1 ? 'Connected — waiting for the next liquidation…' : 'Connecting to OKX…'}</div>`}`;
  }

  async function startLiqs() {
    if (wantLiqs) return;
    if (FX.hasPlan && !FX.hasPlan('trader')) { renderLiqCard(); return; }
    wantLiqs = true;
    renderLiqCard();
    if (API && !Object.keys(ctVal).length) {
      fetch(`${API}/okx/contract-values`).then(r => r.ok ? r.json() : {}).then(d => { ctVal = d || {}; }).catch(() => {});
    }
    if (ws && ws.readyState === 1) send({ op: 'subscribe', args: [{ channel: 'liquidation-orders', instType: 'SWAP' }] });
    else connect();
  }

  function stopLiqs() {
    if (!wantLiqs) return;
    wantLiqs = false;
    send({ op: 'unsubscribe', args: [{ channel: 'liquidation-orders', instType: 'SWAP' }] });
  }

  // Stream liquidations only while the Hub is on screen (saves bandwidth).
  function syncHub() {
    const hub = document.getElementById('hubView');
    if (hub && hub.style.display !== 'none') startLiqs(); else stopLiqs();
  }
  function boot() {
    const hub = document.getElementById('hubView');
    if (hub) new MutationObserver(syncHub).observe(hub, { attributes: true, attributeFilter: ['style'] });
    document.addEventListener('fx:plan', () => { stopLiqs(); syncHub(); renderLiqCard(); });
    syncHub();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
