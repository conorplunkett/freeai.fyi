// Boot the real server: node src/index.js
const { createApp } = require("./app");
const { boot } = require("./boot");

boot()
  .then(({ deps }) => {
    const { server } = createApp(deps);
    server.listen(deps.config.port, () => {
      console.log(`[betterbacks] api listening on :${deps.config.port} — developers keep ${deps.config.revenueShare * 100}%`);
    });
  })
  .catch((err) => {
    console.error("[betterbacks] failed to boot:", err.message);
    process.exit(1);
  });
