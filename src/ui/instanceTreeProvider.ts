import * as vscode from "vscode";

import { DEFAULT_DEPLOYMENT_TARGET, ProjectRepository } from "../core/repository";
import { DashboardRecord, DeploymentTargetRecord, InstanceRecord } from "../core/types";
import { SelectionState } from "./selectionState";

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
    readonly overrideExists: boolean,
    readonly folderOverrideExists: boolean,
  ) {
    super(target.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "grafanaDeploymentTarget";
    this.description = [
      target.name === DEFAULT_DEPLOYMENT_TARGET ? "default" : "target",
      overrideExists ? "override" : "no override",
      folderOverrideExists ? "folder override" : "base folder",
    ].join(", ");
    this.tooltip = new vscode.MarkdownString(
      [
        `**${target.instanceName}/${target.name}**`,
        "",
        `Defaults: ${target.defaultsExists ? "present" : "missing"}`,
        `Override for current dashboard: ${overrideExists ? "present" : "missing"}`,
        `Folder override for current dashboard: ${folderOverrideExists ? "present" : "missing"}`,
      ].join("\n"),
    );
    this.iconPath = new vscode.ThemeIcon(target.name === DEFAULT_DEPLOYMENT_TARGET ? "target" : "symbol-field");
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
    private readonly selectionState: SelectionState,
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

    const selectedDashboard = await this.selectedDashboardRecord();
    return Promise.all(
      targets.map(async (target) => {
        const overrideFile = selectedDashboard
          ? await repository.readTargetOverrideFile(instance.name, target.name, selectedDashboard.entry)
          : undefined;
        return new DeploymentTargetTreeItem(
          target,
          Boolean(overrideFile && Object.keys(overrideFile.variables ?? {}).length > 0),
          Boolean(overrideFile?.folderPath?.trim()),
        );
      }),
    );
  }

  private async selectedDashboardRecord(): Promise<DashboardRecord | undefined> {
    const repository = this.getRepository();
    if (!repository) {
      return undefined;
    }
    if (!this.selectionState.selectedDashboardSelectorName) {
      return undefined;
    }
    return repository.dashboardRecordBySelector(this.selectionState.selectedDashboardSelectorName);
  }
}
