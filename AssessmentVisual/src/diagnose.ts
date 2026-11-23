"use strict";

import { buildUrl, validateEndpoint } from "./api";

/**
 * Connection test for the write-back endpoint. The browser hides why a fetch
 * failed ("Failed to fetch"), so this narrows it down step by step:
 *  1. settings      - URL and key filled in and well-formed
 *  2. web access    - Power BI allows the visual to call this URL
 *  3. reachability  - a no-cors request reaches the host at all (network, DNS,
 *                     firewall, browser local-network block)
 *  4. API           - a real CORS POST with an empty body; the function answers
 *                     400 "batchId must be a UUID" without touching the database
 * No Power BI dependencies: web access status and fetch are passed in.
 */

export type StepStatus = "ok" | "fail" | "warn" | "skip";

export interface DiagStep {
    name: string;
    status: StepStatus;
    detail: string;
}

export interface DiagResult {
    steps: DiagStep[];
    conclusion: string;
    ok: boolean;
}

export type WebAccessStatus = "Allowed" | "NotDeclared" | "NotSupported" | "DisabledByAdmin" | "Unknown";

export interface DiagDeps {
    fetch: typeof fetch;
    webAccess: (url: string) => Promise<WebAccessStatus>;
    timeoutMs?: number;
}

/** URL for display: the key in ?code= is shortened, e.g. "abcd…==". */
export function maskUrl(url: string): string {
    try {
        const u = new URL(url);
        const code = u.searchParams.get("code");
        if (code) u.searchParams.set("code", code.length > 8 ? `${code.slice(0, 4)}…${code.slice(-2)}` : "…");
        return decodeURIComponent(u.toString());
    } catch {
        return url;
    }
}

function errorText(err: unknown): string {
    if (err instanceof Error) return `${err.name}: ${err.message}`;
    return String(err);
}

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        return await run(controller.signal);
    } finally {
        clearTimeout(timer);
    }
}

export async function diagnose(endpoint: string, functionKey: string, deps: DiagDeps): Promise<DiagResult> {
    const steps: DiagStep[] = [];
    const timeout = deps.timeoutMs ?? 15000;
    const done = (conclusion: string, ok = false): DiagResult => ({ steps, conclusion, ok });

    // 1. Settings
    const endpointError = validateEndpoint(endpoint);
    if (endpointError) {
        steps.push({ name: "Innstillinger", status: "fail", detail: endpointError });
        return done("Rett Function URL under Format › Write-back.");
    }
    const url = buildUrl(endpoint, functionKey);
    const parsed = new URL(url);
    const hasKey = !!parsed.searchParams.get("code");
    const pathOk = /\/api\/assessment\/save\/?$/i.test(parsed.pathname);
    steps.push({
        name: "Innstillinger",
        status: pathOk && hasKey ? "ok" : "warn",
        detail: `Kaller ${maskUrl(url)}`
            + (pathOk ? "" : ". Adressen slutter ikke på /api/assessment/save.")
            + (hasKey ? "" : ". Function key mangler (ingen ?code= og tomt nøkkelfelt).")
    });

    // 2. Web access privilege
    let access: WebAccessStatus = "Unknown";
    try {
        access = await deps.webAccess(parsed.origin);
    } catch {
        access = "Unknown";
    }
    const accessText: Record<WebAccessStatus, string> = {
        Allowed: "Power BI tillater visualen å kalle denne adressen.",
        NotDeclared: "Adressen står ikke i visualens liste over tillatte domener (capabilities.json › WebAccess). Visualen må bygges på nytt med adressen.",
        NotSupported: "Web-tilgang støttes ikke i dette miljøet.",
        DisabledByAdmin: "Power BI-admin har sperret web-tilgang for visualer (tenant-innstilling).",
        Unknown: "Power BI oppgir ikke status her. Testen fortsetter."
    };
    steps.push({
        name: "Web-tilgang i Power BI",
        status: access === "Allowed" ? "ok" : access === "Unknown" ? "skip" : "fail",
        detail: accessText[access]
    });
    if (access === "NotDeclared" || access === "DisabledByAdmin" || access === "NotSupported") {
        return done(accessText[access]);
    }

    // 3. Reachability (no-cors: no CORS check, so a failure here is network/DNS/firewall/browser block)
    let reachable = false;
    try {
        await withTimeout(timeout, signal => deps.fetch(`${parsed.origin}/`, { mode: "no-cors", cache: "no-store", signal }));
        reachable = true;
        steps.push({ name: "Nettverk", status: "ok", detail: `Nettleseren når ${parsed.host}.` });
    } catch (err) {
        const timedOut = err instanceof Error && err.name === "AbortError";
        steps.push({
            name: "Nettverk",
            status: "fail",
            detail: timedOut
                ? `Ingen svar fra ${parsed.host} på ${timeout / 1000} sekunder (${errorText(err)}).`
                : `Nettleseren når ikke ${parsed.host} (${errorText(err)}).`
        });
    }
    if (!reachable) {
        return done("Kallet stoppes før det når funksjonen. Mulige årsaker: ikke på bedriftsnettet/VPN, brannmur, "
            + "eller at nettleseren blokkerer kall fra Power BI til en privat adresse (lokalt nettverk). "
            + "Åpne adressen i en egen fane: virker den der, er det nettleserens sperre for lokalt nettverk.");
    }

    // 4. API call (real CORS POST, empty body: validation fails before the database is touched)
    try {
        const res = await withTimeout(timeout, signal => deps.fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
            cache: "no-store",
            signal
        }));
        const text = await res.text().catch(() => "");
        if (res.status === 400 && /batchId/i.test(text)) {
            steps.push({ name: "Funksjon og nøkkel", status: "ok", detail: "Funksjonen svarer, og nøkkelen er gyldig (HTTP 400 på testkall, som forventet)." });
            return done("Tilkoblingen virker. Feiler lagring fortsatt, se meldingen ved lagring eller loggen i Function App-en.", true);
        }
        const byStatus: Record<number, string> = {
            401: "Feil eller manglende function key (HTTP 401). Kopier nøkkelen på nytt via «Get function URL».",
            403: "Avvist (HTTP 403): nettverkssperre (Access restrictions) eller feil nøkkel.",
            404: "Fant ikke funksjonen (HTTP 404). Sjekk at URL-en slutter på /api/assessment/save og at funksjonen er deployet."
        };
        const detail = byStatus[res.status] ?? `Uventet svar: HTTP ${res.status}${text ? ` – ${text.slice(0, 200)}` : ""}`;
        steps.push({ name: "Funksjon og nøkkel", status: "fail", detail });
        return done(detail);
    } catch (err) {
        steps.push({
            name: "Funksjon og nøkkel",
            status: "fail",
            detail: `Kallet ble stoppet av nettleseren (${errorText(err)}).`
        });
        return done("Nettverket virker, men nettleseren stopper selve kallet. Det er nesten alltid CORS: legg til * under "
            + "Function App › API › CORS. Står * der allerede, kan det være nettleserens sperre for lokalt nettverk; "
            + "trykk F12 › Console for detaljer.");
    }
}
