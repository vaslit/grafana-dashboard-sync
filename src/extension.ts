import path from "node:path";

import * as vscode from "vscode";

import { initializeProjectDirectory } from "./core/projectBootstrap";
import { DashboardService } from "./core/dashboardService";
import { selectorNameForEntry } from "./core/manifest";
import { PROJECT_CONFIG_FILE, discoverProjectLayout } from "./core/projectLocator";
import { DEFAULT_DEPLOYMENT_TARGET, ProjectRepository } from "./core/repository";
import {
  BackupRestoreSelection,
  BackupScope,
  BackupRecord,
  DashboardManifestEntry,
  DashboardRecord,
  DeploymentTargetRecord,
  GrafanaDatasourceSummary,
  GrafanaDashboardSummary,
  InstanceRecord,
  LogSink,
} from "./core/types";
import { InstanceSecretStorage } from "./instanceSecretStorage";
import {
  BackupDashboardTreeItem,
  BackupInstanceTreeItem,
  BackupTargetTreeItem,
  BackupTreeItem,
  BackupTreeProvider,
} from "./ui/backupTreeProvider";
import {
  DashboardRevisionTreeItem,
  DashboardTreeItem,
  DashboardTreeProvider,
} from "./ui/dashboardTreeProvider";
import { DetailsViewProvider } from "./ui/detailsViewProvider";
import {
  DevTargetTreeItem,
  DeploymentTargetTreeItem,
  InstanceTargetAlertTreeItem,
  InstanceTargetAlertsGroupTreeItem,
  InstanceTargetDashboardsGroupTreeItem,
  InstanceTargetDashboardTreeItem,
  InstanceTreeItem,
  InstanceTreeProvider,
} from "./ui/instanceTreeProvider";
import { SelectionState } from "./ui/selectionState";

function workspaceRootPath(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error("Open a VS Code workspace folder first.");
  }
  return folder.uri.fsPath;
}

function inputValidator(value: string, fieldName: string): string | undefined {
  return value.trim() ? undefined : `${fieldName} must not be empty.`;
}

function toRemoteDashboardPick(dashboard: GrafanaDashboardSummary): vscode.QuickPickItem & {
  dashboard: GrafanaDashboardSummary;
} {
  return {
    label: dashboard.title,
    description: dashboard.folderTitle || "Root",
    detail: `UID: ${dashboard.uid}${dashboard.url ? ` | ${dashboard.url}` : ""}`,
    dashboard,
  };
}

interface BackupTargetSpec {
  instanceName: string;
  targetName: string;
  entries: DashboardManifestEntry[];
}

function datasourceSelectionsFromFormValues(
  values: Record<string, string>,
  prefix: "dashboard",
): Array<{
  currentSourceName: string;
  nextSourceName: string;
  targetUid?: string;
  targetName?: string;
}> {
  const indexes = new Set(
    Object.keys(values)
      .filter((key) => key.startsWith(`${prefix}_current_source_name__`))
      .map((key) => key.slice(`${prefix}_current_source_name__`.length)),
  );

  const selections: Array<{
    currentSourceName: string;
    nextSourceName: string;
    targetUid?: string;
    targetName?: string;
  }> = [];
  for (const index of indexes) {
    const currentSourceName = values[`${prefix}_current_source_name__${index}`]?.trim();
    const nextSourceName = values[`${prefix}_source_name__${index}`]?.trim();
    const targetUid = values[`${prefix}_target_uid__${index}`]?.trim();
    const targetName = values[`${prefix}_target_name__${index}`]?.trim();

    if (!currentSourceName || !nextSourceName) {
      continue;
    }

    selections.push({
      currentSourceName,
      nextSourceName,
      targetUid: targetUid || undefined,
      targetName: targetName || undefined,
    });
  }

  return selections;
}

function alertSettingsFromFormValues(values: Record<string, string>): {
  isPaused: boolean;
  datasourceUid?: string;
  datasourceName?: string;
} {
  const datasourceUid = values.alert_target_uid?.trim();
  const datasourceName = values.alert_target_name?.trim();
  return {
    isPaused: values.isPaused === "on",
    datasourceUid: datasourceUid || undefined,
    datasourceName: datasourceName || undefined,
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const workspaceRoot = workspaceRootPath();
  const output = vscode.window.createOutputChannel("Grafana Dashboards");
  const secretStorage = new InstanceSecretStorage(context.secrets);
  const log: LogSink = {
    info(message) {
      output.appendLine(message);
    },
    error(message) {
      output.appendLine(`ERROR: ${message}`);
    },
  };

  const selectionState = new SelectionState();
  let repository: ProjectRepository | undefined;
  let service: DashboardService | undefined;

  const missingProjectMessage = (): string =>
    `No Grafana dashboard project found. Run "Initialize Project" or add ${PROJECT_CONFIG_FILE} inside the folder that should contain dashboards/, backups/, and renders/.`;

  const requireRepository = (): ProjectRepository => {
    if (!repository) {
      throw new Error(missingProjectMessage());
    }
    return repository;
  };

  const requireService = (): DashboardService => {
    if (!service) {
      throw new Error(missingProjectMessage());
    }
    return service;
  };

  const activeTargetStorageKey = (projectRootPath: string): string =>
    `grafanaDashboards.activeTarget:${projectRootPath}`;

  const currentActiveTarget = (): { instanceName?: string; targetName?: string } => ({
    instanceName: selectionState.activeInstanceName,
    targetName: selectionState.activeTargetName,
  });

  async function updateDashboardHeaderDescription(): Promise<void> {
    const activeTarget = currentActiveTarget();
    const devTarget = repository ? await repository.getDevTarget().catch(() => undefined) : undefined;
    const devLabel =
      devTarget?.instanceName && devTarget?.targetName
        ? `${devTarget.instanceName}/${devTarget.targetName}`
        : "none";
    const activeLabel =
      activeTarget.instanceName && activeTarget.targetName
        ? `${activeTarget.instanceName}/${activeTarget.targetName}`
        : "none";
    dashboardTreeView.description = `current dev target: ${devLabel} | active target: ${activeLabel}`;
  };

  const syncActiveInstance = async (): Promise<void> => {
    if (!repository) {
      selectionState.setActiveTarget(undefined, undefined);
      return;
    }

    const currentInstanceName = selectionState.activeInstanceName;
    const currentTargetName = selectionState.activeTargetName;
    if (currentInstanceName && currentTargetName) {
      const currentInstance = await repository.instanceByName(currentInstanceName);
      const currentTarget = currentInstance
        ? await repository.deploymentTargetByName(currentInstanceName, currentTargetName)
        : undefined;
      if (currentInstance && currentTarget) {
        return;
      }
    }

    const storedTargetKey = context.workspaceState.get<string | undefined>(
      activeTargetStorageKey(repository.projectRootPath),
    );
    if (storedTargetKey) {
      const [storedInstanceName, storedTargetName] = storedTargetKey.split("/", 2);
      const storedInstance = storedInstanceName ? await repository.instanceByName(storedInstanceName) : undefined;
      const storedTarget =
        storedInstance && storedTargetName
          ? await repository.deploymentTargetByName(storedInstance.name, storedTargetName)
          : undefined;
      if (storedInstance && storedTarget) {
        selectionState.setActiveTarget(storedInstance.name, storedTarget.name);
        return;
      }
    }

    const instances = await repository.listInstances();
    if (instances.length === 1) {
      const targets = await repository.listDeploymentTargets(instances[0].name);
      selectionState.setActiveTarget(instances[0].name, targets[0]?.name);
    } else {
      selectionState.setActiveTarget(undefined, undefined);
    }
  };

  const resolveProject = async (): Promise<void> => {
    const layout = await discoverProjectLayout(workspaceRoot);
    repository = layout
      ? new ProjectRepository(layout, {
          resolveToken: async (instanceName?: string) =>
            instanceName ? secretStorage.getInstanceToken(layout.projectRootPath, instanceName) : undefined,
          resolvePassword: async (instanceName?: string) =>
            instanceName ? secretStorage.getInstancePassword(layout.projectRootPath, instanceName) : undefined,
        })
      : undefined;
    if (repository) {
      await repository.migrateWorkspaceConfig();
    }
    service = repository ? new DashboardService(repository, log) : undefined;
    selectionState.setDashboard(undefined);
    selectionState.setAlert(undefined);
    selectionState.setBackup(undefined);

    if (!layout) {
      log.info(missingProjectMessage());
      await syncActiveInstance();
      return;
    }

    const relativeProjectPath = path.relative(workspaceRoot, layout.projectRootPath) || ".";
    log.info(`Using Grafana project: ${relativeProjectPath}`);
    if (layout.selectionNote) {
      log.info(layout.selectionNote);
    }
    await syncActiveInstance();
  };

  await resolveProject();

  const dashboardsProvider = new DashboardTreeProvider(() => repository, () => service, currentActiveTarget, missingProjectMessage);
  const instancesProvider = new InstanceTreeProvider(() => repository, () => service, currentActiveTarget, missingProjectMessage);
  const backupsProvider = new BackupTreeProvider(() => repository, missingProjectMessage);

  const dashboardTreeView = vscode.window.createTreeView("grafanaDashboards.dashboards", {
    treeDataProvider: dashboardsProvider,
  });
  const instanceTreeView = vscode.window.createTreeView("grafanaDashboards.instances", {
    treeDataProvider: instancesProvider,
  });
  const backupTreeView = vscode.window.createTreeView("grafanaDashboards.backups", {
    treeDataProvider: backupsProvider,
  });

  let detailsProvider: DetailsViewProvider;

  const refreshAll = async (): Promise<void> => {
    await syncActiveInstance();
    dashboardsProvider.clearTargetRevisionCache();
    dashboardsProvider.refresh();
    instancesProvider.refresh();
    backupsProvider.refresh();
    await updateDashboardHeaderDescription();
    await detailsProvider.refresh();
  };

  const actionHandlers = {
    initializeProject: async () => {
      if (repository) {
        void vscode.window.showInformationMessage(
          `Grafana project already initialized at ${path.relative(workspaceRoot, repository.projectRootPath) || "."}.`,
        );
        return;
      }

      const relativeProjectPath = await vscode.window.showInputBox({
        title: "Initialize Grafana project",
        prompt: "Folder inside the current workspace where dashboards, instances and backups will live",
        value: "grafana",
        validateInput: (value) => {
          const trimmed = value.trim().replace(/\\/g, "/");
          if (!trimmed) {
            return "Project folder must not be empty.";
          }
          if (
            trimmed === "." ||
            trimmed.startsWith("/") ||
            trimmed.startsWith("../") ||
            trimmed.includes("/../")
          ) {
            return "Use a relative folder path inside the current workspace.";
          }
          return undefined;
        },
      });
      if (!relativeProjectPath) {
        return;
      }

      const initialInstanceName = await vscode.window.showInputBox({
        title: "Initial instance name",
        prompt: "First instance name to add to workspace config",
        value: "example",
        validateInput: (value) => inputValidator(value, "Instance name"),
      });
      if (!initialInstanceName) {
        return;
      }

      const nextRepository = await initializeProjectDirectory(workspaceRoot, relativeProjectPath, initialInstanceName);
      repository = new ProjectRepository(
        {
          workspaceRootPath: nextRepository.workspaceRootPath,
          projectRootPath: nextRepository.projectRootPath,
          workspaceConfigPath: nextRepository.workspaceConfigPath,
          configPath: nextRepository.configPath,
          manifestPath: nextRepository.manifestPath,
          manifestExamplePath: nextRepository.manifestExamplePath,
          legacyDatasourceCatalogPath: nextRepository.datasourceCatalogPath,
          dashboardsDir: nextRepository.dashboardsDir,
          instancesDir: nextRepository.instancesDir,
          backupsDir: nextRepository.backupsDir,
          rendersDir: nextRepository.rendersDir,
          rootEnvPath: nextRepository.rootEnvPath,
          maxBackups: nextRepository.maxBackups,
        },
        {
          resolveToken: async (instanceName?: string) =>
            instanceName ? secretStorage.getInstanceToken(nextRepository.projectRootPath, instanceName) : undefined,
          resolvePassword: async (instanceName?: string) =>
            instanceName ? secretStorage.getInstancePassword(nextRepository.projectRootPath, instanceName) : undefined,
        },
      );
      service = new DashboardService(repository, log);
      selectionState.setDashboard(undefined);
      selectionState.setAlert(undefined);
      selectionState.setInstance(initialInstanceName.trim());
      selectionState.setTarget(DEFAULT_DEPLOYMENT_TARGET);
      await refreshAll();
      void vscode.window.showInformationMessage(
        `Initialized Grafana project in ${path.relative(workspaceRoot, nextRepository.projectRootPath) || "."}.`,
      );
    },
    renderSelected: async (selectorName?: string) => {
      const record = await requireDashboardRecord(selectorName ?? selectionState.selectedDashboardSelectorName);
      await renderDashboardAcrossScope(record);
    },
    renderTarget: async (instanceName?: string, targetName?: string) => {
      const repository = requireRepository();
      const service = requireService();
      const target = await pickRequiredDeploymentTarget(instanceName, targetName);
      const entries = (await repository.listDashboardRecords()).map((record) => record.entry);
      if (entries.length === 0) {
        throw new Error("No dashboards available in the manifest.");
      }
      const manifest = await service.renderDashboards(entries, target.instanceName, target.name, "target");
      await refreshAll();
      void vscode.window.showInformationMessage(
        `Rendered ${manifest.dashboards.length} dashboard(s) into ${repository.renderRootPath(target.instanceName, target.name)}.`,
      );
    },
    renderInstance: async (instanceName?: string) => {
      const repository = requireRepository();
      const service = requireService();
      const instance = await requireInstance(instanceName);
      const entries = (await repository.listDashboardRecords()).map((record) => record.entry);
      if (entries.length === 0) {
        throw new Error("No dashboards available in the manifest.");
      }
      const targets = await repository.listDeploymentTargets(instance.name);
      if (targets.length === 0) {
        throw new Error(`No deployment targets found for ${instance.name}.`);
      }
      for (const target of targets) {
        await service.renderDashboards(entries, instance.name, target.name, "target");
      }
      await refreshAll();
      void vscode.window.showInformationMessage(
        `Rendered ${entries.length} dashboard(s) for ${targets.length} target(s) in instance ${instance.name}.`,
      );
    },
    renderAllInstances: async () => {
      const repository = requireRepository();
      const service = requireService();
      const entries = (await repository.listDashboardRecords()).map((record) => record.entry);
      if (entries.length === 0) {
        throw new Error("No dashboards available in the manifest.");
      }
      const instances = await repository.listInstances();
      let renderedTargets = 0;
      for (const instance of instances) {
        const targets = await repository.listDeploymentTargets(instance.name);
        for (const target of targets) {
          await service.renderDashboards(entries, instance.name, target.name, "target");
          renderedTargets += 1;
        }
      }
      await refreshAll();
      void vscode.window.showInformationMessage(
        `Rendered ${entries.length} dashboard(s) for ${renderedTargets} target(s) across all instances.`,
      );
    },
    exportAlerts: async () => {
      await exportAlertsCommand(undefined, selectionState.selectedAlertUid ? [selectionState.selectedAlertUid] : undefined);
    },
    copySelectedAlertToTarget: async () => {
      await copyAlertToTargetCommand();
    },
    uploadSelectedAlert: async () => {
      await uploadAlertCommand();
    },
    refreshSelectedAlertStatus: async () => {
      await refreshAlertStatusCommand();
    },
    openRenderFolder: async (instanceName?: string, targetName?: string) => {
      const repository = requireRepository();
      const target = await pickRequiredDeploymentTarget(instanceName, targetName);
      await vscode.env.openExternal(vscode.Uri.file(repository.renderRootPath(target.instanceName, target.name)));
    },
    openDashboardInBrowser: async (selectorName?: string, instanceName?: string, targetName?: string) => {
      const service = requireService();
      const record = await requireDashboardRecord(selectorName ?? selectionState.selectedDashboardSelectorName);
      const target = await pickRequiredDeploymentTarget(instanceName, targetName);
      const url = await service.dashboardBrowserUrl(record.entry, target.instanceName, target.name);
      selectionState.setDashboard(record.selectorName);
      selectionState.setInstance(target.instanceName);
      selectionState.setTarget(target.name);
      await vscode.env.openExternal(vscode.Uri.parse(url));
    },
    createManifestFromExample: async () => {
      const repository = requireRepository();
      await repository.createManifestFromExample();
      await refreshAll();
      void vscode.window.showInformationMessage("Imported dashboards list from example into workspace config.");
    },
    addDashboard: async () => {
      const repository = requireRepository();
      const service = requireService();
      const manifest = await repository.loadManifest();
      const existingUids = new Set(manifest.dashboards.map((entry) => entry.uid));
      const instance = await pickInstanceIfNeeded();
      const dashboards = await service.listRemoteDashboards(instance?.name);
      const availableDashboards = dashboards.filter((dashboard) => !existingUids.has(dashboard.uid));

      if (availableDashboards.length === 0) {
        void vscode.window.showInformationMessage("All dashboards from the selected Grafana are already added.");
        return;
      }

      const picks = await vscode.window.showQuickPick(
        availableDashboards.map((dashboard) => toRemoteDashboardPick(dashboard)),
        {
          canPickMany: true,
          title: "Add dashboards from Grafana",
          placeHolder: "Select dashboards to add to the project",
        },
      );

      if (!picks || picks.length === 0) {
        return;
      }

      const selectedDashboards = picks.map((pick) => pick.dashboard);
      const entries = await service.suggestManifestEntriesForRemoteDashboards(selectedDashboards);
      await repository.addManifestEntries(entries);

      const firstSelectorName = selectorNameForEntry(entries[0]);
      selectionState.setDashboard(firstSelectorName);
      await refreshAll();

      const nextAction = await vscode.window.showQuickPick(
        [
          {
            label: "Pull from dev target",
            description: "Fetch the selected dashboard JSON files from the configured dev target",
            action: "pull" as const,
          },
          {
            label: "Open later",
            description: "Keep only the project entries for now",
            action: "skip" as const,
          },
        ],
        {
          title: `${entries.length} dashboard(s) added`,
          placeHolder: "Choose what to do next",
        },
      );

      if (nextAction?.action === "pull") {
        const devTarget = await requireDevTarget();
        const summary = await service.pullDashboards(entries, devTarget.instanceName, devTarget.name);
        await refreshAll();
        void vscode.window.showInformationMessage(
          `Dashboards pulled from dev target ${devTarget.instanceName}/${devTarget.name}: ${summary.updatedCount} updated, ${summary.skippedCount} unchanged.`,
        );
        return;
      }

      void vscode.window.showInformationMessage(`${entries.length} dashboard(s) added to the project.`);
    },
    createInstance: async (instanceName: string) => {
      const repository = requireRepository();
      const service = requireService();
      const rawValue = instanceName.trim()
        ? instanceName
        : await vscode.window.showInputBox({
            title: "Create instance",
            prompt: "Instance name to add to workspace config",
            validateInput: (value) => inputValidator(value, "Instance name"),
          });
      if (!rawValue) {
        return;
      }

      const instance = await repository.createInstance(rawValue);
      await service.ensureDatasourceCatalogInstance(instance.name);
      selectionState.setInstance(instance.name);
      selectionState.setTarget(DEFAULT_DEPLOYMENT_TARGET);
      await refreshAll();
    },
    createDeploymentTarget: async (instanceName: string, targetName: string) => {
      const repository = requireRepository();
      const service = requireService();
      const instance = await requireInstance(instanceName || selectionState.selectedInstanceName);
      const existingTargets = await repository.listDeploymentTargets(instance.name);
      const rawValue = targetName.trim()
        ? targetName
        : await vscode.window.showInputBox({
            title: `Create deployment target for ${instance.name}`,
            prompt: "Deployment target name for this instance",
            value: existingTargets.length === 0 ? DEFAULT_DEPLOYMENT_TARGET : "",
            validateInput: (value) => inputValidator(value, "Deployment target name"),
          });
      if (!rawValue) {
        return;
      }

      const target = await service.createDeploymentTarget(instance.name, rawValue);
      selectionState.setInstance(instance.name);
      selectionState.setTarget(target.name);
      await refreshAll();
    },
    removeDeploymentTarget: async () => {
      const repository = requireRepository();
      const target = await requireDeploymentTarget(selectionState.selectedInstanceName, selectionState.selectedTargetName);
      const confirmed = await vscode.window.showWarningMessage(
        `Remove deployment target ${target.instanceName}/${target.name}?`,
        { modal: true },
        "Remove",
      );
      if (confirmed !== "Remove") {
        return;
      }

      await repository.removeDeploymentTarget(target.instanceName, target.name);
      const remainingTargets = await repository.listDeploymentTargets(target.instanceName);
      selectionState.setTarget(remainingTargets[0]?.name);
      await refreshAll();
      void vscode.window.showInformationMessage(`Removed deployment target ${target.instanceName}/${target.name}.`);
    },
    renameDeploymentTarget: async () => {
      const repository = requireRepository();
      const target = await requireDeploymentTarget(selectionState.selectedInstanceName, selectionState.selectedTargetName);
      const nextName = await vscode.window.showInputBox({
        title: `Rename deployment target ${target.instanceName}/${target.name}`,
        prompt: "New deployment target name",
        value: target.name,
        validateInput: (value) => inputValidator(value, "Deployment target name"),
      });
      if (!nextName) {
        return;
      }

      const renamed = await repository.renameDeploymentTarget(target.instanceName, target.name, nextName);
      selectionState.setInstance(renamed.instanceName);
      selectionState.setTarget(renamed.name);
      selectionState.setActiveTarget(renamed.instanceName, renamed.name);
      await refreshAll();
      void vscode.window.showInformationMessage(`Renamed deployment target to ${renamed.instanceName}/${renamed.name}.`);
    },
    removeInstance: async () => {
      const repository = requireRepository();
      const instance = await requireInstance(selectionState.selectedInstanceName);
      const confirmed = await vscode.window.showWarningMessage(
        `Remove instance ${instance.name}?`,
        { modal: true },
        "Remove",
      );
      if (confirmed !== "Remove") {
        return;
      }

      await secretStorage.deleteInstanceToken(repository.projectRootPath, instance.name);
      await secretStorage.deleteInstancePassword(repository.projectRootPath, instance.name);
      await repository.removeInstance(instance.name);
      selectionState.setInstance(undefined);
      selectionState.setTarget(undefined);
      await refreshAll();
      void vscode.window.showInformationMessage(`Removed instance ${instance.name}.`);
    },
    saveManifest: async (currentSelector: string, values: { name?: string; uid: string; path: string }) => {
      const repository = requireRepository();
      await repository.updateManifestEntry(currentSelector, {
        name: values.name?.trim() || undefined,
        uid: values.uid.trim(),
        path: values.path.trim(),
      });
      selectionState.setDashboard(values.name?.trim() || currentSelector);
      await refreshAll();
      void vscode.window.showInformationMessage("Manifest entry saved.");
    },
    saveInstanceEnv: async (instanceName: string, values: Record<string, string>) => {
      const repository = requireRepository();
      const service = requireService();
      await repository.saveInstanceEnvValues(instanceName, values);
      await service.autoMatchDatasourceCatalogForInstance(instanceName).catch(() => {});
      await refreshAll();
      void vscode.window.showInformationMessage(`Saved env for ${instanceName}.`);
    },
    saveDashboardDatasourceMappings: async (
      instanceName: string,
      targetName: string,
      selectorName: string,
      values: Record<string, string>,
    ) => {
      const service = requireService();
      await service.saveDatasourceSelections(
        instanceName,
        targetName,
        selectorName,
        datasourceSelectionsFromFormValues(values, "dashboard"),
      );
      await refreshAll();
      void vscode.window.showInformationMessage(
        `Saved datasources for ${selectorName} on ${instanceName}.`,
      );
    },
    saveAlertSettings: async (
      instanceName: string,
      targetName: string,
      uid: string,
      values: Record<string, string>,
    ) => {
      const service = requireService();
      const alertPath = await service.saveAlertSettings(
        instanceName,
        targetName,
        uid,
        alertSettingsFromFormValues(values),
      );
      selectionState.setDetailsMode("alert");
      selectionState.setInstance(instanceName);
      selectionState.setTarget(targetName);
      selectionState.setActiveTarget(instanceName, targetName);
      selectionState.setAlert(uid);
      await refreshAll();
      void vscode.window.showInformationMessage(`Saved alert settings: ${alertPath}`);
    },
    savePlacement: async (
      instanceName: string,
      targetName: string,
      selectorName: string,
      values: Record<string, string>,
    ) => {
      const service = requireService();
      const record = await requireDashboardRecord(selectorName);
      const folderPath = values.folderPathEnabled ? values.folderPath : undefined;
      const placementPath = await service.savePlacement(instanceName, targetName, record.entry, folderPath);
      await refreshAll();
      void vscode.window.showInformationMessage(`Saved placement file: ${placementPath}`);
    },
    setInstanceToken: async () => {
      const repository = requireRepository();
      const instance = await requireInstance(selectionState.selectedInstanceName);
      const token = await vscode.window.showInputBox({
        title: `Set token for ${instance.name}`,
        prompt: "Stored locally in VS Code Secret Storage for this project and instance",
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => inputValidator(value, "Token"),
      });
      if (!token) {
        return;
      }

      await secretStorage.setInstanceToken(repository.projectRootPath, instance.name, token.trim());
      await requireService().autoMatchDatasourceCatalogForInstance(instance.name).catch(() => {});
      await refreshAll();
      void vscode.window.showInformationMessage(`Stored token for ${instance.name} in VS Code Secret Storage.`);
    },
    clearInstanceToken: async () => {
      const repository = requireRepository();
      const instance = await requireInstance(selectionState.selectedInstanceName);
      const confirmed = await vscode.window.showWarningMessage(
        `Clear stored token for ${instance.name}?`,
        { modal: true },
        "Clear",
      );
      if (confirmed !== "Clear") {
        return;
      }

      await secretStorage.deleteInstanceToken(repository.projectRootPath, instance.name);
      await refreshAll();
      void vscode.window.showInformationMessage(`Cleared stored token for ${instance.name}.`);
    },
    setInstancePassword: async () => {
      const repository = requireRepository();
      const instance = await requireInstance(selectionState.selectedInstanceName);
      const password = await vscode.window.showInputBox({
        title: `Set password for ${instance.name}`,
        prompt: "Stored locally in VS Code Secret Storage for this project and instance",
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => inputValidator(value, "Password"),
      });
      if (!password) {
        return;
      }

      await secretStorage.setInstancePassword(repository.projectRootPath, instance.name, password.trim());
      await requireService().autoMatchDatasourceCatalogForInstance(instance.name).catch(() => {});
      await refreshAll();
      void vscode.window.showInformationMessage(`Stored password for ${instance.name} in VS Code Secret Storage.`);
    },
    clearInstancePassword: async () => {
      const repository = requireRepository();
      const instance = await requireInstance(selectionState.selectedInstanceName);
      const confirmed = await vscode.window.showWarningMessage(
        `Clear stored password for ${instance.name}?`,
        { modal: true },
        "Clear",
      );
      if (confirmed !== "Clear") {
        return;
      }

      await secretStorage.deleteInstancePassword(repository.projectRootPath, instance.name);
      await refreshAll();
      void vscode.window.showInformationMessage(`Cleared stored password for ${instance.name}.`);
    },
    saveOverride: async (
      instanceName: string,
      targetName: string,
      selectorName: string,
      values: Record<string, string>,
    ) => {
      const service = requireService();
      const record = await requireDashboardRecord(selectorName);
      const overridePath = await service.saveOverrideFromForm(instanceName, targetName, record.entry, values);
      await refreshAll();
      void vscode.window.showInformationMessage(`Saved override file: ${overridePath}`);
    },
    createRevision: async (selectorName: string) => {
      const service = requireService();
      const record = await requireDashboardRecord(selectorName);
      const revision = await service.createRevisionFromWorkingCopy(record.entry);
      await refreshAll();
      void vscode.window.showInformationMessage(`Created revision ${revision.id} from working copy.`);
    },
    setTargetRevision: async (selectorName: string, revisionId: string, instanceName: string, targetName: string) => {
      const service = requireService();
      const record = await requireDashboardRecord(selectorName);
      await service.setTargetRevision(record.entry, revisionId, instanceName, targetName);
      await refreshAll();
      void vscode.window.showInformationMessage(`Target revision set to ${revisionId} for ${instanceName}/${targetName}.`);
    },
    deleteRevision: async (selectorName: string, revisionId: string) => {
      const service = requireService();
      const record = await requireDashboardRecord(selectorName);
      await service.deleteRevision(record.entry, revisionId);
      await refreshAll();
      void vscode.window.showInformationMessage(`Deleted revision ${revisionId} for ${selectorName}.`);
    },
    checkoutRevision: async (selectorName: string, revisionId: string) => {
      const service = requireService();
      const record = await requireDashboardRecord(selectorName);
      const revision = await service.checkoutRevision(record.entry, revisionId);
      selectionState.setDashboard(selectorName);
      await refreshAll();
      void vscode.window.showInformationMessage(`Checked out revision ${revision.id}.`);
    },
    deployRevision: async (selectorName: string, revisionId: string, instanceName: string, targetName: string) => {
      const service = requireService();
      const record = await requireDashboardRecord(selectorName);
      const summary = await service.deployRevision(record.entry, revisionId, instanceName, targetName);
      await refreshAll();
      void vscode.window.showInformationMessage(
        `Revision deploy complete: ${summary.dashboardResults.length} dashboard(s) deployed to ${instanceName}/${targetName}.`,
      );
    },
    deployLatestRevision: async (selectorName: string, instanceName: string, targetName: string) => {
      const service = requireService();
      const record = await requireDashboardRecord(selectorName);
      const revisions = await service.listDashboardRevisions(record.entry);
      const latest = revisions[0];
      if (!latest) {
        throw new Error("No revisions available.");
      }
      const summary = await service.deployRevision(record.entry, latest.record.id, instanceName, targetName);
      await refreshAll();
      void vscode.window.showInformationMessage(
        `Latest revision ${latest.record.id} deployed to ${instanceName}/${targetName}.`,
      );
    },
    pullTarget: async (selectorName: string, instanceName: string, targetName: string) => {
      const service = requireService();
      const record = await requireDashboardRecord(selectorName);
      selectionState.setDashboard(selectorName);
      selectionState.setActiveTarget(instanceName, targetName);
      const summary = await service.pullDashboards([record.entry], instanceName, targetName);
      await refreshAll();
      void vscode.window.showInformationMessage(
        `Pull complete: ${summary.updatedCount} updated, ${summary.skippedCount} unchanged from ${instanceName}/${targetName}.`,
      );
    },
    setActiveTarget: async (instanceName: string, targetName: string) => {
      selectionState.setActiveTarget(instanceName, targetName);
      await refreshAll();
    },
    selectDevTarget: async () => {
      const repository = requireRepository();
      const targets = await repository.listAllDeploymentTargets();
      if (targets.length === 0) {
        throw new Error("No deployment targets available.");
      }
      const selection = await vscode.window.showQuickPick(
        targets.map((target) => ({
          label: `${target.instanceName}/${target.name}`,
          target,
        })),
        {
          title: "Select dev target",
          placeHolder: "Pull is allowed only from this target",
        },
      );
      if (!selection) {
        return;
      }
      await repository.setDevTarget(selection.target.instanceName, selection.target.name);
      await refreshAll();
    },
    pullSelected: async () => {
      await pullDashboards();
    },
    pullAllDashboards: async (instanceName?: string, targetName?: string) => {
      const repository = requireRepository();
      const service = requireService();
      const entries = (await repository.listDashboardRecords()).map((record) => record.entry);
      if (entries.length === 0) {
        throw new Error("No dashboards available in the manifest.");
      }

      const target = await requireDevTarget();
      if (instanceName && instanceName !== target.instanceName) {
        throw new Error(`Pull uses dev target ${target.instanceName}/${target.name}, not instance ${instanceName}.`);
      }
      if (targetName && targetName !== target.name) {
        throw new Error(`Pull uses dev target ${target.instanceName}/${target.name}, not target ${instanceName}/${targetName}.`);
      }
      const summary = await service.pullDashboards(entries, target.instanceName, target.name);
      await refreshAll();
      void vscode.window.showInformationMessage(
        `Pull complete from dev target ${target.instanceName}/${target.name}: ${summary.updatedCount} updated, ${summary.skippedCount} unchanged.`,
      );
    },
    deploySelected: async () => {
      const record = await requireDashboardRecord(selectionState.selectedDashboardSelectorName);
      await deployDashboardAcrossScope(record);
    },
    openDashboardJson: async () => {
      const record = await requireDashboardRecord(selectionState.selectedDashboardSelectorName);
      await openFile(record.absolutePath);
    },
    openDatasourceCatalog: async () => {
      const repository = requireRepository();
      if (!(await repository.readTextFileIfExists(repository.workspaceConfigPath))) {
        await repository.migrateWorkspaceConfig();
        await refreshAll();
      }
      await openFile(repository.workspaceConfigPath);
    },
    openOverrideFile: async () => {
      const repository = requireRepository();
      const service = requireService();
      const record = await requireDashboardRecord(selectionState.selectedDashboardSelectorName);
      const target = await requireDeploymentTarget(selectionState.selectedInstanceName, selectionState.selectedTargetName);
      const overridePath = repository.dashboardOverridesFilePath(record.entry);
      const existing = await repository.readTextFileIfExists(overridePath);
      if (!existing) {
        await service.savePlacement(target.instanceName, target.name, record.entry, undefined);
      }
      await openFile(overridePath);
    },
    generateOverride: async () => {
      const service = requireService();
      const record = await requireDashboardRecord(selectionState.selectedDashboardSelectorName);
      const target = await pickRequiredDeploymentTarget();
      const result = await service.generateOverride(target.instanceName, target.name, record.entry);
      await refreshAll();
      void vscode.window.showInformationMessage(
        `Generated override with ${result.variableCount} variable(s): ${result.overridePath}`,
      );
    },
    removeDashboard: async () => {
      const repository = requireRepository();
      const selectorName = selectionState.selectedDashboardSelectorName;
      if (!selectorName) {
        return;
      }

      const confirmed = await vscode.window.showWarningMessage(
        `Remove ${selectorName} from the project?`,
        { modal: true },
        "Remove Entry Only",
        "Remove Entry And Files",
      );
      if (!confirmed) {
        return;
      }

      const result = await repository.removeDashboardFromProject(selectorName, {
        deleteFiles: confirmed === "Remove Entry And Files",
      });
      selectionState.setDashboard(undefined);
      selectionState.setAlert(undefined);
      await refreshAll();
      void vscode.window.showInformationMessage(
        result.removedPaths.length > 0
          ? `Removed ${selectorName} and deleted ${result.removedPaths.length} local file(s).`
          : `Removed ${selectorName} from the manifest.`,
      );
    },
    removeAlertFromProject: async () => {
      const service = requireService();
      const instanceName = selectionState.selectedInstanceName ?? selectionState.activeInstanceName;
      const targetName = selectionState.selectedTargetName ?? selectionState.activeTargetName;
      const uid = selectionState.selectedAlertUid;
      if (!instanceName || !targetName || !uid) {
        throw new Error("Select an alert first.");
      }

      const confirmed = await vscode.window.showWarningMessage(
        `Remove alert ${uid} from the project?`,
        { modal: true },
        "Remove Alert",
      );
      if (confirmed !== "Remove Alert") {
        return;
      }

      const result = await service.removeAlertFromProject(instanceName, targetName, uid);
      selectionState.setAlert(undefined);
      selectionState.setDetailsMode("instance");
      await refreshAll();
      void vscode.window.showInformationMessage(
        result.removedContactPointKeys.length > 0
          ? `Removed alert ${uid} and pruned ${result.removedContactPointKeys.length} unused contact point(s).`
          : `Removed alert ${uid} from the project.`,
      );
    },
    selectActiveInstance: async () => {
      const repository = requireRepository();
      const targets = await repository.listAllDeploymentTargets();
      const picks = [
        ...targets.map((target) => ({
          label: `${target.instanceName}/${target.name}`,
          description:
            target.instanceName === selectionState.activeInstanceName && target.name === selectionState.activeTargetName
              ? "Active"
              : undefined,
          action: "select" as const,
          instanceName: target.instanceName,
          targetName: target.name,
        })),
        {
          label: "$(add) Create deployment target",
          description: "Create a new deployment target and make it active",
          action: "create" as const,
          instanceName: undefined,
          targetName: undefined,
        },
        {
          label: "$(circle-slash) Clear active target",
          description: "Unset the default target for deploy/override flows",
          action: "clear" as const,
          instanceName: undefined,
          targetName: undefined,
        },
      ];

      const selection = await vscode.window.showQuickPick(picks, {
        title: "Select active deployment target",
        placeHolder: "Choose the default deployment target for current work",
      });

      if (!selection) {
        return;
      }

      if (selection.action === "create") {
        const instance = await pickRequiredInstance();
        await actionHandlers.createDeploymentTarget(instance.name, "");
        return;
      }

      if (selection.action === "clear") {
        selectionState.setActiveTarget(undefined, undefined);
        return;
      }

      selectionState.setActiveTarget(selection.instanceName, selection.targetName);
    },
  };
  detailsProvider = new DetailsViewProvider(() => repository, () => service, selectionState, actionHandlers, missingProjectMessage);

  const dashboardSelectionDisposable = dashboardTreeView.onDidChangeSelection((event) => {
    const item = event.selection[0];
    if (item instanceof DashboardTreeItem) {
      selectionState.setDetailsMode("dashboard");
      selectionState.setDashboard(item.record.selectorName);
      selectionState.setAlert(undefined);
      dashboardsProvider.clearTargetRevisionCache();
      dashboardsProvider.refresh();
      instancesProvider.refresh();
      void detailsProvider.refresh();
    } else if (item instanceof DashboardRevisionTreeItem) {
      selectionState.setDetailsMode("dashboard");
      selectionState.setDashboard(item.record.selectorName);
      selectionState.setAlert(undefined);
      dashboardsProvider.refresh();
      instancesProvider.refresh();
      void detailsProvider.refresh();
    }
  });

  const instanceSelectionDisposable = instanceTreeView.onDidChangeSelection((event) => {
    const item = event.selection[0];
    if (item instanceof DevTargetTreeItem) {
      return;
    }
    if (item instanceof InstanceTreeItem) {
      selectionState.setDetailsMode("instance");
      selectionState.setInstance(item.instance.name);
      selectionState.setAlert(undefined);
      void detailsProvider.refresh();
    } else if (item instanceof DeploymentTargetTreeItem) {
      selectionState.setDetailsMode("instance");
      selectionState.setInstance(item.target.instanceName);
      selectionState.setTarget(item.target.name);
      selectionState.setAlert(undefined);
      selectionState.setActiveTarget(item.target.instanceName, item.target.name);
      dashboardsProvider.clearTargetRevisionCache();
      dashboardsProvider.refresh();
      void detailsProvider.refresh();
    } else if (item instanceof InstanceTargetDashboardsGroupTreeItem || item instanceof InstanceTargetAlertsGroupTreeItem) {
      selectionState.setDetailsMode("instance");
      selectionState.setInstance(item.target.instanceName);
      selectionState.setTarget(item.target.name);
      selectionState.setAlert(undefined);
      selectionState.setActiveTarget(item.target.instanceName, item.target.name);
      dashboardsProvider.clearTargetRevisionCache();
      dashboardsProvider.refresh();
      void detailsProvider.refresh();
    } else if (item instanceof InstanceTargetDashboardTreeItem) {
      selectionState.setDetailsMode("dashboard");
      selectionState.setDashboard(item.record.selectorName);
      selectionState.setAlert(undefined);
      selectionState.setInstance(item.target.instanceName);
      selectionState.setTarget(item.target.name);
      selectionState.setActiveTarget(item.target.instanceName, item.target.name);
      dashboardsProvider.clearTargetRevisionCache();
      dashboardsProvider.refresh();
      void detailsProvider.refresh();
    } else if (item instanceof InstanceTargetAlertTreeItem) {
      selectionState.setDetailsMode("alert");
      selectionState.setAlert(item.record.uid);
      selectionState.setInstance(item.target.instanceName);
      selectionState.setTarget(item.target.name);
      selectionState.setActiveTarget(item.target.instanceName, item.target.name);
      dashboardsProvider.clearTargetRevisionCache();
      dashboardsProvider.refresh();
      void detailsProvider.refresh();
    }
  });

  const backupSelectionDisposable = backupTreeView.onDidChangeSelection((event) => {
    const item = event.selection[0];
    if (
      item instanceof BackupTreeItem ||
      item instanceof BackupInstanceTreeItem ||
      item instanceof BackupTargetTreeItem ||
      item instanceof BackupDashboardTreeItem
    ) {
      selectionState.setBackup(item.backup.rootPath);
      void detailsProvider.refresh();
    }
  });

  const selectionStateDisposable = selectionState.onDidChange(() => {
    if (repository) {
      void context.workspaceState.update(
        activeTargetStorageKey(repository.projectRootPath),
        selectionState.activeInstanceName && selectionState.activeTargetName
          ? `${selectionState.activeInstanceName}/${selectionState.activeTargetName}`
          : undefined,
      );
    }
    void updateDashboardHeaderDescription();
    dashboardsProvider.clearTargetRevisionCache();
    dashboardsProvider.refresh();
    instancesProvider.refresh();
    void detailsProvider.refresh();
  });

  context.subscriptions.push(
    output,
    dashboardTreeView,
    instanceTreeView,
    backupTreeView,
    dashboardSelectionDisposable,
    instanceSelectionDisposable,
    backupSelectionDisposable,
    selectionStateDisposable,
    vscode.window.registerWebviewViewProvider("grafanaDashboards.details", detailsProvider),
    vscode.commands.registerCommand("grafanaDashboards.initializeProject", () => actionHandlers.initializeProject()),
    vscode.commands.registerCommand(
      "grafanaDashboards.createBackup",
      (
        item?:
          | DashboardTreeItem
          | InstanceTreeItem
          | DeploymentTargetTreeItem
          | InstanceTargetDashboardTreeItem,
      ) => createBackupCommand(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.createAllDashboardsBackup", () => createAllDashboardsBackupCommand()),
    vscode.commands.registerCommand(
      "grafanaDashboards.restoreBackup",
      (item?: BackupTreeItem | BackupInstanceTreeItem | BackupTargetTreeItem | BackupDashboardTreeItem) =>
        restoreBackupCommand(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.openBackupFolder", (item?: BackupTreeItem) =>
      openBackupFolder(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.deleteBackup", (item?: BackupTreeItem) => deleteBackup(item)),
    vscode.commands.registerCommand("grafanaDashboards.selectActiveInstance", () => actionHandlers.selectActiveInstance()),
    vscode.commands.registerCommand("grafanaDashboards.selectDevTarget", () => actionHandlers.selectDevTarget()),
    vscode.commands.registerCommand("grafanaDashboards.refresh", async () => {
      await resolveProject();
      await refreshAll();
    }),
    vscode.commands.registerCommand("grafanaDashboards.createManifestFromExample", () =>
      actionHandlers.createManifestFromExample(),
    ),
    vscode.commands.registerCommand("grafanaDashboards.addDashboard", () => actionHandlers.addDashboard()),
    vscode.commands.registerCommand("grafanaDashboards.createInstance", () => actionHandlers.createInstance("")),
    vscode.commands.registerCommand("grafanaDashboards.createDeploymentTarget", (item?: string | InstanceTreeItem) =>
      actionHandlers.createDeploymentTarget(
        typeof item === "string"
          ? item
          : item instanceof InstanceTreeItem
            ? item.instance.name
            : selectionState.selectedInstanceName ?? "",
        "",
      ),
    ),
    vscode.commands.registerCommand("grafanaDashboards.removeInstance", (item?: InstanceTreeItem) => removeInstance(item)),
    vscode.commands.registerCommand("grafanaDashboards.removeDeploymentTarget", (item?: DeploymentTargetTreeItem) =>
      removeDeploymentTarget(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.renameDeploymentTarget", (item?: DeploymentTargetTreeItem) =>
      renameDeploymentTarget(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.setInstanceToken", (item?: InstanceTreeItem) =>
      setInstanceToken(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.clearInstanceToken", (item?: InstanceTreeItem) =>
      clearInstanceToken(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.setInstancePassword", (item?: InstanceTreeItem) =>
      setInstancePassword(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.clearInstancePassword", (item?: InstanceTreeItem) =>
      clearInstancePassword(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.checkoutRevisionFromTree", (item?: DashboardRevisionTreeItem) =>
      checkoutRevisionFromTree(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.setTargetRevisionFromTree", (item?: DashboardRevisionTreeItem) =>
      setTargetRevisionFromTree(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.deployRevisionToActiveTargetFromTree", (item?: DashboardRevisionTreeItem) =>
      deployRevisionToActiveTargetFromTree(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.deleteRevisionFromTree", (item?: DashboardRevisionTreeItem) =>
      deleteRevisionFromTree(item),
    ),
    vscode.commands.registerCommand(
      "grafanaDashboards.openDashboardInBrowser",
      (item?: DashboardTreeItem | InstanceTargetDashboardTreeItem) => openDashboardInBrowser(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.openDashboardJson", (item?: DashboardTreeItem | InstanceTargetDashboardTreeItem) =>
      openDashboardJson(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.removeDashboard", (item?: DashboardTreeItem | InstanceTargetDashboardTreeItem) =>
      removeDashboard(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.removeAlertFromProject", (item?: InstanceTargetAlertTreeItem) =>
      removeAlertFromProject(item),
    ),
    vscode.commands.registerCommand(
      "grafanaDashboards.pullDashboard",
      (item?: DashboardTreeItem | InstanceTreeItem | DeploymentTargetTreeItem | InstanceTargetDashboardTreeItem) =>
      pullDashboards(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.pullAllDashboards", (item?: InstanceTreeItem | DeploymentTargetTreeItem) =>
      pullAllDashboards(item),
    ),
    vscode.commands.registerCommand(
      "grafanaDashboards.renderDashboard",
      (item?: DashboardTreeItem | InstanceTargetDashboardTreeItem) =>
      renderDashboardCommand(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.renderTarget", (item?: DeploymentTargetTreeItem) =>
      renderTargetCommand(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.renderInstance", (item?: InstanceTreeItem) =>
      renderInstanceCommand(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.renderAllInstances", () =>
      renderAllInstancesCommand(),
    ),
    vscode.commands.registerCommand(
      "grafanaDashboards.exportAlerts",
      (item?: InstanceTreeItem | DeploymentTargetTreeItem | InstanceTargetAlertTreeItem) =>
        exportAlertsCommand(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.copyAlertToTarget", (item?: InstanceTargetAlertTreeItem) =>
      copyAlertToTargetCommand(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.uploadAlert", (item?: InstanceTargetAlertTreeItem) =>
      uploadAlertCommand(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.refreshAlertStatus", (item?: InstanceTargetAlertTreeItem) =>
      refreshAlertStatusCommand(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.deployAllDashboards", () =>
      deployAllDashboardsCommand(),
    ),
    vscode.commands.registerCommand("grafanaDashboards.openRenderFolder", (item?: InstanceTreeItem | DeploymentTargetTreeItem) =>
      openRenderFolder(item),
    ),
    vscode.commands.registerCommand(
      "grafanaDashboards.deployDashboard",
      (item?: DashboardTreeItem | InstanceTreeItem | DeploymentTargetTreeItem | InstanceTargetDashboardTreeItem) =>
      deployDashboards(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.openOverrideFile", (item?: InstanceTreeItem | DeploymentTargetTreeItem) =>
      openOverrideFile(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.generateOverride", (item?: DashboardTreeItem) =>
      generateOverride(item),
    ),
  );

  async function requireDashboardRecord(selectorName?: string): Promise<DashboardRecord> {
    const repository = requireRepository();
    const resolvedSelector = selectorName ?? selectionState.selectedDashboardSelectorName;
    if (!resolvedSelector) {
      throw new Error("Select a dashboard first.");
    }

    const record = await repository.dashboardRecordBySelector(resolvedSelector);
    if (!record) {
      throw new Error(`Dashboard not found in manifest: ${resolvedSelector}`);
    }
    return record;
  }

  async function requireInstance(instanceName?: string): Promise<InstanceRecord> {
    const repository = requireRepository();
    const resolvedName = instanceName ?? selectionState.selectedInstanceName;
    if (!resolvedName) {
      throw new Error("Select an instance first.");
    }

    const instance = await repository.instanceByName(resolvedName);
    if (!instance) {
      throw new Error(`Instance not found: ${resolvedName}`);
    }
    return instance;
  }

  async function requireDeploymentTarget(
    instanceName?: string,
    targetName?: string,
  ): Promise<DeploymentTargetRecord> {
    const repository = requireRepository();
    const resolvedInstanceName = instanceName ?? selectionState.selectedInstanceName;
    const resolvedTargetName = targetName ?? selectionState.selectedTargetName;
    if (!resolvedInstanceName || !resolvedTargetName) {
      throw new Error("Select a deployment target first.");
    }

    const target = await repository.deploymentTargetByName(resolvedInstanceName, resolvedTargetName);
    if (!target) {
      throw new Error(`Deployment target not found: ${resolvedInstanceName}/${resolvedTargetName}`);
    }

    return target;
  }

  async function firstDeploymentTarget(instanceName: string): Promise<DeploymentTargetRecord> {
    const repository = requireRepository();
    const targets = await repository.listDeploymentTargets(instanceName);
    const firstTarget = targets[0];
    if (!firstTarget) {
      throw new Error(`Deployment target not found for ${instanceName}.`);
    }
    return firstTarget;
  }

  async function requireBackup(backupName?: string): Promise<BackupRecord> {
    const repository = requireRepository();
    const resolvedKey = backupName ?? selectionState.selectedBackupName;
    if (!resolvedKey) {
      throw new Error("Select a backup first.");
    }
    const backups = await repository.listBackups();
    const backup =
      backups.find((candidate) => candidate.rootPath === resolvedKey) ??
      backups.find((candidate) => candidate.name === resolvedKey);
    if (!backup) {
      throw new Error(`Backup not found: ${resolvedKey}`);
    }
    return backup;
  }

  function isDashboardScopeItem(
    item: unknown,
  ): item is DashboardTreeItem {
    return item instanceof DashboardTreeItem;
  }

  function isInstanceTargetDashboardItem(item: unknown): item is InstanceTargetDashboardTreeItem {
    return item instanceof InstanceTargetDashboardTreeItem;
  }

  async function requireDevTarget(): Promise<DeploymentTargetRecord> {
    const repository = requireRepository();
    const devTarget = await repository.getDevTarget();
    if (!devTarget) {
      throw new Error("Dev target is not configured. Use Select Dev Target first.");
    }
    return requireDeploymentTarget(devTarget.instanceName, devTarget.targetName);
  }

  function sameTarget(
    left: { instanceName: string; name: string },
    right: { instanceName: string; name: string },
  ): boolean {
    return left.instanceName === right.instanceName && left.name === right.name;
  }

  async function pickDashboardExecutionScope(
    record: DashboardRecord,
    action: "render" | "deploy",
  ): Promise<{
    targets: DeploymentTargetRecord[];
    label: string;
  }> {
    const repository = requireRepository();
    const contextTarget = await pickRequiredDeploymentTarget();
    const instanceTargets = await repository.listDeploymentTargets(contextTarget.instanceName);
    const allTargets = await repository.listAllDeploymentTargets();
    const actionLabel = action === "render" ? "render" : "deploy";
    const selection = await vscode.window.showQuickPick(
      [
        {
          label: "Current Active Target",
          description: `${contextTarget.instanceName}/${contextTarget.name}`,
          targets: [contextTarget],
          resultLabel: `${record.selectorName} on ${contextTarget.instanceName}/${contextTarget.name}`,
        },
        {
          label: "All Targets In Active Instance",
          description: `${contextTarget.instanceName} (${instanceTargets.length} target(s))`,
          targets: instanceTargets,
          resultLabel: `${record.selectorName} across all targets in ${contextTarget.instanceName}`,
        },
        {
          label: "All Instances",
          description: `${allTargets.length} target(s)`,
          targets: allTargets,
          resultLabel: `${record.selectorName} across all instances`,
        },
      ],
      {
        title: `Choose ${actionLabel} scope for ${record.selectorName}`,
        placeHolder: "Use current active target, all targets in its instance, or all instances.",
      },
    );

    if (!selection) {
      throw new Error(`No ${actionLabel} scope selected.`);
    }

    return {
      targets: selection.targets,
      label: selection.resultLabel,
    };
  }

  async function renderDashboardAcrossScope(record: DashboardRecord): Promise<void> {
    const service = requireService();
    const { targets, label } = await pickDashboardExecutionScope(record, "render");
    for (const target of targets) {
      await service.renderDashboards([record.entry], target.instanceName, target.name, "dashboard");
    }

    await refreshAll();
    void vscode.window.showInformationMessage(
      `Render complete for ${label}: ${targets.length} target(s) updated.`,
    );
  }

  async function deployDashboardAcrossScope(record: DashboardRecord): Promise<void> {
    const service = requireService();
    const { targets, label } = await pickDashboardExecutionScope(record, "deploy");
    let deployedCount = 0;

    for (const target of targets) {
      const summary = await service.deployDashboards([record.entry], target.instanceName, target.name);
      deployedCount += summary.dashboardResults.length;
    }

    await refreshAll();
    void vscode.window.showInformationMessage(
      `Deploy complete for ${label}: ${deployedCount} deployment(s) across ${targets.length} target(s).`,
    );
  }

  async function pickDashboardEntries(
    item?: DashboardTreeItem | InstanceTargetDashboardTreeItem,
  ): Promise<DashboardManifestEntry[]> {
    const repository = requireRepository();
    if (item) {
      return [item.record.entry];
    }

    if (selectionState.selectedDashboardSelectorName) {
      const record = await repository.dashboardRecordBySelector(selectionState.selectedDashboardSelectorName);
      if (record) {
        return [record.entry];
      }
    }

    const records = await repository.listDashboardRecords();
    if (records.length === 0) {
      throw new Error("No dashboards available in the manifest.");
    }

    const picks = await vscode.window.showQuickPick(
      records.map((record) => ({
        label: record.selectorName,
        description: record.title ?? record.entry.uid,
        detail: record.entry.path,
        record,
      })),
      {
        canPickMany: true,
        title: "Select dashboards",
      },
    );

    if (!picks || picks.length === 0) {
      throw new Error("No dashboards selected.");
    }

    return picks.map((pick) => pick.record.entry);
  }

  async function allDashboardEntries(): Promise<DashboardManifestEntry[]> {
    const repository = requireRepository();
    const records = await repository.listDashboardRecords();
    if (records.length === 0) {
      throw new Error("No dashboards available in the manifest.");
    }
    return records.map((record) => record.entry);
  }

  function isBackupScopeItem(
    item: unknown,
  ): item is DashboardTreeItem | InstanceTreeItem | DeploymentTargetTreeItem | InstanceTargetDashboardTreeItem {
    return (
      isDashboardScopeItem(item) ||
      isInstanceTargetDashboardItem(item) ||
      item instanceof InstanceTreeItem ||
      item instanceof DeploymentTargetTreeItem
    );
  }

  async function backupSpecsForItem(
    item:
      | DashboardTreeItem
      | InstanceTreeItem
      | DeploymentTargetTreeItem
      | InstanceTargetDashboardTreeItem,
  ): Promise<{
    scope: BackupScope;
    specs: BackupTargetSpec[];
    label: string;
  }> {
    const repository = requireRepository();

    if (item instanceof DashboardTreeItem) {
      const targets = await repository.listAllDeploymentTargets();
      return {
        scope: "multi-instance",
        specs: targets.map((target) => ({
          instanceName: target.instanceName,
          targetName: target.name,
          entries: [item.record.entry],
        })),
        label: `${item.record.selectorName} across all instances`,
      };
    }

    if (item instanceof InstanceTreeItem) {
      const entries = await allDashboardEntries();
      const targets = await repository.listDeploymentTargets(item.instance.name);
      return {
        scope: "instance",
        specs: targets.map((target) => ({
          instanceName: target.instanceName,
          targetName: target.name,
          entries,
        })),
        label: `all dashboards in ${item.instance.name}`,
      };
    }

    if (item instanceof DeploymentTargetTreeItem) {
      return {
        scope: "target",
        specs: [
          {
            instanceName: item.target.instanceName,
            targetName: item.target.name,
            entries: await allDashboardEntries(),
          },
        ],
        label: `all dashboards on ${item.target.instanceName}/${item.target.name}`,
      };
    }

    return {
      scope: "dashboard",
      specs: [
        {
          instanceName: item.target.instanceName,
          targetName: item.target.name,
          entries: [item.record.entry],
        },
      ],
      label: `${item.record.selectorName} on ${item.target.instanceName}/${item.target.name}`,
    };
  }

  function backupRestoreSelectionForItem(
    item?: BackupTreeItem | BackupInstanceTreeItem | BackupTargetTreeItem | BackupDashboardTreeItem,
  ): BackupRestoreSelection {
    if (!item || item instanceof BackupTreeItem) {
      return { kind: "backup" };
    }
    if (item instanceof BackupInstanceTreeItem) {
      return {
        kind: "instance",
        instanceName: item.instance.instanceName,
      };
    }
    if (item instanceof BackupTargetTreeItem) {
      return {
        kind: "target",
        instanceName: item.target.instanceName,
        targetName: item.target.targetName,
      };
    }
    return {
      kind: "dashboard",
      instanceName: item.instanceName,
      targetName: item.targetName,
      selectorName: item.dashboard.selectorName,
    };
  }

  async function pickInstanceIfNeeded(explicitInstanceName?: string): Promise<InstanceRecord | undefined> {
    const repository = requireRepository();
    if (explicitInstanceName) {
      return requireInstance(explicitInstanceName);
    }

    if (selectionState.activeInstanceName) {
      return requireInstance(selectionState.activeInstanceName);
    }

    const instances = await repository.listInstances();
    const picks = instances.map((instance) => ({
      label: instance.name,
      description: instance.envExists ? "Configured in workspace config" : "Missing config",
      instanceName: instance.name,
    }));

    const selection = await vscode.window.showQuickPick(picks, {
      title: "Choose Grafana connection context",
    });

    if (!selection) {
      throw new Error("No Grafana connection context selected.");
    }

    return requireInstance(selection.instanceName);
  }

  async function pickRequiredInstance(explicitInstanceName?: string): Promise<InstanceRecord> {
    const instance = await pickInstanceIfNeeded(explicitInstanceName);
    if (!instance) {
      throw new Error("Choose a concrete instance.");
    }
    return instance;
  }

  async function pickDeploymentTargetIfNeeded(
    explicitInstanceName?: string,
    explicitTargetName?: string,
  ): Promise<DeploymentTargetRecord> {
    const repository = requireRepository();
    if (explicitInstanceName && explicitTargetName) {
      return requireDeploymentTarget(explicitInstanceName, explicitTargetName);
    }

    if (selectionState.activeInstanceName && selectionState.activeTargetName) {
      return requireDeploymentTarget(selectionState.activeInstanceName, selectionState.activeTargetName);
    }

    const targets = await repository.listAllDeploymentTargets();
    if (targets.length === 0) {
      throw new Error("No deployment targets available.");
    }

    const selection = await vscode.window.showQuickPick(
      targets.map((target) => ({
        label: `${target.instanceName}/${target.name}`,
        target,
      })),
      {
        title: "Choose deployment target",
      },
    );

    if (!selection) {
      throw new Error("No deployment target selected.");
    }

    return selection.target;
  }

  async function pickRequiredDeploymentTarget(
    explicitInstanceName?: string,
    explicitTargetName?: string,
  ): Promise<DeploymentTargetRecord> {
    return pickDeploymentTargetIfNeeded(explicitInstanceName, explicitTargetName);
  }

  async function openFile(filePath: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(document, { preview: false });
  }

  async function openDashboardJson(item?: DashboardTreeItem | InstanceTargetDashboardTreeItem): Promise<void> {
    const record = item?.record ?? (await requireDashboardRecord());
    await openFile(record.absolutePath);
  }

  async function openDashboardInBrowser(item?: DashboardTreeItem | InstanceTargetDashboardTreeItem): Promise<void> {
    if (isInstanceTargetDashboardItem(item)) {
      await actionHandlers.openDashboardInBrowser(
        item.record.selectorName,
        item.target.instanceName,
        item.target.name,
      );
      return;
    }

    const selectorName = item?.record.selectorName ?? selectionState.selectedDashboardSelectorName;
    if (!selectorName) {
      throw new Error("Select a dashboard first.");
    }
    await actionHandlers.openDashboardInBrowser(selectorName);
  }

  async function checkoutRevisionFromTree(item?: DashboardRevisionTreeItem): Promise<void> {
    if (!item) {
      throw new Error("Select a dashboard revision first.");
    }
    selectionState.setDashboard(item.record.selectorName);
    await actionHandlers.checkoutRevision(item.record.selectorName, item.revision.record.id);
  }

  async function setTargetRevisionFromTree(item?: DashboardRevisionTreeItem): Promise<void> {
    if (!item) {
      throw new Error("Select a dashboard revision first.");
    }
    const target = await pickRequiredDeploymentTarget();
    selectionState.setDashboard(item.record.selectorName);
    selectionState.setInstance(target.instanceName);
    selectionState.setTarget(target.name);
    selectionState.setActiveTarget(target.instanceName, target.name);
    await actionHandlers.setTargetRevision(item.record.selectorName, item.revision.record.id, target.instanceName, target.name);
  }

  async function deployRevisionToActiveTargetFromTree(item?: DashboardRevisionTreeItem): Promise<void> {
    if (!item) {
      throw new Error("Select a dashboard revision first.");
    }
    const target = await pickRequiredDeploymentTarget();
    selectionState.setDashboard(item.record.selectorName);
    selectionState.setInstance(target.instanceName);
    selectionState.setTarget(target.name);
    selectionState.setActiveTarget(target.instanceName, target.name);
    await actionHandlers.deployRevision(item.record.selectorName, item.revision.record.id, target.instanceName, target.name);
  }

  async function deleteRevisionFromTree(item?: DashboardRevisionTreeItem): Promise<void> {
    if (!item) {
      throw new Error("Select a dashboard revision first.");
    }
    const confirmed = await vscode.window.showWarningMessage(
      `Delete revision ${item.revision.record.id} for ${item.record.selectorName}?`,
      { modal: true },
      "Delete",
    );
    if (confirmed !== "Delete") {
      return;
    }
    selectionState.setDashboard(item.record.selectorName);
    await actionHandlers.deleteRevision(item.record.selectorName, item.revision.record.id);
  }

  async function removeDashboard(item?: DashboardTreeItem | InstanceTargetDashboardTreeItem): Promise<void> {
    const selectorName = item?.record.selectorName ?? selectionState.selectedDashboardSelectorName;
    if (!selectorName) {
      throw new Error("Select a dashboard first.");
    }
    selectionState.setDashboard(selectorName);
    await actionHandlers.removeDashboard();
  }

  async function removeAlertFromProject(item?: InstanceTargetAlertTreeItem): Promise<void> {
    const instanceName = item?.target.instanceName ?? selectionState.selectedInstanceName ?? selectionState.activeInstanceName;
    const targetName = item?.target.name ?? selectionState.selectedTargetName ?? selectionState.activeTargetName;
    const uid = item?.record.uid ?? selectionState.selectedAlertUid;
    if (!instanceName || !targetName || !uid) {
      throw new Error("Select an alert first.");
    }
    selectionState.setDetailsMode("alert");
    selectionState.setInstance(instanceName);
    selectionState.setTarget(targetName);
    selectionState.setActiveTarget(instanceName, targetName);
    selectionState.setAlert(uid);
    await actionHandlers.removeAlertFromProject();
  }

  async function pullDashboards(
    item?:
      | DashboardTreeItem
      | InstanceTreeItem
      | DeploymentTargetTreeItem
      | InstanceTargetDashboardTreeItem,
  ): Promise<void> {
    const service = requireService();
    const devTarget = await requireDevTarget();
    if (isDashboardScopeItem(item)) {
      const summary = await service.pullDashboards(
        [item.record.entry],
        devTarget.instanceName,
        devTarget.name,
      );

      await refreshAll();
      void vscode.window.showInformationMessage(
        `Pull complete for ${item.record.selectorName} from dev target ${devTarget.instanceName}/${devTarget.name}: ${summary.updatedCount} updated, ${summary.skippedCount} unchanged.`,
      );
      return;
    }

    if (isInstanceTargetDashboardItem(item)) {
      if (!sameTarget(item.target, devTarget)) {
        throw new Error(`Pull is available only on dev target ${devTarget.instanceName}/${devTarget.name}.`);
      }
      const summary = await service.pullDashboards([item.record.entry], devTarget.instanceName, devTarget.name);
      await refreshAll();
      void vscode.window.showInformationMessage(
        `Pull complete for ${item.record.selectorName} from dev target ${devTarget.instanceName}/${devTarget.name}: ${summary.updatedCount} updated, ${summary.skippedCount} unchanged.`,
      );
      return;
    }

    if (item instanceof InstanceTreeItem) {
      if (item.instance.name !== devTarget.instanceName) {
        throw new Error(`Pull is available only from dev target ${devTarget.instanceName}/${devTarget.name}.`);
      }
      const entries = await allDashboardEntries();
      const summary = await service.pullDashboards(entries, devTarget.instanceName, devTarget.name);
      await refreshAll();
      void vscode.window.showInformationMessage(
        `Pull complete for all dashboards from dev target ${devTarget.instanceName}/${devTarget.name}: ${summary.updatedCount} updated, ${summary.skippedCount} unchanged.`,
      );
      return;
    }

    if (item instanceof DeploymentTargetTreeItem) {
      if (!sameTarget(item.target, devTarget)) {
        throw new Error(`Pull is available only on dev target ${devTarget.instanceName}/${devTarget.name}.`);
      }
      const entries = await allDashboardEntries();
      const summary = await service.pullDashboards(entries, devTarget.instanceName, devTarget.name);
      await refreshAll();
      void vscode.window.showInformationMessage(
        `Pull complete for all dashboards from dev target ${devTarget.instanceName}/${devTarget.name}: ${summary.updatedCount} updated, ${summary.skippedCount} unchanged.`,
      );
      return;
    }

    const entries = await pickDashboardEntries();
    const summary = await service.pullDashboards(entries, devTarget.instanceName, devTarget.name);
    await refreshAll();
    void vscode.window.showInformationMessage(
      `Pull complete from dev target ${devTarget.instanceName}/${devTarget.name}: ${summary.updatedCount} updated, ${summary.skippedCount} unchanged.`,
    );
  }

  async function renderDashboardCommand(
    item?: DashboardTreeItem | InstanceTargetDashboardTreeItem,
  ): Promise<void> {
    const service = requireService();
    if (isInstanceTargetDashboardItem(item)) {
      await service.renderDashboards([item.record.entry], item.target.instanceName, item.target.name, "dashboard");
      await refreshAll();
      void vscode.window.showInformationMessage(
        `Render complete for ${item.record.selectorName} on ${item.target.instanceName}/${item.target.name}.`,
      );
      return;
    }

    if (item) {
      await renderDashboardAcrossScope(item.record);
      return;
    }

    await actionHandlers.renderSelected(selectionState.selectedDashboardSelectorName);
  }

  async function renderTargetCommand(item?: DeploymentTargetTreeItem): Promise<void> {
    const instanceName = item?.target.instanceName;
    const targetName = item?.target.name;
    await actionHandlers.renderTarget(instanceName, targetName);
  }

  async function renderInstanceCommand(item?: InstanceTreeItem): Promise<void> {
    const instanceName = item?.instance.name;
    await actionHandlers.renderInstance(instanceName);
  }

  async function renderAllInstancesCommand(): Promise<void> {
    await actionHandlers.renderAllInstances();
  }

  async function openRenderFolder(item?: InstanceTreeItem | DeploymentTargetTreeItem): Promise<void> {
    const instanceName =
      item instanceof InstanceTreeItem ? item.instance.name : item instanceof DeploymentTargetTreeItem ? item.target.instanceName : undefined;
    const targetName = item instanceof DeploymentTargetTreeItem ? item.target.name : undefined;
    await actionHandlers.openRenderFolder(instanceName, targetName);
  }

  async function pickTargetForInstance(instanceName: string): Promise<DeploymentTargetRecord> {
    const repository = requireRepository();
    const targets = await repository.listDeploymentTargets(instanceName);
    if (targets.length === 0) {
      throw new Error(`No deployment targets found for ${instanceName}.`);
    }
    if (targets.length === 1) {
      return targets[0]!;
    }

    const selection = await vscode.window.showQuickPick(
      targets.map((target) => ({
        label: `${target.instanceName}/${target.name}`,
        target,
      })),
      {
        title: `Choose deployment target for ${instanceName}`,
      },
    );

    if (!selection) {
      throw new Error("No deployment target selected.");
    }

    return selection.target;
  }

  async function exportAlertsCommand(
    item?: InstanceTreeItem | DeploymentTargetTreeItem | InstanceTargetAlertTreeItem,
    forcedAlertUids?: string[],
  ): Promise<void> {
    const repository = requireRepository();
    const service = requireService();
    const target =
      item instanceof InstanceTargetAlertTreeItem
        ? item.target
        : item instanceof DeploymentTargetTreeItem
        ? item.target
        : item instanceof InstanceTreeItem
          ? await pickTargetForInstance(item.instance.name)
          : await pickRequiredDeploymentTarget();

    const candidates = await service.listRemoteAlertRules(target.instanceName);
    if (candidates.length === 0) {
      throw new Error(`No alert rules available in ${target.instanceName}.`);
    }

    const presetUids = new Set(forcedAlertUids?.map((uid) => uid.trim()).filter(Boolean) ?? []);
    const picks = await vscode.window.showQuickPick(
      candidates.map((candidate) => ({
        label: candidate.title,
        description: candidate.receiver ? `receiver: ${candidate.receiver}` : "policy-managed",
        detail: `UID: ${candidate.uid}`,
        picked: presetUids.size > 0 ? presetUids.has(candidate.uid) : false,
        uid: candidate.uid,
      })),
      {
        canPickMany: true,
        title: `Pull alerts from ${target.instanceName}/${target.name}`,
        placeHolder: "Select alert rules to pull",
      },
    );
    if (!picks || picks.length === 0) {
      return;
    }

    const summary = await service.exportSelectedAlerts(
      target.instanceName,
      target.name,
      picks.map((pick) => pick.uid),
    );
    selectionState.setInstance(target.instanceName);
    selectionState.setTarget(target.name);
    selectionState.setActiveTarget(target.instanceName, target.name);
    selectionState.setAlert(undefined);
    await refreshAll();

    const outputLabel = path.relative(repository.workspaceRootPath, summary.outputDir) || ".";
    void vscode.window.showInformationMessage(
      `Alerts pull complete for ${summary.instanceName}/${summary.targetName}: ${summary.selectedCount} selected, ${summary.updatedCount} updated, ${summary.skippedCount} unchanged (${outputLabel}).`,
    );
  }

  async function pickAlertDatasourceForInstance(
    instanceName: string,
    title: string,
  ): Promise<{ uid: string; name?: string }> {
    const service = requireService();
    let datasourceOptions: GrafanaDatasourceSummary[] | undefined;

    try {
      datasourceOptions = await service.listRemoteDatasources(instanceName);
    } catch {
      datasourceOptions = undefined;
    }

    if (datasourceOptions && datasourceOptions.length > 0) {
      const selection = await vscode.window.showQuickPick(
        datasourceOptions.map((datasource) => ({
          label: datasource.name,
          description: datasource.type ?? "datasource",
          detail: datasource.uid,
          datasource,
        })),
        {
          title,
          placeHolder: `Choose datasource for ${instanceName}`,
        },
      );
      if (!selection) {
        throw new Error("No datasource selected.");
      }
      return {
        uid: selection.datasource.uid,
        name: selection.datasource.name,
      };
    }

    const datasourceName = await vscode.window.showInputBox({
      title,
      prompt: `Datasource name for ${instanceName}`,
      validateInput: (value) => inputValidator(value, "Datasource name"),
    });
    if (!datasourceName) {
      throw new Error("No datasource name provided.");
    }

    const datasourceUid = await vscode.window.showInputBox({
      title,
      prompt: `Datasource UID for ${instanceName}`,
      validateInput: (value) => inputValidator(value, "Datasource UID"),
    });
    if (!datasourceUid) {
      throw new Error("No datasource UID provided.");
    }

    return {
      uid: datasourceUid.trim(),
      name: datasourceName.trim(),
    };
  }

  async function copyAlertToTargetCommand(item?: InstanceTargetAlertTreeItem): Promise<void> {
    const repository = requireRepository();
    const service = requireService();
    const sourceInstanceName = item?.target.instanceName ?? selectionState.selectedInstanceName ?? selectionState.activeInstanceName;
    const sourceTargetName = item?.target.name ?? selectionState.selectedTargetName ?? selectionState.activeTargetName;
    const uid = item?.record.uid ?? selectionState.selectedAlertUid;
    if (!sourceInstanceName || !sourceTargetName || !uid) {
      throw new Error("Select an alert in a deployment target first.");
    }

    const targets = (await repository.listAllDeploymentTargets()).filter(
      (target) => !(target.instanceName === sourceInstanceName && target.name === sourceTargetName),
    );
    if (targets.length === 0) {
      throw new Error("No destination deployment targets available.");
    }

    const destination = await vscode.window.showQuickPick(
      targets.map((target) => ({
        label: `${target.instanceName}/${target.name}`,
        target,
      })),
      {
        title: `Copy alert ${uid}`,
        placeHolder: "Choose destination deployment target",
      },
    );
    if (!destination) {
      return;
    }

    const alertDetails = await service.loadAlertDetails(sourceInstanceName, sourceTargetName, uid);
    const datasourceSelection = alertDetails?.datasourceSelection
      ? await pickAlertDatasourceForInstance(
          destination.target.instanceName,
          `Choose datasource for copied alert ${uid}`,
        )
      : undefined;

    const summary = await service.copyAlertToTarget(
      sourceInstanceName,
      sourceTargetName,
      uid,
      destination.target.instanceName,
      destination.target.name,
      datasourceSelection,
    );
    selectionState.setDetailsMode("alert");
    selectionState.setInstance(summary.destinationInstanceName);
    selectionState.setTarget(summary.destinationTargetName);
    selectionState.setActiveTarget(summary.destinationInstanceName, summary.destinationTargetName);
    selectionState.setAlert(summary.destinationUid);
    await refreshAll();
    void vscode.window.showInformationMessage(
      `Copied alert ${summary.sourceUid} to ${summary.destinationInstanceName}/${summary.destinationTargetName} as ${summary.destinationUid}.`,
    );
  }

  async function uploadAlertCommand(item?: InstanceTargetAlertTreeItem): Promise<void> {
    const service = requireService();
    const instanceName = item?.target.instanceName ?? selectionState.selectedInstanceName ?? selectionState.activeInstanceName;
    const targetName = item?.target.name ?? selectionState.selectedTargetName ?? selectionState.activeTargetName;
    const uid = item?.record.uid ?? selectionState.selectedAlertUid;
    if (!instanceName || !targetName || !uid) {
      throw new Error("Select an alert in a deployment target first.");
    }

    const summary = await service.uploadAlert(instanceName, targetName, uid);
    selectionState.setDetailsMode("alert");
    selectionState.setAlert(uid);
    selectionState.setInstance(instanceName);
    selectionState.setTarget(targetName);
    selectionState.setActiveTarget(instanceName, targetName);
    await refreshAll();
    const updatedContactPoints = summary.contactPointResults.filter((result) => result.status === "updated").length;
    const skippedContactPoints = summary.contactPointResults.filter((result) => result.status === "skipped").length;
    void vscode.window.showInformationMessage(
      `Alert deploy complete for ${uid} on ${instanceName}/${targetName}: rule ${summary.ruleStatus}, contact points ${updatedContactPoints} updated, ${skippedContactPoints} unchanged.`,
    );
  }

  async function refreshAlertStatusCommand(item?: InstanceTargetAlertTreeItem): Promise<void> {
    const service = requireService();
    const instanceName = item?.target.instanceName ?? selectionState.selectedInstanceName ?? selectionState.activeInstanceName;
    const targetName = item?.target.name ?? selectionState.selectedTargetName ?? selectionState.activeTargetName;
    const uid = item?.record.uid ?? selectionState.selectedAlertUid;
    if (!instanceName || !targetName || !uid) {
      throw new Error("Select an alert in a deployment target first.");
    }

    const syncStatus = await service.refreshAlertStatus(instanceName, targetName, uid);
    selectionState.setDetailsMode("alert");
    selectionState.setAlert(uid);
    selectionState.setInstance(instanceName);
    selectionState.setTarget(targetName);
    selectionState.setActiveTarget(instanceName, targetName);
    await refreshAll();
    void vscode.window.showInformationMessage(`Alert ${uid} status on ${instanceName}/${targetName}: ${syncStatus}.`);
  }

  async function pullAllDashboards(item?: InstanceTreeItem | DeploymentTargetTreeItem): Promise<void> {
    if (item instanceof InstanceTreeItem) {
      await actionHandlers.pullAllDashboards(item.instance.name);
      return;
    }

    const instanceName = item instanceof DeploymentTargetTreeItem ? item.target.instanceName : undefined;
    const targetName = item instanceof DeploymentTargetTreeItem ? item.target.name : undefined;
    await actionHandlers.pullAllDashboards(instanceName, targetName);
  }

  async function deployDashboards(
    item?:
      | DashboardTreeItem
      | InstanceTreeItem
      | DeploymentTargetTreeItem
      | InstanceTargetDashboardTreeItem,
  ): Promise<void> {
    const service = requireService();
    if (isDashboardScopeItem(item)) {
      await deployDashboardAcrossScope(item.record);
      return;
    }

    if (isInstanceTargetDashboardItem(item)) {
      const summary = await service.deployDashboards([item.record.entry], item.target.instanceName, item.target.name);
      await refreshAll();
      void vscode.window.showInformationMessage(
        `Deploy complete for ${item.record.selectorName} to ${item.target.instanceName}/${item.target.name}: ${summary.dashboardResults.length} dashboard(s) deployed.`,
      );
      return;
    }

    if (item instanceof InstanceTreeItem) {
      const entries = await allDashboardEntries();
      const targets = await requireRepository().listDeploymentTargets(item.instance.name);
      let deployedCount = 0;
      for (const target of targets) {
        const summary = await service.deployDashboards(entries, target.instanceName, target.name);
        deployedCount += summary.dashboardResults.length;
      }
      await refreshAll();
      void vscode.window.showInformationMessage(
        `Deploy complete for all dashboards in ${item.instance.name}: ${deployedCount} deployment(s) across ${targets.length} target(s).`,
      );
      return;
    }

    if (item instanceof DeploymentTargetTreeItem) {
      const entries = await allDashboardEntries();
      const summary = await service.deployDashboards(entries, item.target.instanceName, item.target.name);
      await refreshAll();
      void vscode.window.showInformationMessage(
        `Deploy complete for all dashboards to ${item.target.instanceName}/${item.target.name}: ${summary.dashboardResults.length} dashboard(s) deployed.`,
      );
      return;
    }

    const entries = await pickDashboardEntries();
    const target = await pickRequiredDeploymentTarget();
    const summary = await service.deployDashboards(entries, target.instanceName, target.name);
    await refreshAll();
    void vscode.window.showInformationMessage(
      `Deploy complete: ${summary.dashboardResults.length} dashboard(s) deployed${
        summary.instanceName && summary.deploymentTargetName
          ? ` to ${summary.instanceName}/${summary.deploymentTargetName}`
          : ""
      }.`,
    );
  }

  async function openOverrideFile(item?: InstanceTreeItem | DeploymentTargetTreeItem): Promise<void> {
    const repository = requireRepository();
    const target =
      item instanceof DeploymentTargetTreeItem
        ? item.target
        : item instanceof InstanceTreeItem
          ? await firstDeploymentTarget(item.instance.name)
          : await requireDeploymentTarget();
    const record = await requireDashboardRecord();
    const overridePath = repository.dashboardOverridesFilePath(record.entry);
    const existing = await repository.readTextFileIfExists(overridePath);
    if (!existing) {
      await repository.saveTargetOverrideFile(target.instanceName, target.name, record.entry, {
        revisionStates: {},
      });
      await refreshAll();
    }
    await openFile(overridePath);
  }

  async function generateOverride(item?: DashboardTreeItem): Promise<void> {
    const service = requireService();
    const record = item?.record ?? (await requireDashboardRecord());
    const target = await pickRequiredDeploymentTarget();
    const result = await service.generateOverride(target.instanceName, target.name, record.entry);
    selectionState.setDashboard(selectorNameForEntry(record.entry));
    selectionState.setInstance(target.instanceName);
    selectionState.setTarget(target.name);
    await refreshAll();
    void vscode.window.showInformationMessage(
      `Generated override with ${result.variableCount} variable(s): ${result.overridePath}`,
    );
  }

  async function createAllDashboardsBackupCommand(): Promise<void> {
    const service = requireService();
    const repository = requireRepository();
    const entries = (await repository.listDashboardRecords()).map((record) => record.entry);
    if (entries.length === 0) {
      throw new Error("No managed dashboards available for backup.");
    }
    const targets = await repository.listAllDeploymentTargets();
    if (targets.length === 0) {
      throw new Error("No deployment targets available.");
    }
    const backup = await service.createBackup(
      targets.map((target) => ({
        instanceName: target.instanceName,
        targetName: target.name,
        entries,
      })),
      "multi-instance",
    );
    selectionState.setBackup(backup.rootPath);
    await refreshAll();
    void vscode.window.showInformationMessage(
      `Created backup ${backup.name} for all dashboards across ${backup.instanceCount} instance(s) and ${backup.targetCount} target(s).`,
    );
  }

  async function createBackupCommand(
    item?:
      | DashboardTreeItem
      | InstanceTreeItem
      | DeploymentTargetTreeItem
      | InstanceTargetDashboardTreeItem,
  ): Promise<void> {
    const service = requireService();

    if (item && isBackupScopeItem(item)) {
      const { scope, specs, label } = await backupSpecsForItem(item);
      const backup = await service.createBackup(specs, scope);
      selectionState.setBackup(backup.rootPath);
      await refreshAll();
      void vscode.window.showInformationMessage(
        `Created ${scope} backup ${backup.name} for ${label}.`,
      );
      return;
    }

    await createAllDashboardsBackupCommand();
  }

  async function setInstanceToken(item?: InstanceTreeItem): Promise<void> {
    if (item) {
      selectionState.setInstance(item.instance.name);
    }
    await actionHandlers.setInstanceToken();
  }

  async function clearInstanceToken(item?: InstanceTreeItem): Promise<void> {
    if (item) {
      selectionState.setInstance(item.instance.name);
    }
    await actionHandlers.clearInstanceToken();
  }

  async function setInstancePassword(item?: InstanceTreeItem): Promise<void> {
    if (item) {
      selectionState.setInstance(item.instance.name);
    }
    await actionHandlers.setInstancePassword();
  }

  async function clearInstancePassword(item?: InstanceTreeItem): Promise<void> {
    if (item) {
      selectionState.setInstance(item.instance.name);
    }
    await actionHandlers.clearInstancePassword();
  }

  async function removeInstance(item?: InstanceTreeItem): Promise<void> {
    if (item) {
      selectionState.setInstance(item.instance.name);
      selectionState.setTarget(undefined);
    }
    await actionHandlers.removeInstance();
  }

  async function removeDeploymentTarget(item?: DeploymentTargetTreeItem): Promise<void> {
    if (item) {
      selectionState.setInstance(item.target.instanceName);
      selectionState.setTarget(item.target.name);
    }
    await actionHandlers.removeDeploymentTarget();
  }

  async function renameDeploymentTarget(item?: DeploymentTargetTreeItem): Promise<void> {
    if (item) {
      selectionState.setInstance(item.target.instanceName);
      selectionState.setTarget(item.target.name);
    }
    await actionHandlers.renameDeploymentTarget();
  }

  async function restoreBackupCommand(
    item?: BackupTreeItem | BackupInstanceTreeItem | BackupTargetTreeItem | BackupDashboardTreeItem,
  ): Promise<void> {
    const service = requireService();
    const backup = item?.backup ?? (await requireBackup());
    const selection = backupRestoreSelectionForItem(item);
    selectionState.setBackup(backup.rootPath);
    const summary = await service.restoreBackup(backup, selection);
    await refreshAll();
    void vscode.window.showInformationMessage(
      `Backup restore complete: ${summary.dashboardCount} dashboard(s) restored across ${summary.targetCount} target(s).`,
    );
  }

  async function openBackupFolder(item?: BackupTreeItem): Promise<void> {
    const backup = item?.backup ?? (await requireBackup());
    selectionState.setBackup(backup.rootPath);
    await vscode.env.openExternal(vscode.Uri.file(backup.rootPath));
  }

  async function deleteBackup(item?: BackupTreeItem): Promise<void> {
    const repository = requireRepository();
    const backup = item?.backup ?? (await requireBackup());
    selectionState.setBackup(backup.rootPath);
    const confirmed = await vscode.window.showWarningMessage(
      `Delete backup ${backup.name}?`,
      { modal: true },
      "Delete",
    );
    if (confirmed !== "Delete") {
      return;
    }

    await repository.deleteBackup(backup.name);
    selectionState.setBackup(undefined);
    await refreshAll();
    void vscode.window.showInformationMessage(`Deleted backup ${backup.name}.`);
  }

  async function deployAllDashboardsCommand(): Promise<void> {
    const service = requireService();
    const repository = requireRepository();
    const entries = await allDashboardEntries();
    const targets = await repository.listAllDeploymentTargets();
    if (targets.length === 0) {
      throw new Error("No deployment targets available.");
    }

    let deployedCount = 0;
    for (const target of targets) {
      const summary = await service.deployDashboards(entries, target.instanceName, target.name);
      deployedCount += summary.dashboardResults.length;
    }

    await refreshAll();
    void vscode.window.showInformationMessage(
      `Deploy complete for all dashboards: ${deployedCount} deployment(s) across ${targets.length} target(s).`,
    );
  }

  await refreshAll();
}

export function deactivate(): void {}
