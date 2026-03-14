import * as vscode from "vscode";

export class SelectionState {
  private readonly changeEmitter = new vscode.EventEmitter<void>();

  private dashboardSelectorName?: string;
  private instanceName?: string;
  private targetName?: string;
  private backupName?: string;
  private detailsMode?: "dashboard" | "instance";

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
}
