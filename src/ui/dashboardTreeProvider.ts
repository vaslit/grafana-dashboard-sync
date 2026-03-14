import * as vscode from "vscode";

import { DashboardService } from "../core/dashboardService";
import { ProjectRepository } from "../core/repository";
import { DashboardRecord, DashboardRevisionListItem } from "../core/types";

export class DashboardTreeItem extends vscode.TreeItem {
  constructor(
    readonly record: DashboardRecord,
    readonly revisionCount: number,
  ) {
    super(
      record.selectorName,
      revisionCount > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    this.contextValue = "grafanaDashboard";
    this.description = record.exists ? record.title ?? record.entry.uid : "Missing local file";
    this.tooltip = new vscode.MarkdownString(
      [
        `**${record.selectorName}**`,
        "",
        `UID: \`${record.entry.uid}\``,
        `Path: \`${record.entry.path}\``,
        record.exists ? `Local file: \`${record.absolutePath}\`` : "Local file is missing.",
        `Revisions: ${revisionCount}`,
      ].join("\n"),
    );
    this.iconPath = new vscode.ThemeIcon(record.exists ? "file-code" : "warning");
  }
}

export class DashboardRevisionTreeItem extends vscode.TreeItem {
  constructor(
    readonly record: DashboardRecord,
    readonly revision: DashboardRevisionListItem,
    readonly isActiveTargetRevision: boolean,
  ) {
    super(revision.record.id, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "grafanaDashboardRevision";
    const badges = [
      revision.isCheckedOut ? "checked out" : undefined,
      isActiveTargetRevision ? "on dev target" : undefined,
      revision.record.source.kind,
    ].filter(Boolean);
    this.description = badges.join(", ");
    this.tooltip = new vscode.MarkdownString(
      [
        `**${revision.record.id}**`,
        "",
        `Dashboard: \`${record.selectorName}\``,
        `Created: \`${revision.record.createdAt}\``,
        `Source: \`${revision.record.source.kind}\``,
        revision.isCheckedOut ? "Current checked out revision." : "",
        isActiveTargetRevision ? "Matches the current dev target." : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    this.iconPath = new vscode.ThemeIcon(
      isActiveTargetRevision ? "radio-tower" : revision.isCheckedOut ? "check" : "history",
    );
  }
}

class DashboardPlaceholderItem extends vscode.TreeItem {
  constructor(label: string, command?: vscode.Command) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.command = command;
    this.contextValue = "grafanaPlaceholder";
    this.iconPath = new vscode.ThemeIcon("info");
  }
}

export class DashboardTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly targetRevisionCache = new Map<string, string | undefined>();

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly getRepository: () => ProjectRepository | undefined,
    private readonly getService: () => DashboardService | undefined,
    private readonly getActiveTarget: () => { instanceName?: string; targetName?: string },
    private readonly getMissingProjectMessage: () => string,
  ) {}

  refresh(): void {
    this.changeEmitter.fire();
  }

  clearTargetRevisionCache(): void {
    this.targetRevisionCache.clear();
  }

  async getTreeItem(element: vscode.TreeItem): Promise<vscode.TreeItem> {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
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
      return Promise.all(
        records.map(async (record) => {
          const revisionCount = service
            ? (await service.listDashboardRevisions(record.entry).catch(() => [])).length
            : 0;
          return new DashboardTreeItem(record, revisionCount);
        }),
      );
    } catch (error) {
      return [new DashboardPlaceholderItem(`Manifest error: ${String(error)}`)];
    }
  }

  private async dashboardChildren(record: DashboardRecord): Promise<vscode.TreeItem[]> {
    const service = this.getService();
    if (!service) {
      return [new DashboardPlaceholderItem("Dashboard service is not ready.")];
    }

    const revisions = await service.listDashboardRevisions(record.entry).catch(() => []);
    if (revisions.length === 0) {
      return [new DashboardPlaceholderItem("No revisions yet.")];
    }

    const { instanceName, targetName } = this.getActiveTarget();
    const cacheKey =
      instanceName && targetName ? `${record.selectorName}::${instanceName}/${targetName}` : undefined;
    let matchedRevisionId = cacheKey ? this.targetRevisionCache.get(cacheKey) : undefined;

    if (cacheKey && !this.targetRevisionCache.has(cacheKey)) {
      matchedRevisionId = await service
        .matchedRevisionIdForTarget(record.entry, instanceName!, targetName!)
        .catch(() => undefined);
      this.targetRevisionCache.set(cacheKey, matchedRevisionId);
    }

    return revisions.map(
      (revision) => new DashboardRevisionTreeItem(record, revision, matchedRevisionId === revision.record.id),
    );
  }
}
