# 🤖 Crypto Futures Trading Bot

Automatically executes the trades suggested by the AI Portfolio Dashboard.  
Uses the exact same analysis engine (RSI · MACD · Bollinger Bands · Holt's forecast).

## Supported Exchanges
Binance · Bybit · OKX (and 100+ via [ccxt](https://github.com/ccxt/ccxt))

## Quick Start

### 1. Install dependencies
```bash
pip install -r requirements.txt
```

### 2. Get your exchange API keys
- **Binance**: Account → API Management → Create API  
  Enable: ✅ Enable Futures  ❌ Do NOT enable withdrawals
- **Bybit**: Account → API → Create New Key  
  Enable: ✅ Unified Trading

### 3. Edit `bot.py` — fill in the CONFIGURATION section
```python
EXCHANGE   = "binance"           # or "bybit" / "okx"
API_KEY    = "your_api_key"
API_SECRET = "your_api_secret"

CAPITAL    = 1000                # USD to invest
RISK_PROFILE = "moderate"        # conservative / moderate / aggressive

DRY_RUN    = True                # ← start here, test safely first
```

### 4. Test in dry run mode (no real money)
```bash
python bot.py
```
You'll see every trade it *would* make, with no actual orders placed.

### 5. Go live
Once you're happy with the dry run results, set `DRY_RUN = False`.

---

## Risk Profiles

| Profile | Leverage | Take Profit | Stop Loss |
|---|---|---|---|
| 🛡️ Conservative | 2–5× | 4% | 2.5% |
| ⚖️ Moderate | 4–10× | 7% | 4% |
| 🚀 Aggressive | 8–20× | 12% | 7% |

Leverage is automatically reduced for highly volatile coins.

## Safety Features
- **Dry run by default** — won't touch real money until you explicitly set `DRY_RUN = False`
- **Daily loss limit** — stops trading if daily loss exceeds `MAX_DAILY_LOSS_PCT`
- **Max open trades** — never opens more than `MAX_OPEN_TRADES` at once
- **Minimum signal threshold** — only trades when confidence score ≥ `MIN_SIGNAL_SCORE` (out of 6)
- **Duplicate protection** — skips coins already in an open position
- **Full logging** — every decision saved to `bot.log`

## Email Notifications
Set `EMAIL_ALERTS = True` and fill in your Gmail details to receive an email each time the bot trades.  
Use a [Gmail App Password](https://support.google.com/accounts/answer/185833), not your real password.

## Running 24/7
To keep the bot running continuously on a server:
```bash
# Linux / Mac — run in background
nohup python bot.py &

# Or with screen
screen -S cryptobot
python bot.py
# Ctrl+A then D to detach
```

---

⚠️ **Disclaimer**: This bot is for educational purposes only. Crypto futures trading carries extreme risk of total loss. Never invest money you cannot afford to lose.
