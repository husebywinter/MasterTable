"use strict";

import * as XLSX from "xlsx-js-style";

export type RawValue = string | number | boolean | Date | null;

export interface ExportColumn {
    header: string;
    /** Power BI format string of a measure; used as the Excel number format. */
    format?: string;
}

export interface ExportRow {
    values: RawValue[];
    category: string | null;
    comment: string | null;
    dirty: boolean;
}

export interface ExportInput {
    sheetName: string;
    columns: ExportColumn[];
    categoryHeader: string;
    commentHeader: string;
    categories: string[];
    colorCategories: boolean;
    rows: ExportRow[];
}

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Same colours as the visual's category pills (.cat-0 ... .cat-5). */
const CATEGORY_FILLS: Array<[string, string]> = [
    ["DFF6DD", "0E5C0E"], ["FED9CC", "8A3707"], ["EDEBE9", "3B3A39"],
    ["DEECF9", "004578"], ["FDE7E9", "A4262C"], ["F4E6F7", "5C2E91"]
];
const BORDER = { style: "thin", color: { rgb: "E1DFDD" } };
const HEADER_BORDER = { style: "thin", color: { rgb: "8A8886" } };

/**
 * Power BI and Excel number formats share the common cases (#,0 / 0.00 /
 * 0.0 %). Excel has no space before %, and an empty format means General.
 */
export function excelNumFmt(pbiFormat: string | undefined, value: number): string {
    const f = (pbiFormat ?? "").trim();
    if (!f) return Number.isInteger(value) ? "#,##0" : "#,##0.00";
    return f.replace(/\s+%/g, "%").replace(/#,0(?![#0])/g, "#,##0");
}

/** Builds a one-sheet workbook: header, data columns, category (coloured) and comment. */
export function buildWorkbook(input: ExportInput): XLSX.WorkBook {
    const headerStyle = {
        font: { bold: true, color: { rgb: "252423" } },
        fill: { fgColor: { rgb: "F3F2F1" } },
        border: { bottom: HEADER_BORDER },
        alignment: { vertical: "center" }
    };
    const header = [...input.columns.map(c => c.header), input.categoryHeader, input.commentHeader]
        .map(v => ({ v, t: "s", s: headerStyle }));

    const border = { bottom: BORDER };
    const dirtyFill = { fgColor: { rgb: "FFF4CE" } };
    const rows = input.rows.map(r => {
        const cells: object[] = r.values.map((v, i) => {
            if (v === null || v === undefined || v === "") return { v: "", t: "s", s: { border } };
            if (v instanceof Date) return { v, t: "d", s: { border, numFmt: "yyyy-mm-dd" } };
            if (typeof v === "number") {
                return { v, t: "n", s: { border, numFmt: excelNumFmt(input.columns[i]?.format, v), alignment: { horizontal: "right" } } };
            }
            if (typeof v === "boolean") return { v, t: "b", s: { border } };
            return { v: String(v), t: "s", s: { border } };
        });

        const ci = r.category === null ? -1 : input.categories.indexOf(r.category);
        const [bg, fg] = input.colorCategories && ci >= 0 ? CATEGORY_FILLS[ci % CATEGORY_FILLS.length] : [null, null];
        cells.push({
            v: r.category ?? "", t: "s",
            s: { border, ...(bg ? { fill: { fgColor: { rgb: bg } }, font: { color: { rgb: fg } } } : {}) }
        });
        cells.push({
            v: r.comment ?? "", t: "s",
            s: { border, alignment: { wrapText: true, vertical: "top" }, ...(r.dirty ? { fill: dirtyFill } : {}) }
        });
        return cells;
    });

    const ws = XLSX.utils.aoa_to_sheet([header, ...rows], { cellDates: true });
    const nCols = header.length;
    ws["!cols"] = header.map((h, c) => {
        if (c === nCols - 1) return { wch: 60 };
        const longest = Math.max(String(h.v).length, ...rows.slice(0, 500).map(r => displayLength((r[c] as { v: unknown }).v)));
        return { wch: Math.min(Math.max(longest + 2, 8), c === nCols - 2 ? 22 : 45) };
    });
    ws["!freeze"] = { xSplit: 0, ySplit: 1 };
    ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: nCols - 1 } }) };

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, safeSheetName(input.sheetName));
    return wb;
}

function displayLength(v: unknown): number {
    if (v instanceof Date) return 10;
    if (typeof v === "number") return v.toLocaleString("nb-NO").length + 1;
    return String(v ?? "").length;
}

/** Excel sheet names: max 31 characters, none of : \ / ? * [ ] */
export function safeSheetName(name: string): string {
    const s = (name || "Vurderinger").replace(/[:\\/?*[\]]/g, " ").trim().slice(0, 31);
    return s || "Vurderinger";
}

export function workbookBase64(wb: XLSX.WorkBook): string {
    return XLSX.write(wb, { bookType: "xlsx", type: "base64", cellStyles: true }) as string;
}

export function workbookBlob(wb: XLSX.WorkBook): Blob {
    const bytes = XLSX.write(wb, { bookType: "xlsx", type: "array", cellStyles: true }) as ArrayBuffer;
    return new Blob([bytes], { type: XLSX_MIME });
}
