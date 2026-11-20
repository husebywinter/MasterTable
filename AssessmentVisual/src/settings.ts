"use strict";

import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";

import FormattingSettingsCard = formattingSettings.SimpleCard;
import FormattingSettingsSlice = formattingSettings.Slice;
import FormattingSettingsModel = formattingSettings.Model;

export const DEFAULT_CATEGORIES = "Justert; Ikke justert; Kan ikke justeres";

/** Connection to the Azure Function App that writes to Azure SQL. */
class WriteBackCard extends FormattingSettingsCard {
    endpoint = new formattingSettings.TextInput({
        name: "endpoint",
        displayName: "Function URL",
        description: "f.eks. https://<app>.azurewebsites.net/api/assessment/save",
        placeholder: "https://<app>.azurewebsites.net/api/assessment/save",
        value: ""
    });

    functionKey = new formattingSettings.TextInput({
        name: "functionKey",
        displayName: "Function key",
        description: "Sendes som ?code= i URL-en. Lagres i rapporten og er synlig for alle som kan redigere den.",
        placeholder: "function key",
        value: ""
    });

    context = new formattingSettings.TextInput({
        name: "context",
        displayName: "Kontekst",
        description: "Skiller tabeller som bruker samme database, f.eks. Ratejustering. Filtrer vw_Assessment på samme verdi.",
        placeholder: "Ratejustering",
        value: ""
    });

    refreshAfterSave = new formattingSettings.ToggleSwitch({
        name: "refreshAfterSave",
        displayName: "Oppdater data etter lagring",
        description: "Spør modellen på nytt (nyttig med DirectQuery mot vw_Assessment)",
        value: true
    });

    name: string = "writeBack";
    displayName: string = "Write-back";
    slices: Array<FormattingSettingsSlice> = [this.endpoint, this.functionKey, this.context, this.refreshAfterSave];
}

class TableCard extends FormattingSettingsCard {
    title = new formattingSettings.TextInput({
        name: "title",
        displayName: "Tittel",
        placeholder: "Tittel",
        value: ""
    });

    fontSize = new formattingSettings.NumUpDown({
        name: "fontSize",
        displayName: "Tekststørrelse",
        value: 12
    });

    categories = new formattingSettings.TextInput({
        name: "categories",
        displayName: "Kategorier",
        description: "Valgene i nedtrekkslisten, skilt med semikolon. Må finnes i dbo.AssessmentCategory.",
        placeholder: DEFAULT_CATEGORIES,
        value: DEFAULT_CATEGORIES
    });

    categoryHeader = new formattingSettings.TextInput({
        name: "categoryHeader",
        displayName: "Overskrift kategori",
        placeholder: "Kategori",
        value: "Kategori"
    });

    commentHeader = new formattingSettings.TextInput({
        name: "commentHeader",
        displayName: "Overskrift kommentar",
        placeholder: "Kommentar",
        value: "Kommentar"
    });

    colorCategories = new formattingSettings.ToggleSwitch({
        name: "colorCategories",
        displayName: "Fargekod kategorier",
        value: true
    });

    name: string = "table";
    displayName: string = "Tabell";
    slices: Array<FormattingSettingsSlice> = [
        this.title, this.fontSize, this.categories, this.categoryHeader, this.commentHeader, this.colorCategories
    ];
}

export class VisualFormattingSettingsModel extends FormattingSettingsModel {
    tableCard = new TableCard();
    writeBackCard = new WriteBackCard();

    cards = [this.tableCard, this.writeBackCard];
}
