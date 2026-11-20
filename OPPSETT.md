# Oppsett – sjekkliste

Gå gjennom stegene i rekkefølge og kryss av underveis. Del A–D er nok til å teste på din egen PC. Del E trenger du først når andre skal bruke rapporten.

Oppsettet bruker **Microsoft Entra ID med MFA** (din vanlige jobbkonto), så du trenger ikke noe SQL-passord. Har du likevel en SQL-bruker med passord, ser du [Alternativ: SQL-brukernavn og passord](#alternativ-sql-brukernavn-og-passord) nederst.

---

## Informasjon du trenger

Alt finner du i Azure-portalen ([portal.azure.com](https://portal.azure.com)).

| Hva | Hvor finner jeg det | Eksempel | Brukes i steg |
|---|---|---|---|
| **Servernavn** | SQL databases › din database › *Overview* › «Server name» | `minserver.database.windows.net` | 2, 5, 10 |
| **Databasenavn** | SQL databases › navnet i listen | `PlanningDb` | 2, 5, 10 |
| **Jobbkontoen din** | Den du logger inn i Azure med | `torgeir@firma.no` | 4, 5, 10 |
| *(Del E)* **Function App-navn** | Velger du selv når du lager den | `mastertable-func` | 18–23 |

Kontoen din må ha tilgang til databasen. Kommer du inn med MFA i VS Code eller SSMS i dag, er det i orden.

**Programmer som må være installert:**

| Program | Sjekk i PowerShell | Mangler det? |
|---|---|---|
| Node.js | `node --version` | [nodejs.org](https://nodejs.org) (LTS) |
| Azure Functions Core Tools | `func --version` | `npm install -g azure-functions-core-tools@4` |
| Azure CLI | `az --version` | [Installer Azure CLI](https://aka.ms/installazurecliwindows) |
| VS Code + utvidelsen **SQL Server (mssql)** | – | Søk etter «mssql» under Extensions i VS Code |
| Power BI Desktop | – | Microsoft Store |

Node, `func` og `az` er allerede installert på denne PC-en.

---

## Del A – Gi PC-en tilgang til databasen

- [ ] **1. Åpne innstillingsfilen**
  - Åpne filen `C:\Users\torge\Documents\Forecasting\MasterTable\AzureFunction\local.settings.json`
  - Finnes den ikke: kopier `local.settings.example.json` i samme mappe og gi kopien navnet `local.settings.json`

- [ ] **2. Fyll inn server og database**
  - Erstatt de to plassholderne:
    ```json
    "SQL_SERVER": "minserver.database.windows.net",
    "SQL_DATABASE": "PlanningDb",
    "SQL_CONNECTION_STRING": ""
    ```
  - La `SQL_CONNECTION_STRING` stå tom
  - Lagre. Filen inneholder ikke noe passord og blir aldri lastet opp til GitHub.

- [ ] **3. Åpne brannmuren for PC-en din**
  - Portalen › SQL-serveren (klikk på servernavnet) › *Networking*
  - Klikk **Add your client IPv4 address** og deretter **Save**
  - Må gjøres på nytt hvis du bytter nettverk, f.eks. hjemme og på jobb

- [ ] **4. Logg inn i Azure på PC-en**
  - Kjør dette i PowerShell:
    ```powershell
    az login
    ```
  - Et nettleservindu åpnes. Logg inn med jobbkontoen og godkjenn MFA.
  - Funksjonen bruker denne innloggingen mot databasen. Den varer en god stund, men kjør `az login` på nytt hvis du får innloggingsfeil senere.

---

## Del B – Lag tabellene i databasen

- [ ] **5. Koble til fra VS Code**
  - Klikk på SQL Server-ikonet i venstre kant › **Add Connection**
  - Fyll inn servernavn og databasenavn
  - Under **Authentication type** velger du **Microsoft Entra ID – Universal with MFA support**
  - Velg kontoen din, eller klikk *Add account* og logg inn

- [ ] **6. Kjør skriptet**
  - Åpne `MasterTable\database\assessment.sql`
  - Trykk **Ctrl+Shift+E**, eller høyreklikk og velg *Execute Query*

- [ ] **7. Sjekk at det virket**
  ```sql
  SELECT * FROM dbo.AssessmentCategory;
  ```
  - Du skal få 3 rader: *Justert*, *Ikke justert* og *Kan ikke justeres*

- [ ] **7b. (Valgfritt) Legg inn dummy-vurderinger**
  - Åpne og kjør `MasterTable\AssessmentVisual\dist\Dummydata_vurderinger.sql`
  - Den legger inn 10 vurderinger med Kontekst `Test` som passer til `Dummydata.xlsx`
  - Slette dem igjen: `DELETE dbo.Assessment WHERE Context = N'Test';`

---

## Del C – Start lagringsfunksjonen på PC-en

- [ ] **8. Start funksjonen** i et PowerShell-vindu:
  ```powershell
  cd C:\Users\torge\Documents\Forecasting\MasterTable\AzureFunction
  npm install
  func start
  ```
  - Når den er klar, står det `saveAssessment: [POST,OPTIONS] http://localhost:7071/api/assessment/save`
  - **La vinduet stå åpent** så lenge du tester. Lukker du det, stopper lagringen.

---

## Del D – Power BI Desktop

- [ ] **9. Last inn testdata**
  - Velg **Hjem › Excel-arbeidsbok** og åpne `MasterTable\AssessmentVisual\dist\Dummydata.xlsx`
  - Huk av **Prosjekter** og klikk **Last inn**

- [ ] **10. Koble til databasen**
  - Velg **Hent data › Azure SQL-database**
  - Skriv inn servernavn og databasenavn, og velg **DirectQuery**
  - I innloggingsvinduet velger du **Microsoft-konto** til venstre › **Logg på**, og logger inn med jobbkontoen og MFA
  - Klikk **Koble til**, huk av `vw_Assessment` og klikk **Last inn**

- [ ] **11. Lag en nøkkelkolonne**
  - Høyreklikk `Prosjekter` › **Ny kolonne** og lim inn:
    ```DAX
    RowKey = Prosjekter[Prosjekt] & "|" & Prosjekter[År]
    ```

- [ ] **12. Koble tabellene sammen**
  - Åpne **Modellvisning** (det tredje ikonet til venstre)
  - Dra `Prosjekter[RowKey]` over til `vw_Assessment[RowKey]`
  - Kontroller at relasjonen er **én (Prosjekter) til mange (vw_Assessment)**

- [ ] **13. Lag to mål** (eller endre dem, hvis du allerede har laget `BLANK()`-versjonene)
  ```DAX
  Kategori = MAX(vw_Assessment[Category])
  ```
  ```DAX
  Kommentar = MAX(vw_Assessment[Comment])
  ```

- [ ] **14. Importer visualen** (hopp over hvis den allerede er på siden)
  - Gå til Visualiseringer-panelet › **…** › **Importer et visualobjekt fra en fil**
  - Velg `.pbiviz`-filen i `MasterTable\AssessmentVisual\dist\`
  - Klikk på det nye ikonet, slik at visualen havner på siden

- [ ] **15. Legg inn feltene**

  | Feltboks | Dra inn |
  |---|---|
  | Radnøkkel | `Prosjekt`, deretter `År` |
  | Infokolonner *(valgfritt)* | `Prosjektnavn`, `Segment` |
  | Verdier *(valgfritt)* | `Timepris`, `Endring`, `Timer` (velg **Sum** hvis det står Antall) |
  | Kategori (lagret) | målet `Kategori` |
  | Kommentar (lagret) | målet `Kommentar` |
  | Bruker *(valgfritt)* | et mål `User = USERPRINCIPALNAME()` |

  - Høyreklikk `Prosjekt` i Radnøkkel-boksen og velg **Vis elementer uten data**

- [ ] **16. Fortell visualen hvor den skal lagre** (Format › Write-back)

  | Innstilling | Verdi |
  |---|---|
  | Function URL | `http://localhost:7071/api/assessment/save` |
  | Function key | *(la stå tomt)* |
  | Kontekst | `Test` |

- [ ] **17. Test**
  - Velg en kategori, skriv en kommentar og klikk på diskett-ikonet
  - Det skal stå «Lagret kl. …», og verdiene skal bli stående etter at Power BI har oppdatert
  - Sjekk også i VS Code: `SELECT * FROM dbo.vw_Assessment;`

---

## Del E – I drift i Azure (når andre skal bruke rapporten)

I Azure logger funksjonen inn med sin egen identitet (*managed identity*), heller ikke her trengs noe passord.

- [ ] **18. Lag en egen Function App**
  - Portalen › *Create a resource* › **Function App**
  - Velg **Consumption**-plan, Runtime **Node.js 20**, og et navn du velger selv
  - Bruk **ikke** samme Function App som Planning Grid. Publisering erstatter alle funksjonene i appen.

- [ ] **19. Slå på managed identity**
  - Function App › *Settings* › **Identity** › fanen *System assigned* › **On** › **Save**

- [ ] **20. Gi funksjonen tilgang til databasen**
  - Kjør dette i VS Code, koblet til databasen. Bytt ut navnet med navnet på Function App-en din.
    ```sql
    CREATE USER [mastertable-func] FROM EXTERNAL PROVIDER;
    ALTER ROLE db_datareader ADD MEMBER [mastertable-func];
    ALTER ROLE db_datawriter ADD MEMBER [mastertable-func];
    GRANT EXECUTE ON dbo.usp_SaveAssessments TO [mastertable-func];
    ```
  - Får du en feil om tilgang, må en med admin-rettigheter på SQL-serveren kjøre dette for deg

- [ ] **21. Sett server og database**
  - Function App › *Settings* › *Environment variables* › **Add**, to ganger:
    - `SQL_SERVER` = servernavnet
    - `SQL_DATABASE` = databasenavnet
  - Klikk **Apply**

- [ ] **22. Gi Azure tilgang til SQL-serveren**
  - SQL-serveren › *Networking*
  - Huk av **Allow Azure services and resources to access this server** og klikk **Save**

- [ ] **23. Publiser funksjonen**
  ```powershell
  az login
  cd C:\Users\torge\Documents\Forecasting\MasterTable\AzureFunction
  func azure functionapp publish <function-app-navn>
  ```

- [ ] **24. Hent function key**
  - Function App › *Functions* › *App keys* › kopier verdien til `default`

- [ ] **25. Pek visualen mot Azure** (Format › Write-back)

  | Innstilling | Verdi |
  |---|---|
  | Function URL | `https://<function-app-navn>.azurewebsites.net/api/assessment/save` |
  | Function key | nøkkelen fra steg 24 |
  | Kontekst | f.eks. `Ratejustering`. Bytt fra `Test`, ellers blandes testdata og ekte data. |

- [ ] **26. Bytt testdata mot ekte data**
  - Erstatt `Prosjekter` med den ekte prosjekt/år-tabellen din
  - Lag `RowKey` på samme måte som i steg 11

---

## Hvis noe går galt

| Feilmelding | Årsak | Løsning |
|---|---|---|
| «Fikk ikke kontakt med Function App» (i visualen) | Funksjonen kjører ikke, eller URL-en er feil | Sjekk at `func start`-vinduet er åpent (steg 8), og sjekk URL-en (steg 16) |
| «Database error» i visualen. I `func start`-vinduet står det `CredentialUnavailableError` eller `az login` | Ikke logget inn i Azure på PC-en | Kjør `az login` (steg 4), og start `func start` på nytt |
| `Login failed for user '<token-identified principal>'` i `func start`-vinduet | Kontoen din, eller Function App-en i Azure, er ikke bruker i databasen | Lokalt: be en admin gi kontoen din tilgang. I Azure: gjør steg 20. |
| `Client with IP address ... is not allowed` | Brannmuren | Gjør steg 3 på nytt (eller steg 22 i Azure) |
| `ENOTFOUND <server>` | Plassholderen står fortsatt i innstillingsfilen | Fyll inn steg 2 |
| «Ingen tilgang (401)» (i visualen) | Feil eller manglende function key (Azure) | Gjør steg 24 på nytt |
| «Unknown category» | Kategorien finnes ikke i databasen | Sjekk at den er stavet likt i *Format › Tabell › Kategorier* og i `dbo.AssessmentCategory` |
| Tabellen er tom | Ingen rader har vurdering ennå | Gjør steg 15 (*Vis elementer uten data*) |
| Lagret, men verdien forsvinner | Relasjonen eller nøkkelen stemmer ikke | Sjekk steg 11–12. Kjør `SELECT RowKey FROM dbo.vw_Assessment` og sammenlign med `Prosjekter[RowKey]`. |

---

## Alternativ: SQL-brukernavn og passord

Har du en SQL-bruker med passord i stedet for MFA:
- Steg 2: la `SQL_SERVER` og `SQL_DATABASE` stå tomme, og lim inn ADO.NET-tilkoblingsstrengen fra portalen (*Connection strings*) i `SQL_CONNECTION_STRING`, med passordet ditt i stedet for `{your_password}`
- Steg 4 trengs ikke
- Steg 5 og 10: velg innloggingstypen *SQL Login* / *Database*
- Del E: sett `SQL_CONNECTION_STRING` i stedet for steg 19–21
