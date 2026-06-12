// Boot the real server: node src/index.js
const { createApp } = require("./app");
const { boot } = require("./boot");

boot()
  .then(({ deps, pool }) => {
    const { server } = createApp(deps);
    server.listen(deps.config.port, () => {
      console.log(`[freeai] api on :${deps.config.port} — developers keep ${deps.config.revenueShare * 100}%`);
    });
    // periodic rate-limiter sweep
    const sweep = setInterval(() => deps.rateLimiter.sweep(), 300000).unref();

    async function shutdown(sig) {
      console.log(`[freeai] ${sig} — draining…`);
      clearInterval(sweep);
      server.close(async () => {
        try { await pool.end(); } catch {}
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10000).unref(); // hard stop
    }
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  })
  .catch((err) => {
    console.error("[freeai] failed to boot:", err.message);
    process.exit(1);
  });
