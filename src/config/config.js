import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const config = {
  bybit: {
    apiBase: process.env.BYBIT_API_BASE || 'https://api.bybit.com',
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },

  pushover: {
    token: process.env.PUSHOVER_TOKEN,
    user: process.env.PUSHOVER_USER,
  },

  app: {
    symbolRefreshIntervalMs: parseInt(process.env.SYMBOL_REFRESH_INTERVAL_MS || '900000', 10),
    oiFetchIntervalMs: parseInt(process.env.OI_FETCH_INTERVAL_MS || '60000', 10),
    alertCooldownMinutes: parseInt(process.env.ALERT_COOLDOWN_MINUTES || '10', 10),
    cascadeWindowMinutes: parseInt(process.env.CASCADE_WINDOW_MINUTES || '30', 10),
    concurrentFetches: parseInt(process.env.CONCURRENT_FETCHES || '20', 10),
  },
};

// Validation
export function validateConfig() {
  const errors = [];

  if (!config.telegram.botToken) {
    errors.push('TELEGRAM_BOT_TOKEN is required');
  }

  if (!config.telegram.chatId) {
    errors.push('TELEGRAM_CHAT_ID is required');
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
  }
}

validateConfig();