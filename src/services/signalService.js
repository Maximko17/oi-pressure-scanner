import { createLogger } from '../utils/logger.js';
import { config } from '../config/config.js';

const logger = createLogger('signal');

class SignalService {
  constructor() {
    // Map<symbol, lastAlertTimestamp>
    this.lastAlertTimes = new Map();
  }

  /**
   * Check if a signal should be generated for a symbol
   * Returns signal object or null
   */
  async checkSignal(symbol, oiService) {
    try {
      // Check cooldown
      if (this.isInCooldown(symbol)) {
        logger.debug('Symbol in cooldown, skipping', { symbol });
        return null;
      }

      // Get 5-minute OI change (primary signal)
      const change5m = await oiService.getOIChange(symbol, '5min');

      if (!change5m.available) {
        logger.debug('5min OI change not available', { symbol });
        return null;
      }

      const changePercent = change5m.changePercent;

      // Determine signal type and strength based on SIGN of change
      const signalInfo = this.determineSignal(changePercent);
      if (!signalInfo) {
        logger.debug('Change below threshold', { symbol, changePercent });
        return null;
      }

      // Enhancement: fetch 15-minute data for confirmation
      const change15m = await oiService.getOIChange(symbol, '15min');

      if (!change15m.available) {
        logger.debug('15min OI change not available, cannot confirm', { symbol });
        return null;
      }

      // 15-minute change must confirm same direction
      const direction = changePercent > 0 ? 'positive' : 'negative';
      const oppositeDirection = changePercent > 0 ? 'negative' : 'positive';

      if (direction === 'positive' && change15m.changePercent <= 0) {
        logger.debug('15m change not positive, rejecting buildup signal', {
          symbol,
          change5m: change5m.changePercent,
          change15m: change15m.changePercent,
        });
        return null;
      }
      if (direction === 'negative' && change15m.changePercent >= 0) {
        logger.debug('15m change not negative, rejecting liquidation signal', {
          symbol,
          change5m: change5m.changePercent,
          change15m: change15m.changePercent,
        });
        return null;
      }

      // Additional enhancement: if 15m signal is stronger, boost it
      const strength15m = this.determineSignal(change15m.changePercent);
      if (strength15m && strength15m.level !== signalInfo.level) {
        if (strength15m.level > signalInfo.level) {
          signalInfo = strength15m;
          logger.debug('Signal strength boosted by 15m confirmation', {
            symbol,
            type: signalInfo.type,
            original: signalInfo.level,
            boosted: strength15m.level,
          });
        }
      }

      // Set cooldown
      this.setCooldown(symbol);

      return {
        symbol,
        type: signalInfo.type,
        change5m: change5m.changePercent,
        change15m: change15m.changePercent,
        strength: signalInfo.level,
        currentOI: change5m.currentOI,
        previousOI5m: change5m.previousOI,
        currentOI5m: change5m.currentOI,
        previousOI15m: change15m.previousOI,
        currentOI15m: change15m.currentOI,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      logger.error('Error checking signal', { symbol, error: error.message });
      return null;
    }
  }

  /**
   * Determine signal type (BUILDUP/LIQUIDATION) and strength based on percentage change
   * @returns {null|{type: string, level: string, multiplier: number}}
   */
  determineSignal(changePercent) {
    // Buildup (OI increasing)
    if (changePercent >= 25) {
      return { type: 'BUILDUP', level: 'EXTREME', multiplier: 1.0 };
    } else if (changePercent >= 15) {
      return { type: 'BUILDUP', level: 'STRONG', multiplier: 0.8 };
    } else if (changePercent >= 10) {
      return { type: 'BUILDUP', level: 'WEAK', multiplier: 0.6 };
    }

    // Liquidation (OI decreasing)
    if (changePercent <= -20) {
      return { type: 'LIQUIDATION', level: 'EXTREME', multiplier: 1.0 };
    } else if (changePercent <= -15) {
      return { type: 'LIQUIDATION', level: 'STRONG', multiplier: 0.8 };
    } else if (changePercent <= -10) {
      return { type: 'LIQUIDATION', level: 'WEAK', multiplier: 0.6 };
    }

    return null; // Below threshold
  }

  /**
   * Check if symbol is in cooldown period
   */
  isInCooldown(symbol) {
    const lastAlert = this.lastAlertTimes.get(symbol);
    if (!lastAlert) {
      return false;
    }

    const cooldownMs = config.app.alertCooldownMinutes * 60 * 1000;
    const now = Date.now();
    return now - lastAlert < cooldownMs;
  }

  /**
   * Set cooldown for a symbol
   */
  setCooldown(symbol) {
    this.lastAlertTimes.set(symbol, Date.now());
    logger.debug('Cooldown set for symbol', { symbol });
  }

  /**
   * Get remaining cooldown time in minutes
   */
  getRemainingCooldown(symbol) {
    const lastAlert = this.lastAlertTimes.get(symbol);
    if (!lastAlert) {
      return 0;
    }

    const cooldownMs = config.app.alertCooldownMinutes * 60 * 1000;
    const elapsed = Date.now() - lastAlert;
    const remainingMs = cooldownMs - elapsed;

    return remainingMs > 0 ? Math.ceil(remainingMs / (60 * 1000)) : 0;
  }

  /**
   * Clear cooldown for a symbol (useful for testing)
   */
  clearCooldown(symbol) {
    this.lastAlertTimes.delete(symbol);
  }

  /**
   * Get all symbols currently in cooldown
   */
  getCooldownSymbols() {
    const cooldownSymbols = [];
    for (const [symbol, timestamp] of this.lastAlertTimes.entries()) {
      if (this.isInCooldown(symbol)) {
        cooldownSymbols.push({
          symbol,
          remainingMinutes: this.getRemainingCooldown(symbol),
        });
      }
    }
    return cooldownSymbols;
  }
}

export default new SignalService();