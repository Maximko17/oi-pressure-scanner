import winston from 'winston';

// Define log format for console
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(
    ({ timestamp, level, message, service, ...meta }) => {
      let msg = `${timestamp} [${service}] ${level}: ${message}`;
      if (Object.keys(meta).length > 0) {
        msg += ` ${JSON.stringify(meta)}`;
      }
      return msg;
    }
  )
);

// Create a logger factory that returns a logger for a specific service
export function createLogger(serviceName) {
  const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: consoleFormat,
    defaultMeta: { service: serviceName },
    transports: [
      new winston.transports.Console(),
    ],
  });

  return logger;
}

// Default logger for general use (backward compatibility)
export const logger = createLogger('app');