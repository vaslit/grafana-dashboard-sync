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
exports.BackupTreeProvider = exports.BackupDashboardTreeItem = exports.BackupTargetTreeItem = exports.BackupInstanceTreeItem = exports.BackupTreeItem = void 0;
const vscode = __importStar(require("vscode"));
class BackupTreeItem extends vscode.TreeItem {
    backup;
    constructor(backup) {
        super(backup.scope === "dashboard" ? backup.name : `${backup.name}`, backup.scope === "dashboard" ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
        this.backup = backup;
        this.contextValue = "grafanaBackup";
        this.description = [
            backup.scope,
            `${backup.instanceCount} instance${backup.instanceCount === 1 ? "" : "s"}`,
            `${backup.targetCount} target${backup.targetCount === 1 ? "" : "s"}`,
            `${backup.dashboardCount} dashboard${backup.dashboardCount === 1 ? "" : "s"}`,
        ].join(", ");
        this.tooltip = new vscode.MarkdownString([
            `**${backup.name}**`,
            "",
            `Scope: \`${backup.scope}\``,
            `Generated: \`${backup.generatedAt}\``,
            `Instances: \`${String(backup.instanceCount)}\``,
            `Targets: \`${String(backup.targetCount)}\``,
            `Dashboards: \`${String(backup.dashboardCount)}\``,
        ].join("\n"));
        this.iconPath = new vscode.ThemeIcon("archive");
    }
}
exports.BackupTreeItem = BackupTreeItem;
class BackupInstanceTreeItem extends vscode.TreeItem {
    backup;
    instance;
    constructor(backup, instance) {
        super(instance.instanceName, vscode.TreeItemCollapsibleState.Collapsed);
        this.backup = backup;
        this.instance = instance;
        this.contextValue = "grafanaBackupInstance";
        this.description = [
            `${instance.targetCount} target${instance.targetCount === 1 ? "" : "s"}`,
            `${instance.dashboardCount} dashboard${instance.dashboardCount === 1 ? "" : "s"}`,
        ].join(", ");
        this.tooltip = new vscode.MarkdownString([
            `**${instance.instanceName}**`,
            "",
            `Targets: ${instance.targetCount}`,
            `Dashboards: ${instance.dashboardCount}`,
        ].join("\n"));
        this.iconPath = new vscode.ThemeIcon("server");
    }
}
exports.BackupInstanceTreeItem = BackupInstanceTreeItem;
class BackupTargetTreeItem extends vscode.TreeItem {
    backup;
    target;
    constructor(backup, target) {
        super(`${target.instanceName}/${target.targetName}`, vscode.TreeItemCollapsibleState.Collapsed);
        this.backup = backup;
        this.target = target;
        this.contextValue = "grafanaBackupTarget";
        this.description = `${target.dashboardCount} dashboard${target.dashboardCount === 1 ? "" : "s"}`;
        this.tooltip = new vscode.MarkdownString([
            `**${target.instanceName}/${target.targetName}**`,
            "",
            `Dashboards: ${target.dashboardCount}`,
        ].join("\n"));
        this.iconPath = new vscode.ThemeIcon("target");
    }
}
exports.BackupTargetTreeItem = BackupTargetTreeItem;
class BackupDashboardTreeItem extends vscode.TreeItem {
    backup;
    instanceName;
    targetName;
    dashboard;
    constructor(backup, instanceName, targetName, dashboard) {
        super(dashboard.selectorName, vscode.TreeItemCollapsibleState.None);
        this.backup = backup;
        this.instanceName = instanceName;
        this.targetName = targetName;
        this.dashboard = dashboard;
        this.contextValue = "grafanaBackupDashboard";
        this.description = dashboard.title;
        this.tooltip = new vscode.MarkdownString([
            `**${dashboard.selectorName}**`,
            "",
            `Target: \`${instanceName}/${targetName}\``,
            `UID: \`${dashboard.effectiveDashboardUid}\``,
            `Path: \`${dashboard.path}\``,
        ].join("\n"));
        this.iconPath = new vscode.ThemeIcon("file-code");
    }
}
exports.BackupDashboardTreeItem = BackupDashboardTreeItem;
class BackupPlaceholderItem extends vscode.TreeItem {
    constructor(label, command) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.command = command;
        this.contextValue = "grafanaPlaceholder";
        this.iconPath = new vscode.ThemeIcon("info");
    }
}
class BackupTreeProvider {
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
                new BackupPlaceholderItem(this.getMissingProjectMessage(), {
                    command: "grafanaDashboards.initializeProject",
                    title: "Initialize Grafana Dashboard Project",
                }),
            ];
        }
        try {
            if (element instanceof BackupTreeItem) {
                return this.backupChildren(element.backup);
            }
            if (element instanceof BackupInstanceTreeItem) {
                return element.instance.targets.map((target) => new BackupTargetTreeItem(element.backup, target));
            }
            if (element instanceof BackupTargetTreeItem) {
                return element.target.dashboards.map((dashboard) => new BackupDashboardTreeItem(element.backup, element.target.instanceName, element.target.targetName, dashboard));
            }
            const backups = await repository.listBackups();
            if (backups.length === 0) {
                return [
                    new BackupPlaceholderItem("Create a backup of all dashboards", {
                        command: "grafanaDashboards.createAllDashboardsBackup",
                        title: "Create Backup of All Dashboards",
                    }),
                ];
            }
            return backups.map((backup) => new BackupTreeItem(backup));
        }
        catch (error) {
            return [new BackupPlaceholderItem(`Backup error: ${String(error)}`)];
        }
    }
    backupChildren(backup) {
        if (backup.scope === "dashboard") {
            return [];
        }
        if (backup.scope === "target") {
            const target = backup.instances[0]?.targets[0];
            if (!target) {
                return [];
            }
            return target.dashboards.map((dashboard) => new BackupDashboardTreeItem(backup, target.instanceName, target.targetName, dashboard));
        }
        if (backup.scope === "instance") {
            const instance = backup.instances[0];
            if (!instance) {
                return [];
            }
            return instance.targets.map((target) => new BackupTargetTreeItem(backup, target));
        }
        return backup.instances.map((instance) => new BackupInstanceTreeItem(backup, instance));
    }
}
exports.BackupTreeProvider = BackupTreeProvider;
//# sourceMappingURL=backupTreeProvider.js.map