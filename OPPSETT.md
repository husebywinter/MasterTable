# Oppsett – sjekkliste (bedriftsnett med private endpoints)

Løsningen skal bare brukes av folk på bedriftsnettet. Alt ligger bak private endpoints, og nettverket er allerede satt opp. Du kobler bare MasterTable inn i det som finnes.

```
            ┌──────────────── bedriftsnett / VNet (vnet-swedencentral-azfw-…-powerbi-tools-prod) ────────────────┐
Bruker på   │                                                                                                    │
nettet ─▶ Power BI ─▶ visual ─(https, privat DNS)─▶ pe-funcpowerbiwriteback ─▶ Function App ─(subnet-func-integration)─▶ pe-…-sql ─▶ Azure SQL
            │                                                                                                    ▲
            │  Power BI Service ─(DirectQuery)─▶ gateway ────────────────────────────────────────────────────────┘
            └────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Del | Status |
|---|---|
| VNet, subnett, private endpoints og DNS | ✅ Finnes allerede |
| Function App `func-powerbiwriteback` med VNet-integrasjon | ✅ Finnes allerede. Den er laget for dette. |
| Storage for funksjonen (`pe-sapowerwriteback.blob`) | ✅ Finnes allerede |
| Tabellene i databasen | Del A |
| Koden i Function App-en | Del B |
| Gateway for Power BI Service | Del C |
| Rapporten | Del D–E |

**Viktig å vite:** visualen kjører i nettleseren til brukeren. Function App-en har bare privat tilgang, så **lagring virker bare når brukeren er på bedriftsnettet eller VPN.** Det er slik dere vil ha det.

---

## Informasjon du trenger

| Hva | Hvor finner jeg det | Verdi |
|---|---|---|
| SQL-server | – | `sql-powerbiwriteback.database.windows.net` |
| Database | – | `sqldb-powerbiwriteback` |
| VNet | – | `vnet-swedencentral-azfw-subs-mc-corp-powerbi-tools-prod` (Sweden Central) |
| **Function App-navn** | – | `func-powerbiwriteback` |
| **Function App-adresse** | Function App › *Overview* › *Default domain* | `func-powerbiwriteback-cjgbb5gbfkh4gzad.swedencentral-01.azurewebsites.net` |
| **Maskin på nettverket** | Jobb-PC på bedriftsnettet eller VPN, eller en VM via Bastion (`AzureBastionSubnet` finnes) | |
| **Gateway** | app.powerbi.com › tannhjulet › *Administrer tilkoblinger og gatewayer*, eller spør Power BI-admin | |

Alt under gjøres fra en maskin **på bedriftsnettet**.

**Test nettverket først.** Kjør i PowerShell:
```powershell
Resolve-DnsName sql-powerbiwriteback.database.windows.net
Resolve-DnsName func-powerbiwriteback-cjgbb5gbfkh4gzad.swedencentral-01.azurewebsites.net
```
Begge skal gi `…privatelink…` og en `10.x.x.x`-adresse. Ser du offentlige adresser, er du ikke på nettet, eller så mangler DNS. Kontakt IT.

---

## Del A – Lag tabellene

- [ ] **1. Koble til databasen fra VS Code**
  - Installer utvidelsen **SQL Server (mssql)** i VS Code
  - SQL Server-ikonet › **Add Connection**:
    - Server `sql-powerbiwriteback.database.windows.net`, database `sqldb-powerbiwriteback`
    - Authentication type: **Microsoft Entra ID – Universal with MFA support**
  - Query editor i Azure-portalen virker **ikke** mot databaser med bare privat tilgang

- [ ] **2. Kjør skriptet**
  - Last ned [`database/assessment.sql`](database/assessment.sql) fra GitHub (*Raw* › lagre), eller klon repoet
  - Åpne filen i VS Code og trykk **Ctrl+Shift+E**
  - Sjekk at det virket: `SELECT * FROM dbo.AssessmentCategory;` skal gi *Justert*, *Ikke justert* og *Kan ikke justeres*
  - (Valgfritt) Kjør [`AssessmentVisual/dist/Dummydata_vurderinger.sql`](AssessmentVisual/dist/Dummydata_vurderinger.sql) for å få 10 testvurderinger

---

## Del B – Klargjør Function App-en og deploy koden

- [ ] **3. Sjekk Function App-en**
  - Portalen › Function App-en › **Overview**:
    - **Plan type** skal være *Flex Consumption*
    - Under *Functions*: listen bør være tom. Ligger det noe der allerede, si fra før du deployer, for deploy erstatter alt innholdet.
  - **Settings › Networking** › *Outbound*: **Virtual network integration** skal vise `subnet-func-integration`

- [ ] **4. Slå på managed identity** (hvis den ikke er på)
  - **Settings › Identity** › *System assigned* › **On** › **Save**

- [ ] **5. Gi funksjonen tilgang til databasen**
  - I VS Code (koblet til som i steg 1), kjør dette. Bytt ut navnet med det eksakte navnet på Function App-en.
    ```sql
    CREATE USER [func-powerbiwriteback] FROM EXTERNAL PROVIDER;
    ALTER ROLE db_datareader ADD MEMBER [func-powerbiwriteback];
    ALTER ROLE db_datawriter ADD MEMBER [func-powerbiwriteback];
    GRANT EXECUTE ON dbo.usp_SaveAssessments TO [func-powerbiwriteback];
    ```
  - Får du en feil om tilgang, må Entra-admin på SQL-serveren kjøre dette

- [ ] **6. Sett server og database**
  - **Settings › Environment variables** › **+ Add**:

    | Name | Value |
    |---|---|
    | `SQL_SERVER` | `sql-powerbiwriteback.database.windows.net` |
    | `SQL_DATABASE` | `sqldb-powerbiwriteback` |

  - **Apply** › **Confirm**

- [ ] **7. Deploy den ferdige pakken** (fra nettleseren, på bedriftsnettet)

  Du trenger ingen verktøy på PC-en. Funksjonen er bygget ferdig i én zip-fil, som lastes opp der Function App-en henter koden sin.

  a. **Last ned** [`AssessmentVisual/dist/MasterTable-function.zip`](AssessmentVisual/dist/MasterTable-function.zip) (nedlastingsikonet)

  b. **Gi filen nytt navn** i Filutforsker: `released-package.zip`. Ligger det allerede en zip-fil i containeren (punkt d), bruker du nøyaktig det navnet.

  c. **Finn deploy-containeren:** `func-powerbiwriteback` › **Settings › Deployment settings** › noter *Storage account* og *Container* (`app-package-func-powerbiwriteback-06940e7`)

  d. **Last opp:** åpne Storage-kontoen › **Storage browser** › **Blob containers** › klikk på containeren › **Upload** › velg filen › huk av **Overwrite if files already exist** › **Upload**
  - Krever skrivetilgang (*Storage Blob Data Contributor*). Står det en melding om tilgang, klikk *Switch to Microsoft Entra user account*.

  e. **Start på nytt:** `func-powerbiwriteback` › **Overview** › **Restart** › vent 2–3 minutter

  Med Azure CLI (alternativ): `az functionapp deployment source config-zip --resource-group <rg> --name func-powerbiwriteback --src MasterTable-function.zip`

- [ ] **8. Sjekk at funksjonen er deployet**
  - Function App › **Overview** › *Functions*: `saveAssessment` skal vises

- [ ] **9. Hent function key**
  - **Functions › App keys** › kopier `default`
  - URL: `https://func-powerbiwriteback-cjgbb5gbfkh4gzad.swedencentral-01.azurewebsites.net/api/assessment/save`

---

## Del C – Gateway for Power BI Service

Power BI Service står utenfor nettverket og trenger en gateway for å lese `vw_Assessment`. Det finnes ikke noe subnett for en VNet data gateway, så bruk en **on-premises data gateway** på en VM i VNet-et, eller en som finnes fra før.

- [ ] **10. Finnes det en gateway?**
  - app.powerbi.com › tannhjulet › **Administrer tilkoblinger og gatewayer** › fanen **Lokale datagatewayer**
  - Spør Power BI-admin om det finnes en gateway som når `sql-powerbiwriteback`

- [ ] **11. (Hvis ikke) Installer gateway på en VM i VNet-et**
  - Logg inn på VM-en via **Bastion** (VM › *Connect › Bastion*)
  - Last ned *On-premises data gateway (standard mode)* fra Microsoft, installer, og logg inn med jobbkontoen
  - Gi gatewayen et navn og en gjenopprettingsnøkkel. Ta vare på nøkkelen.

- [ ] **12. Lag tilkoblingen**
  - **Administrer tilkoblinger og gatewayer** › **Tilkoblinger** › **+ Ny** › **Lokalt** › velg gatewayen
  - Type **SQL Server**, server `sql-powerbiwriteback.database.windows.net`, database `sqldb-powerbiwriteback`
  - Godkjenning: **OAuth 2.0** (logg på med MFA), eller en service principal på sikt

---

## Del D – Rapporten (Power BI Desktop, på bedriftsnettet)

- [ ] **13. Last ned** `assessmentVisual….pbiviz` og `Dummydata.xlsx` fra [`AssessmentVisual/dist`](AssessmentVisual/dist)

- [ ] **14. Testdata:** **Hjem › Excel-arbeidsbok** › `Dummydata.xlsx` › **Prosjekter** › **Last inn**

- [ ] **15. Database:** **Hent data › Azure SQL-database** › server og database › **DirectQuery** › **Microsoft-konto** (MFA) › `vw_Assessment` › **Last inn**

- [ ] **16. Nøkkel og relasjon**
  - Ny kolonne i `Prosjekter`: `RowKey = Prosjekter[Prosjekt] & "|" & Prosjekter[År]`
  - **Modellvisning**: dra `Prosjekter[RowKey]` over til `vw_Assessment[RowKey]` (én til mange)

- [ ] **17. Mål** i `Prosjekter`:
  ```DAX
  Kategori = MAX(vw_Assessment[Category])
  ```
  ```DAX
  Kommentar = MAX(vw_Assessment[Comment])
  ```
  ```DAX
  User = USERPRINCIPALNAME()
  ```

- [ ] **18. Visual:** Visualiseringer › **…** › **Importer et visualobjekt fra en fil** › `.pbiviz`

- [ ] **19. Felter**

  | Feltboks | Dra inn |
  |---|---|
  | Radnøkkel | `Prosjekt`, deretter `År` |
  | Infokolonner | `Prosjektnavn`, `Segment` |
  | Verdier | `Timepris`, `Endring`, `Timer` (Sum) |
  | Kategori (lagret) | `Kategori` |
  | Kommentar (lagret) | `Kommentar` |
  | Bruker | `User` |

  - Høyreklikk `Prosjekt` i Radnøkkel og velg **Vis elementer uten data**

- [ ] **20. Write-back** (Format › Write-back)

  | Innstilling | Verdi |
  |---|---|
  | Function URL | `https://func-powerbiwriteback-cjgbb5gbfkh4gzad.swedencentral-01.azurewebsites.net/api/assessment/save` |
  | Function key | nøkkelen fra steg 9 |
  | Kontekst | `Test` (bytt til f.eks. `Ratejustering` for ekte data) |

- [ ] **21. Test i Desktop:** velg kategori › lagre › «Lagret kl. …»

- [ ] **22. Publiser:** **Hjem › Publiser** › workspace

---

## Del E – Power BI Service

- [ ] **23. Koble modellen til gatewayen**
  - Workspacet › den semantiske modellen › **…** › **Innstillinger** › **Gateway- og skytilkoblinger**
  - Velg tilkoblingen fra steg 12 for SQL-kilden › **Bruk**

- [ ] **24. Test i Service** (fra bedriftsnettet): lagre en vurdering, og sjekk at verdien blir stående etter oppdatering

- [ ] **25. Del:** lag en **app** eller gi brukerne **Viewer**-tilgang

- [ ] **26. (Anbefalt) Organisasjonsvisual:** be Power BI-admin laste opp `.pbiviz`-filen under *Admin-portal › Organisasjonsvisualer*

---

## Hvis noe går galt

**Start med tilkoblingstesten i visualen:** klikk på puls-ikonet i verktøylinjen (*Test tilkoblingen til Function App*). Testen kjøres også automatisk når en lagring ikke får kontakt. Den sjekker trinn for trinn:

| Trinn | Hva som sjekkes |
|---|---|
| Innstillinger | URL og function key er fylt ut, og adressen slutter på `/api/assessment/save` |
| Web-tilgang i Power BI | At Power BI tillater visualen å kalle adressen (tenant-innstilling og visualens liste over domener) |
| Nettverk | At nettleseren når Function App-en i det hele tatt (VPN, brannmur, sperre for lokalt nettverk) |
| Funksjon og nøkkel | Et testkall som ikke lagrer noe: riktig URL, gyldig nøkkel og CORS |

Konklusjonen nederst i testen sier hva som må rettes.


| Symptom | Årsak | Løsning |
|---|---|---|
| `Resolve-DnsName` gir offentlig IP | Ikke på bedriftsnettet, eller DNS mangler | Koble til VPN. Kontakt IT. |
| `az functionapp deployment …` feiler med 403 eller timeout | Maskinen når ikke Function App-ens private endpoint | Kjør fra bedriftsnettet eller VM-en. Sjekk `Resolve-DnsName func-powerbiwriteback-cjgbb5gbfkh4gzad.swedencentral-01.azurewebsites.net`. |
| Visualen: «Fikk ikke kontakt med Function App» | Brukeren er ikke på nettet, feil URL, eller funksjonen er ikke deployet | VPN, steg 8 og steg 20 |
| Visualen: «Ingen tilgang (401)» | Feil function key | Steg 9 og 20 |
| Visualen: «Database error» | Funksjonen kommer ikke inn i databasen | Se loggen: Function App › *Monitoring › Log stream* |
| Loggen: `Failed to connect to …:1433 in 15000ms` (`ETIMEOUT`) | Funksjonen når ikke SQL-endepunktet | Åpne `https://func-powerbiwriteback-cjgbb5gbfkh4gzad.swedencentral-01.azurewebsites.net/api/assessment/nettest?code=<nøkkel>` i nettleseren. Den viser hvilken adresse funksjonen slår opp for SQL og om port 1433 svarer. Send resultatet til IT. |
| Loggen: `Login failed for user '<token-identified principal>'` | Funksjonens identitet er ikke bruker i databasen | Steg 4–5, med eksakt app-navn |
| Loggen: `Deny Public Network Access is set to Yes` | Funksjonen går ikke via private endpoint | IT: sjekk DNS for VNet-integrasjonen |
| Loggen: `Set SQL_SERVER and SQL_DATABASE …` | Miljøvariablene mangler | Steg 6 |
| Lagret, men verdien forsvinner i Service | Modellen når ikke databasen | Steg 23 (gateway-tilkobling og innlogging) |
| Visualen: «Unknown category» | Kategorien finnes ikke i databasen | Samme stavemåte i *Format › Tabell › Kategorier* og `dbo.AssessmentCategory` |
