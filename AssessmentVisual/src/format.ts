"use strict";

/**
 * Display and key formatting for data view values. Covers the common Power BI
 * format strings (#,0 / 0.00 / 0.0 % / dates) without the formatting-utils
 * dependency. No Power BI dependencies, so it can be tested in plain Node.
 */

type Primitive = string | number | boolean | Date | null | undefined;

export const BLANK = "(Blank)";

const pad = (n: number) => String(n).padStart(2, "0");

/** Stable text for a key value: dates as YYYY-MM-DD, numbers without grouping. */
export function keyText(v: Primitive): string {
    if (v === null || v === undefined || v === "") return BLANK;
    if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
    return String(v);
}

export class ValueFormat {
    private readonly cache = new Map<string, Intl.NumberFormat>();

    constructor(private readonly locale: string) { }

    format(v: Primitive, formatString?: string): string {
        if (v === null || v === undefined || v === "") return "";
        if (v instanceof Date) return v.toLocaleDateString(this.locale);
        if (typeof v === "boolean") return v ? "True" : "False";
        if (typeof v !== "number") return String(v);
        if (!Number.isFinite(v)) return String(v);

        const fmt = formatString ?? "";
        const percent = /%/.test(fmt.replace(/"[^"]*"|\\./g, ""));
        const decimals = ValueFormat.decimals(fmt, v);
        const key = `${decimals}|${percent}`;
        let nf = this.cache.get(key);
        if (!nf) {
            nf = new Intl.NumberFormat(this.locale, {
                style: percent ? "percent" : "decimal",
                minimumFractionDigits: decimals,
                maximumFractionDigits: decimals
            });
            this.cache.set(key, nf);
        }
        return nf.format(v);
    }

    /** Decimals from the first section of the format string; integers keep 0, others up to 2. */
    static decimals(fmt: string, v: number): number {
        const section = fmt.split(";")[0];
        const m = /\.([0#]+)/.exec(section);
        if (m) return m[1].replace(/#/g, "").length || (Number.isInteger(v) ? 0 : m[1].length);
        if (/[0#]/.test(section)) return 0;
        return Number.isInteger(v) ? 0 : 2;
    }
}
