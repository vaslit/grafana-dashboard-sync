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
exports.DashboardTreeProvider = exports.DashboardTargetTreeItem = exports.DashboardInstanceTreeItem = exports.DashboardTreeItem = void 0;
const vscode = __importStar(require("vscode"));
const repository_1 = require("../core/repository");
class DashboardTreeItem extends vscode.TreeItem {
    record;
    instanceCount;
    constructor(record, instanceCount) {
        super(record.selectorName, instanceCount > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        this.record = record;
        this.instanceCount = instanceCount;
        this.contextValue = "grafanaDashboard";
        this.description = [
            record.exists ? record.title ?? record.entry.uid : "Missing local file",
            `${instanceCount} instance${instanceCount === 1 ? "" : "s"}`,
        ].join(", ");
        this.tooltip = new vscode.MarkdownString([
            `**${record.selectorName}**`,
            "",
            `UID: \`${record.entry.uid}\``,
            `Path: \`${record.entry.path}\``,
            record.exists ? `Local file: \`${record.absolutePath}\`` : "Local file is missing.",
            `Instances: ${instanceCount}`,
        ].join("\n"));
        this.iconPath = new vscode.ThemeIcon(record.exists ? "file-code" : "warning");
    }
}
exports.DashboardTreeItem = DashboardTreeItem;
class DashboardInstanceTreeItem extends vscode.TreeItem {
    record;
    instance;
    targetCount;
    constructor(record, instance, targetCount) {
        super(instance.name, targetCount > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        this.record = record;
        this.instance = instance;
        this.targetCount = targetCount;
        this.contextValue = "grafanaDashboardInstance";
        this.description = [
            instance.envExists ? "env" : "no env",
            `${targetCount} target${targetCount === 1 ? "" : "s"}`,
        ].join(", ");
        this.tooltip = new vscode.MarkdownString([
            `**${record.selectorName} -> ${instance.name}**`,
            "",
            `Env: ${instance.envExists ? "present" : "missing"}`,
            `Targets: ${targetCount}`,
            `Default target: \`${repository_1.DEFAULT_DEPLOYMENT_TARGET}\``,
        ].join("\n"));
        this.iconPath = new vscode.ThemeIcon(instance.envExists ? "server" : "warning");
    }
}
exports.DashboardInstanceTreeItem = DashboardInstanceTreeItem;
class DashboardTargetTreeItem extends vscode.TreeItem {
    record;
    target;
    overrideExists;
    folderOverrideExists;
    constructor(record, target, overrideExists, folderOverrideExists) {
        super(target.name, vscode.TreeItemCollapsibleState.None);
        this.record = record;
        this.target = target;
        this.overrideExists = overrideExists;
        this.folderOverrideExists = folderOverrideExists;
        this.contextValue = "grafanaDashboardTarget";
        this.description = [
            target.name === repository_1.DEFAULT_DEPLOYMENT_TARGET ? "default" : "target",
            overrideExists ? "override" : "no override",
            folderOverrideExists ? "folder override" : "base folder",
        ].join(", ");
        this.tooltip = new vscode.MarkdownString([
            `**${record.selectorName} -> ${target.instanceName}/${target.name}**`,
            "",
            `Override for this dashboard: ${overrideExists ? "present" : "missing"}`,
            `Folder override for this dashboard: ${folderOverrideExists ? "present" : "missing"}`,
        ].join("\n"));
        this.iconPath = new vscode.ThemeIcon(target.name === repository_1.DEFAULT_DEPLOYMENT_TARGET ? "target" : "symbol-field");
    }
}
exports.DashboardTargetTreeItem = DashboardTargetTreeItem;
class DashboardPlaceholderItem extends vscode.TreeItem {
    constructor(label, command) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.command = command;
        this.contextValue = "grafanaPlaceholder";
        this.iconPath = new vscode.ThemeIcon("info");
    }
}
class DashboardTreeProvider {
    getRepository;
    getMissingProjectMessage;
    changeEmitter = new vscode.EventEmitter();
    onDidChangeTreeData = this.changeEmitter.event;
    constructor(getRepository, getMissingProjectMessage) {
        this.getRepository = getRepository;
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
                new DashboardPlaceholderItem(this.getMissingProjectMessage(), {
                    command: "grafanaDashboards.initializeProject",
                    title: "Initialize Grafana Dashboard Project",
                }),
            ];
        }
        try {
            if (element instanceof DashboardTreeItem) {
                return this.dashboardChildren(repository, element.record);
            }
            if (element instanceof DashboardInstanceTreeItem) {
                return this.dashboardInstanceChildren(repository, element.record, element.instance);
            }
            const manifestExists = await repository.manifestExists();
            if (!manifestExists) {
                return [
                    new DashboardPlaceholderItem("Import dashboards list from example", {
                        command: "grafanaDashboards.createManifestFromExample",
                        title: "Import Dashboards From Example",
                    }),
                ];
            }
            const records = await repository.listDashboardRecords();
            if (records.length === 0) {
                return [
                    new DashboardPlaceholderItem("Manifest is empty. Add a dashboard.", {
                        command: "grafanaDashboards.addDashboard",
                        title: "Add Dashboard",
                    }),
                ];
            }
            const instances = await repository.listInstances();
            return records.map((record) => new DashboardTreeItem(record, instances.length));
        }
        catch (error) {
            return [new DashboardPlaceholderItem(`Manifest error: ${String(error)}`)];
        }
    }
    async dashboardChildren(repository, record) {
        const instances = await repository.listInstances();
        if (instances.length === 0) {
            return [
                new DashboardPlaceholderItem("Create an instance", {
                    command: "grafanaDashboards.createInstance",
                    title: "Create Instance",
                }),
            ];
        }
        return Promise.all(instances.map(async (instance) => {
            const targets = await repository.listDeploymentTargets(instance.name);
            return new DashboardInstanceTreeItem(record, instance, targets.length);
        }));
    }
    async dashboardInstanceChildren(repository, record, instance) {
        const targets = await repository.listDeploymentTargets(instance.name);
        if (targets.length === 0) {
            return [
                new DashboardPlaceholderItem("Create a deployment target", {
                    command: "grafanaDashboards.createDeploymentTarget",
                    title: "Create Deployment Target",
                    arguments: [instance.name],
                }),
            ];
        }
        return Promise.all(targets.map(async (target) => {
            const overrideFile = await repository.readTargetOverrideFile(instance.name, target.name, record.entry);
            return new DashboardTargetTreeItem(record, target, Boolean(overrideFile && Object.keys(overrideFile.variables ?? {}).length > 0), Boolean(overrideFile?.folderPath?.trim()));
        }));
    }
}
exports.DashboardTreeProvider = DashboardTreeProvider;
//# sourceMappingURL=dashboardTreeProvider.js.map