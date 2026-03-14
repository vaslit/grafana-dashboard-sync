import * as vscode from "vscode";

export class InstanceSecretStorage {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getInstanceToken(projectRootPath: string, instanceName: string): Promise<string | undefined> {
    return this.secrets.get(this.instanceTokenKey(projectRootPath, instanceName));
  }

  async setInstanceToken(projectRootPath: string, instanceName: string, token: string): Promise<void> {
    await this.secrets.store(this.instanceTokenKey(projectRootPath, instanceName), token);
  }

  async deleteInstanceToken(projectRootPath: string, instanceName: string): Promise<void> {
    await this.secrets.delete(this.instanceTokenKey(projectRootPath, instanceName));
  }

  async getInstancePassword(projectRootPath: string, instanceName: string): Promise<string | undefined> {
    return this.secrets.get(this.instancePasswordKey(projectRootPath, instanceName));
  }

  async setInstancePassword(projectRootPath: string, instanceName: string, password: string): Promise<void> {
    await this.secrets.store(this.instancePasswordKey(projectRootPath, instanceName), password);
  }

  async deleteInstancePassword(projectRootPath: string, instanceName: string): Promise<void> {
    await this.secrets.delete(this.instancePasswordKey(projectRootPath, instanceName));
  }

  private instanceTokenKey(projectRootPath: string, instanceName: string): string {
    return `grafanaDashboards.instanceToken:${projectRootPath}:${instanceName}`;
  }

  private instancePasswordKey(projectRootPath: string, instanceName: string): string {
    return `grafanaDashboards.instancePassword:${projectRootPath}:${instanceName}`;
  }
}
