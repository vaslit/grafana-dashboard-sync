"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SelectionState = void 0;
const vscode = __importStar(require("vscode"));
class SelectionState {
    changeEmitter = new vscode.EventEmitter();
    dashboardSelectorName;
    instanceName;
    targetName;
    backupName;
    detailsMode;
    activeDevInstanceName;
    activeDevTargetName;
    onDidChange = this.changeEmitter.event;
    get selectedDashboardSelectorName() {
        return this.dashboardSelectorName;
    }
    get selectedInstanceName() {
        return this.instanceName;
    }
    get selectedTargetName() {
        return this.targetName;
    }
    get selectedBackupName() {
        return this.backupName;
    }
    get selectedDetailsMode() {
        return this.detailsMode;
    }
    get activeInstanceName() {
        return this.activeDevInstanceName;
    }
    get activeTargetName() {
        return this.activeDevTargetName;
    }
    setDashboard(selectorName) {
        if (this.dashboardSelectorName === selectorName) {
            return;
        }
        this.dashboardSelectorName = selectorName;
        this.changeEmitter.fire();
    }
    setInstance(instanceName) {
        if (this.instanceName === instanceName) {
            return;
        }
        this.instanceName = instanceName;
        this.targetName = undefined;
        this.changeEmitter.fire();
    }
    setTarget(targetName) {
        if (this.targetName === targetName) {
            return;
        }
        this.targetName = targetName;
        this.changeEmitter.fire();
    }
    setBackup(backupName) {
        if (this.backupName === backupName) {
            return;
        }
        this.backupName = backupName;
        this.changeEmitter.fire();
    }
    setDetailsMode(mode) {
        if (this.detailsMode === mode) {
            return;
        }
        this.detailsMode = mode;
        this.changeEmitter.fire();
    }
    setActiveTarget(instanceName, targetName) {
        if (this.activeDevInstanceName === instanceName && this.activeDevTargetName === targetName) {
            return;
        }
        this.activeDevInstanceName = instanceName;
        this.activeDevTargetName = targetName;
        this.changeEmitter.fire();
    }
}
exports.SelectionState = SelectionState;
//# sourceMappingURL=selectionState.js.map