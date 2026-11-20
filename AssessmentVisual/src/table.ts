"use strict";

import { AssessmentModel, Row } from "./model";

export interface Column {
    header: string;
    numeric: boolean;
}

export interface TableOptions {
    columns: Column[];
    categories: string[];
    categoryHeader: string;
    commentHeader: string;
    colorCategories: boolean;
    fontSize: number;
    /** Row id -> tooltip for rows the server reported as changed by someone else. */
    conflicts: Map<string, string>;
}

export interface TableCallbacks {
    onCategory(id: string, value: string | null): void;
    onComment(id: string, value: string | null): void;
    onRevert(id: string): void;
    onSave(): void;
}

/** Filter for the category column: all, without category, or one category. */
export const FILTER_ALL = "\u0000all";
export const FILTER_NONE = "\u0000none";

const MAX_RENDERED = 2000;
const CATEGORY_COLORS = ["cat-0", "cat-1", "cat-2", "cat-3", "cat-4", "cat-5"];

type SortKey = { col: number | "category" | "comment"; dir: 1 | -1 } | null;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** The assessment table: read-only data columns plus a category dropdown and a comment field per row. */
export class TableView {
    readonly element: HTMLElement;
    private readonly table: HTMLTableElement;
    private readonly thead: HTMLTableSectionElement;
    private readonly tbody: HTMLTableSectionElement;
    private readonly footer: HTMLElement;

    private model: AssessmentModel | null = null;
    private opts: TableOptions | null = null;
    private sort: SortKey = null;
    private search = "";
    private categoryFilter = FILTER_ALL;
    private onlyChanged = false;
    private readonly rowEls = new Map<string, HTMLTableRowElement>();

    constructor(parent: HTMLElement, private readonly cb: TableCallbacks) {
        this.element = document.createElement("div");
        this.element.className = "at-scroll";
        this.table = document.createElement("table");
        this.table.className = "at-table";
        this.thead = this.table.createTHead();
        this.tbody = this.table.createTBody();
        this.element.appendChild(this.table);
        this.footer = document.createElement("div");
        this.footer.className = "at-footer";
        this.element.appendChild(this.footer);
        parent.appendChild(this.element);

        this.tbody.addEventListener("keydown", e => this.onKeyDown(e));
    }

    setSearch(text: string): void {
        this.search = text.trim().toLocaleLowerCase();
        this.renderBody();
    }

    setCategoryFilter(value: string): void {
        this.categoryFilter = value;
        this.renderBody();
    }

    setOnlyChanged(value: boolean): void {
        this.onlyChanged = value;
        this.renderBody();
    }

    render(model: AssessmentModel, opts: TableOptions): void {
        // Keep focus and caret in the comment/category being edited across a data refresh
        const active = document.activeElement as HTMLInputElement | HTMLSelectElement | null;
        const focus = active && this.tbody.contains(active)
            ? { id: active.closest("tr")?.dataset.id, field: active.dataset.field,
                caret: active instanceof HTMLInputElement ? active.selectionStart : null }
            : null;

        if (typeof this.sort?.col === "number" && this.sort.col >= opts.columns.length) this.sort = null;
        this.model = model;
        this.opts = opts;
        this.table.style.fontSize = `${opts.fontSize}px`;
        this.renderHead();
        this.renderBody();

        if (focus?.id !== undefined) {
            const el = this.rowEls.get(focus.id)?.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-field="${focus.field}"]`);
            if (el) {
                el.focus();
                if (el instanceof HTMLInputElement && focus.caret !== null) el.setSelectionRange(focus.caret, focus.caret);
            }
        }
    }

    /** Updates the dirty/conflict marks and current values of one row without re-rendering. */
    refreshRow(id: string): void {
        const tr = this.rowEls.get(id);
        if (!tr || !this.model || !this.opts) return;
        this.decorateRow(tr, id);
    }

    focus(): void {
        this.element.focus();
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    private renderHead(): void {
        const opts = this.opts;
        this.thead.replaceChildren();
        const tr = this.thead.insertRow();
        const add = (text: string, key: number | "category" | "comment", cls: string) => {
            const th = document.createElement("th");
            th.className = cls;
            th.textContent = text;
            th.title = "Sorter";
            if (this.sort?.col === key) th.classList.add(this.sort.dir === 1 ? "sort-asc" : "sort-desc");
            th.addEventListener("click", () => {
                this.sort = this.sort?.col !== key ? { col: key, dir: 1 }
                    : this.sort.dir === 1 ? { col: key, dir: -1 } : null;
                this.renderHead();
                this.renderBody();
            });
            tr.appendChild(th);
        };
        opts.columns.forEach((c, i) => add(c.header, i, c.numeric ? "h-num" : "h-text"));
        add(opts.categoryHeader || "Kategori", "category", "h-category");
        add(opts.commentHeader || "Kommentar", "comment", "h-comment");
    }

    /** Rows after search, filters and sorting - what the user sees (also used by the export). */
    visibleRows(): Row[] {
        const model = this.model;
        if (!model || !this.opts) return [];
        let rows = model.rows.filter(r => {
            if (this.onlyChanged && !model.isDirty(r.id)) return false;
            const cat = model.category(r.id);
            if (this.categoryFilter === FILTER_NONE && cat !== null) return false;
            if (this.categoryFilter !== FILTER_ALL && this.categoryFilter !== FILTER_NONE && cat !== this.categoryFilter) return false;
            if (this.search) {
                const hay = (r.cells.join(" ") + " " + (cat ?? "") + " " + (model.comment(r.id) ?? "")).toLocaleLowerCase();
                if (!hay.includes(this.search)) return false;
            }
            return true;
        });
        const sort = this.sort;
        if (sort) {
            const order = this.opts.categories;
            const value = (r: Row): string | number | null =>
                sort.col === "category" ? (model.category(r.id) === null ? null : indexOrEnd(order, model.category(r.id)))
                    : sort.col === "comment" ? model.comment(r.id)
                        : r.sort[sort.col];
            rows = rows.slice().sort((a, b) => compare(value(a), value(b)) * sort.dir);
        }
        return rows;
    }

    private renderBody(): void {
        if (!this.model || !this.opts) return;
        const rows = this.visibleRows();
        this.rowEls.clear();
        const frag = document.createDocumentFragment();
        for (const r of rows.slice(0, MAX_RENDERED)) frag.appendChild(this.buildRow(r));
        this.tbody.replaceChildren(frag);

        const total = this.model.rows.length;
        const parts: string[] = [];
        parts.push(rows.length === total ? `${total} rader` : `${rows.length} av ${total} rader`);
        if (rows.length > MAX_RENDERED) parts.push(`viser de første ${MAX_RENDERED} – filtrer for å se resten`);
        this.footer.textContent = parts.join(" · ");
    }

    private buildRow(r: Row): HTMLTableRowElement {
        const opts = this.opts;
        const tr = document.createElement("tr");
        tr.dataset.id = r.id;

        r.cells.forEach((text, i) => {
            const td = tr.insertCell();
            td.className = opts.columns[i]?.numeric ? "c-num" : "c-text";
            td.textContent = text;
            td.title = text;
        });

        const catTd = tr.insertCell();
        catTd.className = "c-category";
        const select = document.createElement("select");
        select.dataset.field = "category";
        select.setAttribute("aria-label", opts.categoryHeader || "Kategori");
        select.addEventListener("change", () => {
            this.cb.onCategory(r.id, select.value || null);
        });
        catTd.appendChild(select);

        const comTd = tr.insertCell();
        comTd.className = "c-comment";
        const input = document.createElement("input");
        input.type = "text";
        input.maxLength = 2000;
        input.dataset.field = "comment";
        input.placeholder = "–";
        input.setAttribute("aria-label", opts.commentHeader || "Kommentar");
        input.addEventListener("input", () => this.cb.onComment(r.id, input.value));
        comTd.appendChild(input);

        this.rowEls.set(r.id, tr);
        this.decorateRow(tr, r.id);
        return tr;
    }

    private decorateRow(tr: HTMLTableRowElement, id: string): void {
        const model = this.model, opts = this.opts;
        const row = model.row(id);
        const cat = model.category(id);
        const com = model.comment(id) ?? "";
        const dirty = model.isDirty(id);
        const conflict = opts.conflicts.get(id);

        const select = tr.querySelector("select");
        const options = [""].concat(opts.categories);
        // A stored category no longer in the list is still shown (marked), so it is not silently lost
        if (cat !== null && !opts.categories.includes(cat)) options.push(cat);
        if (select.options.length !== options.length || Array.from(select.options).some((o, i) => o.value !== options[i])) {
            select.replaceChildren(...options.map(v => {
                const o = document.createElement("option");
                o.value = v;
                o.textContent = v === "" ? "–" : opts.categories.includes(v) ? v : `${v} (utgått)`;
                return o;
            }));
        }
        select.value = cat ?? "";
        select.className = "cat-select";
        if (opts.colorCategories && cat !== null) {
            const i = opts.categories.indexOf(cat);
            select.classList.add(i >= 0 ? CATEGORY_COLORS[i % CATEGORY_COLORS.length] : "cat-unknown");
        }

        const input = tr.querySelector("input");
        if (input.value !== com && document.activeElement !== input) input.value = com;
        input.title = com;

        const catChanged = dirty && cat !== row?.category;
        const comChanged = dirty && (model.comment(id) ?? null) !== row?.comment;
        tr.cells[tr.cells.length - 2].classList.toggle("dirty", catChanged);
        tr.cells[tr.cells.length - 1].classList.toggle("dirty", comChanged);
        tr.classList.toggle("conflict", !!conflict);
        tr.title = conflict ?? (dirty ? "Ulagret endring (Esc i feltet angrer raden)" : "");
    }

    // ── Keyboard ────────────────────────────────────────────────────────────

    private onKeyDown(e: KeyboardEvent): void {
        const el = e.target as HTMLElement;
        const field = el.dataset.field;
        const tr = el.closest("tr");
        if (!field || !tr) return;

        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            this.cb.onSave();
            return;
        }
        if (e.key === "Escape") {
            e.preventDefault();
            this.cb.onRevert(tr.dataset.id);
            return;
        }
        // Enter / arrows move between rows in the same column (arrows only in the comment field)
        const down = (e.key === "Enter" && !e.shiftKey) || (field === "comment" && e.key === "ArrowDown");
        const up = (e.key === "Enter" && e.shiftKey) || (field === "comment" && e.key === "ArrowUp");
        if (!down && !up) return;
        const next = (down ? tr.nextElementSibling : tr.previousElementSibling) as HTMLTableRowElement | null;
        const target = next?.querySelector<HTMLElement>(`[data-field="${field}"]`);
        if (target) {
            e.preventDefault();
            target.focus();
            if (target instanceof HTMLInputElement) target.select();
        }
    }
}

function indexOrEnd(list: string[], v: string): number {
    const i = list.indexOf(v);
    return i >= 0 ? i : list.length;
}

/** Blanks last, numbers numerically, text with natural ordering. */
function compare(a: string | number | null, b: string | number | null): number {
    if (a === null || a === "") return b === null || b === "" ? 0 : 1;
    if (b === null || b === "") return -1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    return collator.compare(String(a), String(b));
}
