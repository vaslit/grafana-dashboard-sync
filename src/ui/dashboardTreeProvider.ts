import * as vscode from "vscode";

import { DEFAULT_DEPLOYMENT_TARGET, ProjectRepository } from "../core/repository";
import { DashboardRecord, DeploymentTargetRecord, InstanceRecord } from "../core/types";

export class DashboardTreeItem extends vscode.TreeItem {
  constructor(
    readonly record: DashboardRecord,
    readonly instanceCount: number,
  ) {
    super(
      record.selectorName,
      instanceCount > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    this.contextValue = "grafanaDashboard";
    this.description = [
      record.exists ? record.title ?? record.entry.uid : "Missing local file",
      `${instanceCount} instance${instanceCount === 1 ? "" : "s"}`,
    ].join(", ");
    this.tooltip = new vscode.MarkdownString(
      [
        `**${record.selectorName}**`,
        "",
        `UID: \`${record.entry.uid}\``,
        `Path: \`${record.entry.path}\``,
        record.exists ? `Local file: \`${record.absolutePath}\`` : "Local file is missing.",
        `Instances: ${instanceCount}`,
      ].join("\n"),
    );
    this.iconPath = new vscode.ThemeIcon(record.exists ? "file-code" : "warning");
  }
}

export class DashboardInstanceTreeItem extends vscode.TreeItem {
  constructor(
    readonly record: DashboardRecord,
    readonly instance: InstanceRecord,
    readonly targetCount: number,
  ) {
    super(
      instance.name,
      targetCount > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    this.contextValue = "grafanaDashboardInstance";
    this.description = [
      instance.envExists ? "env" : "no env",
      `${targetCount} target${targetCount === 1 ? "" : "s"}`,
    ].join(", ");
    this.tooltip = new vscode.MarkdownString(
      [
        `**${record.selectorName} -> ${instance.name}**`,
        "",
        `Env: ${instance.envExists ? "present" : "missing"}`,
        `Targets: ${targetCount}`,
        `Default target: \`${DEFAULT_DEPLOYMENT_TARGET}\``,
      ].join("\n"),
    );
    this.iconPath = new vscode.ThemeIcon(instance.envExists ? "server" : "warning");
  }
}

export class DashboardTargetTreeItem extends vscode.TreeItem {
  constructor(
    readonly record: DashboardRecord,
    readonly target: DeploymentTargetRecord,
    readonly overrideExists: boolean,
    readonly folderOverrideExists: boolean,
  ) {
    super(target.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "grafanaDashboardTarget";
    this.description = [
      target.name === DEFAULT_DEPLOYMENT_TARGET ? "default" : "target",
      overrideExists ? "override" : "no override",
      folderOverrideExists ? "folder override" : "base folder",
    ].join(", ");
    this.tooltip = new vscode.MarkdownString(
      [
        `**${record.selectorName} -> ${target.instanceName}/${target.name}**`,
        "",
        `Defaults: ${target.defaultsExists ? "present" : "missing"}`,
        `Override for this dashboard: ${overrideExists ? "present" : "missing"}`,
        `Folder override for this dashboard: ${folderOverrideExists ? "present" : "missing"}`,
      ].join("\n"),
    );
    this.iconPath = new vscode.ThemeIcon(target.name === DEFAULT_DEPLOYMENT_TARGET ? "target" : "symbol-field");
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
    } catch (error) {
      return [new DashboardPlaceholderItem(`Manifest error: ${String(error)}`)];
    }
  }

  private async dashboardChildren(repository: ProjectRepository, record: DashboardRecord): Promise<vscode.TreeItem[]> {
    const instances = await repository.listInstances();
    if (instances.length === 0) {
      return [
        new DashboardPlaceholderItem("Create an instance", {
          command: "grafanaDashboards.createInstance",
          title: "Create Instance",
        }),
      ];
    }

    return Promise.all(
      instances.map(async (instance) => {
        const targets = await repository.listDeploymentTargets(instance.name);
        return new DashboardInstanceTreeItem(record, instance, targets.length);
      }),
    );
  }

  private async dashboardInstanceChildren(
    repository: ProjectRepository,
    record: DashboardRecord,
    instance: InstanceRecord,
  ): Promise<vscode.TreeItem[]> {
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

    return Promise.all(
      targets.map(async (target) => {
        const overrideFile = await repository.readTargetOverrideFile(instance.name, target.name, record.entry);
        return new DashboardTargetTreeItem(
          record,
          target,
          Boolean(overrideFile && Object.keys(overrideFile.variables ?? {}).length > 0),
          Boolean(overrideFile?.folderPath?.trim()),
        );
      }),
    );
  }
}
