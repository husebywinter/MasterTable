"use strict";

import powerbi from "powerbi-visuals-api";
import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import "./../style/visual.less";

import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import ISelectionManager = powerbi.extensibility.ISelectionManager;
import DataView = powerbi.DataView;
import DataViewMetadataColumn = powerbi.DataViewMetadataColumn;
import PrimitiveValue = powerbi.PrimitiveValue;

import { VisualFormattingSettingsModel } from "./settings";
import { AssessmentModel, SourceRow, parseCategories, rowId } from "./model";
import { TableView, Column, FILTER_ALL, FILTER_NONE } from "./table";
import { ValueFormat, keyText } from "./format";
import { Conflict, NetworkError, saveAssessments, validateEndpoint } from "./api";
import { RawValue, buildWorkbook, workbookBase64, workbookBlob } from "./export";

const SVG_NS = "http://www.w3.org/2000/svg";

/** 24x24 stroke icons (path data). */
const ICONS: Record<string, string> = {
    save: "M5 3h11l3 3v15H5z M8 3v5h7V3 M8 21v-7h8v7",
    discard: "M6 6l12 12 M18 6L6 18",
    download: "M12 4v11 M7 10l5 5 5-5 M5 20h14"
};

interface ColumnIndex {
    keys: number[];
    shown: number[];
    category: number;
    comment: number;
    user: number;
}

export class Visual implements IVisual {
    private readonly host: IVisualHost;
    private readonly selectionManager: ISelectionManager;
    private readonly formattingSettingsService = new FormattingSettingsService();
    private settings: VisualFormattingSettingsModel;

    private readonly titleEl: HTMLElement;
    private readonly statusEl: HTMLElement;
    private readonly messageEl: HTMLElement;
    private readonly filterEl: HTMLSelectElement;
    private readonly searchEl: HTMLInputElement;
    private readonly changedEl: HTMLInputElement;
    private readonly buttons: Record<string, HTMLButtonElement> = {};
    private readonly table: TableView;

    private model: AssessmentModel | null = null;
    private columns: Column[] = [];
    /** Format string per visible column (measures only), for the Excel export. */
    private formats: Array<string | undefined> = [];
    private user: string | null = null;
    private saving = false;
    /** Rows the server reported as changed by someone else: id -> tooltip. */
    private conflicts = new Map<string, string>();
    /** Batch id of a save that may have reached the server; reused on retry while the edits are unchanged. */
    private pendingBatch: { id: string; snapshot: string } | null = null;
    private lastContext = "";
    private readonly format: ValueFormat;

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;
        this.selectionManager = this.host.createSelectionManager();
        this.format = new ValueFormat(this.host.locale || "nb-NO");

        const root = options.element;
        root.classList.add("assessment-visual");

        const header = document.createElement("div");
        header.className = "at-header";
        this.titleEl = document.createElement("div");
        this.titleEl.className = "at-title";
        header.appendChild(this.titleEl);

        const toolbar = document.createElement("div");
        toolbar.className = "at-toolbar";
        this.addButton(toolbar, "save", "Lagre til databasen (Ctrl+S)", () => void this.save());
        this.addButton(toolbar, "discard", "Forkast endringer", () => this.discard());
        this.addButton(toolbar, "download", "Eksporter til Excel (rader som vises)", () => void this.exportXlsx());

        this.searchEl = document.createElement("input");
        this.searchEl.type = "search";
        this.searchEl.className = "at-search";
        this.searchEl.placeholder = "Søk…";
        this.searchEl.setAttribute("aria-label", "Søk i tabellen");
        this.searchEl.addEventListener("input", () => this.table.setSearch(this.searchEl.value));
        toolbar.appendChild(this.searchEl);

        this.filterEl = document.createElement("select");
        this.filterEl.className = "at-filter";
        this.filterEl.setAttribute("aria-label", "Filtrer på kategori");
        this.filterEl.addEventListener("change", () => this.table.setCategoryFilter(this.filterEl.value));
        toolbar.appendChild(this.filterEl);

        const changedLabel = document.createElement("label");
        changedLabel.className = "at-check";
        this.changedEl = document.createElement("input");
        this.changedEl.type = "checkbox";
        this.changedEl.addEventListener("change", () => this.table.setOnlyChanged(this.changedEl.checked));
        changedLabel.append(this.changedEl, document.createTextNode("Bare endrede"));
        toolbar.appendChild(changedLabel);

        this.statusEl = document.createElement("span");
        this.statusEl.className = "at-status";
        toolbar.appendChild(this.statusEl);
        header.appendChild(toolbar);
        root.appendChild(header);

        this.messageEl = document.createElement("div");
        this.messageEl.className = "at-message";
        root.appendChild(this.messageEl);

        this.table = new TableView(root, {
            onCategory: (id, v) => this.edit(id, () => this.model.setCategory(id, v)),
            onComment: (id, v) => this.edit(id, () => this.model.setComment(id, v)),
            onRevert: id => this.edit(id, () => this.model.revert(id)),
            onSave: () => void this.save()
        });

        root.addEventListener("contextmenu", (e: MouseEvent) => {
            if ((e.target as HTMLElement).closest("input, select")) return;
            e.preventDefault();
            this.selectionManager.showContextMenu({}, { x: e.clientX, y: e.clientY });
        });
    }

    public update(options: VisualUpdateOptions): void {
        this.host.eventService.renderingStarted(options);
        try {
            const dataView = options.dataViews?.[0];
            this.settings = this.formattingSettingsService.populateFormattingSettingsModel(VisualFormattingSettingsModel, dataView);
            this.titleEl.textContent = this.settings.tableCard.title.value;

            const context = this.settings.writeBackCard.context.value.trim();
            if (context !== this.lastContext && this.model?.changeCount) {
                this.model.discard();
                this.setStatus("Konteksten ble endret – ulagrede endringer er forkastet.", true);
            }
            this.lastContext = context;

            if (options.type & powerbi.VisualUpdateType.Data) {
                if (dataView?.metadata?.segment && this.host.fetchMoreData(true)) {
                    this.setStatus("Henter flere rader…");
                    this.host.eventService.renderingFinished(options);
                    return;   // update() is called again with the next segment
                }
                this.loadData(dataView);
            }
            this.render();
            this.host.eventService.renderingFinished(options);
        } catch (err) {
            this.host.eventService.renderingFailed(options, String(err));
            throw err;
        }
    }

    public getFormattingModel(): powerbi.visuals.FormattingModel {
        return this.formattingSettingsService.buildFormattingModel(this.settings);
    }

    // ── Data ────────────────────────────────────────────────────────────────

    private loadData(dataView: DataView | undefined): void {
        const cols = dataView?.table?.columns ?? [];
        const missing: string[] = [];
        if (!cols.some(c => c.roles?.key)) missing.push("Radnøkkel");
        if (!cols.some(c => c.roles?.category)) missing.push("Kategori (lagret)");
        if (!cols.some(c => c.roles?.comment)) missing.push("Kommentar (lagret)");
        if (missing.length > 0) {
            this.model = null;
            this.showMessage("Legg til felt i: " + missing.join(", "));
            return;
        }

        const idx = Visual.indexColumns(cols);
        this.columns = idx.shown.map(i => ({ header: cols[i].displayName, numeric: Visual.isNumeric(cols[i]) }));
        this.formats = idx.shown.map(i => (cols[i].roles?.values ? cols[i].format : undefined));
        const rows = dataView.table.rows;
        const source: SourceRow[] = rows.map(row => ({
            keys: idx.keys.map(i => keyText(row[i] as PrimitiveValue)),
            cells: idx.shown.map(i => this.cellText(row[i], cols[i])),
            sort: idx.shown.map(i => Visual.sortValue(row[i] as PrimitiveValue)),
            raw: idx.shown.map(i => (Visual.isBlank(row[i]) ? null : row[i] as RawValue)),
            category: Visual.text(row[idx.category]),
            comment: Visual.text(row[idx.comment])
        }));
        this.user = idx.user >= 0 ? rows.map(r => Visual.text(r[idx.user])).find(Boolean) ?? null : null;

        const fresh = new AssessmentModel(source);
        const prev = this.model;
        if (prev) fresh.carryEditsFrom(prev, new Set(this.conflicts.keys()));
        // Conflict marks stay until the next save; drop marks for rows that are gone
        this.conflicts.forEach((_, id) => { if (!fresh.row(id)) this.conflicts.delete(id); });
        this.model = fresh;
        this.showMessage(fresh.isEmpty ? "Ingen data for gjeldende filter." : "");
    }

    /** Column positions by role, in the order of the fields in the wells. */
    private static indexColumns(cols: DataViewMetadataColumn[]): ColumnIndex {
        const byRole = (role: string) => cols
            .map((c, i) => ({ c, i }))
            .filter(x => x.c.roles?.[role])
            .sort((a, b) => Visual.roleIndex(a.c, role) - Visual.roleIndex(b.c, role))
            .map(x => x.i);
        const keys = byRole("key").slice(0, 3);
        return {
            keys,
            shown: [...keys, ...byRole("details"), ...byRole("values")],
            category: byRole("category")[0],
            comment: byRole("comment")[0],
            user: byRole("user")[0] ?? -1
        };
    }

    /** Position of the field in its well (rolesIndex is set at runtime but missing from the API typings). */
    private static roleIndex(c: DataViewMetadataColumn, role: string): number {
        return (c as DataViewMetadataColumn & { rolesIndex?: Record<string, number[]> }).rolesIndex?.[role]?.[0] ?? 0;
    }

    /** Key and info columns are shown as-is (no thousand separators on e.g. years); measures use their format string. */
    private cellText(v: PrimitiveValue, col: DataViewMetadataColumn): string {
        if (col.roles?.key || col.roles?.details) {
            if (Visual.isBlank(v)) return "(Blank)";
            return v instanceof Date ? this.format.format(v) : String(v);
        }
        return this.format.format(v, col.format);
    }

    private static isNumeric(c: DataViewMetadataColumn): boolean {
        return !!(c.type?.numeric || c.type?.integer) && !c.roles?.key && !c.roles?.details;
    }

    private static isBlank(v: PrimitiveValue): boolean {
        return v === null || v === undefined || v === "";
    }

    private static text(v: PrimitiveValue): string | null {
        return Visual.isBlank(v) ? null : String(v);
    }

    private static sortValue(v: PrimitiveValue): string | number | null {
        if (Visual.isBlank(v)) return null;
        if (v instanceof Date) return v.getTime();
        if (typeof v === "number") return v;
        if (typeof v === "boolean") return v ? 1 : 0;
        return String(v);
    }

    // ── Editing ─────────────────────────────────────────────────────────────

    private edit(id: string, change: () => void): void {
        if (!this.model) return;
        change();
        this.table.refreshRow(id);
        this.setStatus("");
        this.updateButtons();
    }

    private discard(): void {
        if (!this.model || this.model.changeCount === 0) return;
        this.model.discard();
        this.conflicts.clear();
        this.setStatus("Endringene er forkastet.");
        this.render();
    }

    // ── Save / export ───────────────────────────────────────────────────────

    private async save(): Promise<void> {
        const model = this.model;
        if (!model || this.saving) return;
        if (model.changeCount === 0) {
            this.setStatus("Ingenting å lagre.");
            return;
        }
        const wb = this.settings.writeBackCard;
        const endpoint = wb.endpoint.value.trim();
        const context = wb.context.value.trim();
        const endpointError = validateEndpoint(endpoint);
        if (endpointError || !context) {
            this.setStatus(endpointError ?? "Sett Kontekst under Format › Write-back.", true);
            return;
        }

        // Reuse the batch id after a timeout so a save that did reach the database is not applied twice
        const snapshot = model.snapshot();
        if (this.pendingBatch?.snapshot !== snapshot) this.pendingBatch = { id: crypto.randomUUID(), snapshot };
        const payload = model.buildPayload(this.pendingBatch.id, context, this.user);

        this.saving = true;
        this.setStatus("Lagrer…");
        this.updateButtons();
        try {
            const result = await saveAssessments(endpoint, wb.functionKey.value.trim(), payload);
            this.pendingBatch = null;
            if (result.status === "conflict") {
                this.markConflicts(result.conflicts);
                // Re-query so the table shows the other user's values; unsaved edits are carried over
                this.host.refreshHostData();
                return;
            }
            if (this.model === model) model.markSaved();
            this.conflicts.clear();
            const time = new Date(result.savedAt).toLocaleTimeString(this.host.locale);
            this.setStatus(result.status === "duplicate"
                ? `Allerede lagret (${time}).`
                : `Lagret ${time}: ${result.inserted} nye, ${result.updated} endret, ${result.deleted} fjernet.`);
            if (wb.refreshAfterSave.value) this.host.refreshHostData();
        } catch (err) {
            if (!(err instanceof NetworkError)) this.pendingBatch = null;
            this.setStatus((err as Error).message, true);
        } finally {
            this.saving = false;
            this.render();
        }
    }

    private markConflicts(conflicts: Conflict[]): void {
        this.conflicts.clear();
        for (const c of conflicts) {
            const when = c.modifiedAt ? new Date(c.modifiedAt).toLocaleString(this.host.locale) : "";
            const now = [c.category ?? "(ingen kategori)", c.comment ? `«${c.comment}»` : ""].filter(Boolean).join(" – ");
            this.conflicts.set(rowId(c.keys),
                `Endret av ${c.modifiedBy ?? "en annen"}${when ? " " + when : ""}. Nå lagret: ${c.category === null && !c.comment ? "(tom)" : now}. `
                + "Lagre igjen for å overskrive.");
        }
        const who = Array.from(new Set(conflicts.map(c => c.modifiedBy).filter(Boolean))).join(", ");
        this.setStatus(`Ikke lagret: ${conflicts.length} rad(er) er endret av ${who || "en annen"}. `
            + "De er merket røde; sjekk dem og lagre igjen for å overskrive.", true);
    }

    /** Exports the rows currently shown (search/filter/sort applied), including unsaved edits. */
    private async exportXlsx(): Promise<void> {
        const model = this.model;
        if (!model) return;
        const t = this.settings.tableCard;
        const rows = this.table.visibleRows();
        const wb = buildWorkbook({
            sheetName: t.title.value || this.settings.writeBackCard.context.value || "Vurderinger",
            columns: this.columns.map((c, i) => ({ header: c.header, format: this.formats[i] })),
            categoryHeader: t.categoryHeader.value || "Kategori",
            commentHeader: t.commentHeader.value || "Kommentar",
            categories: parseCategories(t.categories.value),
            colorCategories: t.colorCategories.value,
            rows: rows.map(r => ({
                values: r.raw ?? r.cells,
                category: model.category(r.id),
                comment: model.comment(r.id),
                dirty: model.isDirty(r.id)
            }))
        });
        const base = (this.settings.writeBackCard.context.value.trim() || "Vurderinger").replace(/[\\/:*?"<>|]+/g, "_");
        const fileName = `${base}_${new Date().toISOString().slice(0, 10)}.xlsx`;
        const note = model.changeCount > 0 ? " Filen inneholder ulagrede endringer (gule)." : "";

        try {
            const status = await this.host.downloadService.exportStatus();
            if (status === powerbi.PrivilegeStatus.Allowed) {
                const ok = await this.host.downloadService.exportVisualsContent(workbookBase64(wb), fileName, "xlsx", "Vurderinger");
                if (ok) {
                    this.setStatus(`Eksportert ${rows.length} rader til ${fileName}.${note}`);
                    return;
                }
            }
        } catch {
            // fall back to a download link below
        }
        // Export blocked (tenant setting / environment): offer a plain link - a user click on it is allowed in the sandbox
        this.showDownloadLink(workbookBlob(wb), fileName, note);
    }

    private showDownloadLink(blob: Blob, fileName: string, note: string): void {
        this.statusEl.replaceChildren();
        this.statusEl.classList.remove("error");
        delete this.statusEl.dataset.auto;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = fileName;
        a.textContent = `Last ned ${fileName}`;
        a.className = "at-link";
        a.addEventListener("click", () => setTimeout(() => this.setStatus(`Lastet ned ${fileName}.${note}`), 0));
        this.statusEl.append("Power BI-eksport er ikke tilgjengelig her: ", a);
        this.statusEl.title = "Høyreklikk og velg «Lagre lenke som…» hvis klikk ikke laster ned filen.";
    }

    // ── UI ──────────────────────────────────────────────────────────────────

    private render(): void {
        const t = this.settings.tableCard;
        const categories = parseCategories(t.categories.value);
        this.updateFilterOptions(categories);
        const show = !!this.model && !this.model.isEmpty;
        this.table.element.style.display = show ? "" : "none";
        if (show) {
            this.table.render(this.model, {
                columns: this.columns,
                categories,
                categoryHeader: t.categoryHeader.value,
                commentHeader: t.commentHeader.value,
                colorCategories: t.colorCategories.value,
                fontSize: Math.min(Math.max(t.fontSize.value, 8), 24),
                conflicts: this.conflicts
            });
        }
        this.updateButtons();
    }

    private updateFilterOptions(categories: string[]): void {
        const values = [FILTER_ALL, FILTER_NONE, ...categories];
        const current = this.filterEl.value || FILTER_ALL;
        if (Array.from(this.filterEl.options).map(o => o.value).join("|") !== values.join("|")) {
            this.filterEl.replaceChildren(...values.map(v => {
                const o = document.createElement("option");
                o.value = v;
                o.textContent = v === FILTER_ALL ? "Alle kategorier" : v === FILTER_NONE ? "Uten kategori" : v;
                return o;
            }));
            this.filterEl.value = values.includes(current) ? current : FILTER_ALL;
            this.table.setCategoryFilter(this.filterEl.value);
        }
    }

    private updateButtons(): void {
        const changes = this.model?.changeCount ?? 0;
        this.buttons.save.disabled = this.saving || changes === 0;
        this.buttons.discard.disabled = this.saving || changes === 0;
        this.buttons.download.disabled = !this.model || this.model.isEmpty;
        if (!this.statusEl.textContent || this.statusEl.dataset.auto) {
            const hidden = this.model?.hiddenChangeCount ?? 0;
            this.statusEl.textContent = changes === 0 ? ""
                : `${changes} ulagret endring${changes === 1 ? "" : "er"}` + (hidden ? ` (${hidden} i rader som er filtrert bort)` : "");
            this.statusEl.dataset.auto = "1";
            this.statusEl.classList.remove("error");
        }
    }

    /** Shows a message in the toolbar; an empty message falls back to the change count. */
    private setStatus(text: string, isError = false): void {
        this.statusEl.textContent = text;
        this.statusEl.title = text;
        this.statusEl.classList.toggle("error", isError);
        if (text) delete this.statusEl.dataset.auto;
        else this.statusEl.dataset.auto = "1";
    }

    private showMessage(text: string): void {
        this.messageEl.textContent = text;
        this.messageEl.style.display = text ? "" : "none";
    }

    private addButton(parent: HTMLElement, icon: string, title: string, onClick: () => void): void {
        const btn = document.createElement("button");
        btn.className = "at-btn";
        btn.title = title;
        btn.setAttribute("aria-label", title);
        const svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        const path = document.createElementNS(SVG_NS, "path");
        path.setAttribute("d", ICONS[icon]);
        svg.appendChild(path);
        btn.appendChild(svg);
        btn.addEventListener("click", onClick);
        parent.appendChild(btn);
        this.buttons[icon] = btn;
    }
}
