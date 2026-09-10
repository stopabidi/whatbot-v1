/**
 * Error tracking module.
 * Logs persistent errors for monitoring.
 */

const ERROR_THRESHOLD = 5;
const BATCH_WINDOW_MS = 60000;

const errorCounts = new Map();

/**
 * Track an error and log if persistent.
 * @param {string} component - The component where the error occurred
 * @param {Error} error - The error object
 */
export function trackError(component, error) {
  const key = component;
  const now = Date.now();

  if (!errorCounts.has(key)) {
    errorCounts.set(key, []);
  }

  const errors = errorCounts.get(key);
  errors.push(now);

  const recent = errors.filter(t => now - t < BATCH_WINDOW_MS);
  errorCounts.set(key, recent);

  if (recent.length >= ERROR_THRESHOLD) {
    const windows = new Set(recent.map(t => Math.floor(t / 10000)));
    if (windows.size >= 3) {
      console.error(`[ALERT] Persistent errors in ${component} (${recent.length} in ${Math.round(BATCH_WINDOW_MS/1000)}s): ${error.message}`);
    }
  }
}
