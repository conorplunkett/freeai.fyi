// Apply db/schema.sql: npm run migrate
const fs = require("node:fs");
const path = require("node:path");

(async () => {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8");
  await pool.query(sql);
  await pool.end();
  console.log("[freeai] schema applied");
})().catch((err) => {
  console.error("[freeai] migrate failed:", err.message);
  process.exit(1);
});
