import * as vscode from "vscode";

export class SelectionState {
  private readonly changeEmitter = new vscode.EventEmitter<void>();

  private dashboardSelectorName?: string;
  private instanceName?: string;
  private targetName?: string;
  private backupName?: string;
  private detailsMode?: "dashboard" | "instance";
  private activeDevInstanceName?: string;
  private activeDevTargetName?: string;

  readonly onDidChange = this.changeEmitter.event;

  get selectedDashboardSelectorName(): string | undefined {
    return this.dashboardSelectorName;
  }

  get selectedInstanceName(): string | undefined {
    return this.instanceName;
  }

  get selectedTargetName(): string | undefined {
    return this.targetName;
  }

  get selectedBackupName(): string | undefined {
    return this.backupName;
  }

  get selectedDetailsMode(): "dashboard" | "instance" | undefined {
    return this.detailsMode;
  }

  get activeInstanceName(): string | undefined {
    return this.activeDevInstanceName;
  }

  get activeTargetName(): string | undefined {
    return this.activeDevTargetName;
  }

  setDashboard(selectorName: string | undefined): void {
    if (this.dashboardSelectorName === selectorName) {
      return;
    }
    this.dashboardSelectorName = selectorName;
    this.changeEmitter.fire();
  }

  setInstance(instanceName: string | undefined): void {
    if (this.instanceName === instanceName) {
      return;
    }
    this.instanceName = instanceName;
    this.targetName = undefined;
    this.changeEmitter.fire();
  }

  setTarget(targetName: string | undefined): void {
    if (this.targetName === targetName) {
      return;
    }
    this.targetName = targetName;
    this.changeEmitter.fire();
  }

  setBackup(backupName: string | undefined): void {
    if (this.backupName === backupName) {
      return;
    }
    this.backupName = backupName;
    this.changeEmitter.fire();
  }

  setDetailsMode(mode: "dashboard" | "instance" | undefined): void {
    if (this.detailsMode === mode) {
      return;
    }
    this.detailsMode = mode;
    this.changeEmitter.fire();
  }

  setActiveTarget(instanceName: string | undefined, targetName: string | undefined): void {
    if (this.activeDevInstanceName === instanceName && this.activeDevTargetName === targetName) {
      return;
    }
    this.activeDevInstanceName = instanceName;
    this.activeDevTargetName = targetName;
    this.changeEmitter.fire();
  }
}
