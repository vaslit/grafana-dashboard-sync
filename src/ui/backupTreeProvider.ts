import * as vscode from "vscode";

import { ProjectRepository } from "../core/repository";
import { BackupRecord } from "../core/types";

export class BackupTreeItem extends vscode.TreeItem {
  constructor(readonly backup: BackupRecord) {
    super(
      backup.scope === "dashboard"
        ? `${backup.dashboards[0]?.selectorName ?? backup.name} @ ${backup.instanceName}/${backup.targetName} @ ${backup.name}`
        : `${backup.instanceName}/${backup.targetName} @ ${backup.name}`,
      vscode.TreeItemCollapsibleState.None,
    );
    this.contextValue = "grafanaBackup";
    this.description = `${backup.scope}, ${backup.dashboardCount} dashboard${backup.dashboardCount === 1 ? "" : "s"}`;
    this.tooltip = new vscode.MarkdownString(
      [
        `**${backup.name}**`,
        "",
        `Scope: \`${backup.scope}\``,
        `Target: \`${backup.instanceName}/${backup.targetName}\``,
        `Generated: \`${backup.generatedAt}\``,
        `Dashboards: \`${String(backup.dashboardCount)}\``,
      ].join("\n"),
    );
    this.iconPath = new vscode.ThemeIcon("archive");
  }
}

class BackupPlaceholderItem extends vscode.TreeItem {
  constructor(label: string, command?: vscode.Command) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.command = command;
    this.contextValue = "grafanaPlaceholder";
    this.iconPath = new vscode.ThemeIcon("info");
  }
}

export class BackupTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly getRepository: () => ProjectRepository | undefined,
    private readonly getMissingProjectMessage: () => string,
  ) {}

  refresh(): void {
    this.changeEmitter.fire();
  }

  async getTreeItem(element: vscode.TreeItem): Promise<vscode.TreeItem> {
    return element;
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
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
    } catch (error) {
      return [new BackupPlaceholderItem(`Backup error: ${String(error)}`)];
    }
  }
}
