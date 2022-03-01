const {WebcController} = WebCardinal.controllers;
import SettingsService from "../services/SettingsService.js";
import interpretGS1scan from "../gs1ScanInterpreter/interpretGS1scan/interpretGS1scan.js";
import utils from "../../utils.js";
import constants from "../../constants.js";
import DSUDataRetrievalService from "../services/DSUDataRetrievalService/DSUDataRetrievalService.js";
import BatchStatusService from "../services/BatchStatusService.js";

import ScanService, { SCANNER_STATUS } from "../services/ScanService.js";

const gtinResolver = require("gtin-resolver");

const opendsu = require("opendsu");
const resolver = opendsu.loadApi("resolver");

const timeout = (time) => {
    return new Promise((resolve) => {
        const id = setTimeout(() => {
            resolve();
            clearTimeout(id)
        }, time)
    })
}

export default class ScanController extends WebcController {
    constructor(...props) {
        super(...props);

		this.model = {
			data: '',
			scannerStatus: undefined,
			hasCode: false,
			hasError: false,
			nativeSupport: false,
			useScandit: false
		};

		this.on("content-updated", async () => {
			let placeHolderElement = this.querySelector("#scanner-placeholder");

			if (!this.scanService) {
				this.scanService = new ScanService(placeHolderElement);

				this.scanService.onStatusChanged = (status) => this.onScannerStatusChanged(status);

				await this.scanService.setup();
			} else {
				console.log("Multiple calls to content-updated. Maybe you should check this...");
			}

			if (this.startScanningAsSoonAsPossible) {
				delete this.startScanningAsSoonAsPossible;
				await this.startScanning();
			}
		});

        const dbApi = opendsu.loadApi("db");
        dbApi.getMainEnclaveDB((err, enclaveDB) => {
            if (err) {
                console.log('Error on getting enclave DB');
                return;
            }
            this.dbStorage = enclaveDB;
            this.barcodePicker = null;
            this.settingsService = new SettingsService(enclaveDB);
            this.acdc = require('acdc').ReportingService.getInstance(this.settingsService);

            document.addEventListener('leaflet-ssapp:switch-camera', this.switchCamera);

            this.model.onChange("data", () => {
                console.log("new event data change: ", this.model.data);
                this.shouldRequestCaptures = false;
                this.process(this.parseGS1Code(this.model.data));
            });

            this.getNativeApiHandler((err, handler) => {
                if (err) {
                    console.log("Not able to activate native API support. Continue using bar code scanner from web.", err);
                    this.startScanning();
                    return;
                }

                if (handler) {

                    this.model.nativeSupport = true;

                    this.settingsService.readSetting("scanditLicense", (err, scanditLicense) => {
                        if (scanditLicense && window.ScanditSDK) {
                            const scan = handler.importNativeAPI("scanditScan");
                            scan([scanditLicense]).then((resultArray) => {
                                if (resultArray && resultArray.length > 0) {
                                    const firstScanObj = {
                                        symbology: resultArray[0],
                                        data: resultArray[1]
                                    }

                                    if (resultArray.length == 2) {
                                        return this.processSingleCodeScan(firstScanObj)
                                    }

                                    if (resultArray.length == 4) {
                                        const scanObjArray = [
                                            firstScanObj,
                                            {
                                                symbology: resultArray[2],
                                                data: resultArray[3]
                                            }
                                        ]

                                        return this.processCompositeCodeScan(scanObjArray)
                                    }
                                }
                                this.redirectToError(this.translate("err_no_code_scanned"));
                            }, (error) => {
                                switch (error) {
                                    case "ERR_NO_CODE_FOUND":
                                        this.redirectToError(this.translate("err_no_code_found"));
                                        break;
                                    case "ERR_SCAN_NOT_SUPPORTED":
                                        this.redirectToError(this.translate("err_scan_not_supported"));
                                        break;
                                    case "ERR_CAM_UNAVAILABLE":
                                        this.redirectToError(this.translate("err_cam_unavailable"));
                                        break;
                                    case "ERR_USER_CANCELLED":
                                        this.disposeOfBarcodePicker()
                                        this.navigateToPageTag("home");
                                        //   this.history.push(`${new URL(this.history.win.basePath).pathname}home`);
                                        break;
                                    default:
                                        this.redirectToError(this.translate("err_default"));
                                }
                            }).catch((err) => {
                                this.redirectToError(this.translate("err_unknown"));
                            });
                        } else {
                            this.startScanning();
                            /*const scan = handler.importNativeAPI("dataMatrixScan");
                            scan().then((resultArray) => {
                                if (resultArray && resultArray.length > 0) {
                                    return this.process(this.parseGS1Code(resultArray[0]));
                                }
                                this.redirectToError(this.translate("err_no_code_scanned"));
                            }, (error) => {
                                switch (error) {
                                    case "ERR_NO_CODE_FOUND":
                                        this.redirectToError(this.translate("err_no_code_found"));
                                        break;
                                    case "ERR_SCAN_NOT_SUPPORTED":
                                        this.redirectToError(this.translate("err_scan_not_supported"));
                                        break;
                                    case "ERR_CAM_UNAVAILABLE":
                                        this.redirectToError(this.translate("err_cam_unavailable"));
                                        break;
                                    case "ERR_USER_CANCELLED":
                                        this.disposeOfBarcodePicker()
                                        this.navigateToPageTag("home");
                                        // this.history.push(`${new URL(this.history.win.basePath).pathname}home`);
                                        break;
                                    default:
                                        this.redirectToError(this.translate("err_default"));
                                }
                            }).catch((err) => {
                                this.redirectToError(this.translate("err_unknown"));
                            });*/
                        }
                    });
                    return;
                } else {
                    this.startScanning();
                }

                this.settingsService.readSetting("scanditLicense", (err, scanditLicense) => {
                    if (scanditLicense && window.ScanditSDK) {
                        this.model.useScandit = true;
                        this.initScanditLib(scanditLicense)
                    }
                });
            });
        });
    }

    async startScanning() {
        if (!this.scanService) {
            this.startScanningAsSoonAsPossible = true;
            return;
        }
        this.scanInterval = setInterval( () => {
            this.scanService.scan().then(result=>{
                if(!result){
                    return;
                }
                this.onScannerStatusChanged(SCANNER_STATUS.DONE);

				console.log("Scan result:", result);
				this.scanService.stop();
				clearInterval(this.scanInterval);

				this.process(this.parseGS1Code(result.text));
			}).catch(err=>{
				console.log("Caught", err);
			});
        }, 100);
    }

	onScannerStatusChanged(status) {
		switch (status) {
			case SCANNER_STATUS.ACTIVE:
				this.model.scannerStatus = 'active';
				return;
			case SCANNER_STATUS.SETTING:
				this.model.scannerStatus = 'feedback';
				return;
			case SCANNER_STATUS.NO_CAMERAS:
				this.model.scannerStatus = 'no-cameras';
				return;
			case SCANNER_STATUS.PERMISSION_DENIED:
				this.model.scannerStatus = 'permission-denied';
				return;
			case SCANNER_STATUS.DONE:
				this.model.scannerStatus = 'done';
				return;
			default:
				this.model.scannerStatus = undefined;
		}
	}

	onDisconnectedCallback() {
		this.disposeOfBarcodePicker();
		document.removeEventListener('leaflet-ssapp:switch-camera', this.switchCamera);

        if (this.scanService) {
            this.scanService.stop();
        }

        if(this.scanInterval){
            clearInterval(this.scanInterval);
        }
    }

    switchCamera = async () => {
        const barcodeScanner = this.querySelector('psk-barcode-scanner');
        if (barcodeScanner) {
            await barcodeScanner.switchCamera();
            return;
        }

        if (this.barcodePicker) {
            const types = {BACK: 'back', FRONT: 'front'};

            try {
                this.barcodePicker.setCameraType(this.barcodePicker.cameraManager.cameraType === types.BACK ? types.FRONT : types.BACK);
            } catch (error) {
                console.log('Scandit camera can not be changed!');
            }

            window.barcodePicker = this.barcodePicker;
            return;
        }
    }

    callAfterElementLoad(querySelector, callback, ms = 100) {
        const delayedInit = () => {
            const element = this.element.querySelector(querySelector)
            if (element) {
                callback(element)
            } else {
                setTimeout(delayedInit, ms);
            }
        };

        delayedInit();
    }

    parseGS1Code(scannedBarcode) {
        let gs1FormatFields;
        try {
            gs1FormatFields = interpretGS1scan.interpretScan(scannedBarcode);
        } catch (e) {
            this.redirectToError(this.translate("err_barcode"), this.parseGs1Fields(e.dlOrderedAIlist), e.message);
            return;
        }

        return this.parseGs1Fields(gs1FormatFields.ol);
    }

    parseCompositeCodeScan(barrcodesArray) {
        this.model.hasCode = true;
        const gtinObject = barrcodesArray.find((item) => item.symbology.indexOf('databar') !== -1)
        const batchAndExpiriCodeObject = barrcodesArray.find((item) => item.symbology === "micropdf417")

        return this.parseGS1Code(`${gtinObject.data}${batchAndExpiriCodeObject.data}`)
    }

    parseEAN13CodeScan(scannedEan13Code) {
        let ean13 = scannedEan13Code ? scannedEan13Code : ""
        const length = scannedEan13Code && scannedEan13Code.length ? scannedEan13Code.length : 0;
        ean13 = ean13.padStart(14 - length, '0');
        return {
            "gtin": ean13,
            "batchNumber": "",
            "expiry": "",
            "serialNumber": ""
        }
    }

    process(gs1Fields) {
        console.log("Processing fields: ", gs1Fields);
        if (!this.hasMandatoryFields(gs1Fields)) {
            return this.redirectToError(this.translate("err_barcode"), gs1Fields);
        }

        const evt = this.acdc.createScanEvent(gs1Fields);

        this.buildSSI(gs1Fields, (err, gtinSSI) => {
            if (err) {
                return this.redirectToError(this.translate("err_combination"), gs1Fields);
            }
            this.packageAlreadyScanned(gtinSSI, gs1Fields, (err, result) => {
                if (err) {
                    evt.report((err, response) => {
                        if (err)
                            console.log(err)
                        return this.redirectToError(this.translate("err_combination"), gs1Fields);
                    });
                }
                if (result.status === false) {
                    this.batchAnchorExists(gtinSSI, (err, status) => {
                        if (status) {
                            evt.setBatchDSUStatus(true)
                            evt.report((err, response) => {
                                if (err)
                                    console.log(err)
                                this.addPackageToHistoryAndRedirect(gtinSSI, gs1Fields, (err) => {
                                    if (err) {
                                        return this.redirectToError(this.translate("err_to_history"), gs1Fields, err.message);
                                    }
                                });
                            });
                        } else {
                            evt.setBatchDSUStatus(false);
                            evt.report((err, response) => {
                                if (err)
                                    console.log(err);
                                this.addConstProductDSUToHistory(gs1Fields);
                            })
                        }
                    });
                } else {
                    evt.setBatchDSUStatus(true);
                    evt.report((err, response) => {
                        if (err)
                            console.log(err)
                        this.redirectToDrugDetails({productData: result.record});
                    })
                }
            });
        });
    }

    insertScanditStyles() {
        const style = document.createElement('style');

        style.setAttribute('type', 'text/css');
        style.innerHTML = ".scandit.scandit-container{width:100%;height:100%;display:flex;justify-content:center;align-items:center;overflow:hidden}.scandit.scandit-barcode-picker{position:relative;min-width:1px;min-height:1px;width:100%;height:100%;background-color:#000}.scandit .scandit-video{width:100%;height:100%;position:relative;display:block}.scandit .scandit-video.mirrored{transform:scaleX(-1)}.scandit .scandit-logo{bottom:5%;right:5%;max-width:35%;max-height:12.5%}.scandit .scandit-laser,.scandit .scandit-logo{position:absolute;pointer-events:none;transform:translateZ(0)}.scandit .scandit-laser{z-index:10;box-sizing:border-box;top:-9999px;display:flex;align-items:center}.scandit .scandit-laser img{width:100%;max-height:47px}.scandit .scandit-laser img,.scandit .scandit-viewfinder{position:absolute;transition:opacity .25s ease;animation-duration:.25s}.scandit .scandit-viewfinder{z-index:10;box-sizing:border-box;border:2px solid #fff;border-radius:10px;top:-9999px;pointer-events:none;transform:translateZ(0)}.scandit .scandit-viewfinder.paused{opacity:.4}.scandit .scandit-camera-switcher,.scandit .scandit-torch-toggle{-webkit-tap-highlight-color:rgba(255,255,255,0);position:absolute;top:5%;max-width:15%;max-height:15%;z-index:10;cursor:pointer;filter:drop-shadow(0 2px 0 #808080);transform:translateZ(0)}.scandit .scandit-camera-switcher{left:5%}.scandit .scandit-torch-toggle{right:5%}.scandit .scandit-camera-upload{-webkit-tap-highlight-color:rgba(255,255,255,0);width:100%;height:100%;z-index:5}.scandit .scandit-camera-upload,.scandit .scandit-camera-upload label{display:flex;flex-direction:column;justify-content:center;align-items:center}.scandit .scandit-camera-upload label{cursor:pointer;width:180px;height:180px;margin-top:18px;border-radius:50%}.scandit .scandit-camera-upload label input[type=file]{position:absolute;top:-9999px}.scandit .radial-progress{width:180px;height:180px;background-color:transparent;border-width:3px;border-style:solid;border-radius:50%;position:absolute;transition:opacity 1s ease,border-color .5s;animation-duration:.25s;box-sizing:border-box}.scandit .radial-progress[data-progress=\"0\"]{opacity:.2}.scandit .radial-progress[data-progress=\"5\"]{opacity:.24}.scandit .radial-progress[data-progress=\"10\"]{opacity:.28}.scandit .radial-progress[data-progress=\"15\"]{opacity:.32}.scandit .radial-progress[data-progress=\"20\"]{opacity:.36}.scandit .radial-progress[data-progress=\"25\"]{opacity:.4}.scandit .radial-progress[data-progress=\"30\"]{opacity:.44}.scandit .radial-progress[data-progress=\"35\"]{opacity:.48}.scandit .radial-progress[data-progress=\"40\"]{opacity:.52}.scandit .radial-progress[data-progress=\"45\"]{opacity:.56}.scandit .radial-progress[data-progress=\"50\"]{opacity:.6}.scandit .radial-progress[data-progress=\"55\"]{opacity:.64}.scandit .radial-progress[data-progress=\"60\"]{opacity:.68}.scandit .radial-progress[data-progress=\"65\"]{opacity:.72}.scandit .radial-progress[data-progress=\"70\"]{opacity:.76}.scandit .radial-progress[data-progress=\"75\"]{opacity:.8}.scandit .radial-progress[data-progress=\"80\"]{opacity:.84}.scandit .radial-progress[data-progress=\"85\"]{opacity:.88}.scandit .radial-progress[data-progress=\"90\"]{opacity:.92}.scandit .radial-progress[data-progress=\"95\"]{opacity:.96}.scandit .radial-progress[data-progress=\"100\"]{opacity:1}.scandit .scandit-flash-color{animation-name:scandit-flash-color}.scandit .scandit-flash-white{animation-name:scandit-flash-white}.scandit .scandit-flash-inset{animation-name:scandit-flash-inset}.scandit .scandit-opacity-pulse{animation-duration:.333s,1s;animation-iteration-count:1,infinite;animation-delay:0s,.333s;animation-timing-function:cubic-bezier(.645,.045,.355,1),cubic-bezier(.645,.045,.355,1);animation-name:scandit-opacity-pulse-before,scandit-opacity-pulse}.scandit .scandit-hidden-opacity{opacity:0}.scandit-hidden{display:none!important}@keyframes scandit-flash-color{0%{filter:none}50%{filter:drop-shadow(0 0 .75rem #fff) drop-shadow(0 0 2.5rem #7ed9e2)}to{filter:none}}@keyframes scandit-flash-white{0%{filter:none}50%{filter:drop-shadow(0 0 .5rem #fff) drop-shadow(0 0 1rem #fff) drop-shadow(0 0 2.5rem #fff)}to{filter:none}}@keyframes scandit-flash-inset{0%{box-shadow:none}50%{box-shadow:inset 0 0 .5rem,inset 0 0 1rem,inset 0 0 2.5rem}to{box-shadow:none}}@keyframes scandit-opacity-pulse-before{0%{opacity:1}to{opacity:.4}}@keyframes scandit-opacity-pulse{0%{opacity:.4}50%{opacity:.6}to{opacity:.4}}";

        this.callAfterElementLoad("#scandit-barcode-picker-wrapper", (element) => {
            element.appendChild(style);
        })
    }

    initScanditLib(scanditLicense) {
        this.insertScanditStyles()

        let compositeOngoing = false
        const compositeMap = {}
        compositeMap[4] = "databar-limited"
        compositeMap[2] = "micropdf417"


        const defaultScanSettings = {
            enabledSymbologies: [
                window.ScanditSDK.Barcode.Symbology.CODE128,
                window.ScanditSDK.Barcode.Symbology.DATA_MATRIX,
                window.ScanditSDK.Barcode.Symbology.DOTCODE,
                window.ScanditSDK.Barcode.Symbology.GS1_DATABAR_LIMITED,
                window.ScanditSDK.Barcode.Symbology.EAN13,
                window.ScanditSDK.Barcode.Symbology.PDF417,
                window.ScanditSDK.Barcode.Symbology.MICRO_PDF417,
                window.ScanditSDK.Barcode.Symbology.GS1_DATABAR,
                window.ScanditSDK.Barcode.Symbology.UPCE,
                window.ScanditSDK.Barcode.Symbology.UPCA,
                window.ScanditSDK.Barcode.Symbology.EAN8,
                window.ScanditSDK.Barcode.Symbology.GS1_DATABAR_EXPANDED
            ],
            maxNumberOfCodesPerFrame: 4
        }
        const createNewBarcodePicker = (scanSettings = defaultScanSettings) => {
            const scanningSettings = new window.ScanditSDK.ScanSettings(scanSettings)
            scanningSettings.getSymbologySettings(window.ScanditSDK.Barcode.Symbology.GS1_DATABAR_LIMITED).setColorInvertedEnabled(true)
            scanningSettings.getSymbologySettings(window.ScanditSDK.Barcode.Symbology.DATA_MATRIX).setColorInvertedEnabled(true);
            scanningSettings.getSymbologySettings(window.ScanditSDK.Barcode.Symbology.DOTCODE).setColorInvertedEnabled(true);
            //just to eliminate dublicates durring scanning
            scanningSettings.codeDuplicateFilter = 3000;

            return new Promise((resolve) => {
                window.requestAnimationFrame(() => {
                    this.callAfterElementLoad("#scandit-barcode-picker", (element) => {
                        return resolve(window.ScanditSDK.BarcodePicker.create(element, {
                            scanSettings: scanningSettings,
                            cameraSettings: {resolutionPreference: "full-hd"},
                            guiStyle: "none", // "none", "viewfinder", "laser"
                            videoFit: "cover",
                            enableCameraSwitcher: false
                        }))
                    })
                })
            })
        }

        const newBarcodePickerCallback = (barcodePicker) => {
            this.barcodePicker = barcodePicker;
            barcodePicker.setMirrorImageEnabled(false);
            barcodePicker.resumeScanning()
            barcodePicker.on("scan", (scanResult) => {
                const firstBarcodeObj = scanResult.barcodes[0];
                const secondBarcodeObj = scanResult.barcodes[1];

                if (scanResult.barcodes.length === 2 && firstBarcodeObj.symbology !== secondBarcodeObj.symbology) {
                    compositeOngoing = false
                    return this.processCompositeCodeScan(scanResult.barcodes);
                }

                if (firstBarcodeObj) {
                    // single barcode
                    if (firstBarcodeObj.compositeFlag < 2) {
                        compositeOngoing = false

                        return this.processSingleCodeScan(firstBarcodeObj)
                    }
                    // composite barcode
                    if (compositeOngoing) {
                        if (compositeMap[compositeOngoing.compositeFlag] === firstBarcodeObj.symbology) {
                            this.processCompositeCodeScan([
                                compositeOngoing,
                                firstBarcodeObj
                            ]);
                            compositeOngoing = false
                        }
                    } else {
                        compositeOngoing = firstBarcodeObj
                    }
                }
            });
        }

        window.ScanditSDK.configure(scanditLicense, {
            engineLocation: "https://cdn.jsdelivr.net/npm/scandit-sdk@5.x/build/",
        })
            .then(() => {
                return createNewBarcodePicker()
            })
            .then(newBarcodePickerCallback);
    }

    initPskBarcodeWithFrames = (nativeHandler) => {
        window.requestAnimationFrame(async () => {
            const barcodeScanner = this.querySelector('psk-barcode-scanner');
            barcodeScanner.useFrames = true;
            const photoCaptureStream = nativeHandler.importNativeStreamAPI("photoCaptureStream");

            try {
                await photoCaptureStream.openStream()
                console.log("Photo capture stream API opened");
            } catch (error) {
                console.log("Photo stream API error " + error);
                return;
            }

            this.shouldRequestCaptures = true;

            const startCapturing = async () => {
                try {
                    if (this.shouldRequestCaptures) {
                        const [frame] = await photoCaptureStream.retrieveNextValue(1)
                        await barcodeScanner.setFrame(frame)
                        await timeout(0)
                        await startCapturing()
                    }
                } catch (error) {
                    console.log("Received error on retrieved next value " + error);
                }
            }

            const stopCapturing = () => {
                this.shouldRequestCaptures = false
                // stencil router does not have a removeListener for history
            }

            startCapturing();

            this.model.onChange("data", stopCapturing);
            this.history.listen(stopCapturing);
        });
    }

    processSingleCodeScan(scanObj) {
        if (scanObj.symbology === "data-matrix") {
            return this.process(this.parseGS1Code(scanObj.data));
        } else if (scanObj.symbology === "code128") {
            return this.process(this.parseGS1Code(scanObj.data));
        } else if (scanObj.symbology === "ean13") {
            return this.process(this.parseEAN13CodeScan(scanObj.data))
        } else {
            console.error(`Incompatible barcode scan: `, scanObj)
            throw new Error(`code symbology "${scanObj.symbology}" not recognized.`)
        }
    }

    processCompositeCodeScan(scanResultArray) {
        return this.process(this.parseCompositeCodeScan(scanResultArray));
    }

    buildSSI(gs1Fields, callback) {
        this.settingsService.readSetting("networkName", (err, networkName) => {
            if (err || typeof networkName === "undefined") {
                networkName = constants.DEFAULT_NETWORK_NAME;
            }
            return callback(undefined, gtinResolver.createGTIN_SSI(networkName, undefined, gs1Fields.gtin, gs1Fields.batchNumber));
        });
    }

    addConstProductDSUToHistory(gs1Fields) {
        this.createConstProductDSU_SSI(gs1Fields, (err, constProductDSU_SSI) => {
            if (err) {
                //todo: what to do in this case?
            }

            this.constProductDSUExists(constProductDSU_SSI, (err, status) => {
                if (err) {
                    return console.log("Failed to check constProductDSU existence", err);
                }
                if (status) {
                    this.addPackageToHistoryAndRedirect(constProductDSU_SSI, gs1Fields, (err) => {
                        if (err) {
                            return this.redirectToError(this.translate("err_to_history"), gs1Fields, err.message)
                        }
                    });
                } else {
                    return this.redirectToError(this.translate("err_combination"), gs1Fields);
                }
            });
        });
    }

    addPackageToHistoryAndRedirect(gtinSSI, gs1Fields, callback) {
        this.packageAlreadyScanned(gtinSSI, gs1Fields, (err, result) => {
            if (err) {
                console.log("Failed to verify if package was already scanned", err);
                return callback(err);
            }

            if (!result.status) {
                this.addPackageToScannedPackagesList(gtinSSI, gs1Fields, (err, record) => {
                    if (err) {
                        return callback(err);
                    }
                    this.redirectToDrugDetails({productData: record});
                });
            } else {
                this.redirectToDrugDetails({productData: result.record});
            }
        });

    }

    createConstProductDSU_SSI(gs1Fields, callback) {
        this.settingsService.readSetting("networkName", (err, networkName) => {
            if (err || typeof networkName === "undefined") {
                networkName = constants.DEFAULT_NETWORK_NAME;
            }
            return callback(undefined, gtinResolver.createGTIN_SSI(networkName, undefined, gs1Fields.gtin));
        });
    }

    packageAlreadyScanned(packageGTIN_SSI, gs1Fields, callback) {
        this.dbStorage.getRecord(constants.HISTORY_TABLE, utils.getRecordPKey(packageGTIN_SSI, gs1Fields), (err, result) => {
            if (err || !result) {
                callback(undefined, {status: false, record: null});
            } else {
                console.log("Found in db ", result);
                callback(undefined, {status: true, record: result});
            }

        })
    }

    addPackageToScannedPackagesList(packageGTIN_SSI, gs1Fields, callback) {
        this.dsuDataRetrievalService = new DSUDataRetrievalService(packageGTIN_SSI);
        let batchStatusService = new BatchStatusService();
        this.dsuDataRetrievalService.readProductData(async (err, product) => {
            if (err) {
                return callback(err);
            }
            let batchData;
            try {
                batchData = await this.dsuDataRetrievalService.asyncReadBatchData();
                batchStatusService.getProductStatus(batchData, gs1Fields);
            } catch (e) {
                batchStatusService.unableToVerify();
            }

            const pk = utils.getRecordPKey(packageGTIN_SSI, gs1Fields);
            this.dbStorage.insertRecord(constants.HISTORY_TABLE, pk, {
                gs1Fields: gs1Fields,
                gtinSSI: packageGTIN_SSI,
                status: batchStatusService.status,
                statusMessage: batchStatusService.statusMessage,
                statusType: batchStatusService.statusType,
                expiryForDisplay: batchStatusService.expiryForDisplay,
                expiryTime: batchStatusService.expiryTime,
                snCheck: batchStatusService.snCheck,
                product: product,
                batch: batchData,
                createdAt: new Date().toISOString(),
            }, (err, result) => {
                if (err) {
                    return callback(err);
                }
                callback(undefined, result);
            })
        })


    }

    constProductDSUExists(constProductDSU_SSI, callback) {
        resolver.loadDSU(constProductDSU_SSI.getIdentifier(), (err) => {
            if (err) {
                return callback(undefined, false);
            }

            callback(undefined, true);
        });
    }

    batchAnchorExists(packageGTIN_SSI, callback) {
        resolver.loadDSU(packageGTIN_SSI.getIdentifier(), (err) => {
            if (err) {
                return callback(undefined, false);
            }

            callback(undefined, true);
        });
    }

    parseGs1Fields(orderedList) {
        const gs1Fields = {};
        const fieldsConfig = {
            "GTIN": "gtin",
            "BATCH/LOT": "batchNumber",
            "SERIAL": "serialNumber",
            "USE BY OR EXPIRY": "expiry"
        };

        orderedList.map(el => {
            let fieldName = fieldsConfig[el.label];
            gs1Fields[fieldName] = el.value;
        })

        if (gs1Fields.expiry) {
            gs1Fields.expiry = utils.convertFromISOtoYYYY_HM(gs1Fields.expiry);
        }

        return gs1Fields;
    }

    hasMandatoryFields(gs1Fields) {
        if (!gs1Fields.gtin) {
            return false;
        }

        return true;
    }

    redirectToError(message, fields, secondaryMessage) {
        this.disposeOfBarcodePicker()
        this.navigateToPageTag("scan-error", {
            message,
            fields,
            secondaryMessage
        });
    }

    redirectToDrugDetails(state) {
        this.disposeOfBarcodePicker();
        this.navigateToPageTag("drug-details", JSON.parse(JSON.stringify(state)));
    }

    getNativeApiHandler(callback) {
        try {
            const nativeBridgeSupport = window.opendsu_native_apis;
            if (typeof nativeBridgeSupport === "object") {
                return nativeBridgeSupport.createNativeBridge(callback);
            }

            callback(undefined, undefined);
        } catch (err) {
            console.log("Caught an error during initialization of the native API bridge", err);
        }
    }

    disposeOfBarcodePicker() {
        if (this.barcodePicker) {
            this.barcodePicker.pauseScanning()
            this.barcodePicker.destroy()
        }
    }

    isDeveloperOptionActive(option) {
        switch (option) {
            case constants.IOS_USE_FRAMES:
                return localStorage.getItem(constants.IOS_USE_FRAMES) === 'true';
        }
    }
}
