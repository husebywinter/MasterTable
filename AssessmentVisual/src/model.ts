"use strict";

/**
 * Assessment model: one row per key (1-3 key values) with two editable
 * fields, category and comment. Edits are kept separately from the stored
 * values, together with the stored values the user started from ("original"),
 * so the server can detect that someone else changed the row in between.
 * An empty category/comment is null; both null means "no assessment" (the
 * database row is deleted).
 *
 * This module has no Power BI dependencies so it can be tested in plain Node.
 */

export type Text = string | null;

/** One row from the data view, already normalised. */
export interface SourceRow {
    keys: string[];
    /** Display text for every visible column except category/comment. */
    cells: string[];
    /** Values to sort the visible columns by (same order as cells). */
    sort: Array<string | number | null>;
    /** Unformatted values of the visible columns, for the Excel export. */
    raw?: Array<string | number | boolean | Date | null>;
    category: Text;
    comment: Text;
}

export interface Row extends SourceRow {
    id: string;
}

export interface Edit {
    category: Text;
    comment: Text;
    originalCategory: Text;
    originalComment: Text;
}

export interface RowChange {
    keys: string[];
    category: Text;
    comment: Text;
    originalCategory: Text;
    originalComment: Text;
}

export interface SavePayload {
    batchId: string;
    /** USERPRINCIPALNAME() from the report, for the audit trail (not authentication). */
    user: string | null;
    context: string;
    rows: RowChange[];
}

const SEP = "\u001f";

export function rowId(keys: string[]): string {
    return keys.join(SEP);
}

/** Trims; empty text becomes null. */
export function norm(v: string | null | undefined): Text {
    const t = (v ?? "").trim();
    return t === "" ? null : t;
}

/** Parses the category list from the format pane ("A; B; C" or one per line). */
export function parseCategories(text: string): string[] {
    const out: string[] = [];
    for (const part of (text ?? "").split(/[;\n]/)) {
        const t = part.trim();
        if (t && !out.includes(t)) out.push(t);
    }
    return out;
}

export class AssessmentModel {
    readonly rows: Row[] = [];
    private readonly byId = new Map<string, Row>();
    private edits = new Map<string, Edit>();
    /** Keys of edits by id, so edits for rows outside the current filter can still be saved. */
    private editKeys = new Map<string, string[]>();

    constructor(source: SourceRow[]) {
        for (const s of source) {
            const id = rowId(s.keys);
            const existing = this.byId.get(id);
            if (existing) {
                // Same key twice (e.g. a details column with several values): keep the first, but a stored value wins over blank
                existing.category ??= norm(s.category);
                existing.comment ??= norm(s.comment);
                continue;
            }
            const row: Row = { ...s, id, category: norm(s.category), comment: norm(s.comment) };
            this.rows.push(row);
            this.byId.set(id, row);
        }
    }

    get isEmpty(): boolean { return this.rows.length === 0; }
    get changeCount(): number { return this.edits.size; }
    /** Unsaved edits on rows that are not in the current data (filtered away). */
    get hiddenChangeCount(): number {
        let n = 0;
        this.edits.forEach((_, id) => { if (!this.byId.has(id)) n++; });
        return n;
    }

    row(id: string): Row | undefined { return this.byId.get(id); }
    isDirty(id: string): boolean { return this.edits.has(id); }

    category(id: string): Text {
        const e = this.edits.get(id);
        return e ? e.category : this.byId.get(id)?.category ?? null;
    }

    comment(id: string): Text {
        const e = this.edits.get(id);
        return e ? e.comment : this.byId.get(id)?.comment ?? null;
    }

    setCategory(id: string, value: string | null): void {
        this.set(id, norm(value), this.comment(id));
    }

    setComment(id: string, value: string | null): void {
        this.set(id, this.category(id), norm(value));
    }

    private set(id: string, category: Text, comment: Text): void {
        const row = this.byId.get(id);
        if (!row) return;
        const e = this.edits.get(id);
        const origCat = e ? e.originalCategory : row.category;
        const origCom = e ? e.originalComment : row.comment;
        if (category === origCat && comment === origCom) {
            this.edits.delete(id);
            this.editKeys.delete(id);
        } else {
            this.edits.set(id, { category, comment, originalCategory: origCat, originalComment: origCom });
            this.editKeys.set(id, row.keys);
        }
    }

    /** Reverts one row to its stored values. */
    revert(id: string): void {
        this.edits.delete(id);
        this.editKeys.delete(id);
    }

    discard(): void {
        this.edits.clear();
        this.editKeys.clear();
    }

    markSaved(): void {
        this.discard();
    }

    /**
     * Keeps unsaved edits across a data refresh. Rows in `rebase` (reported as
     * conflicts) take the fresh stored values as their original, so saving
     * again deliberately overwrites the other user's change - but only in the
     * field(s) this user edited; the other field keeps the new stored value. Edits that now
     * equal the stored values are dropped.
     */
    carryEditsFrom(prev: AssessmentModel, rebase: Set<string> = new Set()): void {
        prev.edits.forEach((e, id) => {
            const row = this.byId.get(id);
            const edit = { ...e };
            if (row && rebase.has(id)) {
                // Fields the user did not touch take the other user's value; touched fields keep the user's
                if (e.category === e.originalCategory) edit.category = row.category;
                if (e.comment === e.originalComment) edit.comment = row.comment;
                edit.originalCategory = row.category;
                edit.originalComment = row.comment;
            }
            if (row && edit.category === row.category && edit.comment === row.comment) return;
            this.edits.set(id, edit);
            this.editKeys.set(id, prev.editKeys.get(id));
        });
    }

    buildPayload(batchId: string, context: string, user: string | null): SavePayload {
        const rows: RowChange[] = [];
        this.edits.forEach((e, id) => rows.push({ keys: this.editKeys.get(id), ...e }));
        return { batchId, user, context, rows };
    }

    /** Serialised edits, used to detect whether a retried save is unchanged. */
    snapshot(): string {
        return JSON.stringify(Array.from(this.edits.entries()));
    }
}
