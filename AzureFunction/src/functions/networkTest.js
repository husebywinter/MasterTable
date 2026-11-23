"use strict";

// GET /api/assessment/nettest?code=<function key>
// Shows how the Function App resolves and reaches the SQL server: DNS result
// (private or public address) and whether TCP 1433 answers. Nothing is sent
// to the database - it only opens and closes a TCP connection.
// Open it in a browser on the corporate network and send the result to IT.

const { app } = require("@azure/functions");
const dns     = require("dns").promises;
const net     = require("net");

const TIMEOUT_MS = 5000;

function isPrivate(ip) {
  return /^10\./.test(ip)
    || /^192\.168\./.test(ip)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
    || /^(fc|fd)/i.test(ip);
}

function tcpTest(host, port) {
  return new Promise(resolve => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    const finish = (result) => { socket.destroy(); resolve({ ...result, ms: Date.now() - started }); };
    socket.setTimeout(TIMEOUT_MS);
    socket.once("connect", () => finish({ open: true }));
    socket.once("timeout", () => finish({ open: false, error: `timeout after ${TIMEOUT_MS} ms` }));
    socket.once("error", err => finish({ open: false, error: `${err.code || ""} ${err.message}`.trim() }));
  });
}

app.http("networkTest", {
  methods:   ["GET"],
  authLevel: "function",
  route:     "assessment/nettest",

  handler: async () => {
    const server = (process.env.SQL_SERVER || "").trim().replace(/^tcp:/i, "").replace(/,\d+$/, "");
    const result = { sqlServer: server || null, time: new Date().toISOString() };
    if (!server) {
      result.conclusion = "SQL_SERVER er ikke satt i Environment variables.";
      return { status: 200, jsonBody: result };
    }

    try {
      const cname = await dns.resolveCname(server).catch(() => []);
      const addresses = await dns.lookup(server, { all: true });
      result.dns = { cname, addresses: addresses.map(a => a.address) };
    } catch (err) {
      result.dns = { error: `${err.code || ""} ${err.message}`.trim() };
    }

    const first = result.dns?.addresses?.[0];
    if (first) {
      result.dns.private = isPrivate(first);
      result.tcp1433 = await tcpTest(first, 1433);
    }

    if (!first) {
      result.conclusion = "Funksjonen får ikke slått opp SQL-serveren i DNS. IT: sjekk DNS for VNet-et (privat DNS-sone privatelink.database.windows.net).";
    } else if (!result.dns.private) {
      result.conclusion = `Funksjonen slår opp SQL til en OFFENTLIG adresse (${first}). IT: DNS i VNet-et må gi den private adressen til pe-swc-sql (privat DNS-sone privatelink.database.windows.net koblet til VNet-et, eller videresending i egen DNS).`;
    } else if (!result.tcp1433.open) {
      result.conclusion = `DNS er riktig (privat adresse ${first}), men port 1433 svarer ikke (${result.tcp1433.error}). IT: åpne TCP 1433 fra subnet-func-integration til pe-swc-sql i NSG og Azure Firewall.`;
    } else {
      result.conclusion = `Nettverket til SQL virker (privat adresse ${first}, port 1433 åpen). Feiler lagring fortsatt, er det innlogging eller rettigheter i databasen.`;
    }
    return { status: 200, jsonBody: result };
  },
});
