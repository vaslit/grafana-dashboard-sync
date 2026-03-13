import path from "node:path";

import * as vscode from "vscode";

import { initializeProjectDirectory } from "./core/projectBootstrap";
import { DashboardService } from "./core/dashboardService";
import { selectorNameForEntry } from "./core/manifest";
import { PROJECT_CONFIG_FILE, discoverProjectLayout } from "./core/projectLocator";
import { DEFAULT_DEPLOYMENT_TARGET, ProjectRepository } from "./core/repository";
import {
  BackupRecord,
  DashboardManifestEntry,
  DashboardRecord,
  DeploymentTargetRecord,
  GrafanaDashboardSummary,
  InstanceRecord,
  LogSink,
} from "./core/types";
import { InstanceSecretStorage } from "./instanceSecretStorage";
import { BackupTreeItem, BackupTreeProvider } from "./ui/backupTreeProvider";
import {
  DashboardInstanceTreeItem,
  DashboardTargetTreeItem,
  DashboardTreeItem,
  DashboardTreeProvider,
} from "./ui/dashboardTreeProvider";
import { DetailsViewProvider } from "./ui/detailsViewProvider";
import { FolderPickerPanel } from "./ui/folderPickerPanel";
import { DeploymentTargetTreeItem, InstanceTreeItem, InstanceTreeProvider } from "./ui/instanceTreeProvider";
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

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const workspaceRoot = workspaceRootPath();
  const output = vscode.window.createOutputChannel("Grafana Dashboards");
  const activeInstanceStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
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
    `No Grafana dashboard project found. Run "Initialize Project" or add ${PROJECT_CONFIG_FILE} inside the folder that should contain dashboards/ and instances/.`;

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

  const updateStatusBar = (): void => {
    if (!repository) {
      activeInstanceStatusBar.text = "$(warning) Grafana: no project";
      activeInstanceStatusBar.tooltip = missingProjectMessage();
      activeInstanceStatusBar.command = "grafanaDashboards.initializeProject";
      activeInstanceStatusBar.show();
      return;
    }

    const activeInstanceName = selectionState.selectedInstanceName;
    const activeTargetName = selectionState.selectedTargetName;
    activeInstanceStatusBar.text = activeInstanceName && activeTargetName
      ? `$(server-environment) Grafana: ${activeInstanceName}/${activeTargetName}`
      : "$(circle-slash) Grafana: no target";
    activeInstanceStatusBar.tooltip = activeInstanceName && activeTargetName
      ? `Active deployment target: ${activeInstanceName}/${activeTargetName}\nClick to switch.`
      : "No active deployment target selected.\nClick to choose one.";
    activeInstanceStatusBar.command = "grafanaDashboards.selectActiveInstance";
    activeInstanceStatusBar.show();
  };

  const syncActiveInstance = async (): Promise<void> => {
    if (!repository) {
      selectionState.setInstance(undefined);
      selectionState.setTarget(undefined);
      updateStatusBar();
      return;
    }

    const currentInstanceName = selectionState.selectedInstanceName;
    const currentTargetName = selectionState.selectedTargetName;
    if (currentInstanceName && currentTargetName) {
      const currentInstance = await repository.instanceByName(currentInstanceName);
      const currentTarget = currentInstance
        ? await repository.deploymentTargetByName(currentInstanceName, currentTargetName)
        : undefined;
      if (currentInstance && currentTarget) {
        updateStatusBar();
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
        selectionState.setInstance(storedInstance.name);
        selectionState.setTarget(storedTarget.name);
        updateStatusBar();
        return;
      }
    }

    const instances = await repository.listInstances();
    if (instances.length === 1) {
      const defaultTarget = await repository.deploymentTargetByName(instances[0].name, DEFAULT_DEPLOYMENT_TARGET);
      selectionState.setInstance(instances[0].name);
      selectionState.setTarget(defaultTarget?.name);
    } else {
      selectionState.setInstance(undefined);
      selectionState.setTarget(undefined);
    }
    updateStatusBar();
  };

  const resolveProject = async (): Promise<void> => {
    const layout = await discoverProjectLayout(workspaceRoot);
    repository = layout
      ? new ProjectRepository(layout, {
          resolveToken: async (instanceName?: string) =>
            instanceName ? secretStorage.getInstanceToken(layout.projectRootPath, instanceName) : undefined,
        })
      : undefined;
    if (repository) {
      await repository.migrateWorkspaceConfig();
    }
    service = repository ? new DashboardService(repository, log) : undefined;
    selectionState.setDashboard(undefined);
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

  const dashboardsProvider = new DashboardTreeProvider(() => repository, missingProjectMessage);
  const instancesProvider = new InstanceTreeProvider(() => repository, selectionState, missingProjectMessage);
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
  const folderPickerPanel = new FolderPickerPanel();

  const refreshAll = async (): Promise<void> => {
    await syncActiveInstance();
    dashboardsProvider.refresh();
    instancesProvider.refresh();
    backupsProvider.refresh();
    updateStatusBar();
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
        prompt: "First instance folder to create under instances/",
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
        },
      );
      service = new DashboardService(repository, log);
      selectionState.setDashboard(undefined);
      selectionState.setInstance(initialInstanceName.trim());
      selectionState.setTarget(DEFAULT_DEPLOYMENT_TARGET);
      await refreshAll();
      void vscode.window.showInformationMessage(
        `Initialized Grafana project in ${path.relative(workspaceRoot, nextRepository.projectRootPath) || "."}.`,
      );
    },
    createBackup: async () => {
      const service = requireService();
      const repository = requireRepository();
      const target = await pickRequiredDeploymentTarget();
      const entries = (await repository.listDashboardRecords()).map((record) => record.entry);
      if (entries.length === 0) {
        throw new Error("No managed dashboards available for backup.");
      }
      const backup = await service.createTargetBackup(entries, target.instanceName, target.name, "target");
      selectionState.setBackup(backup.rootPath);
      await refreshAll();
      void vscode.window.showInformationMessage(`Created target backup ${backup.name} for ${target.instanceName}/${target.name}.`);
    },
    createDashboardBackup: async () => {
      const service = requireService();
      const target = await pickRequiredDeploymentTarget();
      const record = await requireDashboardRecord(selectionState.selectedDashboardSelectorName);
      const backup = await service.createTargetBackup([record.entry], target.instanceName, target.name, "dashboard");
      selectionState.setBackup(backup.rootPath);
      await refreshAll();
      void vscode.window.showInformationMessage(`Created dashboard backup ${backup.name} for ${record.selectorName} on ${target.instanceName}/${target.name}.`);
    },
    restoreBackup: async () => {
      const service = requireService();
      const backup = await requireBackup();
      const summary = await service.restoreTargetBackup(backup);
      await refreshAll();
      void vscode.window.showInformationMessage(
        `Backup restore complete: ${summary.dashboardResults.length} dashboard(s) restored to ${backup.instanceName}/${backup.targetName} from ${backup.name}.`,
      );
    },
    renderSelected: async (selectorName?: string) => {
      const service = requireService();
      const target = await pickRequiredDeploymentTarget();
      const record = await requireDashboardRecord(selectorName ?? selectionState.selectedDashboardSelectorName);
      const manifest = await service.renderDashboards([record.entry], target.instanceName, target.name, "dashboard");
      await refreshAll();
      void vscode.window.showInformationMessage(
        `Rendered ${manifest.dashboards.length} dashboard(s) into ${requireRepository().renderRootPath(target.instanceName, target.name)}.`,
      );
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
    openRenderFolder: async (instanceName?: string, targetName?: string) => {
      const repository = requireRepository();
      const target = await pickRequiredDeploymentTarget(instanceName, targetName);
      await vscode.env.openExternal(vscode.Uri.file(repository.renderRootPath(target.instanceName, target.name)));
    },
    openBackupFolder: async () => {
      const backup = await requireBackup();
      await vscode.env.openExternal(vscode.Uri.file(backup.rootPath));
    },
    deleteBackup: async () => {
      const repository = requireRepository();
      const backup = await requireBackup();
      const confirmed = await vscode.window.showWarningMessage(
        `Delete backup ${backup.name}?`,
        { modal: true },
        "Delete",
      );
      if (confirmed !== "Delete") {
        return;
      }

      await repository.deleteBackup(backup.instanceName, backup.targetName, backup.name);
      selectionState.setBackup(undefined);
      await refreshAll();
      void vscode.window.showInformationMessage(`Deleted backup ${backup.name}.`);
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
            label: "Pull now",
            description: "Fetch the selected dashboard JSON files from Grafana into the project",
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
        const target = await pickRequiredDeploymentTarget(instance?.name);
        const summary = await service.pullDashboards(entries, target.instanceName, target.name);
        await refreshAll();
        void vscode.window.showInformationMessage(
          `Dashboards pulled: ${summary.updatedCount} updated, ${summary.skippedCount} unchanged from ${target.instanceName}/${target.name}.`,
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
            prompt: "Instance folder name under instances/",
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
      const rawValue = targetName.trim()
        ? targetName
        : await vscode.window.showInputBox({
            title: `Create deployment target for ${instance.name}`,
            prompt: "Deployment target name under instances/<instance>/targets/",
            value: "default",
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
      selectionState.setTarget(undefined);
      await refreshAll();
      void vscode.window.showInformationMessage(`Removed deployment target ${target.instanceName}/${target.name}.`);
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
      selectorName: string,
      values: Record<string, string>,
    ) => {
      const service = requireService();
      await service.saveDatasourceSelections(
        instanceName,
        selectorName,
        datasourceSelectionsFromFormValues(values, "dashboard"),
      );
      await refreshAll();
      void vscode.window.showInformationMessage(
        `Saved datasources for ${selectorName} on ${instanceName}.`,
      );
    },
    pickPlacementFolder: async (instanceName: string, targetName: string, selectorName: string) => {
      const service = requireService();
      const record = await requireDashboardRecord(selectorName);
      const placement = await service.buildPlacementDetails(instanceName, targetName, record.entry);
      await folderPickerPanel.open(
        {
          instanceName,
          targetName,
          dashboardSelector: selectorName,
          initialPath: placement.overrideFolderPath ?? placement.baseFolderPath,
          baseFolderPath: placement.baseFolderPath,
        },
        {
          listChildren: (parentUid?: string) => service.listFolderChildren(instanceName, parentUid),
          createFolder: (parentUid: string | undefined, title: string) => service.createFolderInParent(instanceName, parentUid, title),
          onConfirm: async (folderPath: string | undefined) => {
            await service.savePlacement(instanceName, targetName, record.entry, folderPath);
            await refreshAll();
          },
        },
      );
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
      await service.checkoutRevision(record.entry, revisionId);
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
      await service.checkoutRevision(record.entry, latest.record.id);
      await refreshAll();
      void vscode.window.showInformationMessage(
        `Latest revision ${latest.record.id} deployed to ${instanceName}/${targetName}.`,
      );
    },
    pullTarget: async (selectorName: string, instanceName: string, targetName: string) => {
      const service = requireService();
      const record = await requireDashboardRecord(selectorName);
      selectionState.setDashboard(selectorName);
      selectionState.setInstance(instanceName);
      selectionState.setTarget(targetName);
      const summary = await service.pullDashboards([record.entry], instanceName, targetName);
      await refreshAll();
      void vscode.window.showInformationMessage(
        `Pull complete: ${summary.updatedCount} updated, ${summary.skippedCount} unchanged from ${instanceName}/${targetName}.`,
      );
    },
    setActiveTarget: async (instanceName: string, targetName: string) => {
      selectionState.setInstance(instanceName);
      selectionState.setTarget(targetName);
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

      const target = await pickRequiredDeploymentTarget(instanceName, targetName);
      const summary = await service.pullDashboards(entries, target.instanceName, target.name);
      await refreshAll();
      void vscode.window.showInformationMessage(
        `Pull complete: ${summary.updatedCount} updated, ${summary.skippedCount} unchanged from ${target.instanceName}/${target.name}.`,
      );
    },
    deploySelected: async () => {
      await deployDashboards();
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
      await refreshAll();
      void vscode.window.showInformationMessage(
        result.removedPaths.length > 0
          ? `Removed ${selectorName} and deleted ${result.removedPaths.length} local file(s).`
          : `Removed ${selectorName} from the manifest.`,
      );
    },
    selectActiveInstance: async () => {
      const repository = requireRepository();
      const targets = await repository.listAllDeploymentTargets();
      const picks = [
        ...targets.map((target) => ({
          label: `${target.instanceName}/${target.name}`,
          description:
            target.instanceName === selectionState.selectedInstanceName && target.name === selectionState.selectedTargetName
              ? "Active"
              : undefined,
          detail: target.defaultsExists ? "Target defaults present" : "Target defaults missing",
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
        selectionState.setInstance(undefined);
        selectionState.setTarget(undefined);
        return;
      }

      selectionState.setInstance(selection.instanceName);
      selectionState.setTarget(selection.targetName);
    },
  };
  detailsProvider = new DetailsViewProvider(() => repository, () => service, selectionState, actionHandlers, missingProjectMessage);

  const dashboardSelectionDisposable = dashboardTreeView.onDidChangeSelection((event) => {
    const item = event.selection[0];
    if (item instanceof DashboardTreeItem) {
      selectionState.setDashboard(item.record.selectorName);
      instancesProvider.refresh();
      void detailsProvider.refresh();
    } else if (item instanceof DashboardInstanceTreeItem) {
      selectionState.setDashboard(item.record.selectorName);
      selectionState.setInstance(item.instance.name);
      void repository?.deploymentTargetByName(item.instance.name, DEFAULT_DEPLOYMENT_TARGET).then((target) => {
        selectionState.setTarget(target?.name);
      });
      instancesProvider.refresh();
      void detailsProvider.refresh();
    } else if (item instanceof DashboardTargetTreeItem) {
      selectionState.setDashboard(item.record.selectorName);
      selectionState.setInstance(item.target.instanceName);
      selectionState.setTarget(item.target.name);
      instancesProvider.refresh();
      void detailsProvider.refresh();
    }
  });

  const instanceSelectionDisposable = instanceTreeView.onDidChangeSelection((event) => {
    const item = event.selection[0];
    if (item instanceof InstanceTreeItem) {
      selectionState.setInstance(item.instance.name);
      void repository?.deploymentTargetByName(item.instance.name, DEFAULT_DEPLOYMENT_TARGET).then((target) => {
        selectionState.setTarget(target?.name);
      });
      void detailsProvider.refresh();
    } else if (item instanceof DeploymentTargetTreeItem) {
      selectionState.setInstance(item.target.instanceName);
      selectionState.setTarget(item.target.name);
      void detailsProvider.refresh();
    }
  });

  const backupSelectionDisposable = backupTreeView.onDidChangeSelection((event) => {
    const item = event.selection[0];
    if (item instanceof BackupTreeItem) {
      selectionState.setBackup(item.backup.rootPath);
      void detailsProvider.refresh();
    }
  });

  const selectionStateDisposable = selectionState.onDidChange(() => {
    if (repository) {
      void context.workspaceState.update(
        activeTargetStorageKey(repository.projectRootPath),
        selectionState.selectedInstanceName && selectionState.selectedTargetName
          ? `${selectionState.selectedInstanceName}/${selectionState.selectedTargetName}`
          : undefined,
      );
    }
    instancesProvider.refresh();
    updateStatusBar();
    void detailsProvider.refresh();
  });

  context.subscriptions.push(
    output,
    activeInstanceStatusBar,
    dashboardTreeView,
    instanceTreeView,
    backupTreeView,
    dashboardSelectionDisposable,
    instanceSelectionDisposable,
    backupSelectionDisposable,
    selectionStateDisposable,
    vscode.window.registerWebviewViewProvider("grafanaDashboards.details", detailsProvider),
    vscode.commands.registerCommand("grafanaDashboards.initializeProject", () => actionHandlers.initializeProject()),
    vscode.commands.registerCommand("grafanaDashboards.createBackup", () => actionHandlers.createBackup()),
    vscode.commands.registerCommand("grafanaDashboards.createDashboardBackup", (item?: DashboardTreeItem) => createDashboardBackup(item)),
    vscode.commands.registerCommand("grafanaDashboards.deployBackup", (item?: BackupTreeItem) => restoreBackup(item)),
    vscode.commands.registerCommand("grafanaDashboards.openBackupFolder", (item?: BackupTreeItem) =>
      openBackupFolder(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.deleteBackup", (item?: BackupTreeItem) => deleteBackup(item)),
    vscode.commands.registerCommand("grafanaDashboards.selectActiveInstance", () => actionHandlers.selectActiveInstance()),
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
    vscode.commands.registerCommand("grafanaDashboards.pickPlacementFolder", async () => {
      const target = await requireDeploymentTarget();
      const record = await requireDashboardRecord();
      await actionHandlers.pickPlacementFolder(target.instanceName, target.name, record.selectorName);
    }),
    vscode.commands.registerCommand("grafanaDashboards.removeInstance", (item?: InstanceTreeItem) => removeInstance(item)),
    vscode.commands.registerCommand("grafanaDashboards.removeDeploymentTarget", (item?: DeploymentTargetTreeItem) =>
      removeDeploymentTarget(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.setInstanceToken", (item?: InstanceTreeItem) =>
      setInstanceToken(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.clearInstanceToken", (item?: InstanceTreeItem) =>
      clearInstanceToken(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.openDashboardJson", (item?: DashboardTreeItem) =>
      openDashboardJson(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.removeDashboard", (item?: DashboardTreeItem) =>
      removeDashboard(item),
    ),
    vscode.commands.registerCommand(
      "grafanaDashboards.pullDashboard",
      (item?: DashboardTreeItem | DashboardInstanceTreeItem | DashboardTargetTreeItem | InstanceTreeItem | DeploymentTargetTreeItem) =>
      pullDashboards(item),
    ),
    vscode.commands.registerCommand("grafanaDashboards.pullAllDashboards", (item?: InstanceTreeItem | DeploymentTargetTreeItem) =>
      pullAllDashboards(item),
    ),
    vscode.commands.registerCommand(
      "grafanaDashboards.renderDashboard",
      (item?: DashboardTreeItem | DashboardInstanceTreeItem | DashboardTargetTreeItem) =>
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
    vscode.commands.registerCommand("grafanaDashboards.openRenderFolder", (item?: InstanceTreeItem | DeploymentTargetTreeItem) =>
      openRenderFolder(item),
    ),
    vscode.commands.registerCommand(
      "grafanaDashboards.deployDashboard",
      (item?: DashboardTreeItem | DashboardInstanceTreeItem | DashboardTargetTreeItem | InstanceTreeItem | DeploymentTargetTreeItem) =>
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
  ): item is DashboardTreeItem | DashboardInstanceTreeItem | DashboardTargetTreeItem {
    return item instanceof DashboardTreeItem || item instanceof DashboardInstanceTreeItem || item instanceof DashboardTargetTreeItem;
  }

  async function dashboardScopeContext(
    item: DashboardTreeItem | DashboardInstanceTreeItem | DashboardTargetTreeItem,
  ): Promise<{
    record: DashboardRecord;
    targets: DeploymentTargetRecord[];
    label: string;
  }> {
    const repository = requireRepository();

    if (item instanceof DashboardTargetTreeItem) {
      return {
        record: item.record,
        targets: [item.target],
        label: `${item.record.selectorName} on ${item.target.instanceName}/${item.target.name}`,
      };
    }

    if (item instanceof DashboardInstanceTreeItem) {
      const targets = await repository.listDeploymentTargets(item.instance.name);
      if (targets.length === 0) {
        throw new Error(`No deployment targets found for ${item.instance.name}.`);
      }
      return {
        record: item.record,
        targets,
        label: `${item.record.selectorName} on ${item.instance.name}`,
      };
    }

    const targets = await repository.listAllDeploymentTargets();
    if (targets.length === 0) {
      throw new Error("No deployment targets available.");
    }
    return {
      record: item.record,
      targets,
      label: `${item.record.selectorName} across all instances`,
    };
  }

  async function pickDashboardEntries(
    item?: DashboardTreeItem | DashboardInstanceTreeItem | DashboardTargetTreeItem,
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

  async function pickInstanceIfNeeded(explicitInstanceName?: string): Promise<InstanceRecord | undefined> {
    const repository = requireRepository();
    if (explicitInstanceName) {
      return requireInstance(explicitInstanceName);
    }

    if (selectionState.selectedInstanceName) {
      return requireInstance(selectionState.selectedInstanceName);
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

    if (selectionState.selectedInstanceName && selectionState.selectedTargetName) {
      return requireDeploymentTarget(selectionState.selectedInstanceName, selectionState.selectedTargetName);
    }

    const targets = await repository.listAllDeploymentTargets();
    if (targets.length === 0) {
      throw new Error("No deployment targets available.");
    }

    const selection = await vscode.window.showQuickPick(
      targets.map((target) => ({
        label: `${target.instanceName}/${target.name}`,
        description: target.defaultsExists ? "Target defaults present" : "Target defaults missing",
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

  async function openDashboardJson(item?: DashboardTreeItem): Promise<void> {
    const record = item?.record ?? (await requireDashboardRecord());
    await openFile(record.absolutePath);
  }

  async function removeDashboard(item?: DashboardTreeItem): Promise<void> {
    const selectorName = item?.record.selectorName ?? selectionState.selectedDashboardSelectorName;
    if (!selectorName) {
      throw new Error("Select a dashboard first.");
    }
    selectionState.setDashboard(selectorName);
    await actionHandlers.removeDashboard();
  }

  async function pullDashboards(
    item?: DashboardTreeItem | DashboardInstanceTreeItem | DashboardTargetTreeItem | InstanceTreeItem | DeploymentTargetTreeItem,
  ): Promise<void> {
    const service = requireService();
    if (isDashboardScopeItem(item)) {
      const { record, targets, label } = await dashboardScopeContext(item);
      let updatedCount = 0;
      let skippedCount = 0;

      for (const target of targets) {
        const summary = await service.pullDashboards([record.entry], target.instanceName, target.name);
        updatedCount += summary.updatedCount;
        skippedCount += summary.skippedCount;
      }

      await refreshAll();
      void vscode.window.showInformationMessage(
        `Pull complete for ${label}: ${updatedCount} updated, ${skippedCount} unchanged across ${targets.length} target(s).`,
      );
      return;
    }

    const explicitDashboardItem = item instanceof DashboardTreeItem ? item : undefined;
    const explicitInstanceName =
      item instanceof InstanceTreeItem ? item.instance.name : item instanceof DeploymentTargetTreeItem ? item.target.instanceName : undefined;
    const explicitTargetName = item instanceof DeploymentTargetTreeItem ? item.target.name : undefined;
    const entries = await pickDashboardEntries(explicitDashboardItem);
    const target = await pickRequiredDeploymentTarget(explicitInstanceName, explicitTargetName);
    const summary = await service.pullDashboards(entries, target.instanceName, target.name);
    await refreshAll();
    void vscode.window.showInformationMessage(
      `Pull complete: ${summary.updatedCount} updated, ${summary.skippedCount} unchanged from ${target.instanceName}/${target.name}.`,
    );
  }

  async function renderDashboardCommand(
    item?: DashboardTreeItem | DashboardInstanceTreeItem | DashboardTargetTreeItem,
  ): Promise<void> {
    const service = requireService();
    if (item) {
      const { record, targets, label } = await dashboardScopeContext(item);

      for (const target of targets) {
        await service.renderDashboards([record.entry], target.instanceName, target.name, "dashboard");
      }

      await refreshAll();
      void vscode.window.showInformationMessage(
        `Render complete for ${label}: ${targets.length} target(s) updated.`,
      );
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

  async function pullAllDashboards(item?: InstanceTreeItem | DeploymentTargetTreeItem): Promise<void> {
    const instanceName =
      item instanceof InstanceTreeItem ? item.instance.name : item instanceof DeploymentTargetTreeItem ? item.target.instanceName : undefined;
    const targetName = item instanceof DeploymentTargetTreeItem ? item.target.name : undefined;
    await actionHandlers.pullAllDashboards(instanceName, targetName);
  }

  async function deployDashboards(
    item?: DashboardTreeItem | DashboardInstanceTreeItem | DashboardTargetTreeItem | InstanceTreeItem | DeploymentTargetTreeItem,
  ): Promise<void> {
    const service = requireService();
    if (isDashboardScopeItem(item)) {
      const { record, targets, label } = await dashboardScopeContext(item);
      let deployedCount = 0;

      for (const target of targets) {
        const summary = await service.deployDashboards([record.entry], target.instanceName, target.name);
        deployedCount += summary.dashboardResults.length;
      }

      await refreshAll();
      void vscode.window.showInformationMessage(
        `Deploy complete for ${label}: ${deployedCount} deployment(s) across ${targets.length} target(s).`,
      );
      return;
    }

    const explicitDashboardItem = item instanceof DashboardTreeItem ? item : undefined;
    const explicitInstanceName =
      item instanceof InstanceTreeItem ? item.instance.name : item instanceof DeploymentTargetTreeItem ? item.target.instanceName : undefined;
    const explicitTargetName = item instanceof DeploymentTargetTreeItem ? item.target.name : undefined;
    const entries = await pickDashboardEntries(explicitDashboardItem);
    const target = await pickRequiredDeploymentTarget(explicitInstanceName, explicitTargetName);
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
          ? await requireDeploymentTarget(item.instance.name, DEFAULT_DEPLOYMENT_TARGET)
          : await requireDeploymentTarget();
    const record = await requireDashboardRecord();
    const overridePath = repository.dashboardOverridesFilePath(record.entry);
    const existing = await repository.readTextFileIfExists(overridePath);
    if (!existing) {
      await repository.saveTargetOverrideFile(target.instanceName, target.name, record.entry, {
        variables: {},
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

  async function createDashboardBackup(item?: DashboardTreeItem): Promise<void> {
    if (item) {
      selectionState.setDashboard(item.record.selectorName);
    }
    await actionHandlers.createDashboardBackup();
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

  async function restoreBackup(item?: BackupTreeItem): Promise<void> {
    if (item) {
      selectionState.setBackup(item.backup.rootPath);
    }
    await actionHandlers.restoreBackup();
  }

  async function openBackupFolder(item?: BackupTreeItem): Promise<void> {
    if (item) {
      selectionState.setBackup(item.backup.rootPath);
    }
    await actionHandlers.openBackupFolder();
  }

  async function deleteBackup(item?: BackupTreeItem): Promise<void> {
    if (item) {
      selectionState.setBackup(item.backup.rootPath);
    }
    await actionHandlers.deleteBackup();
  }

  await refreshAll();
}

export function deactivate(): void {}
