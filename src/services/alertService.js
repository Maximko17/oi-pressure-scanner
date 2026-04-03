import { createLogger } from '../utils/logger.js';
import { config } from '../config/config.js';

const logger = createLogger('alert');

class AlertService {
  constructor() {
    this.bot = null;
    this.isConnected = false;
  }

  /**
 * Set the Telegram bot instance (dependency injection)
 */
setBot(bot) {
  this.bot = bot;
}

/**
 * Initialize alert service (assumes bot already set)
 * Returns true on success, false on failure (caller handles retries)
 */
async initialize() {
  if (!this.bot) {
    logger.error('Cannot initialize alert service: bot not set');
    return false;
  }

  try {
    // Test connection
    const botInfo = await this.bot.getMe();
    logger.info('Alert service initialized', {
      username: botInfo.username,
      botId: botInfo.id,
    });
    this.isConnected = true;
    return true;
  } catch (error) {
    logger.error('Failed to initialize alert service', { error: error.message });
    this.isConnected = false;
    return false;
  }
}

  /**
   * Send OI spike alert via Telegram and Pushover
   */
  async sendOISpikeAlert(signal) {
    if (!this.isConnected || !this.bot) {
      logger.error('Telegram bot not initialized');
      return false;
    }

    try {
      const { symbol, type, change5m, change15m, strength, currentOI, previousOI5m, currentOI5m, previousOI15m, currentOI15m, timestamp } = signal;

      // Format message according to specification
      const message = this.formatAlertMessage({
        symbol,
        type,
        change5m,
        change15m,
        strength,
        currentOI,
        previousOI5m,
        currentOI5m,
        previousOI15m,
        currentOI15m,
        timestamp,
      });

      await this.bot.sendMessage(config.telegram.chatId, message, {
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      });

      logger.info('Telegram alert sent', {
        symbol,
        type,
        strength,
        change5m,
        change15m,
      });
    } catch (error) {
      logger.error('Failed to send Telegram alert', {
        symbol: signal.symbol,
        error: error.message,
      });
      return false;
    }

    // Send Pushover notification (non-blocking, never breaks flow)
    this.sendPushoverAlert(signal).catch((err) => {
      logger.error('Pushover alert failed', { error: err.message });
    });

    return true;
  }

  /**
   * Send alert via Pushover HTTP API
   */
  async sendPushoverAlert(signal) {
    if (!config.pushover.token || !config.pushover.user) {
      logger.debug('Pushover not configured, skipping');
      return;
    }

    const { symbol, type, change5m, change15m, strength, currentOI, timestamp } = signal;

    const formatChange = (val) => (val >= 0 ? `+${val.toFixed(2)}%` : `${val.toFixed(2)}%`);
    const strengthEmoji = this.getStrengthEmoji(strength);

    const message = [
      `OI Event Detected ${strengthEmoji}`,
      ``,
      `Symbol: ${symbol}`,
      `Type: ${type}`,
      ``,
      `OI Change:`,
      `  5m:  ${formatChange(change5m)}`,
      `  15m: ${formatChange(change15m)}`,
      ``,
      `Signal Strength: ${strength}`,
      `Current OI: ${currentOI.toLocaleString()}`,
      ``,
      `Bybit: https://www.bybit.com/trade/usdt/${symbol}`,
      `Coinglass: https://www.coinglass.com/tv/ru/Bybit_${symbol}`,
      ``,
      `Timestamp: ${new Date(timestamp).toUTCString()}`,
    ].join('\n');

    const priority = strength === 'EXTREME' ? 2 : strength === 'STRONG' ? 1 : 0;

    const body = new URLSearchParams({
      token: config.pushover.token,
      user: config.pushover.user,
      message,
      title: `OI Alert: ${symbol}`,
      priority: String(priority),
    });

    logger.info('Sending Pushover alert', { symbol, strength, priority });

    const response = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Pushover API error ${response.status}: ${text}`);
    }

    logger.info('Pushover alert sent', { symbol, strength });
  }

  /**
   * Format alert message according to specification
   */
  formatAlertMessage({ symbol, type, change5m, change15m, strength, currentOI, previousOI5m, currentOI5m, previousOI15m, currentOI15m, timestamp }) {
    const bybitUrl = `https://www.bybit.com/trade/usdt/${symbol}`;
    const coinglassUrl = `https://www.coinglass.com/tv/ru/Bybit_${symbol}`;

    // Format timestamp to UTC
    const utcTime = new Date(timestamp).toUTCString();

    // Add emoji based on strength
    const strengthEmoji = this.getStrengthEmoji(strength);

    // Format percentage changes with proper sign
    const formatChange = (val) => (val >= 0 ? `+${val.toFixed(2)}%` : `${val.toFixed(2)}%`);

    // Format OI values with previous→current notation
    const formatOIPair = (prev, curr) => {
      if (prev == null || curr == null) return '';
      return ` (${prev.toLocaleString()} → ${curr.toLocaleString()})`;
    };

    return `
      🚨 OI Event Detected ${strengthEmoji}

      Symbol: <b>${symbol}</b>

      Type: <b>${type}</b>

      OI Change:
      • 5m: <b>${formatChange(change5m)}</b>${formatOIPair(previousOI5m, currentOI5m)}
      • 15m: <b>${formatChange(change15m)}</b>${formatOIPair(previousOI15m, currentOI15m)}

      Signal Strength: <b>${strength}</b>

      Links:
      Bybit: ${bybitUrl}
      Coinglass: ${coinglassUrl}

      Timestamp: ${utcTime}
    `.trim();
  }

  /**
   * Get emoji for signal strength
   */
  getStrengthEmoji(strength) {
    switch (strength) {
      case 'EXTREME':
        return '🔴🔴🔴';
      case 'STRONG':
        return '🟠🟠';
      case 'WEAK':
        return '🟡';
      default:
        return '';
    }
  }

  /**
   * Send test message to verify bot is working
   */
  async sendTestMessage() {
    if (!this.isConnected || !this.bot) {
      throw new Error('Bot not initialized');
    }

    const testMessage = '🟢 OI Spike Detector is online and working!';
    await this.bot.sendMessage(config.telegram.chatId, testMessage);
    logger.info('Test message sent to Telegram');
  }

  /**
   * Send test Pushover message to verify configuration
   */
  async sendPushoverTestMessage() {
    if (!config.pushover.token || !config.pushover.user) {
      logger.debug('Pushover not configured, skipping test message');
      return;
    }

    try {
      const message = '🟢 OI Spike Detector — Pushover is configured and working!';

      const body = new URLSearchParams({
        token: config.pushover.token,
        user: config.pushover.user,
        message,
        title: 'OI Detector Test',
        priority: '0',
      });

      const response = await fetch('https://api.pushover.net/1/messages.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Pushover API error ${response.status}: ${text}`);
      }

      logger.info('Pushover test message sent');
    } catch (error) {
      logger.error('Failed to send Pushover test message', { error: error.message });
    }
  }

}

export default new AlertService();