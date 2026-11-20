# Oppsett – sjekkliste (Azure SQL med private endpoint)

Databasen er bare tilgjengelig fra et privat nettverk (VNet) i Azure. Derfor må alt som skal snakke med databasen, være koblet til det nettverket:

```
                                    ┌──────────── VNet ─────────────────────────────┐
Bruker ─▶ Power BI Service ─▶ visual ─(https + function key)─▶ Azure Function ─(VNet-integrasjon)─▶ private endpoint ─▶ Azure SQL
               │                    │                                                    ▲
               └─(DirectQuery)─▶ Gateway (VNet data gateway eller VM) ────────────────────┘
                                    └───────────────────────────────────────────────┘
```

| Del | Hvordan den når databasen |
|---|---|
| **Visualen** | Snakker aldri med databasen. Den kaller bare funksjonen over https, så den trenger ingen endring. |
| **Azure Function** (lagring) | VNet-integrasjon og privat DNS. Logger inn med managed identity. |
| **Power BI Service** (visning) | Gateway inn i VNet-et |
| **Du** (oppsett, Power BI Desktop) | Fra en maskin på nettverket: jobb-PC med VPN, eller en VM i Azure |

Query editor i Azure-portalen virker **ikke** mot en database med bare privat tilgang. Skriptet kjøres derfor fra VS Code eller SSMS på en maskin som er på nettverket.

---

## Informasjon du trenger

Mye av dette må du sannsynligvis få fra IT eller den som eier Azure-oppsettet.

| Hva | Hvor finner jeg det | Ditt |
|---|---|---|
| SQL-server | – | `sql-powerbiwriteback.database.windows.net` |
| Database | – | `sqldb-powerbiwriteback` |
| Private endpoint | – | `pe-sqc-sql` |
| **VNet** som private endpoint ligger i | `pe-sqc-sql` › *Overview* › *Virtual network/subnet* | `vnet-swedencentral-azfw-subs-mc-corp-powerbi-tools-prod` (subnett `subnet-sql-mi`) |
| **Region** | Samme som VNet-et | **Sweden Central** |
| **Ledig subnett for Function App-en** | Må lages i VNet-et over, se steg 4 og [bestillingen til IT](#bestilling-til-it) | |
| **Privat DNS-sone** `privatelink.database.windows.net` koblet til VNet-et | Portalen › *Private DNS zones*. I et sentralt corp-oppsett ligger den ofte i hub-nettverket og styres av IT. | |
| **Tilgang til nettverket** for deg | VPN-klient på jobb-PC, eller en VM i VNet-et | |
| **Gateway-type** | Har organisasjonen Fabric/Premium-kapasitet? Finnes det en gateway fra før? Spør Power BI-admin. | |
| Function App-navn | Velger du selv i steg 5 | |

---

## Bestilling til IT

VNet-et (`…-azfw-…-mc-corp-…`) ser ut til å være en del av et sentralt styrt bedriftsnett med Azure Firewall. Da er det vanligvis IT eller plattformteamet som lager subnett, åpner brannmur og styrer DNS. Send dem dette:

> **Emne:** Subnett og nettverkstilgang for Azure Function og Power BI-gateway (MasterTable)
>
> Hei! Jeg setter opp en Power BI-løsning som skriver til Azure SQL `sql-powerbiwriteback` (database `sqldb-powerbiwriteback`) via private endpoint `pe-sqc-sql` i `vnet-swedencentral-azfw-subs-mc-corp-powerbi-tools-prod`. Jeg trenger:
>
> 1. **Subnett til Azure Function (Flex Consumption)** i samme VNet, minst `/27`, delegert til `Microsoft.App/environments`, f.eks. `snet-func-mastertable`.
> 2. **Trafikk fra det subnettet til private endpoint `pe-sqc-sql` på TCP 1433** (NSG og Azure Firewall).
> 3. **Utgående HTTPS (443) fra funksjonens subnett** til Microsoft Entra ID (`login.microsoftonline.com`) og Azure Storage, slik at managed identity og selve funksjonen virker.
> 4. **DNS**: at `sql-powerbiwriteback.database.windows.net` slås opp til den private adressen fra VNet-et (privat DNS-sone `privatelink.database.windows.net`).
> 5. **Gateway for Power BI Service**: enten et subnett delegert til `Microsoft.PowerPlatform/vnetaccesslinks` for en VNet data gateway (hvis vi har Fabric- eller Premium-kapasitet), eller tilgang til en eksisterende on-premises data gateway som når databasen.
> 6. **Tilgang for meg** (VPN eller jump-VM) til databasen, slik at jeg kan opprette tabellene.
>
> Function App-en lages i Sweden Central med public access på (den kalles fra Power BI-visualen over https med function key). All trafikk til databasen går via VNet-et.

---

## Del A – Lag tabellene (fra en maskin på nettverket)

- [ ] **1. Koble til nettverket**
  - Jobb-PC: koble til VPN. Eller logg inn på en VM i VNet-et.
  - Sjekk at servernavnet peker på en privat adresse. Kjør i PowerShell:
    ```powershell
    Resolve-DnsName sql-powerbiwriteback.database.windows.net
    ```
    Du skal se `…privatelink.database.windows.net` og en IP-adresse som `10.x.x.x`. Ser du en offentlig adresse, er ikke DNS satt opp for maskinen din. Spør IT.

- [ ] **2. Kjør skriptet i VS Code**
  - Installer utvidelsen **SQL Server (mssql)** i VS Code
  - Last ned [`database/assessment.sql`](database/assessment.sql) fra GitHub, eller klon repoet
  - Velg SQL Server-ikonet › **Add Connection**:
    - Server: `sql-powerbiwriteback.database.windows.net`, database: `sqldb-powerbiwriteback`
    - Authentication type: **Microsoft Entra ID – Universal with MFA support**
  - Åpne `assessment.sql` og trykk **Ctrl+Shift+E**
  - Sjekk at det virket: `SELECT * FROM dbo.AssessmentCategory;` skal gi *Justert*, *Ikke justert* og *Kan ikke justeres*
  - (Valgfritt) Kjør [`AssessmentVisual/dist/Dummydata_vurderinger.sql`](AssessmentVisual/dist/Dummydata_vurderinger.sql) for å få 10 testvurderinger

- [ ] **3. Mangler du tilgang til nettverket?**
  - Be IT kjøre `assessment.sql` for deg, eller midlertidig åpne *Public access › Selected networks* for IP-adressen din
  - I det siste tilfellet kan du bruke Query editor i portalen med [`assessment_portal.sql`](database/assessment_portal.sql)

---

## Del B – Azure Function med VNet-integrasjon

- [ ] **4. Lag et subnett til funksjonen** (IT gjør ofte dette)
  - Portalen › VNet-et › **Subnets** › **+ Subnet**
  - Navn: f.eks. `snet-func-mastertable`, størrelse minst `/27`
  - **Subnet delegation:** `Microsoft.App/environments`, som Flex Consumption krever
  - Subnettet kan ikke brukes til andre ting

- [ ] **5. Lag Function App**
  - Portalen › **Create a resource** › **Function App** › **Flex Consumption**
  - Samme subscription og region som VNet-et (**Sweden Central**). Runtime: **Node.js 22 LTS**. Navn: f.eks. `func-mastertable`
  - Fanen **Networking**:
    - **Enable public access: On.** Visualen kaller funksjonen fra nettleseren til brukerne, så funksjonen må kunne nås utenfra. Den er beskyttet med function key.
    - **Enable virtual network integration: On** › velg VNet-et og subnettet fra steg 4
  - **Review + create** › **Create**
  - Bruk ikke samme Function App som Planning Grid

- [ ] **6. Sjekk privat DNS**
  - Portalen › **Private DNS zones** › `privatelink.database.windows.net` › **Virtual network links**
  - VNet-et fra steg 5 må stå i listen. Mangler det: **+ Add** › velg VNet-et
  - Uten denne koblingen prøver funksjonen å bruke den offentlige adressen og blir avvist

- [ ] **7. Slå på managed identity**
  - Function App › **Settings › Identity** › *System assigned* › **On** › **Save**

- [ ] **8. Gi funksjonen tilgang til databasen**
  - I VS Code (koblet til som i steg 2), kjør dette. Bytt ut navnet med Function App-navnet.
    ```sql
    CREATE USER [func-mastertable] FROM EXTERNAL PROVIDER;
    ALTER ROLE db_datareader ADD MEMBER [func-mastertable];
    ALTER ROLE db_datawriter ADD MEMBER [func-mastertable];
    GRANT EXECUTE ON dbo.usp_SaveAssessments TO [func-mastertable];
    ```

- [ ] **9. Sett server og database**
  - Function App › **Settings › Environment variables** › **+ Add**:

    | Name | Value |
    |---|---|
    | `SQL_SERVER` | `sql-powerbiwriteback.database.windows.net` |
    | `SQL_DATABASE` | `sqldb-powerbiwriteback` |

  - **Apply** › **Confirm**

- [ ] **10. Koble til GitHub**
  - Function App › **Deployment › Deployment Center** › **Source: GitHub**
  - Organization `husebywinter`, repository `MasterTable`, branch `main`, authentication *User-assigned identity* › **Save**

- [ ] **11. Pek workflowen mot riktig mappe**
  - På GitHub: åpne filen i `.github/workflows/` › **Edit**
  - Endre `AZURE_FUNCTIONAPP_PACKAGE_PATH: '.'` til `AZURE_FUNCTIONAPP_PACKAGE_PATH: 'AzureFunction'` › **Commit changes**
  - Du kan også si fra, så gjør jeg det

- [ ] **12. Sjekk deploy**
  - GitHub › **Actions**: den siste kjøringen skal få grønn hake
  - Function App › **Overview** › *Functions*: `saveAssessment` skal vises

- [ ] **13. Hent function key**
  - Function App › **Functions › App keys** › kopier `default`
  - URL: `https://<function-app-navn>.azurewebsites.net/api/assessment/save`

---

## Del C – Gateway for Power BI Service

Velg **én** av de to løsningene. Spør Power BI-admin om det allerede finnes en gateway.

### Alternativ 1: VNet data gateway (krever Fabric- eller Premium-kapasitet)

- [ ] **14a. Lag et subnett til gatewayen**
  - VNet › **Subnets** › **+ Subnet**, f.eks. `snet-pbi-gateway`
  - **Subnet delegation:** `Microsoft.PowerPlatform/vnetaccesslinks`
  - Ressursleverandøren `Microsoft.PowerPlatform` må være registrert i subscriptionen (*Subscription › Resource providers*)

- [ ] **15a. Lag gatewayen**
  - app.powerbi.com › tannhjulet › **Administrer tilkoblinger og gatewayer** › fanen **Virtuelle nettverksdatagatewayer** › **+ Ny**
  - Velg subscription, VNet og subnettet fra 14a › **Lagre**

- [ ] **16a. Lag tilkoblingen**
  - Samme sted › fanen **Tilkoblinger** › **+ Ny** › **Virtuelt nettverk** › gatewayen fra 15a
  - Type **SQL Server**, server `sql-powerbiwriteback.database.windows.net`, database `sqldb-powerbiwriteback`
  - Godkjenning: **OAuth 2.0** › logg på (MFA). På sikt: bytt til en service principal.

### Alternativ 2: On-premises data gateway på en VM i VNet-et

- [ ] **14b. VM**
  - En Windows-VM i VNet-et, som kan nå SQL-serveren (sjekk med `Resolve-DnsName` som i steg 1)

- [ ] **15b. Installer gatewayen**
  - Last ned *On-premises data gateway (standard mode)* fra Microsoft på VM-en, installer og logg inn med jobbkontoen
  - Gi gatewayen et navn og en gjenopprettingsnøkkel. Ta vare på nøkkelen.

- [ ] **16b. Lag tilkoblingen**
  - app.powerbi.com › **Administrer tilkoblinger og gatewayer** › **Tilkoblinger** › **+ Ny** › **Lokalt** › gatewayen fra 15b
  - Type **SQL Server**, server og database som over, godkjenning **OAuth 2.0** eller service principal

---

## Del D – Rapporten (Power BI Desktop, på nettverket)

Power BI Desktop må også nå databasen. Jobb derfor med VPN tilkoblet, eller fra VM-en.

- [ ] **17. Last ned** `assessmentVisual….pbiviz` og `Dummydata.xlsx` fra [`AssessmentVisual/dist`](AssessmentVisual/dist)

- [ ] **18. Testdata:** **Hjem › Excel-arbeidsbok** › `Dummydata.xlsx` › **Prosjekter** › **Last inn**

- [ ] **19. Database:** **Hent data › Azure SQL-database** › server og database › **DirectQuery** › **Microsoft-konto** (MFA) › `vw_Assessment` › **Last inn**

- [ ] **20. Nøkkel og relasjon**
  - Ny kolonne i `Prosjekter`: `RowKey = Prosjekter[Prosjekt] & "|" & Prosjekter[År]`
  - **Modellvisning**: dra `Prosjekter[RowKey]` over til `vw_Assessment[RowKey]` (én til mange)

- [ ] **21. Mål** i `Prosjekter`:
  ```DAX
  Kategori = MAX(vw_Assessment[Category])
  ```
  ```DAX
  Kommentar = MAX(vw_Assessment[Comment])
  ```
  ```DAX
  User = USERPRINCIPALNAME()
  ```

- [ ] **22. Visual:** Visualiseringer › **…** › **Importer et visualobjekt fra en fil** › `.pbiviz`

- [ ] **23. Felter**

  | Feltboks | Dra inn |
  |---|---|
  | Radnøkkel | `Prosjekt`, deretter `År` |
  | Infokolonner | `Prosjektnavn`, `Segment` |
  | Verdier | `Timepris`, `Endring`, `Timer` (Sum) |
  | Kategori (lagret) | `Kategori` |
  | Kommentar (lagret) | `Kommentar` |
  | Bruker | `User` |

  - Høyreklikk `Prosjekt` i Radnøkkel og velg **Vis elementer uten data**

- [ ] **24. Write-back** (Format › Write-back): Function URL og function key fra steg 13, Kontekst `Test`

- [ ] **25. Test i Desktop:** velg kategori › lagre › «Lagret kl. …»

- [ ] **26. Publiser:** **Hjem › Publiser** › workspace

---

## Del E – Power BI Service

- [ ] **27. Koble modellen til gatewayen**
  - Workspacet › den semantiske modellen › **…** › **Innstillinger**
  - **Gateway- og skytilkoblinger** › velg tilkoblingen fra steg 16a eller 16b for SQL-kilden › **Bruk**
  - Excel-dataene (dummydata) er importert og trenger ikke gateway før de skal oppdateres

- [ ] **28. Test i Service:** åpne rapporten, lagre en vurdering, og sjekk at verdien blir stående etter oppdatering

- [ ] **29. Del:** lag en **app** eller gi brukerne **Viewer**-tilgang

- [ ] **30. (Anbefalt) Organisasjonsvisual:** be Power BI-admin laste opp `.pbiviz`-filen under *Admin-portal › Organisasjonsvisualer*

---

## Hvis noe går galt

| Symptom | Årsak | Løsning |
|---|---|---|
| `Resolve-DnsName` gir offentlig IP | Maskinen bruker ikke den private DNS-sonen | VPN eller DNS-oppsett hos IT |
| Funksjonsloggen: `Deny Public Network Access is set to Yes` | Funksjonen går ikke via private endpoint | Steg 5 (VNet-integrasjon) og steg 6 (DNS-kobling) |
| Funksjonsloggen: `Login failed for user '<token-identified principal>'` | Funksjonens identitet er ikke bruker i databasen | Steg 8, med nøyaktig Function App-navn |
| Funksjonsloggen: timeout eller `ETIMEDOUT` | Subnettet når ikke private endpoint (NSG eller brannmur) | Be IT åpne port 1433 fra funksjonens subnett til private endpoint |
| Visualen: «Fikk ikke kontakt med Function App» | Funksjonen er ikke deployet, eller public access er av | Steg 5 (*Enable public access: On*) og steg 12 |
| Visualen: «Ingen tilgang (401)» | Feil function key | Steg 13 og 24 |
| Lagret, men verdien forsvinner i Service | Modellen når ikke databasen | Steg 27. Sjekk at gateway-tilkoblingen er valgt og har gyldig innlogging. |
| Desktop får ikke koblet til | Ikke på nettverket | Koble til VPN, eller bruk VM-en |
| Visualen: «Unknown category» | Kategorien finnes ikke i databasen | Samme stavemåte i *Format › Tabell › Kategorier* og i `dbo.AssessmentCategory` |

Logger for funksjonen: Function App › **Monitoring › Log stream**.

---

## Lokal utvikling (valgfritt)

Med VPN tilkoblet kan funksjonen også kjøres lokalt med `func start` og `az login`. Fyll inn `SQL_SERVER` og `SQL_DATABASE` i `AzureFunction/local.settings.json`, og bruk Function URL `http://localhost:7071/api/assessment/save`. Det trengs ikke for vanlig bruk.
