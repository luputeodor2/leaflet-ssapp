import LanguageService from "../LanguageService/LanguageService.js";
import constants from "../../../constants.js";

const pathToXsl = constants.XSL_PATH;
let errorMessage = "This is a valid product. However, more information about this product has not been published by the Pharmaceutical Company. Please check back later.";

export default class XmlDisplayService {
    constructor(dsuStorage, element, gtinSSI, basePath, xmlType, xmlFile, model) {
        this.languageService = new LanguageService(dsuStorage);
        this.DSUStorage = dsuStorage;
        this.element = element;
        this.gtinSSI = gtinSSI;
        this.xmlType = xmlType;
        this.xmlFile = xmlFile;
        this.model = model;
        this.basePath = basePath;
    }

    displayXml(language) {
        if (typeof language !== "undefined") {
            return this.displayXmlForLanguage(language);
        }

        this.languageService.getWorkingLanguages((err, workingLanguages) => {
            const searchForLeaflet = (languages) => {
                if(languages.length === 0) {
                    this.displayError();
                    return;
                }
                const languageCode = languages.shift().value;
                this.readXmlFile(languageCode, (err, xmlContent, pathBase) => {
                    if (err) {
                        searchForLeaflet(languages);
                    } else {
                        return this.applyStylesheetAndDisplayXml(pathBase, xmlContent);
                    }
                });
            }
            searchForLeaflet(workingLanguages);
        })
    }

    isXmlAvailable() {
        this.getAvailableLanguagesForXmlType((err, languages) => {
            if (this.xmlType === "smpc" && languages.length > 0) {
                this.model.showSmpc = true;
                this.model.epiColumns++;
            }
            if (this.xmlType === "leaflet" && languages.length > 0) {
                this.model.showLeaflet = true;
                this.model.epiColumns++;
            }
        });
    }


    populateModel() {
        this.getAvailableLanguagesForXmlType((err, languages) => {
            this.languageService.addWorkingLanguages(languages, (err) => {
                if (languages.length >= 2) {
                    this.languageService.getLanguagesForSelect(languages, (err, languagesForSelect) => {
                        if (err) {
                            return callback(err);
                        }
                        this.createLanguageSelector(languagesForSelect);
                        this.model.onChange("languages.value", () => {
                            this.displayXmlForLanguage(this.model.languages.value);
                        })
                    });
                }
                this.displayXml();
            });
        })
    }

    createLanguageSelector(languages) {
        this.model.twoOrMoreLanguages = true;
        this.model.languages = {
            value: languages[0].value,
            options: languages
        }
    }

    displayXmlForLanguage(language) {
        this.readXmlFile(language, (err, xmlContent, pathBase) => {
            if (err) {
                this.displayError();
                return;
            }

            this.applyStylesheetAndDisplayXml(pathBase, xmlContent);
        });
    }

    readXmlFile(language, callback) {
        this.buildBasePath((err, pathBase) => {
            const pathToLeafletLanguage = `${pathBase}${language}/`;
            const pathToXml = pathToLeafletLanguage + this.xmlFile;

            this.readFileAndDecodeContent(pathToXml, (err, xmlContent) => {
                if (err) {
                    return callback(err);
                }
                callback(undefined, xmlContent, pathToLeafletLanguage);
            })
        })
    }

    applyStylesheetAndDisplayXml(pathBase, xmlContent) {
        this.readFileAndDecodeContent(pathToXsl, (err, xslContent) => {
            if (err) {
                this.displayError();
                return;
            }
            this.displayXmlContent(pathBase, xmlContent, xslContent);
        });
    }

    displayError(){
        let errorMessageElement = this.getErrorMessageElement(errorMessage)
        this.element.querySelector("#content").appendChild(errorMessageElement);
    }

    displayXmlContent(pathBase, xmlContent, xslContent) {
        let xsltProcessor = new XSLTProcessor();
        xsltProcessor.setParameter(null, "resources_path", "download" + pathBase);
        let parser = new DOMParser();

        let xmlDoc = parser.parseFromString(xmlContent, "text/xml");

        let xslDoc = parser.parseFromString(xslContent, "text/xml");

        xsltProcessor.importStylesheet(xslDoc);

        let resultDocument = xsltProcessor.transformToFragment(xmlDoc, document);
        this.element.querySelector("#content").innerHTML = '';
        let mainDiv = document.createElement("div");
        let sectionsElements = resultDocument.querySelectorAll(".accordion-item");
        let aboutContent = "";
        let beforeContent = "";
        let howToContent = "";
        let sideEffectsContent = "";
        let storingContent = "";
        let moreContent = "";
        sectionsElements.forEach(section=>{
            let xmlCodeValue = section.getAttribute("sectionCode");
            switch (xmlCodeValue) {
                case '48780-1':
                case '34089-3':
                case '34076-0':
                case '60559-2':
                    aboutContent = aboutContent + section.innerHTML;
                    break;
                case '34070-3':
                case '34084-4':
                case '34086-9':
                case '69759-9':
                    beforeContent = beforeContent + section.innerHTML;
                    break;
                case '34068-7':
                case '43678-2':
                case '34072-9':
                case '34067-9':
                case '59845-8':
                    howToContent = howToContent + section.innerHTML;
                    break;
                case '34071-1':
                case '43685-7':
                case '54433-8':
                case '69762-3':
                case '34077-8':
                case '60563-4':
                case '34078-6':
                    sideEffectsContent = sideEffectsContent + section.innerHTML;
                    break;
                case '44425-7':
                    storingContent = storingContent + section.innerHTML;
                    break;
                default:
                    moreContent = moreContent + section.innerHTML;

            }
        });

        let htmlFragment = ` <accordion-item shadow title="About">
                                 <div class="accordion-item-content" slot="item-content">${aboutContent}</div>
                             </accordion-item>
                             <accordion-item shadow title="Before Taking">
                                 <div class="accordion-item-content" slot="item-content">${beforeContent}</div>
                             </accordion-item>
                             <accordion-item shadow title="How To Take">
                                 <div class="accordion-item-content" slot="item-content">${howToContent}</div>
                             </accordion-item>
                             <accordion-item shadow title="Side Effects">
                                 <div class="accordion-item-content" slot="item-content">${sideEffectsContent}</div>
                             </accordion-item>
                             <accordion-item shadow title="Storing">
                                 <div class="accordion-item-content" slot="item-content">${storingContent}</div>
                             </accordion-item>
                             <accordion-item shadow title="More">
                                 <div class="accordion-item-content" slot="item-content">${moreContent}</div>
                             </accordion-item>`
        this.element.querySelector("#content").innerHTML = htmlFragment;
    }

    buildBasePath(callback) {
        const pathToBatchDSU = `${this.basePath}${constants.PATH_TO_BATCH_DSU}`;
            let batchBasePath = `${pathToBatchDSU}${this.xmlType}/`;
            this.DSUStorage.call("listFolders", batchBasePath, (err, files) => {
                if (err) {
                    return callback(err);
                }
                if (files.length > 0) {
                    return callback(undefined, batchBasePath);
                }

                    const pathToProductDSU = `${this.basePath}${constants.PATH_TO_PRODUCT_DSU}`;
                    let pathBase = `${pathToProductDSU}${this.xmlType}/`;
                    callback(undefined, pathBase);
                });

    }


    getErrorMessageElement(errorMessage) {
        let pskLabel = document.createElement("psk-label");
        pskLabel.className = "scan-error-message";
        pskLabel.label = errorMessage;
        return pskLabel;
    }

    readFileAndDecodeContent(path, callback) {
        this.DSUStorage.getItem(path, (err, content) => {
            if (err) {
                return callback(err);
            }
            let textDecoder = new TextDecoder("utf-8");
            callback(undefined, textDecoder.decode(content));
        })
    }

    getAvailableLanguagesForXmlType(callback) {
        this.buildBasePath((err, pathBase) => {
            this.DSUStorage.call("listFolders", pathBase, (err, languages) => {
                if (err) {
                    return callback(err);
                }

                callback(undefined, this.languageService.normalizeLanguages(languages));
            })
        });
    }

    registerLanguages(languages, callback) {
        this.languageService.addWorkingLanguages(languages, callback);
    }

    registerAvailableLanguages(callback) {
        this.getAvailableLanguagesForXmlType((err, languages) => {
            this.registerLanguages(languages, callback);
        });
    }
}
