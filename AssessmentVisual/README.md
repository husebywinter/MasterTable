# Vurderingstabell – Power BI custom visual

Tabell der hver rad får en **kategori** (nedtrekksliste: *Justert*, *Ikke justert*, *Kan ikke justeres*) og en **kommentar** (fritekst). Begge lagres i Azure SQL via Azure Function:

```
Visual ──POST /api/assessment/save──▶ AzureFunction/saveAssessment.js ──▶ dbo.usp_SaveAssessments ──▶ dbo.Assessment (+ historikk)
   ▲                                                                                                    │
   └──────────────────────────── Power BI (DirectQuery mot dbo.vw_Assessment) ◀─────────────────────────┘
```

## Struktur

| Fil | Innhold |
|---|---|
| `capabilities.json` | Datafelter, format-pane-objekter, `WebAccess`-tillatte domener |
| `src/visual.ts` | Entry: leser dataView, verktøylinje, lagring, konflikter, Excel-eksport |
| `src/export.ts` | Bygger xlsx-filen (xlsx-js-style): overskrift, tallformat, fargede kategorier, autofilter |
| `src/model.ts` | Rader, ulagrede endringer med original-verdier, payload |
| `src/table.ts` | Tabellen: sortering, søk, filter, nedtrekksliste og kommentarfelt |
| `src/api.ts` | Kall mot `saveAssessment` |
| `src/format.ts` | Visningsformat for verdier og stabile nøkkelverdier |
| `src/settings.ts` | Format pane (Tabell og Write-back) |
| `test/*.test.mjs` | Tester for modell og Excel-eksport (`npm test`) |
| `test/harness.html` | Visualen med eksempeldata og mock-API i nettleseren (etter `npm run package`) |
| `../database/assessment.sql` | Tabeller, temporal historikk, prosedyre og views |
| `../AzureFunction/src/functions/saveAssessment.js` | API-et visualen kaller |

## Oppsett

1. Kjør `database/assessment.sql` mot Azure SQL-databasen (kan være samme database som andre løsninger).
2. Deploy `AzureFunction` til en egen Function App (se [hoved-README](../README.md#deploy-til-azure)). Lokalt: `func start`, og bruk `http://localhost:7071/api/assessment/save`.
3. `npm install` og `npm run package` i denne mappen. Importer `dist/*.pbiviz` i Power BI.
4. I Power BI: legg til `vw_Assessment` med **DirectQuery**, filtrert på `Context` = verdien du setter i visualen. Lag en relasjon fra `vw_Assessment[RowKey]` til en tilsvarende nøkkelkolonne i modellen din (se under), eller bruk mål med `LOOKUPVALUE`/`TREATAS`.

## Felter i visualen

| Felt | Påkrevd | Eksempel |
|---|---|---|
| Radnøkkel | ja (1–3 felt) | `Prosjekt[Nummer]`, `Kalender[År]`. Lagres som `Key1`–`Key3`. Vises som kolonner. |
| Infokolonner | nei (maks 5) | `Prosjekt[Navn]`. Vises, men er ikke del av nøkkelen. |
| Verdier | nei (maks 10) | Timepris, endring i % osv. Vises skrivebeskyttet med målets formatstreng. |
| Kategori (lagret) | ja | `Kategori = MAX(vw_Assessment[Category])` |
| Kommentar (lagret) | ja | `Kommentar = MAX(vw_Assessment[Comment])` |
| Bruker | nei | `User = USERPRINCIPALNAME()`. Lagres som `ModifiedBy`. |

**Nøkkelformat:** verdiene sendes som tekst i samme rekkefølge som feltene i *Radnøkkel*. Tall uten tusenskille (`2026`), datoer som `YYYY-MM-DD`, blank som `(Blank)`. `vw_Assessment[RowKey]` er nøklene skilt med `|`, f.eks. `P-1001|2026`. Lag en kolonne med samme format i modellen for relasjonen:

```DAX
RowKey = Prosjekt[Nummer] & "|" & Kalender[År]
```

For at rader uten vurdering skal vises, må målene for kategori/kommentar ikke fjerne radene. Bruk *Show items with no data* på nøkkelfeltet, eller ta med et verdi-mål som alltid har verdi for rader som skal vurderes.

## Write-back-oppsett (Format › Write-back)

- **Function URL:** `https://<app>.azurewebsites.net/api/assessment/save`
- **Function key:** sendes som `?code=`. Lagres i rapporten og er synlig for alle som kan redigere den.
- **Kontekst:** påkrevd. Skiller ulike tabeller i samme database, f.eks. `Ratejustering`. Bytter du kontekst, forkastes ulagrede endringer.
- **Oppdater data etter lagring:** spør modellen på nytt etter lagring.

**Format › Tabell › Kategorier** styrer nedtrekkslisten (semikolonseparert). Verdiene må finnes og være aktive i `dbo.AssessmentCategory`, ellers avvises lagringen. En lagret kategori som er fjernet fra listen vises som «(utgått)».

## Regler i lagringen

| Situasjon | Hva skjer |
|---|---|
| Ny vurdering | INSERT. Bare endrede rader sendes. |
| Endring | UPDATE, men bare hvis databasen fortsatt har verdiene brukeren startet fra |
| Konflikt (noen andre har endret raden) | Ingenting lagres. Raden markeres rød, og tooltip viser hvem som endret og hva som er lagret nå. Data hentes på nytt. Feltet brukeren ikke rørte, får den andres verdi; feltet brukeren endret, beholdes. Lagre igjen for å overskrive. |
| Tom kategori og tom kommentar | DELETE. Raden finnes fortsatt i `AssessmentHistory`, med hvem som tømte den. |
| Ukjent/inaktiv kategori | Avvises (HTTP 400) |
| Retry etter tidsavbrudd | Samme `batchId` sendes igjen. Er den allerede lagret, svarer API-et `duplicate`. |

### Payload

```json
{
  "batchId": "0b6c…",
  "user": "ola@firma.no",
  "context": "Ratejustering",
  "rows": [ { "keys": ["P-1002", "2026"], "category": "Justert", "comment": "Avtalt med kunde",
              "originalCategory": null, "originalComment": null } ]
}
```

Svar: `200 {status: "saved" | "duplicate", inserted, updated, deleted}`, `409 {status: "conflict", conflicts: [{keys, category, comment, modifiedBy, modifiedAt}]}`, `400 {error}`.

## Bruk

- Velg kategori i nedtrekkslisten, skriv kommentar direkte i feltet.
- Enter / Shift+Enter (og pil opp/ned i kommentarfeltet) flytter til neste/forrige rad. Esc angrer raden. Ctrl+S lagrer.
- Klikk på en kolonneoverskrift for å sortere. Søk, kategorifilter (inkl. *Uten kategori*) og *Bare endrede* i verktøylinjen.
- Gult betyr ulagret endring. Rødt betyr konflikt med en annen brukers endring.
- Verktøylinjen har Lagre, Forkast og **Eksporter til Excel**. Eksporten tar med radene som vises (søk, filter og sortering gjelder), med målenes tallformat, fargede kategorier, frosset overskrift og autofilter. Ulagrede kommentarer er gule i filen.
- Eksporten går via Power BI (`exportVisualsContent`) og krever at tenant-admin tillater eksport fra custom visuals. Er det blokkert, vises en nedlastingslenke i verktøylinjen i stedet.

## Nyttige spørringer

```sql
INSERT dbo.AssessmentCategory (Code, SortOrder) VALUES (N'Under vurdering', 4);        -- ny kategori
SELECT * FROM dbo.vw_AssessmentHistory WHERE RowKey = N'P-1001|2026' ORDER BY ValidFrom; -- hvem endret hva
SELECT * FROM dbo.Assessment FOR SYSTEM_TIME AS OF '2026-06-01';                          -- status per dato
```
