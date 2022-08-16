import constants from "../../constants.js";
import recordUtils from "../../utils.js";
import SettingsService from "../services/SettingsService.js";

const {WebcController} = WebCardinal.controllers;
const gtinResolver = require("gtin-resolver");
const utils = gtinResolver.utils;
const XMLDisplayService = gtinResolver.XMLDisplayService;
const LeafletInfoService = gtinResolver.LeafletInfoService;

export default class DrugSummaryController extends WebcController {
  constructor(element, history) {
    super(element, history);

    this.model = {
      serialNumberLabel: constants.SN_LABEL,
      statusMessage: constants.SN_OK_MESSAGE,
      serialNumber: "",
      preferredDocType: "leaflet",
      loadingData: true
    };
    let dbApi = require("opendsu").loadApi("db");

    dbApi.getMainEnclaveDB(async (err, enclaveDB) => {
      if (err) {
        console.log('Error on getting enclave DB');
        this.showPopup(this.getModalConfigForSuccessScan("invalid_data", err));
        return;
      }
      let scanErrorData = history.location.state.scanErrorData;
      if (scanErrorData) {
        this.showPopup(this.getModalConfigForFailedScan(scanErrorData.secondaryMessage.stage, scanErrorData));
        return;
      }
      try {

        this.settingsService = new SettingsService(enclaveDB);
        let record = await $$.promisify(enclaveDB.getRecord)(constants.HISTORY_TABLE, history.location.state.productData);
        record = await recordUtils.updateRecordData(enclaveDB, record);

        this.leafletInfoService = await LeafletInfoService.init(record.gs1Fields, record.networkName);

        this.model.expiryForDisplay = record.expiryForDisplay
        this.model.expiryTime = record.expiryTime;
        this.model.product = record.product;
        this.model.batch = record.batch || {};
        this.model.statusType = record.statusType;
        this.model.status = record.status;
        this.model.networkName = record.networkName;
        this.model.statusMessage = this.translate(record.statusMessage);
        this.model.snCheck = record.snCheck;
        this.record = record;

        // check if gtin only case
        if (!this.model.batch || Object.keys(this.model.batch).length === 0) {
          if (this.model.product.gtin && this.model.product.showEPIOnUnknownBatchNumber) {
            this.model.showEPI = true;
          } else {
            this.model.showEPI = false;
          }
        } else {
          let expiryForDisplay = utils.convertFromGS1DateToYYYY_HM(this.model.batch.expiry);
          if (expiryForDisplay.slice(0, 2) === "00") {
            expiryForDisplay = expiryForDisplay.slice(5);
          }
          let expiryCheck = this.model.expiryForDisplay === expiryForDisplay;

          const currentTime = Date.now();
          this.model.showEPI = this.leafletInfoService.leafletShouldBeDisplayed(this.model, expiryCheck, currentTime);

        }

        //default epi type is leaflet. New design has no epi type selection
        this.documentService = await XMLDisplayService.init(element, record.gtinSSI, this.model, "leaflet");
        //epi preferred language is app language
        this.preferredLanguage = await this.settingsService.asyncReadSetting("preferredLanguage");

        this.availableLanguages = await $$.promisify(this.documentService.getAvailableLanguagesForXmlType.bind(this.documentService))();
        if (!this.availableLanguages || this.availableLanguages.length === 0) {
          throw new Error("No available language for leaflet");
        }

        this.documentLanguage = this.availableLanguages.find((item) => item.value === this.preferredLanguage);

        this.showPopup(this.getModalConfigForSuccessScan(this.model.status));
      } catch (err) {
        let errData = err.message === "ScanError" ? history.location.state.scanErrorData : err;
        this.showPopup(this.getModalConfigForSuccessScan("invalid_data", errData));
      }
    })
    this.addListeners();
  }

  goToDrugDetailsPage(preferredLanguage) {
    this.modalWindow.destroy();
    let drugDetailsState = {
      productData: JSON.parse(JSON.stringify(this.record)),
      preferredLanguage: preferredLanguage,
      availableLanguages: JSON.parse(JSON.stringify(this.availableLanguages)),
    }
    if (this.model.batch && (this.model.batch.defaultMessage || (this.model.batch.recalled && this.model.batch.recalledMessage))) {
      this.showAdditionalInfoPopup(drugDetailsState)
    } else {
      this.model.loadingData = false;
      this.navigateToPageTag("drug-details", drugDetailsState);
    }

  }

  addListeners() {
    this.onTagClick("go-home", () => {
      this.modalWindow.destroy();
      this.navigateToPageTag("home");
    });

    this.onTagClick("scan-again", () => {
      this.modalWindow.destroy();
      this.navigateToPageTag("scan");
    })

    this.onTagClick("lang-proceed", async () => {
      let lang = this.querySelector("input[name='languages']:checked").value
      this.goToDrugDetailsPage(lang);
    })

    this.onTagClick("view-leaflet", () => {
      this.goToDrugDetailsPage(this.documentLanguage);
    })
  }

  showPopup(config) {
    this.modalWindow = this.showModalFromTemplate('drug-summary-modal', () => {
    }, () => {
      this.navigateToPageTag("home")
    }, {model: config, disableExpanding: true, disableFooter: true});
    this.model.loadingData = false;
  }

  showAdditionalInfoPopup(drugDetailsState) {
    let configObj = {}
    configObj.statusMessage = this.translate("_note");
    configObj.title = this.translate("batch_additional_info");
    configObj.content = this.translate("invalid_sn_status_message");
    configObj.mainActionLabel = this.translate("_ok");
    let contentHtml = "";
    if (this.model.batch.defaultMessage) {
      contentHtml = `${contentHtml} <div>${this.model.batch.defaultMessage}</div> <br>`;
    }

    if (this.model.batch.recalled && this.model.batch.recalledMessage) {
      contentHtml = `${contentHtml} <div>${this.model.batch.recalledMessage}</div> <br>`
    }
    configObj.content = {html: `<div> ${contentHtml}</div>`}

    this.modalWindow = this.showModalFromTemplate('drug-additional-info-modal', () => {
      this.model.loadingData = false;
      this.navigateToPageTag("drug-details", drugDetailsState);
    }, () => {
      this.model.loadingData = false;
      this.navigateToPageTag("drug-details", drugDetailsState);
    }, {model: configObj, disableExpanding: true, disableFooter: true});

  }

  getLanguageConfig() {
    let configObj = {
      status: "language-select",
      statusMessage: this.translate("language_select_status"),
      title: this.translate("language_select_title"),
    }

    if (this.availableLanguages.length >= 1) {
      let langContent = `<div class="language-text">${this.translate("language_select_message")}</div>`;
      this.availableLanguages.forEach((lang, index) => {
        let langRadio = `<div class="language-radio-item">
                                <label> ${lang.label} - (${lang.nativeName})
                                <input type="radio" name="languages" ${index === 0 ? "checked" : ""} value="${lang.value}" id="${lang.value}">
                                </label> </div>`;
        langContent = langContent + langRadio;
      })
      configObj.mainAction = "lang-proceed";
      configObj.mainActionLabel = this.translate("lang_proceed");
      configObj.secondaryAction = "go-home";
      configObj.secondaryActionLabel = this.translate("back_home");
      configObj.content = {html: langContent};
    } else {
      let noLangContent = `<div class="language-text">${this.translate("no_language_select_message")}</div>`;
      configObj.mainAction = "go-home";
      configObj.mainActionLabel = this.translate("back_home");
      configObj.secondaryAction = "scan-again";
      configObj.secondaryActionLabel = this.translate("scan_again");
      configObj.content = {html: noLangContent};
    }

    return configObj;
  }

  getModalConfigForFailedScan(stage, error) {
    let configObj = {stage};
    configObj.mainAction = "scan-again";
    configObj.mainActionLabel = this.translate("scan_again");
    configObj.secondaryAction = "go-home";
    configObj.secondaryActionLabel = this.translate("back_home");

    configObj.status = "error";
    configObj.statusMessage = this.translate("unknown_error");
    configObj.title = error.secondaryMessage.message;

    switch (stage) {
      case constants.STAGES.INITIALIZATION:
      case constants.STAGES.START_SCANNING:
      case constants.STAGES.CAMERA_SWITCH:
      case constants.STAGES.INTERPRET_SCAN:
      case constants.STAGES.PARSE_BARCODE:
      case constants.STAGES.CHECK_MANDATORY_FIELDS:
      case constants.STAGES.NETWORK_NOT_FOUND:
      case constants.STAGES.WRONG_COMBINATION:
        configObj.content = this.translate(error.message);
        break;
      default:
        configObj.content = this.translate("err_default");
    }

    let objContentHtml = `<div>${configObj.content}</div>`;

    configObj.content = {html: `<div>${objContentHtml}</div>`};
    return configObj;
  }

  getModalConfigForSuccessScan(status, additionalData) {
    let configObj = {};

    if (this.model.showEPI) {
      if (!this.documentLanguage) {
        return this.getLanguageConfig();
      }
      configObj.mainAction = "view-leaflet";
      configObj.mainActionLabel = this.translate("view_leaflet");
      configObj.secondaryAction = "scan-again";
      configObj.secondaryActionLabel = this.translate("scan_again");

      //for gtin only case id show leaflet is true do not show error
      if (status === "invalid_batch") {
        status = "verified"
      }
    } else {
      configObj.mainAction = "scan-again";
      configObj.mainActionLabel = this.translate("scan_again");
      configObj.secondaryAction = "go-home";
      configObj.secondaryActionLabel = this.translate("back_home");
    }

    configObj.status = status;

    switch (status) {
      case "verified":
        configObj.statusMessage = this.translate("verified_status");
        configObj.title = this.model.product.name;
        configObj.subtitle = this.model.product.description;
        configObj.content = this.translate("verified_status_message");
        break;
      case "invalid_sn":
        configObj.statusMessage = this.translate("invalid_sn_status");
        configObj.title = this.translate("invalid_sn_title");
        configObj.content = this.translate("invalid_sn_status_message");
        break;
      case "incorrect_date":
        configObj.statusMessage = this.translate("incorrect_date_status");
        configObj.title = this.translate("incorrect_date_title");
        configObj.content = this.translate("incorrect_date_status_message");
        break;
      case "expired_date":
        configObj.statusMessage = this.translate("expired_date_status");
        configObj.title = this.model.product.name;
        configObj.subtitle = this.model.product.description;
        configObj.content = this.translate("expired_date_message");
        break;
      case "invalid_data":
        configObj.statusMessage = this.translate("invalid_data_status");
        configObj.title = this.translate("invalid_data_title");
        let objContentHtml = `${this.translate("invalid_data_message")}`;
        if (additionalData) {
          if (additionalData.message) {
            objContentHtml = `${objContentHtml}<br><div>${additionalData.message}</div>`
          }

          if (additionalData.fields && Object.keys(additionalData.fields).length > 0) {
            objContentHtml = `${objContentHtml}<br> <div>
                                                 <div class="label">${this.translate("gs1field_sn")} ${additionalData.fields.serialNumber}</div>
                                                 <div class="label">${this.translate("gs1field_gtin")} ${additionalData.fields.gtin} </div>
                                                 <div class="label">${this.translate("gs1field_batch")} ${additionalData.fields.batchNumber} </div>
                                                 <div class="label">${this.translate("gs1field_date")} ${additionalData.fields.expiry} </div>
                                             </div>`
          }

          if (additionalData.secondaryMessage) {
            objContentHtml = `${objContentHtml} <br><br><div>**${additionalData.secondaryMessage}</div>`
          }
        }

        configObj.content = objContentHtml;
        break;
      case "recalled_batch":
        configObj.statusMessage = this.translate("recalled_batch_status");
        configObj.title = this.translate("recalled_batch_title");
        configObj.content = this.translate("recalled_batch_status_message");
        break;
      case "recalled_sn":
        configObj.statusMessage = this.translate("recalled_sn_status");
        configObj.title = this.translate("recalled_sn_title");
        configObj.content = this.translate("recalled_sn_status_message");
        break;
      case "decommissioned_sn":
        configObj.statusMessage = this.translate("decommissioned_sn_status");
        configObj.title = this.translate("decommissioned_sn_title");
        configObj.content = this.translate("decommissioned_sn_status_message");
        break;
    }

    configObj.content = {html: `<div>${configObj.content}</div>`};
    return configObj;
  }

}
