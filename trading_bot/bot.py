#!/usr/bin/env python3
"""
Crypto Futures Trading Bot
Powered by the same AI analysis engine as the dashboard.
Supports Binance, Bybit, OKX (via ccxt).

HOW TO USE:
  1. Edit the CONFIGURATION section below
  2. Set DRY_RUN = True first to test without real money
  3. Run: python bot.py
  4. Once satisfied, set DRY_RUN = False for live trading
"""

import time
import logging
import smtplib
from datetime import datetime, date
from email.mime.text import MIMEText

import requests
import numpy as np
import ccxt

# ═══════════════════════════════════════════════════════════════════
# CONFIGURATION  ← Edit this section
# ═══════════════════════════════════════════════════════════════════

# ── Exchange ──────────────────────────────────────────────────────
EXCHANGE      = "binance"   # "binance" | "bybit" | "okx"
API_KEY       = ""          # Paste your exchange API key here
API_SECRET    = ""          # Paste your exchange API secret here

# ── Trading ───────────────────────────────────────────────────────
CAPITAL       = 1000        # Total USD to spread across trades
RISK_PROFILE  = "moderate"  # "conservative" | "moderate" | "aggressive"

COINS = [                   # Coins the bot is allowed to trade
    "bitcoin", "ethereum", "solana", "binancecoin", "ripple",
    "cardano", "avalanche-2", "dogecoin", "polkadot", "chainlink",
]

# ── Safety ────────────────────────────────────────────────────────
DRY_RUN           = True    # ← KEEP TRUE until you are confident
MAX_OPEN_TRADES   = 4       # Maximum simultaneous open positions
MAX_DAILY_LOSS_PCT = 5      # Stop trading for the day if loss > this %
MIN_SIGNAL_SCORE  = 3       # Only trade when confidence score ≥ this (max 6)
RUN_EVERY_HOURS   = 4       # Re-analyse every N hours

# ── Email alerts (optional) ───────────────────────────────────────
EMAIL_ALERTS   = False
EMAIL_FROM     = ""         # Your Gmail address
EMAIL_PASSWORD = ""         # Gmail App Password (not your Gmail password)
EMAIL_TO       = ""         # Where to send trade alerts

# ═══════════════════════════════════════════════════════════════════
# COIN MAP  — CoinGecko ID → exchange symbol
# ═══════════════════════════════════════════════════════════════════

COIN_MAP = {
    "bitcoin":       {"sym": "BTC/USDT:USDT", "name": "Bitcoin"},
    "ethereum":      {"sym": "ETH/USDT:USDT", "name": "Ethereum"},
    "binancecoin":   {"sym": "BNB/USDT:USDT", "name": "BNB"},
    "solana":        {"sym": "SOL/USDT:USDT", "name": "Solana"},
    "ripple":        {"sym": "XRP/USDT:USDT", "name": "XRP"},
    "cardano":       {"sym": "ADA/USDT:USDT", "name": "Cardano"},
    "avalanche-2":   {"sym": "AVAX/USDT:USDT","name": "Avalanche"},
    "dogecoin":      {"sym": "DOGE/USDT:USDT","name": "Dogecoin"},
    "polkadot":      {"sym": "DOT/USDT:USDT", "name": "Polkadot"},
    "matic-network": {"sym": "MATIC/USDT:USDT","name": "Polygon"},
    "chainlink":     {"sym": "LINK/USDT:USDT","name": "Chainlink"},
    "uniswap":       {"sym": "UNI/USDT:USDT", "name": "Uniswap"},
    "litecoin":      {"sym": "LTC/USDT:USDT", "name": "Litecoin"},
    "cosmos":        {"sym": "ATOM/USDT:USDT","name": "Cosmos"},
    "filecoin":      {"sym": "FIL/USDT:USDT", "name": "Filecoin"},
}

RISK_CONFIG = {
    "conservative": {"lev_hi": 2,  "lev_mid": 3,  "lev_lo": 5,  "tp": 0.04,  "sl": 0.025},
    "moderate":     {"lev_hi": 4,  "lev_mid": 6,  "lev_lo": 10, "tp": 0.07,  "sl": 0.04 },
    "aggressive":   {"lev_hi": 8,  "lev_mid": 12, "lev_lo": 20, "tp": 0.12,  "sl": 0.07 },
}

# ═══════════════════════════════════════════════════════════════════
# LOGGING
# ═══════════════════════════════════════════════════════════════════

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    handlers=[
        logging.FileHandler("bot.log"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger("CryptoBot")

# ═══════════════════════════════════════════════════════════════════
# MARKET DATA  (CoinGecko — same source as dashboard)
# ═══════════════════════════════════════════════════════════════════

COINGECKO = "https://api.coingecko.com/api/v3"

def fetch_sparkline(coin_ids: list) -> dict:
    """Fetch 7-day hourly prices for all coins in one API call."""
    ids = ",".join(coin_ids)
    url = (f"{COINGECKO}/coins/markets"
           f"?vs_currency=usd&ids={ids}&sparkline=true&price_change_percentage=24h")
    for attempt in range(3):
        try:
            r = requests.get(url, timeout=20)
            if r.status_code == 429:
                log.warning("CoinGecko rate limit — waiting 60 s")
                time.sleep(60)
                continue
            r.raise_for_status()
            return {c["id"]: c for c in r.json()}
        except Exception as e:
            log.error("CoinGecko fetch error (attempt %d): %s", attempt + 1, e)
            time.sleep(10)
    return {}

# ═══════════════════════════════════════════════════════════════════
# TECHNICAL INDICATORS  (same algorithm as frontend)
# ═══════════════════════════════════════════════════════════════════

def calc_rsi(prices: np.ndarray, period: int = 14) -> float:
    if len(prices) < period + 1:
        return 50.0
    deltas = np.diff(prices)
    gains  = np.where(deltas > 0, deltas, 0.0)
    losses = np.where(deltas < 0, -deltas, 0.0)
    ag = gains[:period].mean()
    al = losses[:period].mean()
    for i in range(period, len(deltas)):
        ag = (ag * (period - 1) + gains[i])  / period
        al = (al * (period - 1) + losses[i]) / period
    return 100.0 if al == 0 else 100 - 100 / (1 + ag / al)

def ema(prices: np.ndarray, period: int) -> np.ndarray:
    k, out = 2 / (period + 1), [prices[0]]
    for p in prices[1:]:
        out.append(p * k + out[-1] * (1 - k))
    return np.array(out)

def calc_macd(prices: np.ndarray):
    ef, es = ema(prices, 12), ema(prices, 26)
    macd_line = ef - es
    signal    = ema(macd_line[25:], 9)
    return macd_line[-1], signal[-1]

def calc_bollinger(prices: np.ndarray, period: int = 20):
    sl = prices[-period:]
    m  = sl.mean()
    sd = sl.std()
    return m + 2 * sd, m, m - 2 * sd   # upper, mid, lower

def holt_forecast(prices: np.ndarray, horizon: int = 7,
                  alpha: float = 0.35, beta: float = 0.08) -> float:
    level, trend = prices[0], prices[1] - prices[0]
    for p in prices[1:]:
        prev_l = level
        level  = alpha * p + (1 - alpha) * (level + trend)
        trend  = beta * (level - prev_l) + (1 - beta) * trend
    return level + trend * horizon

# ═══════════════════════════════════════════════════════════════════
# SIGNAL SCORING  (−6 to +6; same logic as dashboard)
# ═══════════════════════════════════════════════════════════════════

def score_coin(market_data: dict) -> dict | None:
    prices_raw = market_data.get("sparkline_in_7d", {}).get("price", [])
    if len(prices_raw) < 30:
        return None
    prices = np.array(prices_raw, dtype=float)
    curr   = market_data["current_price"]
    chg24  = market_data.get("price_change_percentage_24h", 0) or 0

    rsi          = calc_rsi(prices)
    macd, sig    = calc_macd(prices)
    bb_u, bb_m, bb_l = calc_bollinger(prices)
    bb_width     = (bb_u - bb_l) / bb_m * 100 if bb_m else 10
    forecast     = holt_forecast(prices)
    fcast_chg    = (forecast - curr) / curr * 100

    score = 0
    reasons = []

    if   rsi < 25: score += 2; reasons.append(f"RSI very oversold ({rsi:.0f}) — strong bounce likely")
    elif rsi < 35: score += 1; reasons.append(f"RSI oversold ({rsi:.0f}) — price may bounce up")
    elif rsi > 75: score -= 2; reasons.append(f"RSI very overbought ({rsi:.0f}) — sharp drop possible")
    elif rsi > 65: score -= 1; reasons.append(f"RSI overbought ({rsi:.0f}) — upside limited")

    if macd > sig: score += 1; reasons.append("MACD bullish — buyers in control")
    else:          score -= 1; reasons.append("MACD bearish — sellers in control")

    if   curr < bb_l: score += 1; reasons.append("Price below lower Bollinger Band — bounce expected")
    elif curr > bb_u: score -= 1; reasons.append("Price above upper Bollinger Band — pullback expected")

    if   chg24 >  2: score += 1; reasons.append(f"Up {chg24:.1f}% today — strong momentum")
    elif chg24 < -2: score -= 1; reasons.append(f"Down {abs(chg24):.1f}% today — selling pressure")

    if   fcast_chg >  3: score += 1; reasons.append(f"Model forecasts +{fcast_chg:.1f}% over 7 days")
    elif fcast_chg < -3: score -= 1; reasons.append(f"Model forecasts {fcast_chg:.1f}% over 7 days")

    return {
        "id":       market_data["id"],
        "name":     COIN_MAP.get(market_data["id"], {}).get("name", market_data["id"]),
        "sym":      COIN_MAP.get(market_data["id"], {}).get("sym"),
        "price":    curr,
        "score":    score,
        "bb_width": bb_width,
        "reasons":  reasons[:3],
    }

# ═══════════════════════════════════════════════════════════════════
# TRADE PLANNER
# ═══════════════════════════════════════════════════════════════════

def build_trade_plan(scored: list, capital: float, risk: str) -> list:
    cfg   = RISK_CONFIG[risk]
    total = sum(abs(c["score"]) for c in scored)
    plans = []
    for coin in scored:
        alloc     = max(50.0, abs(coin["score"]) / total * capital)
        bb_w      = coin["bb_width"]
        leverage  = cfg["lev_hi"] if bb_w > 15 else (cfg["lev_mid"] if bb_w > 8 else cfg["lev_lo"])
        direction = "long" if coin["score"] > 0 else "short"
        tp = coin["price"] * (1 + cfg["tp"]) if direction == "long" else coin["price"] * (1 - cfg["tp"])
        sl = coin["price"] * (1 - cfg["sl"]) if direction == "long" else coin["price"] * (1 + cfg["sl"])
        qty  = alloc / coin["price"]
        margin = alloc / leverage
        pnl_tp = qty * abs(tp - coin["price"])
        pnl_sl = qty * abs(sl - coin["price"])
        plans.append({**coin, "dir": direction, "alloc": round(alloc, 2),
                      "leverage": leverage, "margin": round(margin, 2),
                      "qty": qty, "tp": tp, "sl": sl,
                      "pnl_tp": pnl_tp, "pnl_sl": -pnl_sl})
    # Normalise allocations
    alloc_sum = sum(p["alloc"] for p in plans)
    for p in plans:
        p["alloc"] = round(p["alloc"] / alloc_sum * capital, 2)
        p["qty"]   = p["alloc"] / p["price"]
    return plans

# ═══════════════════════════════════════════════════════════════════
# EXCHANGE INTERFACE
# ═══════════════════════════════════════════════════════════════════

def get_exchange():
    params = {"apiKey": API_KEY, "secret": API_SECRET, "options": {"defaultType": "future"}}
    ex_map = {"binance": ccxt.binanceusdm, "bybit": ccxt.bybit, "okx": ccxt.okx}
    cls = ex_map.get(EXCHANGE, ccxt.binanceusdm)
    ex = cls(params)
    ex.load_markets()
    return ex

def open_positions(exchange) -> set:
    """Return set of symbols that already have an open position."""
    try:
        positions = exchange.fetch_positions()
        return {p["symbol"] for p in positions if abs(p.get("contracts") or 0) > 0}
    except Exception as e:
        log.warning("Could not fetch positions: %s", e)
        return set()

def execute_trade(exchange, plan: dict, open_pos: set) -> bool:
    sym = plan["sym"]
    if sym is None:
        log.warning("No exchange symbol for %s — skipping", plan["name"])
        return False
    if sym in open_pos:
        log.info("Already have open position in %s — skipping", plan["name"])
        return False

    side      = "buy" if plan["dir"] == "long" else "sell"
    close_side = "sell" if side == "buy" else "buy"
    qty       = round(plan["qty"], 6)
    tp, sl    = plan["tp"], plan["sl"]
    lev       = plan["leverage"]
    price     = plan["price"]

    log.info("─── %s %s  qty=%.6f  lev=%dx  entry~$%.4f  TP=$%.4f  SL=$%.4f",
             plan["dir"].upper(), plan["name"], qty, lev, price, tp, sl)

    if DRY_RUN:
        log.info("    [DRY RUN] Would open position — skipping real order")
        return True

    try:
        # Set leverage and isolated margin
        exchange.set_leverage(lev, sym)
        try:
            exchange.set_margin_mode("ISOLATED", sym)
        except Exception:
            pass  # some exchanges don't support this call

        # Market entry order
        order = exchange.create_order(sym, "market", side, qty)
        log.info("    Entry order placed: %s", order.get("id"))

        # Take-profit order
        tp_order = exchange.create_order(
            sym, "take_profit_market", close_side, qty,
            params={"stopPrice": round(tp, 6), "reduceOnly": True},
        )
        log.info("    TP order placed: %s", tp_order.get("id"))

        # Stop-loss order
        sl_order = exchange.create_order(
            sym, "stop_market", close_side, qty,
            params={"stopPrice": round(sl, 6), "reduceOnly": True},
        )
        log.info("    SL order placed: %s", sl_order.get("id"))
        return True

    except ccxt.InsufficientFunds:
        log.error("    Insufficient funds to open %s trade", plan["name"])
    except ccxt.InvalidOrder as e:
        log.error("    Invalid order for %s: %s", plan["name"], e)
    except Exception as e:
        log.error("    Unexpected error placing %s trade: %s", plan["name"], e)
    return False

# ═══════════════════════════════════════════════════════════════════
# EMAIL NOTIFICATIONS
# ═══════════════════════════════════════════════════════════════════

def send_email(subject: str, body: str) -> None:
    if not EMAIL_ALERTS or not EMAIL_FROM or not EMAIL_TO:
        return
    try:
        msg = MIMEText(body)
        msg["Subject"] = subject
        msg["From"]    = EMAIL_FROM
        msg["To"]      = EMAIL_TO
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as s:
            s.login(EMAIL_FROM, EMAIL_PASSWORD)
            s.send_message(msg)
        log.info("Email notification sent to %s", EMAIL_TO)
    except Exception as e:
        log.warning("Email failed: %s", e)

# ═══════════════════════════════════════════════════════════════════
# DAILY LOSS GUARD
# ═══════════════════════════════════════════════════════════════════

_daily_pnl: dict[str, float] = {}

def record_loss(amount: float) -> None:
    today = str(date.today())
    _daily_pnl[today] = _daily_pnl.get(today, 0) + amount

def daily_loss_exceeded() -> bool:
    today    = str(date.today())
    loss     = _daily_pnl.get(today, 0)
    limit    = -(CAPITAL * MAX_DAILY_LOSS_PCT / 100)
    exceeded = loss < limit
    if exceeded:
        log.warning("Daily loss limit reached (%.2f / %.2f) — pausing until tomorrow", loss, limit)
    return exceeded

# ═══════════════════════════════════════════════════════════════════
# MAIN BOT LOOP
# ═══════════════════════════════════════════════════════════════════

def run_once(exchange) -> None:
    log.info("━━━ Analysis run started — %s", datetime.now().strftime("%Y-%m-%d %H:%M"))

    if daily_loss_exceeded():
        return

    # Fetch market data
    log.info("Fetching market data for %d coins…", len(COINS))
    market_data = fetch_sparkline(COINS)
    if not market_data:
        log.error("No market data received — skipping run")
        return

    # Score each coin
    scored = []
    for coin_id in COINS:
        data = market_data.get(coin_id)
        if not data:
            continue
        result = score_coin(data)
        if result and abs(result["score"]) >= MIN_SIGNAL_SCORE and result["sym"]:
            scored.append(result)
            log.info("  %-12s  score=%+d  reasons: %s",
                     result["name"], result["score"], " | ".join(result["reasons"][:1]))

    if not scored:
        log.info("No coins met the minimum signal threshold (%d) — no trades this run", MIN_SIGNAL_SCORE)
        return

    # Sort by strength, limit to MAX_OPEN_TRADES
    scored.sort(key=lambda c: abs(c["score"]), reverse=True)
    scored = scored[:MAX_OPEN_TRADES]

    # Build trade plan
    plans = build_trade_plan(scored, CAPITAL, RISK_PROFILE)

    # Get current open positions
    open_pos = open_positions(exchange)
    log.info("Currently open positions: %d", len(open_pos))

    available_slots = MAX_OPEN_TRADES - len(open_pos)
    if available_slots <= 0:
        log.info("Max open trades (%d) already reached — skipping", MAX_OPEN_TRADES)
        return

    executed, email_lines = [], []

    for plan in plans[:available_slots]:
        ok = execute_trade(exchange, plan, open_pos)
        if ok:
            executed.append(plan)
            tag = "[DRY RUN] " if DRY_RUN else ""
            email_lines.append(
                f"{tag}{plan['dir'].upper()} {plan['name']}\n"
                f"  Allocated: ${plan['alloc']:.0f} at {plan['leverage']}x leverage\n"
                f"  Entry: ${plan['price']:.4f}  TP: ${plan['tp']:.4f}  SL: ${plan['sl']:.4f}\n"
                f"  Expected profit: +${plan['pnl_tp']:.2f}  Max loss: ${plan['pnl_sl']:.2f}\n"
                f"  Why: {' | '.join(plan['reasons'])}\n"
            )

    if executed:
        body = (
            f"Bot executed {len(executed)} trade(s) at {datetime.now().strftime('%Y-%m-%d %H:%M')}\n\n"
            + "\n".join(email_lines)
            + f"\nRisk profile: {RISK_PROFILE}  |  Mode: {'DRY RUN' if DRY_RUN else 'LIVE'}"
        )
        send_email(f"🤖 Bot traded {len(executed)} coin(s)", body)
        log.info("Executed %d trade(s) this run", len(executed))
    else:
        log.info("No new trades executed this run")

    log.info("━━━ Run complete\n")


def main() -> None:
    log.info("╔══════════════════════════════════════╗")
    log.info("║   Crypto Futures Trading Bot         ║")
    log.info("║   Exchange : %-22s ║", EXCHANGE)
    log.info("║   Capital  : $%-21.0f ║", CAPITAL)
    log.info("║   Profile  : %-22s ║", RISK_PROFILE)
    log.info("║   Mode     : %-22s ║", "DRY RUN (safe)" if DRY_RUN else "⚠️  LIVE TRADING")
    log.info("╚══════════════════════════════════════╝\n")

    if not API_KEY or not API_SECRET:
        if DRY_RUN:
            log.info("No API keys — running in simulation mode (dry run)")
            exchange = None
        else:
            log.error("API_KEY and API_SECRET must be set for live trading. Exiting.")
            return
    else:
        log.info("Connecting to %s…", EXCHANGE)
        try:
            exchange = get_exchange()
            log.info("Connected ✓")
        except Exception as e:
            log.error("Exchange connection failed: %s", e)
            return

    # Wrap exchange so dry-run works without keys
    class SimExchange:
        def fetch_positions(self): return []

    if exchange is None:
        exchange = SimExchange()

    interval = RUN_EVERY_HOURS * 3600
    while True:
        try:
            run_once(exchange)
        except KeyboardInterrupt:
            log.info("Bot stopped by user.")
            break
        except Exception as e:
            log.error("Unexpected error in main loop: %s", e)

        log.info("Next run in %d hours. Press Ctrl+C to stop.\n", RUN_EVERY_HOURS)
        time.sleep(interval)


if __name__ == "__main__":
    main()
