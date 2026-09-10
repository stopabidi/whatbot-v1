/**
 * Rate limiter with sliding window and daily limits.
 */

const slidingWindows = new Map();
const dailyCounts = new Map();

const WINDOW_MS = 60000;  // 1 minute window
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;  // 24 hours

const LIMITS = {
  approved: { window: WINDOW_MS, max: 30 },
  unknown: { window: WINDOW_MS, max: 5 },
};

const DAILY_LIMITS = {
  approved: 50,
  unknown: 10,
};

// Clean up old entries every hour
setInterval(() => {
  const now = Date.now();

  for (const [key, timestamps] of slidingWindows) {
    const recent = timestamps.filter(t => now - t < WINDOW_MS);
    if (recent.length === 0) {
      slidingWindows.delete(key);
    } else {
      slidingWindows.set(key, recent);
    }
  }

  for (const [key, info] of dailyCounts) {
    if (now - info.windowStart > DAILY_WINDOW_MS) {
      dailyCounts.delete(key);
    }
  }
}, 60 * 60 * 1000);

function checkSlidingWindow(key, role = 'approved') {
  const now = Date.now();
  const { max, window } = LIMITS[role] || LIMITS.approved;

  if (!slidingWindows.has(key)) {
    slidingWindows.set(key, []);
  }

  const timestamps = slidingWindows.get(key);
  const recent = timestamps.filter(t => now - t < window);
  slidingWindows.set(key, recent);

  if (recent.length >= max) {
    const oldest = recent[0];
    const retryAfter = oldest + window - now;
    return { allowed: false, remaining: 0, retryAfter };
  }

  recent.push(now);
  return { allowed: true, remaining: max - recent.length, retryAfter: 0 };
}

function checkDailyLimit(phone, role = 'approved') {
  const now = Date.now();
  const limit = DAILY_LIMITS[role] || DAILY_LIMITS.approved;

  if (!dailyCounts.has(phone)) {
    dailyCounts.set(phone, { count: 0, windowStart: now });
  }

  const info = dailyCounts.get(phone);

  if (now - info.windowStart > DAILY_WINDOW_MS) {
    info.count = 0;
    info.windowStart = now;
  }

  if (info.count >= limit) {
    return { allowed: false, remaining: 0 };
  }

  info.count++;
  return { allowed: true, remaining: limit - info.count };
}

/**
 * Check if a phone number is rate limited.
 * @param {string} phone - Phone number
 * @returns {boolean} True if rate limited
 */
export function isRateLimited(phone) {
  const slidingResult = checkSlidingWindow(phone, 'approved');
  if (!slidingResult.allowed) {
    return true;
  }

  const dailyResult = checkDailyLimit(phone, 'approved');
  if (!dailyResult.allowed) {
    return true;
  }

  return false;
}
