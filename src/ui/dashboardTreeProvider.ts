import * as vscode from "vscode";

import { ProjectRepository } from "../core/repository";
import { DashboardRecord } from "../core/types";

export class DashboardTreeItem extends vscode.TreeItem {
  constructor(readonly record: DashboardRecord) {
    super(record.selectorName, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "grafanaDashboard";
    this.description = record.exists ? record.title ?? record.entry.uid : "Missing local file";
    this.tooltip = new vscode.MarkdownString(
      [
        `**${record.selectorName}**`,
        "",
        `UID: \`${record.entry.uid}\``,
        `Path: \`${record.entry.path}\``,
        record.exists ? `Local file: \`${record.absolutePath}\`` : "Local file is missing.",
      ].join("\n"),
    );
    this.iconPath = new vscode.ThemeIcon(record.exists ? "file-code" : "warning");
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
    } catch (error) {
      return [new DashboardPlaceholderItem(`Manifest error: ${String(error)}`)];
    }
  }
}
