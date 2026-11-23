"use strict";

import { SavePayload } from "./model";

export interface Conflict {
    keys: string[];
    category: string | null;
    comment: string | null;
    modifiedBy: string | null;
    modifiedAt: string | null;
}

export type SaveResult =
    | { status: "saved" | "duplicate"; inserted: number; updated: number; deleted: number; savedAt: string }
    | { status: "conflict"; conflicts: Conflict[] };

/** Thrown when the request may or may not have reached the database (safe to retry with the same batch id). */
export class NetworkError extends Error { }

const TIMEOUT_MS = 30000;

/** Returns an error message, or null when the endpoint can be called. */
export function validateEndpoint(endpoint: string): string | null {
    if (!endpoint) return "Sett Function URL under Format › Write-back.";
    let url: URL;
    try {
        url = new URL(endpoint);
    } catch {
        return "Function URL er ikke en gyldig URL.";
    }
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !local) return "Function URL må bruke https.";
    return null;
}

/**
 * The function key goes in the `code` query parameter rather than the
 * x-functions-key header: the CORS preflight (OPTIONS) carries no custom
 * headers, so with authLevel "function" only a key in the URL lets it through.
 */
export function buildUrl(endpoint: string, functionKey: string): string {
    const url = new URL(endpoint);
    if (functionKey && !url.searchParams.has("code")) url.searchParams.set("code", functionKey);
    return url.toString();
}

/** POSTs changed rows to the saveAssessment Azure Function. */
export async function saveAssessments(endpoint: string, functionKey: string, payload: SavePayload): Promise<SaveResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
        res = await fetch(buildUrl(endpoint, functionKey), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
    } catch (err) {
        if (controller.signal.aborted) throw new NetworkError("Lagringen fikk tidsavbrudd. Lagre på nytt for å prøve igjen.");
        // fetch rejects without detail on CORS, DNS and WebAccess-privilege failures; the connection test narrows it down
        const reason = err instanceof Error ? ` [${err.name}: ${err.message}]` : "";
        throw new NetworkError(`Fikk ikke kontakt med Function App${reason}. Se tilkoblingstesten under.`);
    } finally {
        clearTimeout(timer);
    }

    const text = await res.text();
    let body: { status?: string; error?: string; conflicts?: Conflict[]; inserted?: number;
                updated?: number; deleted?: number; savedAt?: string } = {};
    try {
        body = text ? JSON.parse(text) : {};
    } catch {
        // non-JSON response, e.g. an HTML error page from the platform
    }
    if (res.status === 409 && body.status === "conflict") return { status: "conflict", conflicts: body.conflicts ?? [] };
    if (res.ok) {
        return {
            status: body.status === "duplicate" ? "duplicate" : "saved",
            inserted: body.inserted ?? 0, updated: body.updated ?? 0, deleted: body.deleted ?? 0,
            savedAt: body.savedAt ?? new Date().toISOString()
        };
    }
    if (res.status === 401 || res.status === 403) throw new Error(`Ingen tilgang (${res.status}). Sjekk function key.`);
    if (res.status === 404 && !body.error) throw new Error("Fant ikke API-et (404). Sjekk Function URL og at saveAssessment er deployet.");
    if (res.status >= 500 && !body.error) throw new NetworkError(`Serverfeil (HTTP ${res.status}). Lagre på nytt for å prøve igjen.`);
    throw new Error(body.error || `Lagring feilet med HTTP ${res.status}.`);
}
