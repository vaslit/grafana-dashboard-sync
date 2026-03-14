import * as vscode from "vscode";

import { DashboardService } from "../core/dashboardService";
import { ProjectRepository } from "../core/repository";
import { DashboardRecord, DeploymentTargetRecord, InstanceRecord } from "../core/types";

type InstanceHealthState =
  | { kind: "ok" }
  | { kind: "no-auth"; detail: string }
  | { kind: "error"; detail: string };

export class DevTargetTreeItem extends vscode.TreeItem {
  constructor(instanceName?: string, targetName?: string) {
    super("Dev Target", vscode.TreeItemCollapsibleState.None);
    this.contextValue = "grafanaDevTargetSelector";
    this.description = instanceName && targetName ? `${instanceName}/${targetName}` : "not selected";
    this.tooltip = new vscode.MarkdownString(
      [
        "**Dev Target**",
        "",
        instanceName && targetName
          ? `Current dev target: \`${instanceName}/${targetName}\``
          : "No dev target selected.",
      ].join("\n"),
    );
    this.iconPath = new vscode.ThemeIcon("server-environment");
    this.command = {
      command: "grafanaDashboards.selectDevTarget",
      title: "Select Dev Target",
    };
  }
}

export class InstanceTreeItem extends vscode.TreeItem {
  constructor(
    readonly instance: InstanceRecord,
    readonly targetCount: number,
    readonly health: InstanceHealthState,
  ) {
    super(instance.name, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "grafanaInstance";
    this.description = [
      instanceHealthLabel(health),
      `${targetCount} target${targetCount === 1 ? "" : "s"}`,
    ].join(", ");
    this.tooltip = new vscode.MarkdownString(
      [
        `**${instance.name}**`,
        "",
        `Env: ${instance.envExists ? "present" : "missing"}`,
        `Status: ${instanceHealthLabel(health)}`,
        ...(health.kind !== "ok" ? [`Detail: ${health.detail}`] : []),
        `Targets: ${targetCount}`,
      ].join("\n"),
    );
    this.iconPath =
      health.kind === "ok"
        ? new vscode.ThemeIcon("server")
        : health.kind === "no-auth"
          ? new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("disabledForeground"))
          : new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
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
      "target",
      `${dashboardCount} dashboard${dashboardCount === 1 ? "" : "s"}`,
    ].join(", ");
    this.tooltip = new vscode.MarkdownString(
      [
        `**${target.instanceName}/${target.name}**`,
        "",
        `Dashboards: ${dashboardCount}`,
      ].join("\n"),
    );
    this.iconPath = new vscode.ThemeIcon("symbol-field");
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
  private readonly instanceHealthCache = new Map<string, Promise<InstanceHealthState>>();

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly getRepository: () => ProjectRepository | undefined,
    private readonly getService: () => DashboardService | undefined,
    private readonly getActiveTarget: () => { instanceName?: string; targetName?: string },
    private readonly getMissingProjectMessage: () => string,
  ) {}

  refresh(): void {
    this.instanceHealthCache.clear();
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
      const devTarget = await repository.getDevTarget();
      if (instances.length === 0) {
        return [
          new DevTargetTreeItem(devTarget?.instanceName, devTarget?.targetName),
          new InstancePlaceholderItem("Create an instance", {
            command: "grafanaDashboards.createInstance",
            title: "Create Instance",
          }),
        ];
      }

      const items = await Promise.all(
        instances.map(async (instance) => {
          const targets = await repository.listDeploymentTargets(instance.name);
          const health = await this.instanceHealth(repository, instance);
          return new InstanceTreeItem(instance, targets.length, health);
        }),
      );
      return [
        new DevTargetTreeItem(devTarget?.instanceName, devTarget?.targetName),
        ...items,
      ];
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

  private async instanceHealth(repository: ProjectRepository, instance: InstanceRecord): Promise<InstanceHealthState> {
    const cached = this.instanceHealthCache.get(instance.name);
    if (cached) {
      return cached;
    }

    const next = this.computeInstanceHealth(repository, instance);
    this.instanceHealthCache.set(instance.name, next);
    return next;
  }

  private async computeInstanceHealth(repository: ProjectRepository, instance: InstanceRecord): Promise<InstanceHealthState> {
    const details = await repository.loadInstanceDetails(instance.name);
    const hasAnyCredential = Boolean(details?.tokenConfigured || details?.passwordConfigured);
    if (!hasAnyCredential) {
      return {
        kind: "no-auth",
        detail: "Token or password is not configured.",
      };
    }

    try {
      await repository.loadConnectionConfig(instance.name);
    } catch (error) {
      return {
        kind: "error",
        detail: String(error),
      };
    }

    const service = this.getService();
    if (!service) {
      return {
        kind: "error",
        detail: "Grafana service is not available.",
      };
    }

    try {
      await service.listRemoteDatasources(instance.name);
      return { kind: "ok" };
    } catch (error) {
      return {
        kind: "error",
        detail: String(error),
      };
    }
  }
}

function instanceHealthLabel(health: InstanceHealthState): string {
  switch (health.kind) {
    case "ok":
      return "connected";
    case "no-auth":
      return "no auth";
    case "error":
      return "unavailable";
  }
}
