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
exports.DashboardTreeProvider = exports.DashboardTreeItem = void 0;
const vscode = __importStar(require("vscode"));
class DashboardTreeItem extends vscode.TreeItem {
    record;
    constructor(record) {
        super(record.selectorName, vscode.TreeItemCollapsibleState.None);
        this.record = record;
        this.contextValue = "grafanaDashboard";
        this.description = record.exists ? record.title ?? record.entry.uid : "Missing local file";
        this.tooltip = new vscode.MarkdownString([
            `**${record.selectorName}**`,
            "",
            `UID: \`${record.entry.uid}\``,
            `Path: \`${record.entry.path}\``,
            record.exists ? `Local file: \`${record.absolutePath}\`` : "Local file is missing.",
        ].join("\n"));
        this.iconPath = new vscode.ThemeIcon(record.exists ? "file-code" : "warning");
    }
}
exports.DashboardTreeItem = DashboardTreeItem;
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
    async getChildren() {
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
            return records.map((record) => new DashboardTreeItem(record));
        }
        catch (error) {
            return [new DashboardPlaceholderItem(`Manifest error: ${String(error)}`)];
        }
    }
}
exports.DashboardTreeProvider = DashboardTreeProvider;
//# sourceMappingURL=dashboardTreeProvider.js.map