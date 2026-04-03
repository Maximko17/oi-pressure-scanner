import { createLogger } from '../utils/logger.js';
import symbolService from './symbolService.js';
import oiService from './oiService.js';
import signalService from './signalService.js';

const logger = createLogger('telegram');

// UI screen states
const SCREEN = {
  LIST: 'LIST',
  DETAILS: 'DETAILS',
};

class TelegramService {
  constructor() {
    this.bot = null;
    this.isConnected = false;
    // Map<chatId, { messageId: number, state: string, data: any }>
    this.chatUI = new Map();
  }

  /**
   * Set the Telegram bot instance (dependency injection)
   */
  setBot(bot) {
    this.bot = bot;
  }

  /**
   * Initialize Telegram service (assumes bot already set)
   * Returns true on success, false on failure (caller handles retries)
   */
  async initialize() {
    if (!this.bot) {
      logger.error('Cannot initialize telegram service: bot not set');
      return false;
    }

    try {
      // Register commands in Telegram slash menu
      await this.bot.setMyCommands([
        { command: '/list', description: 'Show tracked symbols' },
        { command: '/strategy', description: 'Bot trading strategy' }
      ]);
      logger.info('Command menu registered', { commands: ['/list', '/strategy'] });

      // Set up command handlers
      this.setupHandlers();

      // Test connection
      const botInfo = await this.bot.getMe();
      logger.info('Telegram service initialized', {
        username: botInfo.username,
        botId: botInfo.id,
      });
      this.isConnected = true;
      return true;
    } catch (error) {
      logger.error('Failed to initialize Telegram service', { error: error.message });
      this.isConnected = false;
      return false;
    }
  }

  /**
   * Set up all command and callback handlers
   */
  setupHandlers() {
    // Handle /list command (matches /list, /list , /list@botname, etc.)
    this.bot.onText(/^\/list(?:\s|@|$)/, async (msg) => {
      const chatId = msg.chat.id;
      const userId = msg.from?.id;
      const userName = msg.from?.username || msg.from?.first_name;

      logger.info('Received /list command', { chatId, userId, userName });

      try {
        await this.renderListScreen(chatId);
      } catch (error) {
        logger.error('Error handling /list command', { error: error.message });
        this.bot.sendMessage(chatId, '❌ Error processing command. Please try again.');
      }
    });

    // Handle callback queries (button clicks)
    this.bot.on('callback_query', async (callbackQuery) => {
      const chatId = callbackQuery.message.chat.id;
      const userId = callbackQuery.from?.id;
      const action = callbackQuery.data;

      logger.info('Received callback query', { chatId, userId, action });

      try {
        if (action === 'BACK') {
          // Navigate back to list
          await this.renderListScreen(chatId);
        } else {
          // Treat as symbol selection
          await this.renderDetailsScreen(chatId, action);
        }
        // Answer callback to remove loading state
        await this.bot.answerCallbackQuery(callbackQuery.id);
      } catch (error) {
        logger.error('Error handling callback', { action, error: error.message });
        await this.bot.answerCallbackQuery(callbackQuery.id, {
          text: 'Error loading data',
          show_alert: true,
        });
      }
    });

    // Handle /strategy command (matches /strategy, /strategy , /strategy@botname, etc.)
    this.bot.onText(/^\/strategy(?:\s|@|$)/, async (msg) => {
      const chatId = msg.chat.id;
      logger.info('Received /strategy command', { chatId });
      try {
        await this.handleStrategyCommand(chatId);
      } catch (error) {
        logger.error('Error handling /strategy command', { error: error.message });
        this.bot.sendMessage(chatId, '❌ Error processing command. Please try again.');
      }
    });

    // Note: We don't handle unknown commands - let them be ignored
  }

  /**
   * Core method: render a screen by editing the active message or creating a new one
   */
  async renderScreen(chatId, screen, text, keyboard) {
    const uiState = this.chatUI.get(chatId);
    const previousState = uiState?.state || null;

    try {
      if (uiState?.messageId) {
        // Try to edit existing message
        await this.bot.editMessageText(text, {
          chat_id: chatId,
          message_id: uiState.messageId,
          parse_mode: 'HTML',
          reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
          disable_web_page_preview: screen === SCREEN.DETAILS ? false : true,
        });
        logger.debug('UI message edited', { chatId, messageId: uiState.messageId, screen });
      } else {
        throw new Error('No active message ID');
      }
    } catch (error) {
      // Edit failed — send new message
      logger.warn('UI edit failed, sending new message', { chatId, error: error.message });
      const sentMsg = await this.bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
        disable_web_page_preview: screen === SCREEN.DETAILS ? false : true,
      });
      // Update active message
      this.chatUI.set(chatId, {
        messageId: sentMsg.message_id,
        state: screen,
        data: screen === SCREEN.DETAILS ? this.chatUI.get(chatId)?.data : null,
      });
      logger.info('UI message created (fallback)', { chatId, messageId: sentMsg.message_id, screen });
      return;
    }

    // Update state on successful edit
    this.chatUI.set(chatId, {
      messageId: uiState?.messageId,
      state: screen,
      data: screen === SCREEN.DETAILS ? this.chatUI.get(chatId)?.data : null,
    });

    if (previousState !== screen) {
      logger.info('UI state transition', { chatId, from: previousState, to: screen });
    }
  }

  /**
   * Render the LIST screen — shows tracked symbols grid
   */
  async renderListScreen(chatId) {
    const activeSymbols = symbolService.getActiveSymbols();

    if (activeSymbols.length === 0) {
      // No symbols — just send/update a simple message
      await this.renderScreen(chatId, SCREEN.LIST, '📭 No active symbols currently being monitored.', null);
      return;
    }

    const keyboard = this.createSymbolKeyboard(activeSymbols);
    const text = '📊 <b>Tracked Symbols</b>\n\nClick a symbol to view detailed analytics:';

    await this.renderScreen(chatId, SCREEN.LIST, text, keyboard);
  }

  /**
   * Render the DETAILS screen — shows symbol data with back button
   */
  async renderDetailsScreen(chatId, symbol) {
    const backKeyboard = [[{ text: '⬅ Back to List', callback_data: 'BACK' }]];

    // Check if symbol is being tracked
    if (!symbolService.isActive(symbol)) {
      const uiState = this.chatUI.get(chatId);
      if (uiState?.messageId) {
        await this.bot.editMessageText(`⚠️ Symbol <b>${symbol}</b> is not currently tracked.`, {
          chat_id: chatId,
          message_id: uiState.messageId,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: backKeyboard },
        });
      } else {
        await this.bot.sendMessage(chatId, `⚠️ Symbol <b>${symbol}</b> is not currently tracked.`, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: backKeyboard },
        });
      }
      logger.warn('Requested symbol not tracked', { chatId, symbol });
      return;
    }

    // Check if OI data exists
    const symbolData = oiService.getSymbolData(symbol);
    if (!symbolData || symbolData.currentOI === null) {
      const uiState = this.chatUI.get(chatId);
      if (uiState?.messageId) {
        await this.bot.editMessageText(`⏳ OI data for <b>${symbol}</b> is still loading. Please wait 1-2 minutes and try again.`, {
          chat_id: chatId,
          message_id: uiState.messageId,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: backKeyboard },
        });
      } else {
        await this.bot.sendMessage(chatId, `⏳ OI data for <b>${symbol}</b> is still loading. Please wait 1-2 minutes and try again.`, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: backKeyboard },
        });
      }
      logger.warn('OI data not ready for symbol', { chatId, symbol });
      return;
    }

    // Store current symbol in UI state
    const existingState = this.chatUI.get(chatId);
    this.chatUI.set(chatId, {
      messageId: existingState?.messageId || null,
      state: SCREEN.DETAILS,
      data: { symbol },
    });

    const message = this.formatSymbolDetails(symbol, symbolData);
    const keyboard = [[{ text: '⬅ Back to List', callback_data: 'BACK' }]];

    await this.renderScreen(chatId, SCREEN.DETAILS, message, keyboard);
  }

  /**
   * Create inline keyboard layout for symbols
   * Max 3 buttons per row
   */
  createSymbolKeyboard(symbols) {
    const keyboard = [];
    const buttonsPerRow = 3;

    for (let i = 0; i < symbols.length; i += buttonsPerRow) {
      const row = symbols.slice(i, i + buttonsPerRow).map((symbol) => ({
        text: symbol,
        callback_data: symbol,
      }));
      keyboard.push(row);
    }

    return keyboard;
  }

  /**
   * Format detailed symbol information message using cached data
   */
  formatSymbolDetails(symbol, symbolData) {
    const { currentOI, change5m, change15m, previousOI5m, currentOI5m, previousOI15m, currentOI15m, available, fetchTime } = symbolData;

    // Determine signal type and strength based on 5m change
    let signalType = 'NONE';
    let signalStrength = 'NONE';
    if (change5m !== null && change5m !== undefined) {
      const signalInfo = signalService.determineSignal(change5m);
      if (signalInfo) {
        signalType = signalInfo.type;
        signalStrength = signalInfo.level;
      }
    }

    // Get market info from symbolService
    const activeSymbols = symbolService.activeSymbols;
    const symbolInfo = activeSymbols.find((s) => s.symbol === symbol);

    if (!symbolInfo) {
      return null;
    }

    // Format 24h volume (turnover)
    const volumeFormatted = this.formatNumber(symbolInfo.turnover24h);
    const rangePercent = (symbolInfo.volatility * 100).toFixed(2);

    // Format changes with proper sign
    const formatChange = (val) => {
      if (val === null || val === undefined) return 'N/A';
      return `${val >= 0 ? '+' : ''}${val.toFixed(2)}%`;
    };

    // Format OI values with previous→current notation
    const formatOIPair = (prev, curr) => {
      if (prev == null || curr == null) return '';
      return ` (${prev.toLocaleString()} → ${curr.toLocaleString()})`;
    };

    const change5mText = formatChange(change5m);
    const change15mText = formatChange(change15m);

    // Build message
    const bybitUrl = `https://www.bybit.com/trade/usdt/${symbol}`;
    const coinglassUrl = `https://www.coinglass.com/tv/ru/Bybit_${symbol}`;

    return `
      📊 Symbol: <b>${symbol}</b>

      Open Interest:
      • 5m change: <b>${change5mText}</b>${formatOIPair(previousOI5m, currentOI5m)}
      • 15m change: <b>${change15mText}</b>${formatOIPair(previousOI15m, currentOI15m)}

      Status:
      • Signal strength: <b>${signalStrength}</b>
      • Event type: <b>${signalType}</b>

      Market Info:
      • 24h Volume: <b>$${volumeFormatted}</b>
      • 24h Price Range: <b>${rangePercent}%</b>

      Links:
      Bybit: ${bybitUrl}
      Coinglass: ${coinglassUrl}
    `.trim();
  }

  /**
   * Handle /strategy command - send bot strategy description
   * ALWAYS sends a NEW message, does NOT interact with UI state
   */
  async handleStrategyCommand(chatId) {
    // Clear UI state so next /list creates a fresh message at the bottom
    this.chatUI.delete(chatId);

    const message = `
      📊 <b>Trading Strategy Overview</b>

      This bot monitors <b>Open Interest (OI)</b> on Bybit cryptocurrency futures to detect abnormal market activity.

      ━━━━━━━━━━━━━━━━━━━━━

      🎯 <b>What the Bot Monitors</b>

      • Open Interest changes on USDT perpetual futures
      • Real-time OI data from Bybit API

      📋 <b>Symbol Selection</b>

      • High 24h volume (turnover > $50M)
      • High 24h volatility (price range > 5%)
      • Active symbols refreshed every 15 minutes

      ━━━━━━━━━━━━━━━━━━━━━

      📈 <b>Signal Types</b>

      🟢 <b>BUILDUP</b>
      • OI is increasing
      • New positions are being opened
      • Market is preparing for a move

      🔴 <b>LIQUIDATION</b>
      • OI is decreasing
      • Positions are being closed or liquidated
      • Movement is already happening

      ━━━━━━━━━━━━━━━━━━━━━

      ⏱ <b>Timeframes</b>

      • <b>5-minute OI</b> → primary signal trigger
      • <b>15-minute OI</b> → confirmation (must match direction)

      ━━━━━━━━━━━━━━━━━━━━━

      💪 <b>Signal Strength</b>

      Based on the percentage change in OI:

      🟡 <b>WEAK</b> — 10–15% change
      🟠 <b>STRONG</b> — 15–25% change
      🔴 <b>EXTREME</b> — 25%+ change

      ━━━━━━━━━━━━━━━━━━━━━

      🔔 <b>Alerts</b>

      When a signal is detected, the bot sends a Telegram notification with the symbol, OI changes, signal type, and strength.

      Cooldown: 10 minutes per symbol to avoid spam.
    `.trim();

    await this.bot.sendMessage(chatId, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    logger.info('Sent strategy description', { chatId });
  }

  /**
   * Format large numbers with commas
   */
  formatNumber(num) {
    if (num >= 1_000_000_000) {
      return (num / 1_000_000_000).toFixed(2) + 'B';
    } else if (num >= 1_000_000) {
      return (num / 1_000_000).toFixed(2) + 'M';
    } else if (num >= 1_000) {
      return (num / 1_000).toFixed(2) + 'K';
    }
    return num.toFixed(2);
  }
}

export default new TelegramService();