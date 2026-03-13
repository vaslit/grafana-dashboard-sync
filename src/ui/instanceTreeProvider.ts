import * as vscode from "vscode";

import { DEFAULT_DEPLOYMENT_TARGET, ProjectRepository } from "../core/repository";
import { DashboardRecord, DeploymentTargetRecord, InstanceRecord } from "../core/types";

export class InstanceTreeItem extends vscode.TreeItem {
  constructor(
    readonly instance: InstanceRecord,
    readonly targetCount: number,
  ) {
    super(instance.name, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "grafanaInstance";
    this.description = [
      instance.envExists ? "env" : "no env",
      `${targetCount} target${targetCount === 1 ? "" : "s"}`,
    ].join(", ");
    this.tooltip = new vscode.MarkdownString(
      [
        `**${instance.name}**`,
        "",
        `Env: ${instance.envExists ? "present" : "missing"}`,
        `Targets: ${targetCount}`,
      ].join("\n"),
    );
    this.iconPath = new vscode.ThemeIcon(instance.envExists ? "server" : "warning");
  }
}

export class DeploymentTargetTreeItem extends vscode.TreeItem {
  constructor(
    readonly target: DeploymentTargetRecord,
    readonly dashboardCount: number,
  ) {
    super(
      target.name,
      dashboardCount > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    this.contextValue = "grafanaDeploymentTarget";
    this.description = [
      target.name === DEFAULT_DEPLOYMENT_TARGET ? "default" : "target",
      `${dashboardCount} dashboard${dashboardCount === 1 ? "" : "s"}`,
    ].join(", ");
    this.tooltip = new vscode.MarkdownString(
      [
        `**${target.instanceName}/${target.name}**`,
        "",
        `Dashboards: ${dashboardCount}`,
      ].join("\n"),
    );
    this.iconPath = new vscode.ThemeIcon(target.name === DEFAULT_DEPLOYMENT_TARGET ? "target" : "symbol-field");
  }
}

export class InstanceTargetDashboardTreeItem extends vscode.TreeItem {
  constructor(
    readonly target: DeploymentTargetRecord,
    readonly record: DashboardRecord,
  ) {
    super(record.selectorName, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "grafanaInstanceDashboard";
    this.description = record.exists ? record.title ?? record.entry.uid : "Missing local file";
    this.tooltip = new vscode.MarkdownString(
      [
        `**${record.selectorName} -> ${target.instanceName}/${target.name}**`,
        "",
        `UID: \`${record.entry.uid}\``,
        `Path: \`${record.entry.path}\``,
        record.exists ? `Local file: \`${record.absolutePath}\`` : "Local file is missing.",
      ].join("\n"),
    );
    this.iconPath = new vscode.ThemeIcon(record.exists ? "file-code" : "warning");
  }
}

class InstancePlaceholderItem extends vscode.TreeItem {
  constructor(label: string, command?: vscode.Command) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.command = command;
    this.contextValue = "grafanaPlaceholder";
    this.iconPath = new vscode.ThemeIcon("info");
  }
}

export class InstanceTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
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
          new InstancePlaceholderItem("Create an instance", {
            command: "grafanaDashboards.createInstance",
            title: "Create Instance",
          }),
        ];
      }

      return Promise.all(
        instances.map(async (instance) => {
          const targets = await repository.listDeploymentTargets(instance.name);
          return new InstanceTreeItem(instance, targets.length);
        }),
      );
    } catch (error) {
      return [new InstancePlaceholderItem(`Instance error: ${String(error)}`)];
    }
  }

  private async instanceChildren(repository: ProjectRepository, instance: InstanceRecord): Promise<vscode.TreeItem[]> {
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

  private async targetChildren(repository: ProjectRepository, target: DeploymentTargetRecord): Promise<vscode.TreeItem[]> {
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
