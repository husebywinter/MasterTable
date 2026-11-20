# Oppsett – sjekkliste (rett i skyen)

Alt gjøres i **Azure-portalen**, på **GitHub** og i **Power BI**. Du trenger ikke kjøre noe lokalt, ingen `az login`, `func start` eller Node på PC-en. Det eneste du installerer, er **Power BI Desktop**, for å bygge rapporten før den publiseres.

Innlogging skjer med jobbkontoen din og MFA. I drift skriver Azure-funksjonen til databasen med sin egen identitet (managed identity), så det finnes ingen passord noe sted.

```
Bruker ─(Power BI-innlogging)─▶ Power BI Service ─▶ visual ─(function key)─▶ Azure Function ─(managed identity)─▶ Azure SQL
                                       └──────────── DirectQuery (lagret innlogging) ──────────────────────────────────┘
```

---

## Informasjon du trenger

| Hva | Verdi |
|---|---|
| SQL-server | `sql-powerbiwriteback.database.windows.net` |
| Database | `sqldb-powerbiwriteback` |
| Function App-navn | Velger du selv i steg 5, f.eks. `func-mastertable` |
| GitHub-repo | `husebywinter/MasterTable` |

Kontoen din må kunne logge inn på databasen med Entra ID. Den må også ha rettigheter til å lage tabeller, f.eks. som Entra-admin på SQL-serveren eller med `db_owner`.

---

## Del A – Lag tabellene (Azure-portalen, ca. 5 min)

- [ ] **1. Åpne Query editor**
  - [portal.azure.com](https://portal.azure.com) › **SQL databases** › `sqldb-powerbiwriteback` › **Query editor (preview)** i menyen til venstre
  - Velg **Continue as <din konto>**, som bruker Entra-innloggingen med MFA
  - Får du melding om IP-adressen: klikk **Allowlist IP …** og logg inn på nytt

- [ ] **2. Kjør skriptet**
  - Åpne [`database/assessment_portal.sql`](database/assessment_portal.sql) på GitHub, klikk **Raw** og kopier alt
  - Lim det inn i Query editor og klikk **Run**
  - Nederst skal du få 3 rader: *Justert*, *Ikke justert* og *Kan ikke justeres*
  - Denne versjonen av skriptet er laget for portalen og har ingen `GO`-linjer. Den gjør det samme som `assessment.sql`.

- [ ] **3. (Valgfritt) Legg inn dummy-vurderinger**
  - Gjør det samme med [`AssessmentVisual/dist/Dummydata_vurderinger.sql`](AssessmentVisual/dist/Dummydata_vurderinger.sql)
  - Det gir 10 vurderinger med Kontekst `Test`. Slette dem igjen: `DELETE dbo.Assessment WHERE Context = N'Test';`

- [ ] **4. Gi Azure-tjenester tilgang til SQL-serveren**
  - Portalen › SQL-serveren `sql-powerbiwriteback` › **Networking**
  - Huk av **Allow Azure services and resources to access this server** › **Save**
  - Både funksjonen og Power BI Service trenger dette

---

## Del B – Azure Function (portal og GitHub, ca. 20 min)

- [ ] **5. Lag Function App**
  - Portalen › **Create a resource** › **Function App** › **Flex Consumption** › *Select*
  - Velg samme **Subscription** og **Resource group** som databasen
  - **Function App name:** f.eks. `func-mastertable`
  - **Region:** samme som databasen
  - **Runtime stack:** Node.js, **Version:** 22 LTS
  - Klikk **Review + create** › **Create**, og vent til den er ferdig
  - Bruk **ikke** samme Function App som Planning Grid. Deploy erstatter alle funksjonene i appen.

- [ ] **6. Slå på managed identity**
  - Function App › **Settings › Identity** › fanen *System assigned* › **Status: On** › **Save** › **Yes**

- [ ] **7. Gi funksjonen tilgang til databasen**
  - Tilbake i Query editor (steg 1), kjør dette. Bytt ut `func-mastertable` med navnet fra steg 5.
    ```sql
    CREATE USER [func-mastertable] FROM EXTERNAL PROVIDER;
    ALTER ROLE db_datareader ADD MEMBER [func-mastertable];
    ALTER ROLE db_datawriter ADD MEMBER [func-mastertable];
    GRANT EXECUTE ON dbo.usp_SaveAssessments TO [func-mastertable];
    ```
  - Får du en feil om tilgang, må Entra-admin på SQL-serveren kjøre dette

- [ ] **8. Fortell funksjonen hvilken database den skal bruke**
  - Function App › **Settings › Environment variables** › **+ Add**, to ganger:

    | Name | Value |
    |---|---|
    | `SQL_SERVER` | `sql-powerbiwriteback.database.windows.net` |
    | `SQL_DATABASE` | `sqldb-powerbiwriteback` |

  - Klikk **Apply** › **Confirm**

- [ ] **9. Koble Function App til GitHub**
  - Function App › **Deployment › Deployment Center**
  - **Source:** GitHub › logg inn og gi tilgang
  - **Organization:** `husebywinter`, **Repository:** `MasterTable`, **Branch:** `main`
  - **Authentication type:** *User-assigned identity* (standard)
  - Klikk **Save**. Azure legger da en workflow-fil i repoet, under `.github/workflows/`.

- [ ] **10. Pek workflowen mot riktig mappe**
  - Funksjonen ligger i mappen `AzureFunction`, ikke i roten av repoet
  - På GitHub: åpne filen i `.github/workflows/` › blyant-ikonet (Edit)
  - Finn linjen `AZURE_FUNCTIONAPP_PACKAGE_PATH: '.'` og endre den til:
    ```yaml
    AZURE_FUNCTIONAPP_PACKAGE_PATH: 'AzureFunction'
    ```
  - **Commit changes**. Deployen starter automatisk.

- [ ] **11. Sjekk at deployen gikk bra**
  - GitHub › fanen **Actions**: den siste kjøringen skal få grønn hake (ca. 2–3 min)
  - Function App › **Overview** › nederst under *Functions* skal `saveAssessment` vises

- [ ] **12. Hent function key**
  - Function App › **Functions › App keys** › kopier verdien til `default`
  - Function URL blir: `https://func-mastertable.azurewebsites.net/api/assessment/save` (med ditt navn)

---

## Del C – Bygg rapporten (Power BI Desktop, ca. 15 min)

Desktop brukes bare til å lage rapporten. Lagringen går mot funksjonen i Azure fra første stund.

- [ ] **13. Last ned filene**
  - Fra GitHub, mappen [`AssessmentVisual/dist`](AssessmentVisual/dist): `assessmentVisual….pbiviz` og `Dummydata.xlsx` (klikk filen › nedlastingsikonet)

- [ ] **14. Last inn testdata**
  - **Hjem › Excel-arbeidsbok** › `Dummydata.xlsx` › huk av **Prosjekter** › **Last inn**

- [ ] **15. Koble til databasen**
  - **Hent data › Azure SQL-database**
  - Server `sql-powerbiwriteback.database.windows.net`, database `sqldb-powerbiwriteback`, velg **DirectQuery**
  - Innlogging: **Microsoft-konto** › **Logg på** (MFA) › **Koble til**
  - Huk av `vw_Assessment` › **Last inn**

- [ ] **16. Nøkkelkolonne og relasjon**
  - Høyreklikk `Prosjekter` › **Ny kolonne**:
    ```DAX
    RowKey = Prosjekter[Prosjekt] & "|" & Prosjekter[År]
    ```
  - **Modellvisning**: dra `Prosjekter[RowKey]` over til `vw_Assessment[RowKey]`. Relasjonen skal være én (Prosjekter) til mange.

- [ ] **17. To mål** (høyreklikk `Prosjekter` › **Nytt mål**)
  ```DAX
  Kategori = MAX(vw_Assessment[Category])
  ```
  ```DAX
  Kommentar = MAX(vw_Assessment[Comment])
  ```
  ```DAX
  User = USERPRINCIPALNAME()
  ```

- [ ] **18. Importer visualen**
  - Visualiseringer-panelet › **…** › **Importer et visualobjekt fra en fil** › `.pbiviz`-filen
  - Klikk på det nye ikonet, slik at visualen havner på siden

- [ ] **19. Legg inn feltene**

  | Feltboks | Dra inn |
  |---|---|
  | Radnøkkel | `Prosjekt`, deretter `År` |
  | Infokolonner | `Prosjektnavn`, `Segment` |
  | Verdier | `Timepris`, `Endring`, `Timer` (velg **Sum** hvis det står Antall) |
  | Kategori (lagret) | `Kategori` |
  | Kommentar (lagret) | `Kommentar` |
  | Bruker | `User` |

  - Høyreklikk `Prosjekt` i Radnøkkel-boksen og velg **Vis elementer uten data**

- [ ] **20. Write-back-innstillinger** (Format › Write-back)

  | Innstilling | Verdi |
  |---|---|
  | Function URL | `https://<function-app-navn>.azurewebsites.net/api/assessment/save` |
  | Function key | nøkkelen fra steg 12 |
  | Kontekst | `Test` (bytt til f.eks. `Ratejustering` når du går over til ekte data) |

- [ ] **21. Test i Desktop**
  - Velg en kategori › diskett-ikonet › det skal stå «Lagret kl. …»

- [ ] **22. Publiser**
  - **Hjem › Publiser** › velg workspace

---

## Del D – Power BI Service (ca. 5 min)

- [ ] **23. Sett innloggingen for databasen**
  - app.powerbi.com › workspacet › den semantiske modellen › **…** › **Innstillinger**
  - **Datakildelegitimasjon** › Azure SQL › **Rediger legitimasjon** › **OAuth2** › logg på (MFA)
  - **Ikke** huk av for SSO (*Sluttbrukere bruker egen OAuth2-legitimasjon …*)
  - På sikt: bytt til en service principal, slik at visningen ikke henger på kontoen din

- [ ] **24. Test i Service**
  - Åpne rapporten, velg en kategori og lagre

- [ ] **25. Del med brukerne**
  - Lag en **app** fra workspacet, eller gi brukerne **Viewer**-tilgang. Det er alt de trenger for å se og lagre.

- [ ] **26. (Anbefalt) Organisasjonsvisual**
  - Be en Power BI-admin laste opp `.pbiviz`-filen under **Admin-portal › Organisasjonsvisualer**
  - Da er visualen godkjent sentralt, og nye versjoner kan rulles ut ett sted
  - Tenant-innstillingen for egendefinerte visualer må tillate den

---

## Hvis noe går galt

| Symptom | Årsak | Løsning |
|---|---|---|
| GitHub Actions feiler | Feil mappe | Sjekk steg 10: `AZURE_FUNCTIONAPP_PACKAGE_PATH: 'AzureFunction'` |
| `saveAssessment` vises ikke i Function App | Deployen gikk til feil mappe, eller den har ikke kjørt | Steg 10–11 |
| «Fikk ikke kontakt med Function App» (i visualen) | Feil URL, eller funksjonen er ikke deployet | Steg 11–12 og 20 |
| «Ingen tilgang (401)» | Feil eller manglende function key | Steg 12 og 20 |
| «Database error» (i visualen) | Funksjonen kommer ikke inn i databasen | Sjekk steg 4, 6, 7 og 8. Se loggen under Function App › *Monitoring › Log stream*. |
| `Login failed for user '<token-identified principal>'` (i loggen) | Funksjonens identitet er ikke bruker i databasen | Steg 7, med nøyaktig samme navn som Function App-en |
| «Unknown category» | Kategorien finnes ikke i databasen | Samme stavemåte i *Format › Tabell › Kategorier* og i `dbo.AssessmentCategory` |
| Tabellen i visualen er tom | Ingen rader har vurdering ennå | Steg 19: *Vis elementer uten data* |
| Lagret, men verdien vises ikke | Relasjonen eller nøkkelen stemmer ikke, eller legitimasjonen mangler i Service | Steg 16 og 23 |
| Query editor: `CREATE USER … FROM EXTERNAL PROVIDER` feiler | Du er ikke logget inn med Entra, eller mangler rettigheter | Logg inn med *Continue as …*, eller be Entra-admin kjøre det |

---

## Lokal utvikling (valgfritt)

Vil du endre koden og teste uten å deploye, kan funksjonen kjøres lokalt med `func start` og `az login`. Fyll inn `SQL_SERVER` og `SQL_DATABASE` i `AzureFunction/local.settings.json`, og bruk Function URL `http://localhost:7071/api/assessment/save`. Det trengs ikke for vanlig bruk.
