# MasterTable – Vurderingstabell

Power BI-tabell der hver rad får en **kategori** (*Justert*, *Ikke justert*, *Kan ikke justeres*) og en **kommentar**, med write-back til Azure SQL.

| Mappe | Innhold |
|---|---|
| [AssessmentVisual](AssessmentVisual/) | Power BI custom visual. Se [README](AssessmentVisual/README.md) for felter, oppsett og bruk. |
| [AzureFunction](AzureFunction/) | Azure Function `saveAssessment` (`POST /api/assessment/save`) |
| [database](database/) | `assessment.sql`: tabeller, historikk, lagringsprosedyre og views |

Åpne `MasterTable.code-workspace` i VS Code.

**Steg for steg med sjekkliste: se [OPPSETT.md](OPPSETT.md).**

## Kom i gang (lokal test)

1. Kjør `database/assessment.sql` mot Azure SQL-databasen, f.eks. fra VS Code med utvidelsen *SQL Server (mssql)*.
2. Kopier `AzureFunction/local.settings.example.json` til `local.settings.json` og fyll inn `SQL_SERVER` og `SQL_DATABASE`. Innloggingen skjer med Microsoft Entra ID (MFA) via `az login`, så det trengs ikke noe passord. Alternativt kan du bruke `SQL_CONNECTION_STRING` med SQL-bruker og passord. Filen står i `.gitignore`.
3. Start funksjonen: `cd AzureFunction`, `npm install`, `func start`.
4. Bygg visualen: `cd AssessmentVisual`, `npm install`, `npm run package`. Importer `dist/*.pbiviz` i Power BI Desktop.
5. I visualen, under Format › Write-back: Function URL `http://localhost:7071/api/assessment/save`, tom function key, Kontekst `Test`.

## Deploy til Azure

```powershell
cd AzureFunction; npm install; func azure functionapp publish <app-navn>
```

**NB:** `func azure functionapp publish` erstatter *alt* innhold i Function App-en. Deployer du dette til samme Function App som Planning Grid (MultiPlanning), forsvinner `savePlan`. Bruk derfor en egen Function App for MasterTable. Den kan godt bruke samme database og samme `SQL_CONNECTION_STRING`.

I Function App-en: slå på managed identity, gi den tilgang i databasen (`CREATE USER [app] FROM EXTERNAL PROVIDER`), sett `SQL_SERVER` og `SQL_DATABASE`, og slå på *Allow Azure services and resources to access this server* på SQL-serveren. Detaljer finner du i [OPPSETT.md](OPPSETT.md), Del E.
