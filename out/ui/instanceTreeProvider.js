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
exports.InstanceTreeProvider = exports.InstanceTargetDashboardTreeItem = exports.DeploymentTargetTreeItem = exports.InstanceTreeItem = exports.DevTargetTreeItem = void 0;
const vscode = __importStar(require("vscode"));
const repository_1 = require("../core/repository");
class DevTargetTreeItem extends vscode.TreeItem {
    constructor(instanceName, targetName) {
        super("Dev Target", vscode.TreeItemCollapsibleState.None);
        this.contextValue = "grafanaDevTargetSelector";
        this.description = instanceName && targetName ? `${instanceName}/${targetName}` : "not selected";
        this.tooltip = new vscode.MarkdownString([
            "**Dev Target**",
            "",
            instanceName && targetName
                ? `Current dev target: \`${instanceName}/${targetName}\``
                : "No dev target selected.",
        ].join("\n"));
        this.iconPath = new vscode.ThemeIcon("server-environment");
        this.command = {
            command: "grafanaDashboards.selectActiveInstance",
            title: "Select Active Deployment Target",
        };
    }
}
exports.DevTargetTreeItem = DevTargetTreeItem;
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
    dashboardCount;
    constructor(target, dashboardCount) {
        super(target.name, dashboardCount > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        this.target = target;
        this.dashboardCount = dashboardCount;
        this.contextValue = "grafanaDeploymentTarget";
        this.description = [
            target.name === repository_1.DEFAULT_DEPLOYMENT_TARGET ? "default" : "target",
            `${dashboardCount} dashboard${dashboardCount === 1 ? "" : "s"}`,
        ].join(", ");
        this.tooltip = new vscode.MarkdownString([
            `**${target.instanceName}/${target.name}**`,
            "",
            `Dashboards: ${dashboardCount}`,
        ].join("\n"));
        this.iconPath = new vscode.ThemeIcon(target.name === repository_1.DEFAULT_DEPLOYMENT_TARGET ? "target" : "symbol-field");
    }
}
exports.DeploymentTargetTreeItem = DeploymentTargetTreeItem;
class InstanceTargetDashboardTreeItem extends vscode.TreeItem {
    target;
    record;
    constructor(target, record) {
        super(record.selectorName, vscode.TreeItemCollapsibleState.None);
        this.target = target;
        this.record = record;
        this.contextValue = "grafanaInstanceDashboard";
        this.description = record.exists ? record.title ?? record.entry.uid : "Missing local file";
        this.tooltip = new vscode.MarkdownString([
            `**${record.selectorName} -> ${target.instanceName}/${target.name}**`,
            "",
            `UID: \`${record.entry.uid}\``,
            `Path: \`${record.entry.path}\``,
            record.exists ? `Local file: \`${record.absolutePath}\`` : "Local file is missing.",
        ].join("\n"));
        this.iconPath = new vscode.ThemeIcon(record.exists ? "file-code" : "warning");
    }
}
exports.InstanceTargetDashboardTreeItem = InstanceTargetDashboardTreeItem;
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
    getActiveTarget;
    getMissingProjectMessage;
    changeEmitter = new vscode.EventEmitter();
    onDidChangeTreeData = this.changeEmitter.event;
    constructor(getRepository, getActiveTarget, getMissingProjectMessage) {
        this.getRepository = getRepository;
        this.getActiveTarget = getActiveTarget;
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
            if (element instanceof DeploymentTargetTreeItem) {
                return this.targetChildren(repository, element.target);
            }
            const instances = await repository.listInstances();
            if (instances.length === 0) {
                return [
                    new DevTargetTreeItem(this.getActiveTarget().instanceName, this.getActiveTarget().targetName),
                    new InstancePlaceholderItem("Create an instance", {
                        command: "grafanaDashboards.createInstance",
                        title: "Create Instance",
                    }),
                ];
            }
            const items = await Promise.all(instances.map(async (instance) => {
                const targets = await repository.listDeploymentTargets(instance.name);
                return new InstanceTreeItem(instance, targets.length);
            }));
            return [new DevTargetTreeItem(this.getActiveTarget().instanceName, this.getActiveTarget().targetName), ...items];
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
        const records = await repository.listDashboardRecords();
        return targets.map((target) => new DeploymentTargetTreeItem(target, records.length));
    }
    async targetChildren(repository, target) {
        const records = await repository.listDashboardRecords();
        if (records.length === 0) {
            return [
                new InstancePlaceholderItem("Manifest is empty. Add a dashboard.", {
                    command: "grafanaDashboards.addDashboard",
                    title: "Add Dashboard",
                }),
            ];
        }
        return records.map((record) => new InstanceTargetDashboardTreeItem(target, record));
    }
}
exports.InstanceTreeProvider = InstanceTreeProvider;
//# sourceMappingURL=instanceTreeProvider.js.map