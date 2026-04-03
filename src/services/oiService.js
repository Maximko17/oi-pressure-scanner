import bybitClient from '../api/bybitClient.js';
import { createLogger } from '../utils/logger.js';
import { config } from '../config/config.js';
import pLimit from 'p-limit';

const logger = createLogger('oi');

class OIService {
  constructor() {
    // Map<symbol, {
    //   value: number,           // current OI
    //   change5m: number | null, // 5min change %
    //   change15m: number | null, // 15min change %
    //   candleTs5m: number,      // last processed 5min candle timestamp
    //   candleTs15m: number,     // last processed 15min candle timestamp
    //   fetchTime: Date          // last update time
    // }>
    this.currentOI = new Map();
    this.fetchInterval = null;
    this.limit = pLimit(config.app.concurrentFetches);
  }

  /**
   * Start the OI fetch loop (controlled by app.js)
   */
  start() {
    logger.info('OI service ready (fetching controlled by app.js)');
  }

  /**
   * Stop the OI fetch loop
   */
  stop() {
    logger.info('OI service stopped');
  }

  /**
   * Fetch OI for a single symbol
   */
  async fetchOIForSymbol(symbol, intervalTime = '5min') {
  return this.limit(async () => {
    try {
      logger.debug('Fetching OI for symbol', { symbol, intervalTime });

      const dataList = await bybitClient.fetchOpenInterest(symbol, intervalTime, 2);

      if (!dataList || dataList.length < 2) {
        logger.warn('Insufficient OI data returned', {
          symbol,
          intervalTime,
          count: dataList?.length || 0,
        });
        return null;
      }

      // Safe sort (do not mutate original array)
      const sortedList = [...dataList].sort((a, b) => {
        return parseInt(a.timestamp || 0) - parseInt(b.timestamp || 0);
      });

      const previous = sortedList[sortedList.length - 2];
      const latestCandle = sortedList[sortedList.length - 1];

      const prevTs = parseInt(previous.timestamp || 0);
      const currentTimestamp = parseInt(latestCandle.timestamp || 0);

      if (!prevTs || !currentTimestamp) {
        logger.warn('Invalid timestamps in OI data', {
          symbol,
          intervalTime,
          prevTs,
          currentTimestamp,
        });
        return null;
      }

      // Validate interval gap
      const expectedGap =
        intervalTime === '5min'
          ? 5 * 60 * 1000
          : intervalTime === '15min'
          ? 15 * 60 * 1000
          : null;

      if (expectedGap) {
        const diff = currentTimestamp - prevTs;

        if (Math.abs(diff - expectedGap) > 60 * 1000) {
          logger.warn('Invalid interval gap detected', {
            symbol,
            intervalTime,
            diff,
            expectedGap,
          });
          return null;
        }
      }

      // Get existing data
      const existingData = this.currentOI.get(symbol) || {};

      const existingTs =
        intervalTime === '5min'
          ? existingData.candleTs5m
          : existingData.candleTs15m;

      if (existingTs && existingTs === currentTimestamp) {
        logger.debug('Candle already processed, skipping', {
          symbol,
          intervalTime,
          timestamp: currentTimestamp,
        });
        return null;
      }

      logger.debug('New candle detected', {
        symbol,
        intervalTime,
        timestamp: currentTimestamp,
        previousTimestamp: existingTs,
      });

      const previousOI = parseFloat(previous.openInterest || 0);
      const currentOI = parseFloat(latestCandle.openInterest || 0);

      if (
        isNaN(previousOI) ||
        isNaN(currentOI) ||
        previousOI <= 0 ||
        currentOI <= 0
      ) {
        logger.warn('Invalid OI values', {
          symbol,
          intervalTime,
          previousOI,
          currentOI,
        });
        return null;
      }

      const changePercent = ((currentOI - previousOI) / previousOI) * 100;

      const updatedData = {
        ...existingData,
        value: currentOI,
        fetchTime: new Date(),
      };

      if (intervalTime === '5min') {
        updatedData.change5m = changePercent;
        updatedData.candleTs5m = currentTimestamp;
        updatedData.previousOI5m = previousOI;
        updatedData.currentOI5m = currentOI;
      } else if (intervalTime === '15min') {
        updatedData.change15m = changePercent;
        updatedData.candleTs15m = currentTimestamp;
        updatedData.previousOI15m = previousOI;
        updatedData.currentOI15m = currentOI;
      }

      this.currentOI.set(symbol, updatedData);

      logger.debug('OI data updated', {
        symbol,
        intervalTime,
        changePercent,
        currentOI,
      });

      return {
        symbol,
        intervalTime,
        previousOI,
        currentOI,
        changePercent,
      };
    } catch (error) {
      logger.error('Failed to fetch OI for symbol', {
        symbol,
        intervalTime,
        error: error.message,
      });
      return null;
    }
  });
}

  /**
   * Get OI change for a symbol with specific interval
   * Tries to fetch fresh data first; if candle unchanged, returns cached data
   */
  async getOIChange(symbol, intervalTime) {
    const result = await this.fetchOIForSymbol(symbol, intervalTime);
    if (result) {
      return {
        changePercent: Number(result.changePercent.toFixed(2)),
        available: true,
        currentOI: result.currentOI,
        previousOI: result.previousOI,
      };
    }

    // No new data, return cached if available
    const cached = this.getCachedOIChange(symbol, intervalTime);
    if (cached.available) {
      logger.debug('Returning cached OI change (candle unchanged)', {
        symbol,
        intervalTime,
        changePercent: cached.changePercent,
      });
      return cached;
    }

    return { changePercent: 0, available: false, currentOI: null, previousOI: null };
  }

  /**
   * Get cached OI change data without making API call
   * Returns the last calculated change from memory
   */
  getCachedOIChange(symbol, intervalTime) {
    const data = this.currentOI.get(symbol);
    if (!data) {
      return { changePercent: 0, available: false, currentOI: null, previousOI: null };
    }

    const changeField = intervalTime === '5min' ? 'change5m' : 'change15m';
    const change = data[changeField];

    if (change === null || change === undefined) {
      return { changePercent: 0, available: false, currentOI: data.value, previousOI: null };
    }

    return {
      changePercent: Number(change.toFixed(2)),
      available: true,
      currentOI: data.value,
      previousOI: null,
    };
  }

  /**
   * Get symbol data (cached) - no API call
   * Used by telegramService for display purposes
   */
  getSymbolData(symbol) {
    const data = this.currentOI.get(symbol);
    if (!data) {
      return null;
    }

    return {
      currentOI: data.value,
      change5m: data.change5m,
      change15m: data.change15m,
      previousOI5m: data.previousOI5m,
      currentOI5m: data.currentOI5m,
      previousOI15m: data.previousOI15m,
      currentOI15m: data.currentOI15m,
      available: data.change5m !== null && data.change15m !== null,
      fetchTime: data.fetchTime,
    };
  }

  /**
   * Get current OI value for a symbol
   */
  getCurrentOI(symbol) {
    const data = this.currentOI.get(symbol);
    return data ? data.value : null;
  }

  /**
   * Get all monitored symbols
   */
  getMonitoredSymbols() {
    return Array.from(this.currentOI.keys());
  }

  /**
   * Fetch OI for all active symbols (5min interval)
   */
  async fetchAllOpenInterest(symbols = null) {
    const symbolsToFetch = symbols || (this.currentOI.size === 0 ? this.getMonitoredSymbols() : Array.from(this.currentOI.keys()));

    logger.debug('Symbols to fetch for OI update', {
      count: symbolsToFetch.length,
      symbols: symbolsToFetch.slice(0, 10),
    });

    if (symbolsToFetch.length === 0) {
      logger.warn('No symbols to fetch OI for');
      return;
    }

    // Create array of fetch promises (all 5min)
    const fetchPromises = symbolsToFetch.map((symbol) =>
      this.fetchOIForSymbol(symbol, '5min')
    );

    // Wait for all to complete
    const results = await Promise.all(fetchPromises);

    // Count successes
    const successCount = results.filter((r) => r !== null).length;
    logger.debug('OI fetch batch completed', {
      total: symbolsToFetch.length,
      success: successCount,
    });
  }
}

export default new OIService();