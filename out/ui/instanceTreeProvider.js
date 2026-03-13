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
exports.InstanceTreeProvider = exports.DeploymentTargetTreeItem = exports.InstanceTreeItem = void 0;
const vscode = __importStar(require("vscode"));
const repository_1 = require("../core/repository");
class InstanceTreeItem extends vscode.TreeItem {
    instance;
    targetCount;
    constructor(instance, targetCount) {
        super(instance.name, vscode.TreeItemCollapsibleState.Expanded);
        this.instance = instance;
        this.targetCount = targetCount;
        this.contextValue = "grafanaInstance";
        this.description = [
            instance.envExists ? "env" : "no env",
            `${targetCount} target${targetCount === 1 ? "" : "s"}`,
        ].join(", ");
        this.tooltip = new vscode.MarkdownString([
            `**${instance.name}**`,
            "",
            `Env: ${instance.envExists ? "present" : "missing"}`,
            `Targets: ${targetCount}`,
        ].join("\n"));
        this.iconPath = new vscode.ThemeIcon(instance.envExists ? "server" : "warning");
    }
}
exports.InstanceTreeItem = InstanceTreeItem;
class DeploymentTargetTreeItem extends vscode.TreeItem {
    target;
    overrideExists;
    folderOverrideExists;
    constructor(target, overrideExists, folderOverrideExists) {
        super(target.name, vscode.TreeItemCollapsibleState.None);
        this.target = target;
        this.overrideExists = overrideExists;
        this.folderOverrideExists = folderOverrideExists;
        this.contextValue = "grafanaDeploymentTarget";
        this.description = [
            target.name === repository_1.DEFAULT_DEPLOYMENT_TARGET ? "default" : "target",
            overrideExists ? "override" : "no override",
            folderOverrideExists ? "folder override" : "base folder",
        ].join(", ");
        this.tooltip = new vscode.MarkdownString([
            `**${target.instanceName}/${target.name}**`,
            "",
            `Override for current dashboard: ${overrideExists ? "present" : "missing"}`,
            `Folder override for current dashboard: ${folderOverrideExists ? "present" : "missing"}`,
        ].join("\n"));
        this.iconPath = new vscode.ThemeIcon(target.name === repository_1.DEFAULT_DEPLOYMENT_TARGET ? "target" : "symbol-field");
    }
}
exports.DeploymentTargetTreeItem = DeploymentTargetTreeItem;
class InstancePlaceholderItem extends vscode.TreeItem {
    constructor(label, command) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.command = command;
        this.contextValue = "grafanaPlaceholder";
        this.iconPath = new vscode.ThemeIcon("info");
    }
}
class InstanceTreeProvider {
    getRepository;
    selectionState;
    getMissingProjectMessage;
    changeEmitter = new vscode.EventEmitter();
    onDidChangeTreeData = this.changeEmitter.event;
    constructor(getRepository, selectionState, getMissingProjectMessage) {
        this.getRepository = getRepository;
        this.selectionState = selectionState;
        this.getMissingProjectMessage = getMissingProjectMessage;
    }
    refresh() {
        this.changeEmitter.fire();
    }
    async getTreeItem(element) {
        return element;
    }
    async getChildren(element) {
        const repository = this.getRepository();
        if (!repository) {
            return [
                new InstancePlaceholderItem(this.getMissingProjectMessage(), {
                    command: "grafanaDashboards.initializeProject",
                    title: "Initialize Grafana Dashboard Project",
                }),
            ];
        }
        try {
            if (element instanceof InstanceTreeItem) {
                return this.instanceChildren(repository, element.instance);
            }
            const instances = await repository.listInstances();
            if (instances.length === 0) {
                return [
                    new InstancePlaceholderItem("Create an instance", {
                        command: "grafanaDashboards.createInstance",
                        title: "Create Instance",
                    }),
                ];
            }
            return Promise.all(instances.map(async (instance) => {
                const targets = await repository.listDeploymentTargets(instance.name);
                return new InstanceTreeItem(instance, targets.length);
            }));
        }
        catch (error) {
            return [new InstancePlaceholderItem(`Instance error: ${String(error)}`)];
        }
    }
    async instanceChildren(repository, instance) {
        const targets = await repository.listDeploymentTargets(instance.name);
        if (targets.length === 0) {
            return [
                new InstancePlaceholderItem("Create a deployment target", {
                    command: "grafanaDashboards.createDeploymentTarget",
                    title: "Create Deployment Target",
                    arguments: [instance.name],
                }),
            ];
        }
        const selectedDashboard = await this.selectedDashboardRecord();
        return Promise.all(targets.map(async (target) => {
            const overrideFile = selectedDashboard
                ? await repository.readTargetOverrideFile(instance.name, target.name, selectedDashboard.entry)
                : undefined;
            return new DeploymentTargetTreeItem(target, Boolean(overrideFile && Object.keys(overrideFile.variables ?? {}).length > 0), Boolean(overrideFile?.folderPath?.trim()));
        }));
    }
    async selectedDashboardRecord() {
        const repository = this.getRepository();
        if (!repository) {
            return undefined;
        }
        if (!this.selectionState.selectedDashboardSelectorName) {
            return undefined;
        }
        return repository.dashboardRecordBySelector(this.selectionState.selectedDashboardSelectorName);
    }
}
exports.InstanceTreeProvider = InstanceTreeProvider;
//# sourceMappingURL=instanceTreeProvider.js.map