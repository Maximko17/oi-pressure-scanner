import { createLogger } from '../utils/logger.js';
import { config } from '../config/config.js';

const logger = createLogger('signal');

class SignalService {
  constructor() {
    // Map<symbol, {
    //   lastAlertTime: number | null,          // for cooldown
    //   lastBuildup: {                         // for cascade detection
    //     timestamp: number,
    //     change5m: number,
    //     strength: string
    //   } | null
    // }>
    this.symbolStates = new Map();
  }

  /**
   * Get or create symbol state
   */
  getSymbolState(symbol) {
    if (!this.symbolStates.has(symbol)) {
      this.symbolStates.set(symbol, {
        lastAlertTime: null,
        lastBuildup: null,
      });
    }
    return this.symbolStates.get(symbol);
  }

  /**
   * Check if a signal should be generated for a symbol
   * Returns signal object or null
   */
  async checkSignal(symbol, oiService) {
    try {
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
          signalInfo.type === signalInfo.type; // keep original type
          signalInfo.level = strength15m.level;
          signalInfo.multiplier = strength15m.multiplier;
          logger.debug('Signal strength boosted by 15m confirmation', {
            symbol,
            type: signalInfo.type,
            original: signalInfo.level,
            boosted: strength15m.level,
          });
        }
      }

      // Check for CASCADE: LIQUIDATION after recent BUILDUP
      let isCascade = false;
      let buildupContext = null;
      if (signalInfo.type === 'LIQUIDATION') {
        const state = this.getSymbolState(symbol);
        if (state.lastBuildup) {
          const cascadeWindowMs = config.app.cascadeWindowMinutes * 60 * 1000;
          const timeSinceBuildup = Date.now() - state.lastBuildup.timestamp;
          if (timeSinceBuildup <= cascadeWindowMs) {
            isCascade = true;
            buildupContext = {
              change5m: state.lastBuildup.change5m,
              strength: state.lastBuildup.strength,
              timeAgoMinutes: Math.round(timeSinceBuildup / 60000),
            };
            logger.info('CASCADE detected', {
              symbol,
              buildupChange: buildupContext.change5m,
              buildupStrength: buildupContext.strength,
              minutesSinceBuildup: buildupContext.timeAgoMinutes,
              liquidationChange: changePercent,
            });
          } else {
            logger.debug('Buildup too old for cascade', {
              symbol,
              minutesAgo: Math.round(timeSinceBuildup / 60000),
            });
          }
        }
      }

      // Determine final signal type
      const finalType = isCascade ? 'CASCADE' : signalInfo.type;

      // Check cooldown (CASCADE bypasses it)
      if (!isCascade && this.isInCooldown(symbol)) {
        logger.debug('Symbol in cooldown, skipping', { symbol });
        return null;
      }

      // If BUILDUP → store event for potential cascade detection
      if (signalInfo.type === 'BUILDUP') {
        this.storeBuildupEvent(symbol, signalInfo, change5m.changePercent);
        logger.info('Buildup event stored', {
          symbol,
          change5m: change5m.changePercent,
          strength: signalInfo.level,
        });
      }

      // Set cooldown (not for CASCADE - CASCADE always alerts)
      if (!isCascade) {
        this.setCooldown(symbol);
      } else {
        logger.info('CASCADE bypasses cooldown', { symbol });
      }

      const result = {
        symbol,
        type: finalType,
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

      // Add cascade context if applicable
      if (isCascade && buildupContext) {
        result.buildupChange5m = buildupContext.change5m;
        result.buildupStrength = buildupContext.strength;
        result.buildupTimeAgoMinutes = buildupContext.timeAgoMinutes;
      }

      return result;
    } catch (error) {
      logger.error('Error checking signal', { symbol, error: error.message });
      return null;
    }
  }

  /**
   * Store a BUILDUP event for cascade detection
   */
  storeBuildupEvent(symbol, signalInfo, change5m) {
    const state = this.getSymbolState(symbol);
    state.lastBuildup = {
      timestamp: Date.now(),
      change5m,
      strength: signalInfo.level,
    };
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
    const state = this.symbolStates.get(symbol);
    if (!state || !state.lastAlertTime) {
      return false;
    }

    const cooldownMs = config.app.alertCooldownMinutes * 60 * 1000;
    const now = Date.now();
    return now - state.lastAlertTime < cooldownMs;
  }

  /**
   * Set cooldown for a symbol
   */
  setCooldown(symbol) {
    const state = this.getSymbolState(symbol);
    state.lastAlertTime = Date.now();
    logger.debug('Cooldown set for symbol', { symbol });
  }

  /**
   * Get remaining cooldown time in minutes
   */
  getRemainingCooldown(symbol) {
    const state = this.symbolStates.get(symbol);
    if (!state || !state.lastAlertTime) {
      return 0;
    }

    const cooldownMs = config.app.alertCooldownMinutes * 60 * 1000;
    const elapsed = Date.now() - state.lastAlertTime;
    const remainingMs = cooldownMs - elapsed;

    return remainingMs > 0 ? Math.ceil(remainingMs / (60 * 1000)) : 0;
  }

  /**
   * Clear cooldown for a symbol (useful for testing)
   */
  clearCooldown(symbol) {
    const state = this.symbolStates.get(symbol);
    if (state) {
      state.lastAlertTime = null;
    }
  }

  /**
   * Clear all state for a symbol (useful for testing)
   */
  clearSymbolState(symbol) {
    this.symbolStates.delete(symbol);
  }

  /**
   * Get all symbols currently in cooldown
   */
  getCooldownSymbols() {
    const cooldownSymbols = [];
    for (const [symbol, state] of this.symbolStates.entries()) {
      if (this.isInCooldown(symbol)) {
        cooldownSymbols.push({
          symbol,
          remainingMinutes: this.getRemainingCooldown(symbol),
        });
      }
    }
    return cooldownSymbols;
  }

  /**
   * Get last BUILDUP event for a symbol (for debugging/API)
   */
  getLastBuildup(symbol) {
    const state = this.symbolStates.get(symbol);
    return state?.lastBuildup || null;
  }
}

export default new SignalService();