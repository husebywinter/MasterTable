"use strict";

// Row-level save for the Vurderingstabell visual (AssessmentVisual).
// POST /api/assessment/save -> dbo.usp_SaveAssessments (see database/assessment.sql)

const { app } = require("@azure/functions");
const sql     = require("mssql");

let pool = null;

/**
 * Two ways to connect:
 *  - SQL_SERVER + SQL_DATABASE: Microsoft Entra ID, no password. Uses
 *    DefaultAzureCredential - your `az login` locally, the Function App's
 *    managed identity in Azure.
 *  - SQL_CONNECTION_STRING: classic SQL login with user name and password.
 */
function connectionConfig() {
  const server   = process.env.SQL_SERVER?.trim();
  const database = process.env.SQL_DATABASE?.trim();
  if (server && database) {
    return {
      server: server.replace(/^tcp:/i, "").replace(/,\d+$/, ""),
      database,
      authentication: { type: "azure-active-directory-default", options: {} },
      options: { encrypt: true },
    };
  }
  const connStr = process.env.SQL_CONNECTION_STRING?.trim();
  if (connStr && !connStr.includes("<server>") && !connStr.includes("YOUR_SERVER")) return connStr;
  throw new Error("Set SQL_SERVER and SQL_DATABASE (Entra ID) or SQL_CONNECTION_STRING in the application settings.");
}

async function getPool() {
  if (pool) return pool;
  pool = await new sql.ConnectionPool(connectionConfig()).connect();
  return pool;
}

// The visual sends the function key as ?code=, so only Content-Type needs allowing.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const MAX_ROWS    = 10000;
const MAX_KEYS    = 3;
const MAX_COMMENT = 2000;
const UUID_RE     = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(status, body) {
  return { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

const isTextOrNull = v => v === null || v === undefined || typeof v === "string";

function validatePayload(body) {
  if (!body || typeof body !== "object")                   return "Body must be a JSON object.";
  if (!UUID_RE.test(body.batchId ?? ""))                   return "batchId must be a UUID.";
  if (typeof body.context !== "string" || !body.context.trim()) return "Missing context.";
  if (body.context.length > 100)                           return "context is too long (max 100).";
  const rows = body.rows;
  if (!Array.isArray(rows) || rows.length === 0)           return "Nothing to save.";
  if (rows.length > MAX_ROWS)                              return `Too many rows (max ${MAX_ROWS}).`;
  for (const r of rows) {
    if (!Array.isArray(r.keys) || r.keys.length === 0 || r.keys.length > MAX_KEYS
        || !r.keys.every(k => typeof k === "string" && k.length <= 200) || !r.keys[0])
      return `Each row needs 1-${MAX_KEYS} text keys (max 200 characters).`;
    for (const f of ["category", "comment", "originalCategory", "originalComment"])
      if (!isTextOrNull(r[f])) return `${f} must be text or null.`;
    if ((r.comment ?? "").length > MAX_COMMENT) return `Comment is too long (max ${MAX_COMMENT}).`;
    if ((r.category ?? "").length > 50)         return "Category is too long (max 50).";
  }
  return null;
}

/**
 * Who saved: the platform-verified user when App Service Authentication
 * (Easy Auth) is enabled, otherwise USERPRINCIPALNAME() sent by the visual
 * (client-supplied - fine for an audit trail, not proof of identity).
 */
function savedBy(request, body) {
  const verified = request.headers.get("x-ms-client-principal-name");
  if (verified) return verified;
  if (typeof body.user === "string" && body.user.trim()) return body.user.trim().slice(0, 200);
  return "PowerBI";
}

app.http("saveAssessment", {
  methods:   ["POST", "OPTIONS"],
  authLevel: "function",
  route:     "assessment/save",

  handler: async (request, context) => {
    if (request.method === "OPTIONS") return { status: 204, headers: CORS_HEADERS };

    let body;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "Request body is not valid JSON." });
    }
    const invalid = validatePayload(body);
    if (invalid) return json(400, { error: invalid });

    const { batchId, rows } = body;
    const ctx = body.context.trim();
    context.log(`[saveAssessment] batch=${batchId} context=${ctx} rows=${rows.length}`);

    try {
      const db = await getPool();
      const result = await db.request()
        .input("BatchId", sql.UniqueIdentifier, batchId)
        .input("Context", sql.NVarChar(100), ctx)
        .input("SavedBy", sql.NVarChar(200), savedBy(request, body))
        .input("Payload", sql.NVarChar(sql.MAX), JSON.stringify({ rows }))
        .output("Status",   sql.VarChar(20))
        .output("Inserted", sql.Int)
        .output("Updated",  sql.Int)
        .output("Deleted",  sql.Int)
        .execute("dbo.usp_SaveAssessments");

      const out = result.output;
      if (out.Status === "conflict") {
        const conflicts = (result.recordset ?? []).map(r => ({
          keys:       [r.Key1, r.Key2, r.Key3].filter(k => k !== ""),
          category:   r.CurrentCategory,
          comment:    r.CurrentComment,
          modifiedBy: r.ModifiedBy,
          modifiedAt: r.ModifiedAt,
        }));
        context.log(`[saveAssessment] batch=${batchId} rejected: ${conflicts.length} conflict(s)`);
        return json(409, { status: "conflict", conflicts });
      }
      return json(200, {
        status:   out.Status,          // "saved" | "duplicate"
        inserted: out.Inserted,
        updated:  out.Updated,
        deleted:  out.Deleted,
        savedAt:  new Date().toISOString(),
      });

    } catch (err) {
      const number = err.number ?? err.originalError?.info?.number;
      if (number === 50400) return json(400, { error: err.message });

      context.error("[saveAssessment] Database error:", err);
      pool = null;   // reconnect on next call
      return json(500, { error: "Database error. See function logs for details." });
    }
  },
});
