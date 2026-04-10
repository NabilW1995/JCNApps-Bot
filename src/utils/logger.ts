type LogLevel = 'info' | 'warn' | 'error';

/**
 * Emit a structured JSON log entry to stdout/stderr.
 *
 * Using JSON lines makes it easy to parse logs in Docker,
 * Coolify, and any centralized logging system.
 */
function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data,
  };

  if (level === 'error') {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

export const logger = {
  info: (msg: string, data?: Record<string, unknown>) => log('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => log('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log('error', msg, data),
};
