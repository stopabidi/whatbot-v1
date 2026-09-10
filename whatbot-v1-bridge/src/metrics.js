/**
 * Metrics collection module.
 * Tracks message counts, query types, and response times.
 */

const metrics = {
  messagesReceived: 0,
  messagesSent: 0,
  messagesFailed: 0,
  queriesRag: 0,
  queriesDirect: 0,
  queriesFile: 0,
  responseTimes: [],
};

const MAX_RESPONSE_TIMES = 100;

/**
 * Record a metric.
 * @param {string} name - Metric name
 * @param {number} value - Metric value (default: 1 for counters)
 */
export function recordMetric(name, value = 1) {
  if (name === 'responseTime') {
    metrics.responseTimes.push(value);
    if (metrics.responseTimes.length > MAX_RESPONSE_TIMES) {
      metrics.responseTimes.shift();
    }
  } else if (metrics.hasOwnProperty(name)) {
    metrics[name] += value;
  }
}

/**
 * Get current metrics.
 * @returns {object} Current metrics
 */
export function getMetrics() {
  const avgResponseTime = metrics.responseTimes.length > 0
    ? metrics.responseTimes.reduce((a, b) => a + b, 0) / metrics.responseTimes.length
    : 0;

  return {
    ...metrics,
    avgResponseTime,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString(),
  };
}
