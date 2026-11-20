# Oppsett – sjekkliste

Gå gjennom stegene i rekkefølge og kryss av underveis. Del A–D er nok til å teste på din egen PC. Del E trenger du først når andre skal bruke rapporten.

---

## Informasjon du trenger

Finn dette før du starter. Alt ligger i Azure-portalen ([portal.azure.com](https://portal.azure.com)).

| Hva | Hvor finner jeg det | Eksempel | Brukes i steg |
|---|---|---|---|
| **Servernavn** | SQL databases › din database › *Overview* › «Server name» | `minserver.database.windows.net` | 2, 9 |
| **Databasenavn** | SQL databases › navnet i listen | `PlanningDb` | 2, 9 |
| **SQL-brukernavn** | SQL-serveren › *Overview* › «Server admin» (eller en egen bruker du har fått) | `sqladmin` | 2, 9 |
| **SQL-passord** | Det du valgte da serveren ble laget. Har du glemt det: SQL-serveren › *Reset password* | – | 2, 9 |
| **Tilkoblingsstreng** | SQL databases › din database › *Connection strings* › fanen **ADO.NET** | se steg 2 | 2 |
| *(Del E)* **Function App-navn** | Velger du selv når du lager den | `mastertable-func` | 17–20 |

**Programmer som må være installert:**

| Program | Sjekk i PowerShell | Mangler det? |
|---|---|---|
| Node.js | `node --version` | [nodejs.org](https://nodejs.org) (LTS) |
| Azure Functions Core Tools | `func --version` | `npm install -g azure-functions-core-tools@4` |
| VS Code + utvidelsen **SQL Server (mssql)** | – | Søk etter «mssql» under Extensions i VS Code |
| Power BI Desktop | – | Microsoft Store |

Node og `func` er allerede installert på denne PC-en.

---

## Del A – Gi PC-en tilgang til databasen

- [ ] **1. Lag innstillingsfilen**
  - Gå til mappen `C:\Users\torge\Documents\Forecasting\MasterTable\AzureFunction`
  - Kopier `local.settings.example.json` og gi kopien navnet `local.settings.json`

- [ ] **2. Lim inn tilkoblingsstrengen**
  - Åpne `local.settings.json`
  - Erstatt teksten etter `"SQL_CONNECTION_STRING":` med tilkoblingsstrengen fra portalen
  - Bytt ut `{your_password}` med passordet ditt, uten krøllparentesene
  - Resultatet skal se slik ut:
    ```
    "SQL_CONNECTION_STRING": "Server=tcp:minserver.database.windows.net,1433;Initial Catalog=PlanningDb;User ID=sqladmin;Password=MittPassord;Encrypt=True;..."
    ```
  - Lagre. Filen blir aldri lastet opp til GitHub.

- [ ] **3. Åpne brannmuren for PC-en din**
  - Portalen › SQL-serveren (klikk på servernavnet) › *Networking*
  - Klikk **Add your client IPv4 address** og deretter **Save**
  - Må gjøres på nytt hvis du bytter nettverk, f.eks. hjemme og på jobb

---

## Del B – Lag tabellene i databasen

- [ ] **4. Koble til fra VS Code**
  - Klikk på SQL Server-ikonet i venstre kant › **Add Connection**
  - Fyll inn servernavn, databasenavn, *SQL Login*, brukernavn og passord

- [ ] **5. Kjør skriptet**
  - Åpne `MasterTable\database\assessment.sql`
  - Trykk **Ctrl+Shift+E**, eller høyreklikk og velg *Execute Query*

- [ ] **6. Sjekk at det virket**
  - Kjør dette i et nytt spørringsvindu:
    ```sql
    SELECT * FROM dbo.AssessmentCategory;
    ```
  - Du skal få 3 rader: *Justert*, *Ikke justert* og *Kan ikke justeres*

- [ ] **6b. (Valgfritt) Legg inn dummy-vurderinger**
  - Åpne og kjør `MasterTable\AssessmentVisual\dist\Dummydata_vurderinger.sql`
  - Den legger inn 10 vurderinger med Kontekst `Test` som passer til `Dummydata.xlsx`, slik at tabellen ikke er tom første gang
  - Slette dem igjen: `DELETE dbo.Assessment WHERE Context = N'Test';`

---

## Del C – Start lagringsfunksjonen på PC-en

- [ ] **7. Start funksjonen** i et PowerShell-vindu:
  ```powershell
  cd C:\Users\torge\Documents\Forecasting\MasterTable\AzureFunction
  npm install
  func start
  ```
  - Når den er klar, står det `saveAssessment: [POST,OPTIONS] http://localhost:7071/api/assessment/save`
  - **La vinduet stå åpent** så lenge du tester. Lukker du det, stopper lagringen.

---

## Del D – Power BI Desktop

- [ ] **8. Lag testdata**
  - Velg **Hjem › Excel-arbeidsbok** og åpne `MasterTable\AssessmentVisual\dist\Dummydata.xlsx`
  - Huk av tabellen **Prosjekter** og klikk **Last inn**
  - Filen har 8 prosjekter × 2 år med kolonnene `Prosjekt`, `År`, `Prosjektnavn`, `Segment`, `Timepris`, `Endring` og `Timer`
  - `Dummydata.csv` inneholder det samme, hvis du heller vil bruke den

- [ ] **9. Koble til databasen**
  - Velg **Hent data › Azure SQL-database**
  - Skriv inn servernavn og databasenavn, og velg **DirectQuery**
  - Velg innloggingstypen **Database**, og bruk SQL-brukernavn og passord
  - Huk av `vw_Assessment` og klikk **Last inn**

- [ ] **10. Lag en nøkkelkolonne**
  - Høyreklikk `Prosjekter` › **Ny kolonne** og lim inn:
    ```DAX
    RowKey = Prosjekter[Prosjekt] & "|" & Prosjekter[År]
    ```

- [ ] **11. Koble tabellene sammen**
  - Åpne **Modellvisning** (det tredje ikonet til venstre)
  - Dra `Prosjekter[RowKey]` over til `vw_Assessment[RowKey]`
  - Kontroller at relasjonen er **én (Prosjekter) til mange (vw_Assessment)**

- [ ] **12. Lag to mål**
  - Høyreklikk `Prosjekter` › **Nytt mål**. Gjør det én gang for hvert mål:
    ```DAX
    Kategori = MAX(vw_Assessment[Category])
    ```
    ```DAX
    Kommentar = MAX(vw_Assessment[Comment])
    ```

- [ ] **13. Bygg og importer visualen**
  - Bygg pakken (hopp over hvis `dist`-mappen allerede har en `.pbiviz`-fil):
    ```powershell
    cd C:\Users\torge\Documents\Forecasting\MasterTable\AssessmentVisual
    npm install
    npm run package
    ```
  - Gå til Visualiseringer-panelet › **…** › **Importer et visualobjekt fra en fil**
  - Velg filen i `MasterTable\AssessmentVisual\dist\`
  - Klikk på det nye ikonet, slik at visualen havner på siden

- [ ] **14. Legg inn feltene**

  | Feltboks | Dra inn |
  |---|---|
  | Radnøkkel | `Prosjekt`, deretter `År` |
  | Infokolonner *(valgfritt)* | `Prosjektnavn`, `Segment` |
  | Verdier *(valgfritt)* | `Timepris`, `Endring`, `Timer` (sett aggregering til **Sum**) |
  | Kategori (lagret) | målet `Kategori` |
  | Kommentar (lagret) | målet `Kommentar` |
  | Bruker *(valgfritt)* | et mål `User = USERPRINCIPALNAME()` |

  - Høyreklikk `Prosjekt` i feltboksen og velg **Vis elementer uten data**. Uten dette er tabellen tom, fordi ingen rader har en vurdering ennå.

- [ ] **15. Fortell visualen hvor den skal lagre**
  - Gå til **Format › Write-back**:

  | Innstilling | Verdi |
  |---|---|
  | Function URL | `http://localhost:7071/api/assessment/save` |
  | Function key | *(la stå tomt)* |
  | Kontekst | `Test` |

- [ ] **16. Test**
  - Velg en kategori, skriv en kommentar og klikk på diskett-ikonet
  - Det skal stå «Lagret kl. …», og verdiene skal bli stående etter at Power BI har oppdatert
  - Sjekk også i VS Code:
    ```sql
    SELECT * FROM dbo.vw_Assessment;
    ```

---

## Del E – I drift i Azure (når andre skal bruke rapporten)

- [ ] **17. Lag en egen Function App**
  - Portalen › *Create a resource* › **Function App**
  - Velg **Consumption**-plan, Runtime **Node.js 20**, og et navn du velger selv
  - Bruk **ikke** samme Function App som Planning Grid. Publisering erstatter alle funksjonene i appen.

- [ ] **18. Sett tilkoblingsstrengen**
  - Function App › *Settings* › *Environment variables* › **Add**
  - Navn: `SQL_CONNECTION_STRING`, verdi: samme streng som i steg 2
  - Klikk **Apply**

- [ ] **19. Gi Azure tilgang til SQL-serveren**
  - SQL-serveren › *Networking*
  - Huk av **Allow Azure services and resources to access this server** og klikk **Save**

- [ ] **20. Publiser funksjonen**
  ```powershell
  az login
  cd C:\Users\torge\Documents\Forecasting\MasterTable\AzureFunction
  func azure functionapp publish <function-app-navn>
  ```

- [ ] **21. Hent function key**
  - Function App › *Functions* › *App keys* › kopier verdien til `default`

- [ ] **22. Pek visualen mot Azure**

  | Innstilling | Verdi |
  |---|---|
  | Function URL | `https://<function-app-navn>.azurewebsites.net/api/assessment/save` |
  | Function key | nøkkelen fra steg 21 |
  | Kontekst | f.eks. `Ratejustering`. Bytt fra `Test`, ellers blandes testdata og ekte data. |

- [ ] **23. Bytt testdata mot ekte data**
  - Erstatt tabellen `Prosjekter` med den ekte prosjekt/år-tabellen din
  - Lag `RowKey` på samme måte som i steg 10

---

## Hvis noe går galt

| Feilmelding i visualen | Årsak | Løsning |
|---|---|---|
| «Fikk ikke kontakt med Function App» | Funksjonen kjører ikke, eller URL-en er feil | Sjekk at `func start`-vinduet er åpent (steg 7), og sjekk URL-en (steg 15) |
| «Ingen tilgang (401)» | Feil eller manglende function key (Azure) | Gjør steg 21 på nytt |
| «Database error» i `func start`-vinduet | Brannmur eller tilkoblingsstreng | Gjør steg 3 på nytt, og sjekk passordet i steg 2 |
| «Unknown category» | Kategorien finnes ikke i databasen | Sjekk at den er stavet likt i *Format › Tabell › Kategorier* og i `dbo.AssessmentCategory` |
| Tabellen er tom | Ingen rader har vurdering ennå | Gjør steg 14 (*Vis elementer uten data*) |
| Lagret, men verdien forsvinner | Relasjonen eller nøkkelen stemmer ikke | Sjekk steg 10–11. Kjør `SELECT RowKey FROM dbo.vw_Assessment` og sammenlign med `Prosjekter[RowKey]`. |
| «Sett Kontekst under Format › Write-back» | Kontekst er tom | Fyll inn i steg 15 |
