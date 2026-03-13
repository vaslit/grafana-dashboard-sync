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
exports.BackupTreeProvider = exports.BackupTreeItem = void 0;
const vscode = __importStar(require("vscode"));
class BackupTreeItem extends vscode.TreeItem {
    backup;
    constructor(backup) {
        super(backup.scope === "dashboard"
            ? `${backup.dashboards[0]?.selectorName ?? backup.name} @ ${backup.instanceName}/${backup.targetName} @ ${backup.name}`
            : `${backup.instanceName}/${backup.targetName} @ ${backup.name}`, vscode.TreeItemCollapsibleState.None);
        this.backup = backup;
        this.contextValue = "grafanaBackup";
        this.description = `${backup.scope}, ${backup.dashboardCount} dashboard${backup.dashboardCount === 1 ? "" : "s"}`;
        this.tooltip = new vscode.MarkdownString([
            `**${backup.name}**`,
            "",
            `Scope: \`${backup.scope}\``,
            `Target: \`${backup.instanceName}/${backup.targetName}\``,
            `Generated: \`${backup.generatedAt}\``,
            `Dashboards: \`${String(backup.dashboardCount)}\``,
        ].join("\n"));
        this.iconPath = new vscode.ThemeIcon("archive");
    }
}
exports.BackupTreeItem = BackupTreeItem;
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
    async getChildren() {
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
            const backups = await repository.listBackups();
            if (backups.length === 0) {
                return [
                    new BackupPlaceholderItem("Create a target backup", {
                        command: "grafanaDashboards.createBackup",
                        title: "Create Target Backup",
                    }),
                ];
            }
            return backups.map((backup) => new BackupTreeItem(backup));
        }
        catch (error) {
            return [new BackupPlaceholderItem(`Backup error: ${String(error)}`)];
        }
    }
}
exports.BackupTreeProvider = BackupTreeProvider;
//# sourceMappingURL=backupTreeProvider.js.map