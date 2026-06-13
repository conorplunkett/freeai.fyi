// Apply db/seed.sql (one example active campaign): npm run seed
const fs = require("node:fs");
const path = require("node:path");
const { pgPoolConfig } = require("./boot");

(async () => {
  const { Pool } = require("pg");
  const pool = new Pool(pgPoolConfig());
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "seed.sql"), "utf8");
  await pool.query(sql);
  await pool.end();
  console.log("[freeai] seed applied — one active campaign");
})().catch((err) => {
  console.error("[freeai] seed failed:", err.message);
  process.exit(1);
});
