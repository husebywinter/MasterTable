"use strict";

// Runs a .sql file (split on GO lines) against the database in local.settings.json,
// with the same login as the function (Entra ID via az login, or SQL_CONNECTION_STRING).
// Usage:  node scripts/run-sql.js ../database/assessment.sql

const fs   = require("fs");
const path = require("path");
const sql  = require("mssql");

const settings = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "local.settings.json"), "utf8")).Values;
for (const [k, v] of Object.entries(settings)) if (process.env[k] === undefined) process.env[k] = v;

function config() {
  const server = process.env.SQL_SERVER?.trim(), database = process.env.SQL_DATABASE?.trim();
  if (server && database) {
    return { server, database, options: { encrypt: true },
             authentication: { type: "azure-active-directory-default", options: {} } };
  }
  if (process.env.SQL_CONNECTION_STRING?.trim()) return process.env.SQL_CONNECTION_STRING.trim();
  throw new Error("Fill in SQL_SERVER and SQL_DATABASE in local.settings.json.");
}

(async () => {
  const file = process.argv[2];
  if (!file) throw new Error("Usage: node scripts/run-sql.js <file.sql>");
  const batches = fs.readFileSync(file, "utf8").split(/^\s*GO\s*$/im).map(b => b.trim()).filter(Boolean);
  const pool = await new sql.ConnectionPool(config()).connect();
  try {
    for (const [i, batch] of batches.entries()) {
      const result = await pool.request().batch(batch);
      for (const rs of result.recordsets ?? []) if (rs.length) console.table(rs);
      console.log(`batch ${i + 1}/${batches.length} ok`);
    }
  } finally {
    await pool.close();
  }
})().catch(err => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
