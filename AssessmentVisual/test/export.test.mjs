import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const { buildWorkbook, workbookBase64, excelNumFmt, safeSheetName } = require("../.tmp/test/export.js");
const XLSX = require("xlsx-js-style");

assert.equal(excelNumFmt("0.0 %", 0.1), "0.0%");
assert.equal(excelNumFmt("#,0", 5), "#,##0");
assert.equal(excelNumFmt("#,0.00", 5), "#,##0.00");
assert.equal(excelNumFmt(undefined, 5), "#,##0");
assert.equal(safeSheetName("Ratejustering 2026 – vurdering/test"), "Ratejustering 2026 – vurdering ");

const wb = buildWorkbook({
    sheetName: "Ratejustering", categoryHeader: "Kategori", commentHeader: "Kommentar",
    categories: ["Justert", "Ikke justert", "Kan ikke justeres"], colorCategories: true,
    columns: [{ header: "Prosjekt" }, { header: "År" }, { header: "Timepris", format: "#,0" }, { header: "Endring", format: "0.0 %" }],
    rows: [
        { values: ["P-1001", 2026, 1180, 0.045], category: "Justert", comment: "Avtalt", dirty: false },
        { values: ["P-1002", 2026, null, 0], category: null, comment: null, dirty: true }
    ]
});
const back = XLSX.read(workbookBase64(wb), { type: "base64" });
const ws = back.Sheets["Ratejustering"];
assert.ok(ws, "sheet exists");
const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
assert.deepEqual(aoa[0], ["Prosjekt", "År", "Timepris", "Endring", "Kategori", "Kommentar"]);
assert.deepEqual(aoa[1], ["P-1001", 2026, 1180, 0.045, "Justert", "Avtalt"]);
assert.equal(ws["C2"].t, "n");
assert.equal(ws["!autofilter"].ref, "A1:F3");
console.log("Export tests passed");
