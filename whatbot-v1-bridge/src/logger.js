/**
 * Structured logging module.
 * Outputs JSON-formatted logs for easy parsing and analysis.
 */

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL || 'info'];

/**
 * Log a structured message.
 * @param {string} level - Log level (debug, info, warn, error)
 * @param {string} component - Component name
 * @param {string} message - Log message
 * @param {object} data - Additional data
 */
function log(level, component, message, data = {}) {
  if (LOG_LEVELS[level] < currentLevel) return;
  
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    component,
    message,
    ...data,
  };
  
  console.log(JSON.stringify(entry));
}

export const logger = {
  debug: (component, message, data) => log('debug', component, message, data),
  info: (component, message, data) => log('info', component, message, data),
  warn: (component, message, data) => log('warn', component, message, data),
  error: (component, message, data) => log('error', component, message, data),
};
