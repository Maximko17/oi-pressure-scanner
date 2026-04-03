# Bybit OI Spike Detector

Production-ready Node.js application that monitors cryptocurrency futures markets on Bybit and detects Open Interest (OI) spikes with Telegram and Pushover alerts. Supports both OI buildup (accumulation) and liquidation (position closing) detection.

## Features

- **Symbol Selection**: Automatically filters USDT perpetual futures with >$50M 24h turnover and >5% volatility
- **OI Monitoring**: Fetches open interest every 60 seconds with interval-based aggregation
- **Triple Signal Detection**:
  - **BUILDUP** - OI increase (new positions opening): +10% to +25%+
  - **LIQUIDATION** - OI decrease (positions closing/liquidating): -10% to -20%+
  - **CASCADE** - BUILDUP followed by LIQUIDATION within 30 min (high-value signal, bypasses cooldown)
- **Signal Strength**: WEAK (10%/10%), STRONG (15%/15%), EXTREME (25%/20%)
- **Telegram Alerts**: Instant notifications with formatted messages and trading links
- **Pushover Alerts**: Backup notification channel (optional, no VPN dependency)
- **Interactive UI**: Single-screen navigation with `/list` command and inline keyboards
- **Strategy Info**: `/strategy` command explains how the bot works
- **Cooldown System**: Prevents duplicate alerts within 10 minutes per symbol
- **Resilient Startup**: Retries Telegram connection with exponential backoff; continues monitoring if Telegram is down
- **Console Logging**: Structured Winston logger with colorized console output

## Project Structure

```
/src
  /api
    bybitClient.js      # Bybit API wrapper with intervalTime support
  /services
    symbolService.js    # Symbol selection & filtering
    oiService.js        # OI data collection with interval-based fetching
    signalService.js    # Spike detection - both BUILDUP and LIQUIDATION
    alertService.js     # Telegram + Pushover alert dispatch
    telegramService.js  # Telegram interactive commands & UI state management
  /utils
    logger.js           # Winston logger configuration (console only)
  /config
    config.js           # Environment-based configuration
  app.js                # Main orchestrator
```

## Prerequisites

- Node.js 18+ (LTS recommended)
- Telegram Bot Token and Chat ID
- Pushover Token and User Key (optional, for backup alerts)
- Internet connection to access Bybit API

## Installation

1. Clone or download the project
2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure environment variables:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` with your settings:

   ```env
   BYBIT_API_BASE=https://api.bybit.com
   TELEGRAM_BOT_TOKEN=your_bot_token_here
   TELEGRAM_CHAT_ID=your_chat_id_here
   PUSHOVER_TOKEN=your_pushover_app_token_here
   PUSHOVER_USER=your_pushover_user_key_here
   SYMBOL_REFRESH_INTERVAL_MS=900000
   OI_FETCH_INTERVAL_MS=60000
   ALERT_COOLDOWN_MINUTES=10
   CONCURRENT_FETCHES=20
   LOG_LEVEL=info
   ```

## Getting Telegram Credentials

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` and follow instructions to create a bot
3. Save the **Bot Token** provided by BotFather
4. To get your **Chat ID**:
   - Search for your bot in Telegram and start a conversation
   - Send any message to the bot
   - Visit: `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
   - Look for `"chat":{"id":123456789,...}` - that number is your Chat ID

## Getting Pushover Credentials (Optional)

1. Create an account at [pushover.net](https://pushover.net)
2. Create a new Application and copy the **API Token**
3. Copy your **User Key** from the dashboard
4. Add both to `.env` as `PUSHOVER_TOKEN` and `PUSHOVER_USER`

## Running the Application

### Development mode (with auto-reload):
```bash
npm run dev
```

### Production mode:
```bash
npm start
```

## How It Works

### 1. Symbol Selection (every 15 minutes)
- Fetches all linear (USDT) perpetual futures tickers from Bybit
- Filters symbols with 24h turnover > $50M
- Filters symbols with 24h volatility > 5%
- Updates the active monitoring list

### 2. OI Data Collection (every 60 seconds)
- Fetches open interest for all active symbols in parallel
- Uses Bybit's interval-based API (`intervalTime=5min` or `15min`)
- Requests only latest 2 data points per call
- Stores current OI value per symbol in memory

### 3. Signal Detection (every 60 seconds)
For each monitored symbol:

**Step 1:** Fetch 5-minute OI change (primary trigger)

**Step 2:** Determine event type and strength:
| Direction | Threshold | Type | Strength |
|-----------|-----------|------|----------|
| Positive | +10% to +15% | BUILDUP | WEAK |
| Positive | +15% to +25% | BUILDUP | STRONG |
| Positive | +25%+ | BUILDUP | EXTREME |
| Negative | -10% to -15% | LIQUIDATION | WEAK |
| Negative | -15% to -20% | LIQUIDATION | STRONG |
| Negative | -20%+ | LIQUIDATION | EXTREME |

**Step 3:** If 5-minute change meets threshold (±10% minimum):
- Fetch 15-minute OI change for confirmation
- 15-minute change must confirm same direction (both positive for buildup, both negative for liquidation)
- If 15-minute signal is stronger, boost to match

**Step 4:** Set 10-minute cooldown per symbol after alert

### 4. Alerts

When a signal is detected, the bot sends notifications via:

**Telegram:**
```
🚨 OI Event Detected 🔴🔴🔴

Symbol: BTCUSDT
Type: BUILDUP

OI Change:
• 5m: +28.5%
• 15m: +32.1%

Signal Strength: EXTREME
Current OI: 1,234,567

Links:
Bybit: https://www.bybit.com/trade/usdt/BTCUSDT
Coinglass: https://www.coinglass.com/tv/ru/Bybit_BTCUSDT

Timestamp: Wed, 31 Mar 2026 00:56:00 GMT
```

**Pushover:**
Plain text notification with the same details, priority based on signal strength (WEAK=0, STRONG=1, EXTREME=2).

### 5. Interactive Commands

| Command | Description |
|---------|-------------|
| `/list` | Show tracked symbols with inline keyboard |
| `/strategy` | Explain how the bot works |

The `/list` command opens a single-screen UI where you can:
- Click any symbol to view detailed analytics
- Use "⬅ Back to List" to return
- See OI changes, signal strength, volume, and links

## Logging

All logs are output to the console with colorized, human-readable format. Each log entry includes timestamp, service name, level, and structured metadata.

Log levels:
- `error` - Critical failures
- `warn` - Warnings (insufficient data, invalid values)
- `info` - Normal operations (symbol refreshes, OI fetches, signals)
- `debug` - Detailed data (individual OI values, state transitions) — Set `LOG_LEVEL=debug`

## Configuration Options

| Variable | Default | Description |
|----------|---------|-------------|
| `BYBIT_API_BASE` | `https://api.bybit.com` | Bybit API base URL |
| `TELEGRAM_BOT_TOKEN` | *required* | Telegram bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | *required* | Telegram chat ID to receive alerts |
| `PUSHOVER_TOKEN` | *optional* | Pushover application API token |
| `PUSHOVER_USER` | *optional* | Pushover user key |
| `SYMBOL_REFRESH_INTERVAL_MS` | `900000` (15 min) | How often to refresh symbol list |
| `OI_FETCH_INTERVAL_MS` | `60000` (60 sec) | How often to fetch OI data |
| `ALERT_COOLDOWN_MINUTES` | `10` | Minimum time between alerts per symbol |
| `CASCADE_WINDOW_MINUTES` | `30` | Time window for BUILDUP→LIQUIDATION cascade detection |
| `CONCURRENT_FETCHES` | `20` | Number of parallel OI fetch requests |
| `LOG_LEVEL` | `info` | Log level: error, warn, info, debug |

## Signal Detection Logic

### BUILDUP (OI Increasing)
- **Trigger**: 5-minute OI change ≥ +10%
- **Confirmation**: 15-minute OI change must also be positive
- **Strength levels**:
  - WEAK: +10% to +15%
  - STRONG: +15% to +25%
  - EXTREME: +25%+

### LIQUIDATION (OI Decreasing)
- **Trigger**: 5-minute OI change ≤ -10%
- **Confirmation**: 15-minute OI change must also be negative
- **Strength levels**:
  - WEAK: -10% to -15%
  - STRONG: -15% to -20%
  - EXTREME: -20%+

### CASCADE (BUILDUP → LIQUIDATION Sequence)
- **Trigger**: LIQUIDATION detected AND BUILDUP occurred within the last 30 minutes (configurable)
- **Confirmation**: Inherits from both BUILDUP and LIQUIDATION events
- **Cooldown**: Bypassed — CASCADE alerts always fire immediately
- **Meaning**: Traders opened positions and they're now being forced out — strong reversal signal
- **Strength**: Inherits from the LIQUIDATION event's strength level

**Note**: The 15-minute interval can boost the signal strength if it's higher than the 5-minute strength.

## Error Handling

- **API Failures**: Retry with exponential backoff (handled by axios interceptor)
- **Rate Limits**: Automatic retry after `retry-after` header or 5 seconds
- **Invalid Data**: Skips symbols with malformed data, continues with others
- **Telegram Errors**: Retries on startup with backoff; background reconnection every 60s
- **Pushover Errors**: Logged but never break the alert flow
- **Graceful Shutdown**: Handles SIGINT/SIGTERM, stops intervals cleanly

## Performance Considerations

- Uses `p-limit` to control concurrent API requests (default 20)
- In-memory storage for fast access (no database required)
- Non-blocking async/await pattern throughout
- Lazy 15-minute fetch only when 5-minute shows potential signal
- Native `fetch` for Pushover (no additional dependencies)

## Troubleshooting

### No symbols being monitored
- Check Bybit API connectivity
- Verify turnover/volatility filters may be too strict (adjust in `symbolService.js`)

### No Telegram alerts
- Verify bot token and chat ID in `.env`
- Ensure bot has been started in Telegram (send `/start` to your bot)
- Bot will retry connection in background if Telegram is temporarily unavailable

### No Pushover alerts
- Verify `PUSHOVER_TOKEN` and `PUSHOVER_USER` in `.env`
- Check logs for Pushover API errors
- Pushover is optional — Telegram alerts work independently

### High memory usage
- Monitor number of active symbols (could be hundreds)
- OI data is stored in memory Map, automatically updated on each fetch

### Rate limit errors
- Bybit may rate limit excessive requests
- Reduce `CONCURRENT_FETCHES` if seeing 429 errors
- The client automatically retries after delays

## License

MIT