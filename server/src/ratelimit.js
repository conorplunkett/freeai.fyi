// In-memory token-bucket rate limiter, keyed by IP (or device).
// Good enough for a single instance; swap the store for Redis when you scale out.

function createRateLimiter({ capacity = 60, refillPerSec = 1, now = Date.now } = {}) {
  const buckets = new Map(); // key -> { tokens, last }

  function take(key, cost = 1) {
    const t = now();
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: capacity, last: t };
      buckets.set(key, b);
    }
    // refill
    const elapsed = (t - b.last) / 1000;
    b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerSec);
    b.last = t;
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  // occasional sweep so idle keys don't accumulate
  function sweep() {
    const t = now();
    for (const [key, b] of buckets) {
      if (t - b.last > 600000) buckets.delete(key); // 10 min idle
    }
  }

  return { take, sweep, _buckets: buckets };
}

module.exports = { createRateLimiter };
