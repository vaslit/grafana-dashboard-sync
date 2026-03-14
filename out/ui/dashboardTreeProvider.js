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
exports.DashboardTreeProvider = exports.DashboardRevisionTreeItem = exports.DashboardTreeItem = void 0;
const vscode = __importStar(require("vscode"));
class DashboardTreeItem extends vscode.TreeItem {
    record;
    revisionCount;
    constructor(record, revisionCount) {
        super(record.selectorName, revisionCount > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        this.record = record;
        this.revisionCount = revisionCount;
        this.contextValue = "grafanaDashboard";
        this.description = record.exists ? record.title ?? record.entry.uid : "Missing local file";
        this.tooltip = new vscode.MarkdownString([
            `**${record.selectorName}**`,
            "",
            `UID: \`${record.entry.uid}\``,
            `Path: \`${record.entry.path}\``,
            record.exists ? `Local file: \`${record.absolutePath}\`` : "Local file is missing.",
            `Revisions: ${revisionCount}`,
        ].join("\n"));
        this.iconPath = new vscode.ThemeIcon(record.exists ? "file-code" : "warning");
    }
}
exports.DashboardTreeItem = DashboardTreeItem;
class DashboardRevisionTreeItem extends vscode.TreeItem {
    record;
    revision;
    isSelectedTargetRevision;
    constructor(record, revision, isSelectedTargetRevision) {
        super(revision.record.id, vscode.TreeItemCollapsibleState.None);
        this.record = record;
        this.revision = revision;
        this.isSelectedTargetRevision = isSelectedTargetRevision;
        this.contextValue = "grafanaDashboardRevision";
        const badges = [
            revision.isCheckedOut ? "checked out" : undefined,
            isSelectedTargetRevision ? "on active target" : undefined,
            revision.record.source.kind,
        ].filter(Boolean);
        this.description = badges.join(", ");
        this.tooltip = new vscode.MarkdownString([
            `**${revision.record.id}**`,
            "",
            `Dashboard: \`${record.selectorName}\``,
            `Created: \`${revision.record.createdAt}\``,
            `Source: \`${revision.record.source.kind}\``,
            revision.isCheckedOut ? "Current checked out revision." : "",
            isSelectedTargetRevision ? "Configured as the current revision on the active target." : "",
        ]
            .filter(Boolean)
            .join("\n"));
        this.iconPath = new vscode.ThemeIcon(isSelectedTargetRevision ? "target" : revision.isCheckedOut ? "check" : "history");
    }
}
exports.DashboardRevisionTreeItem = DashboardRevisionTreeItem;
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
    getService;
    getActiveTarget;
    getMissingProjectMessage;
    changeEmitter = new vscode.EventEmitter();
    targetRevisionCache = new Map();
    onDidChangeTreeData = this.changeEmitter.event;
    constructor(getRepository, getService, getActiveTarget, getMissingProjectMessage) {
        this.getRepository = getRepository;
        this.getService = getService;
        this.getActiveTarget = getActiveTarget;
        this.getMissingProjectMessage = getMissingProjectMessage;
    }
    refresh() {
        this.changeEmitter.fire();
    }
    clearTargetRevisionCache() {
        this.targetRevisionCache.clear();
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
                return this.dashboardChildren(element.record);
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
            const service = this.getService();
            return Promise.all(records.map(async (record) => {
                const revisionCount = service
                    ? (await service.listDashboardRevisions(record.entry).catch(() => [])).length
                    : 0;
                return new DashboardTreeItem(record, revisionCount);
            }));
        }
        catch (error) {
            return [new DashboardPlaceholderItem(`Manifest error: ${String(error)}`)];
        }
    }
    async dashboardChildren(record) {
        const service = this.getService();
        if (!service) {
            return [new DashboardPlaceholderItem("Dashboard service is not ready.")];
        }
        const revisions = await service.listDashboardRevisions(record.entry).catch(() => []);
        if (revisions.length === 0) {
            return [new DashboardPlaceholderItem("No revisions yet.")];
        }
        const { instanceName, targetName } = this.getActiveTarget();
        const cacheKey = instanceName && targetName ? `${record.selectorName}::${instanceName}/${targetName}` : undefined;
        let matchedRevisionId = cacheKey ? this.targetRevisionCache.get(cacheKey) : undefined;
        if (cacheKey && !this.targetRevisionCache.has(cacheKey)) {
            matchedRevisionId = await service
                .matchedRevisionIdForTarget(record.entry, instanceName, targetName)
                .catch(() => undefined);
            this.targetRevisionCache.set(cacheKey, matchedRevisionId);
        }
        return revisions.map((revision) => new DashboardRevisionTreeItem(record, revision, matchedRevisionId === revision.record.id));
    }
}
exports.DashboardTreeProvider = DashboardTreeProvider;
//# sourceMappingURL=dashboardTreeProvider.js.map