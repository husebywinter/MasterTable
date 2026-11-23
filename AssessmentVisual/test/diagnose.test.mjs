import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const { diagnose, maskUrl } = require("../.tmp/test/diagnose.js");

const URL_ = "https://func-x.swedencentral-01.azurewebsites.net/api/assessment/save";
const KEY = "abcdefghijklmnop==";
const allowed = async () => "Allowed";
const res = (status, body = "") => ({ status, text: async () => body });
const typeError = () => Object.assign(new TypeError("Failed to fetch"), { name: "TypeError" });

// maskUrl hides the key
assert.equal(maskUrl(`${URL_}?code=${KEY}`), `${URL_}?code=abcd…==`);

// settings
{
    const r = await diagnose("", KEY, { fetch: async () => res(200), webAccess: allowed });
    assert.equal(r.ok, false);
    assert.equal(r.steps[0].status, "fail");
}
{
    const r = await diagnose("https://func-x.azurewebsites.net/api/wrong", "", { fetch: async (u, i) => i?.mode === "no-cors" ? res(0) : res(404), webAccess: allowed });
    assert.equal(r.steps[0].status, "warn", "wrong path and missing key are warned");
    assert.match(r.conclusion, /404/);
}

// web access not declared stops early
{
    let called = false;
    const r = await diagnose(URL_, KEY, { fetch: async () => { called = true; return res(200); }, webAccess: async () => "NotDeclared" });
    assert.equal(called, false);
    assert.match(r.conclusion, /capabilities/);
}

// network failure (no-cors rejects)
{
    const r = await diagnose(URL_, KEY, { fetch: async () => { throw typeError(); }, webAccess: allowed });
    assert.equal(r.steps.find(s => s.name === "Nettverk").status, "fail");
    assert.match(r.conclusion, /lokalt nettverk/);
}

// timeout on no-cors
{
    const hang = (u, i) => new Promise((_, rej) => i.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    const r = await diagnose(URL_, KEY, { fetch: hang, webAccess: allowed, timeoutMs: 20 });
    assert.match(r.steps.find(s => s.name === "Nettverk").detail, /Ingen svar/);
}

// reachable but CORS blocks the POST
{
    const r = await diagnose(URL_, KEY, { fetch: async (u, i) => { if (i.mode === "no-cors") return res(0); throw typeError(); }, webAccess: allowed });
    assert.equal(r.steps.at(-1).status, "fail");
    assert.match(r.conclusion, /CORS/);
}

// wrong key
{
    const r = await diagnose(URL_, KEY, { fetch: async (u, i) => i.mode === "no-cors" ? res(0) : res(401), webAccess: allowed });
    assert.match(r.conclusion, /401/);
}

// function OK, but old package without nettest (404) -> step skipped, overall ok
{
    let postedUrl = "";
    const r = await diagnose(URL_, KEY, {
        fetch: async (u, i) => {
            if (i.mode === "no-cors") return res(0);
            if (i.method === "GET") return res(404);
            postedUrl = u; return res(400, '{"error":"batchId must be a UUID."}');
        },
        webAccess: async () => "Unknown"
    });
    assert.equal(r.ok, true);
    assert.equal(new URL(postedUrl).searchParams.get("code"), KEY);
    assert.equal(r.steps[1].status, "skip", "unknown web access status is skipped, not failed");
    assert.equal(r.steps.at(-1).status, "skip");
}

// database step: public address -> fail with the function's conclusion; key passed on
const okApi = (nettest, seen) => async (u, i) => {
    if (i.mode === "no-cors") return res(0);
    if (i.method === "GET") { seen && seen.push(u); return res(200, JSON.stringify(nettest)); }
    return res(400, '{"error":"batchId must be a UUID."}');
};
{
    const seen = [];
    const r = await diagnose(URL_, KEY, { fetch: okApi({ sqlServer: "sql-x.database.windows.net", dns: { addresses: ["51.12.46.33"], private: false }, tcp1433: { open: true, ms: 30 }, conclusion: "IT: DNS" }, seen), webAccess: allowed });
    assert.equal(r.ok, false);
    assert.equal(r.steps.at(-1).status, "fail");
    assert.match(r.steps.at(-1).detail, /offentlig/);
    assert.equal(r.conclusion, "IT: DNS");
    assert.equal(new URL(seen[0]).pathname, "/api/assessment/nettest");
    assert.equal(new URL(seen[0]).searchParams.get("code"), KEY);
}
// database step: private address, port closed
{
    const r = await diagnose(URL_, KEY, { fetch: okApi({ sqlServer: "s", dns: { addresses: ["10.1.2.3"], private: true }, tcp1433: { open: false, error: "timeout after 5000 ms", ms: 5000 }, conclusion: "IT: 1433" }), webAccess: allowed });
    assert.equal(r.ok, false);
    assert.match(r.steps.at(-1).detail, /svarer ikke/);
}
// database step: everything open
{
    const r = await diagnose(URL_, KEY, { fetch: okApi({ sqlServer: "s", dns: { addresses: ["10.1.2.3"], private: true }, tcp1433: { open: true, ms: 12 } }), webAccess: allowed });
    assert.equal(r.ok, true);
    assert.match(r.conclusion, /Hele veien virker/);
}

console.log("Diagnose tests passed");
