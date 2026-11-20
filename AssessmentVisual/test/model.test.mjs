import { AssessmentModel, norm, parseCategories, rowId } from "../.tmp/test/model.js";
import { ValueFormat, keyText } from "../.tmp/test/format.js";
import assert from "node:assert/strict";

const src = (keys, category = null, comment = null) => ({ keys, cells: keys, sort: keys, category, comment });

// helpers
assert.equal(norm("  "), null);
assert.equal(norm(" a "), "a");
assert.deepEqual(parseCategories("Justert; Ikke justert;;Kan ikke justeres ; Justert"), ["Justert", "Ikke justert", "Kan ikke justeres"]);
assert.equal(keyText(new Date(2026, 0, 5)), "2026-01-05");
assert.equal(keyText(2026), "2026");
assert.equal(keyText(null), "(Blank)");

// model basics
const m = new AssessmentModel([src(["P1", "2026"], "Justert", "ok"), src(["P2", "2026"]), src(["P2", "2026"], "Ikke justert")]);
const p1 = rowId(["P1", "2026"]), p2 = rowId(["P2", "2026"]);
assert.equal(m.rows.length, 2, "duplicate keys are merged");
assert.equal(m.category(p2), "Ikke justert", "stored value wins over blank duplicate");
assert.equal(m.changeCount, 0);

m.setCategory(p1, "Kan ikke justeres");
m.setComment(p2, "  sjekk  ");
assert.equal(m.changeCount, 2);
assert.equal(m.comment(p2), "sjekk");
m.setCategory(p1, "Justert");
assert.equal(m.isDirty(p1), false, "back to original is not a change");

m.setComment(p1, "");
m.setCategory(p1, "");
const payload = m.buildPayload("b", "Ratejustering", "ola@x.no");
assert.equal(payload.context, "Ratejustering");
assert.deepEqual(payload.rows.find(r => r.keys[0] === "P1"),
    { keys: ["P1", "2026"], category: null, comment: null, originalCategory: "Justert", originalComment: "ok" });

// carry edits over a refresh
const fresh = new AssessmentModel([src(["P1", "2026"], "Ikke justert", "ok"), src(["P2", "2026"], "Ikke justert", "sjekk")]);
fresh.carryEditsFrom(m);
assert.equal(fresh.isDirty(p2), false, "edit equal to new stored value is dropped");
assert.equal(fresh.isDirty(p1), true);
assert.equal(fresh.buildPayload("b", "c", null).rows[0].originalCategory, "Justert", "original kept without rebase");

const rebased = new AssessmentModel([src(["P1", "2026"], "Ikke justert", "ok")]);
rebased.carryEditsFrom(m, new Set([p1]));
assert.equal(rebased.buildPayload("b", "c", null).rows[0].originalCategory, "Ikke justert", "conflict rows rebase");

// rebase keeps the other user's value in fields this user did not touch
const a = new AssessmentModel([src(["P9"], null, null)]);
a.setCategory(rowId(["P9"]), "Justert");
const b = new AssessmentModel([src(["P9"], "Ikke justert", "fra Per")]);
b.carryEditsFrom(a, new Set([rowId(["P9"])]));
assert.deepEqual(b.buildPayload("x", "c", null).rows[0],
    { keys: ["P9"], category: "Justert", comment: "fra Per", originalCategory: "Ikke justert", originalComment: "fra Per" });

// edits on filtered-away rows survive and are counted
const filtered = new AssessmentModel([src(["P2", "2026"], "Ikke justert")]);
filtered.carryEditsFrom(m);
assert.equal(filtered.hiddenChangeCount, 1);
assert.deepEqual(filtered.buildPayload("b", "c", null).rows.find(r => r.keys[0] === "P1").keys, ["P1", "2026"]);

m.discard();
assert.equal(m.changeCount, 0);

// value format
const f = new ValueFormat("en-US");
assert.equal(f.format(1234.5, "#,0"), "1,235");
assert.equal(f.format(0.125, "0.0 %"), "12.5%");
assert.equal(f.format(1234.567, "#,0.00"), "1,234.57");
assert.equal(f.format(null), "");
assert.equal(f.format("abc"), "abc");

console.log("All tests passed");
