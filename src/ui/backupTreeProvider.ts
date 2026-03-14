import * as vscode from "vscode";

import { ProjectRepository } from "../core/repository";
import { BackupDashboardRecord, BackupInstanceRecord, BackupRecord, BackupTargetRecord } from "../core/types";

export class BackupTreeItem extends vscode.TreeItem {
  constructor(readonly backup: BackupRecord) {
    super(
      backup.scope === "dashboard" ? backup.name : `${backup.name}`,
      backup.scope === "dashboard" ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.contextValue = "grafanaBackup";
    this.description = [
      backup.scope,
      `${backup.instanceCount} instance${backup.instanceCount === 1 ? "" : "s"}`,
      `${backup.targetCount} target${backup.targetCount === 1 ? "" : "s"}`,
      `${backup.dashboardCount} dashboard${backup.dashboardCount === 1 ? "" : "s"}`,
    ].join(", ");
    this.tooltip = new vscode.MarkdownString(
      [
        `**${backup.name}**`,
        "",
        `Scope: \`${backup.scope}\``,
        `Generated: \`${backup.generatedAt}\``,
        `Instances: \`${String(backup.instanceCount)}\``,
        `Targets: \`${String(backup.targetCount)}\``,
        `Dashboards: \`${String(backup.dashboardCount)}\``,
      ].join("\n"),
    );
    this.iconPath = new vscode.ThemeIcon("archive");
  }
}

export class BackupInstanceTreeItem extends vscode.TreeItem {
  constructor(
    readonly backup: BackupRecord,
    readonly instance: BackupInstanceRecord,
  ) {
    super(instance.instanceName, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = "grafanaBackupInstance";
    this.description = [
      `${instance.targetCount} target${instance.targetCount === 1 ? "" : "s"}`,
      `${instance.dashboardCount} dashboard${instance.dashboardCount === 1 ? "" : "s"}`,
    ].join(", ");
    this.tooltip = new vscode.MarkdownString(
      [
        `**${instance.instanceName}**`,
        "",
        `Targets: ${instance.targetCount}`,
        `Dashboards: ${instance.dashboardCount}`,
      ].join("\n"),
    );
    this.iconPath = new vscode.ThemeIcon("server");
  }
}

export class BackupTargetTreeItem extends vscode.TreeItem {
  constructor(
    readonly backup: BackupRecord,
    readonly target: BackupTargetRecord,
  ) {
    super(
      `${target.instanceName}/${target.targetName}`,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.contextValue = "grafanaBackupTarget";
    this.description = `${target.dashboardCount} dashboard${target.dashboardCount === 1 ? "" : "s"}`;
    this.tooltip = new vscode.MarkdownString(
      [
        `**${target.instanceName}/${target.targetName}**`,
        "",
        `Dashboards: ${target.dashboardCount}`,
      ].join("\n"),
    );
    this.iconPath = new vscode.ThemeIcon("target");
  }
}

export class BackupDashboardTreeItem extends vscode.TreeItem {
  constructor(
    readonly backup: BackupRecord,
    readonly instanceName: string,
    readonly targetName: string,
    readonly dashboard: BackupDashboardRecord,
  ) {
    super(dashboard.selectorName, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "grafanaBackupDashboard";
    this.description = dashboard.title;
    this.tooltip = new vscode.MarkdownString(
      [
        `**${dashboard.selectorName}**`,
        "",
        `Target: \`${instanceName}/${targetName}\``,
        `UID: \`${dashboard.effectiveDashboardUid}\``,
        `Path: \`${dashboard.path}\``,
      ].join("\n"),
    );
    this.iconPath = new vscode.ThemeIcon("file-code");
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

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
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
        return element.target.dashboards.map(
          (dashboard) => new BackupDashboardTreeItem(element.backup, element.target.instanceName, element.target.targetName, dashboard),
        );
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
    } catch (error) {
      return [new BackupPlaceholderItem(`Backup error: ${String(error)}`)];
    }
  }

  private backupChildren(backup: BackupRecord): vscode.TreeItem[] {
    if (backup.scope === "dashboard") {
      return [];
    }

    if (backup.scope === "target") {
      const target = backup.instances[0]?.targets[0];
      if (!target) {
        return [];
      }
      return target.dashboards.map(
        (dashboard) => new BackupDashboardTreeItem(backup, target.instanceName, target.targetName, dashboard),
      );
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
