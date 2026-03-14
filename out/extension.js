"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const node_path_1 = __importDefault(require("node:path"));
const vscode = __importStar(require("vscode"));
const projectBootstrap_1 = require("./core/projectBootstrap");
const dashboardService_1 = require("./core/dashboardService");
const manifest_1 = require("./core/manifest");
const projectLocator_1 = require("./core/projectLocator");
const repository_1 = require("./core/repository");
const instanceSecretStorage_1 = require("./instanceSecretStorage");
const backupTreeProvider_1 = require("./ui/backupTreeProvider");
const dashboardTreeProvider_1 = require("./ui/dashboardTreeProvider");
const detailsViewProvider_1 = require("./ui/detailsViewProvider");
const folderPickerPanel_1 = require("./ui/folderPickerPanel");
const instanceTreeProvider_1 = require("./ui/instanceTreeProvider");
const selectionState_1 = require("./ui/selectionState");
function workspaceRootPath() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        throw new Error("Open a VS Code workspace folder first.");
    }
    return folder.uri.fsPath;
}
function inputValidator(value, fieldName) {
    return value.trim() ? undefined : `${fieldName} must not be empty.`;
}
function toRemoteDashboardPick(dashboard) {
    return {
        label: dashboard.title,
        description: dashboard.folderTitle || "Root",
        detail: `UID: ${dashboard.uid}${dashboard.url ? ` | ${dashboard.url}` : ""}`,
        dashboard,
    };
}
function datasourceSelectionsFromFormValues(values, prefix) {
    const indexes = new Set(Object.keys(values)
        .filter((key) => key.startsWith(`${prefix}_current_source_name__`))
        .map((key) => key.slice(`${prefix}_current_source_name__`.length)));
    const selections = [];
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
async function activate(context) {
    const workspaceRoot = workspaceRootPath();
    const output = vscode.window.createOutputChannel("Grafana Dashboards");
    const activeInstanceStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    const secretStorage = new instanceSecretStorage_1.InstanceSecretStorage(context.secrets);
    const log = {
        info(message) {
            output.appendLine(message);
        },
        error(message) {
            output.appendLine(`ERROR: ${message}`);
        },
    };
    const selectionState = new selectionState_1.SelectionState();
    let repository;
    let service;
    const missingProjectMessage = () => `No Grafana dashboard project found. Run "Initialize Project" or add ${projectLocator_1.PROJECT_CONFIG_FILE} inside the folder that should contain dashboards/, backups/, and renders/.`;
    const requireRepository = () => {
        if (!repository) {
            throw new Error(missingProjectMessage());
        }
        return repository;
    };
    const requireService = () => {
        if (!service) {
            throw new Error(missingProjectMessage());
        }
        return service;
    };
    const activeTargetStorageKey = (projectRootPath) => `grafanaDashboards.activeTarget:${projectRootPath}`;
    const updateStatusBar = () => {
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
    const syncActiveInstance = async () => {
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
        const storedTargetKey = context.workspaceState.get(activeTargetStorageKey(repository.projectRootPath));
        if (storedTargetKey) {
            const [storedInstanceName, storedTargetName] = storedTargetKey.split("/", 2);
            const storedInstance = storedInstanceName ? await repository.instanceByName(storedInstanceName) : undefined;
            const storedTarget = storedInstance && storedTargetName
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
            const defaultTarget = await repository.deploymentTargetByName(instances[0].name, repository_1.DEFAULT_DEPLOYMENT_TARGET);
            selectionState.setInstance(instances[0].name);
            selectionState.setTarget(defaultTarget?.name);
        }
        else {
            selectionState.setInstance(undefined);
            selectionState.setTarget(undefined);
        }
        updateStatusBar();
    };
    const resolveProject = async () => {
        const layout = await (0, projectLocator_1.discoverProjectLayout)(workspaceRoot);
        repository = layout
            ? new repository_1.ProjectRepository(layout, {
                resolveToken: async (instanceName) => instanceName ? secretStorage.getInstanceToken(layout.projectRootPath, instanceName) : undefined,
            })
            : undefined;
        if (repository) {
            await repository.migrateWorkspaceConfig();
        }
        service = repository ? new dashboardService_1.DashboardService(repository, log) : undefined;
        selectionState.setDashboard(undefined);
        selectionState.setBackup(undefined);
        if (!layout) {
            log.info(missingProjectMessage());
            await syncActiveInstance();
            return;
        }
        const relativeProjectPath = node_path_1.default.relative(workspaceRoot, layout.projectRootPath) || ".";
        log.info(`Using Grafana project: ${relativeProjectPath}`);
        if (layout.selectionNote) {
            log.info(layout.selectionNote);
        }
        await syncActiveInstance();
    };
    await resolveProject();
    const dashboardsProvider = new dashboardTreeProvider_1.DashboardTreeProvider(() => repository, missingProjectMessage);
    const instancesProvider = new instanceTreeProvider_1.InstanceTreeProvider(() => repository, missingProjectMessage);
    const backupsProvider = new backupTreeProvider_1.BackupTreeProvider(() => repository, missingProjectMessage);
    const dashboardTreeView = vscode.window.createTreeView("grafanaDashboards.dashboards", {
        treeDataProvider: dashboardsProvider,
    });
    const instanceTreeView = vscode.window.createTreeView("grafanaDashboards.instances", {
        treeDataProvider: instancesProvider,
    });
    const backupTreeView = vscode.window.createTreeView("grafanaDashboards.backups", {
        treeDataProvider: backupsProvider,
    });
    let detailsProvider;
    const folderPickerPanel = new folderPickerPanel_1.FolderPickerPanel();
    const refreshAll = async () => {
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
                void vscode.window.showInformationMessage(`Grafana project already initialized at ${node_path_1.default.relative(workspaceRoot, repository.projectRootPath) || "."}.`);
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
                    if (trimmed === "." ||
                        trimmed.startsWith("/") ||
                        trimmed.startsWith("../") ||
                        trimmed.includes("/../")) {
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
            const nextRepository = await (0, projectBootstrap_1.initializeProjectDirectory)(workspaceRoot, relativeProjectPath, initialInstanceName);
            repository = new repository_1.ProjectRepository({
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
            }, {
                resolveToken: async (instanceName) => instanceName ? secretStorage.getInstanceToken(nextRepository.projectRootPath, instanceName) : undefined,
            });
            service = new dashboardService_1.DashboardService(repository, log);
            selectionState.setDashboard(undefined);
            selectionState.setInstance(initialInstanceName.trim());
            selectionState.setTarget(repository_1.DEFAULT_DEPLOYMENT_TARGET);
            await refreshAll();
            void vscode.window.showInformationMessage(`Initialized Grafana project in ${node_path_1.default.relative(workspaceRoot, nextRepository.projectRootPath) || "."}.`);
        },
        renderSelected: async (selectorName) => {
            const service = requireService();
            const target = await pickRequiredDeploymentTarget();
            const record = await requireDashboardRecord(selectorName ?? selectionState.selectedDashboardSelectorName);
            const manifest = await service.renderDashboards([record.entry], target.instanceName, target.name, "dashboard");
            await refreshAll();
            void vscode.window.showInformationMessage(`Rendered ${manifest.dashboards.length} dashboard(s) into ${requireRepository().renderRootPath(target.instanceName, target.name)}.`);
        },
        renderTarget: async (instanceName, targetName) => {
            const repository = requireRepository();
            const service = requireService();
            const target = await pickRequiredDeploymentTarget(instanceName, targetName);
            const entries = (await repository.listDashboardRecords()).map((record) => record.entry);
            if (entries.length === 0) {
                throw new Error("No dashboards available in the manifest.");
            }
            const manifest = await service.renderDashboards(entries, target.instanceName, target.name, "target");
            await refreshAll();
            void vscode.window.showInformationMessage(`Rendered ${manifest.dashboards.length} dashboard(s) into ${repository.renderRootPath(target.instanceName, target.name)}.`);
        },
        renderInstance: async (instanceName) => {
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
            void vscode.window.showInformationMessage(`Rendered ${entries.length} dashboard(s) for ${targets.length} target(s) in instance ${instance.name}.`);
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
            void vscode.window.showInformationMessage(`Rendered ${entries.length} dashboard(s) for ${renderedTargets} target(s) across all instances.`);
        },
        openRenderFolder: async (instanceName, targetName) => {
            const repository = requireRepository();
            const target = await pickRequiredDeploymentTarget(instanceName, targetName);
            await vscode.env.openExternal(vscode.Uri.file(repository.renderRootPath(target.instanceName, target.name)));
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
            const picks = await vscode.window.showQuickPick(availableDashboards.map((dashboard) => toRemoteDashboardPick(dashboard)), {
                canPickMany: true,
                title: "Add dashboards from Grafana",
                placeHolder: "Select dashboards to add to the project",
            });
            if (!picks || picks.length === 0) {
                return;
            }
            const selectedDashboards = picks.map((pick) => pick.dashboard);
            const entries = await service.suggestManifestEntriesForRemoteDashboards(selectedDashboards);
            await repository.addManifestEntries(entries);
            const firstSelectorName = (0, manifest_1.selectorNameForEntry)(entries[0]);
            selectionState.setDashboard(firstSelectorName);
            await refreshAll();
            const nextAction = await vscode.window.showQuickPick([
                {
                    label: "Pull now",
                    description: "Fetch the selected dashboard JSON files from Grafana into the project",
                    action: "pull",
                },
                {
                    label: "Open later",
                    description: "Keep only the project entries for now",
                    action: "skip",
                },
            ], {
                title: `${entries.length} dashboard(s) added`,
                placeHolder: "Choose what to do next",
            });
            if (nextAction?.action === "pull") {
                const target = await pickRequiredDeploymentTarget(instance?.name);
                const summary = await service.pullDashboards(entries, target.instanceName, target.name);
                await refreshAll();
                void vscode.window.showInformationMessage(`Dashboards pulled: ${summary.updatedCount} updated, ${summary.skippedCount} unchanged from ${target.instanceName}/${target.name}.`);
                return;
            }
            void vscode.window.showInformationMessage(`${entries.length} dashboard(s) added to the project.`);
        },
        createInstance: async (instanceName) => {
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
            selectionState.setTarget(repository_1.DEFAULT_DEPLOYMENT_TARGET);
            await refreshAll();
        },
        createDeploymentTarget: async (instanceName, targetName) => {
            const repository = requireRepository();
            const service = requireService();
            const instance = await requireInstance(instanceName || selectionState.selectedInstanceName);
            const rawValue = targetName.trim()
                ? targetName
                : await vscode.window.showInputBox({
                    title: `Create deployment target for ${instance.name}`,
                    prompt: "Deployment target name for this instance",
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
            const confirmed = await vscode.window.showWarningMessage(`Remove deployment target ${target.instanceName}/${target.name}?`, { modal: true }, "Remove");
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
            const confirmed = await vscode.window.showWarningMessage(`Remove instance ${instance.name}?`, { modal: true }, "Remove");
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
        saveManifest: async (currentSelector, values) => {
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
        saveInstanceEnv: async (instanceName, values) => {
            const repository = requireRepository();
            const service = requireService();
            await repository.saveInstanceEnvValues(instanceName, values);
            await service.autoMatchDatasourceCatalogForInstance(instanceName).catch(() => { });
            await refreshAll();
            void vscode.window.showInformationMessage(`Saved env for ${instanceName}.`);
        },
        saveDashboardDatasourceMappings: async (instanceName, selectorName, values) => {
            const service = requireService();
            await service.saveDatasourceSelections(instanceName, selectorName, datasourceSelectionsFromFormValues(values, "dashboard"));
            await refreshAll();
            void vscode.window.showInformationMessage(`Saved datasources for ${selectorName} on ${instanceName}.`);
        },
        pickPlacementFolder: async (instanceName, targetName, selectorName) => {
            const service = requireService();
            const record = await requireDashboardRecord(selectorName);
            const placement = await service.buildPlacementDetails(instanceName, targetName, record.entry);
            await folderPickerPanel.open({
                instanceName,
                targetName,
                dashboardSelector: selectorName,
                initialPath: placement.overrideFolderPath ?? placement.baseFolderPath,
                baseFolderPath: placement.baseFolderPath,
            }, {
                listChildren: (parentUid) => service.listFolderChildren(instanceName, parentUid),
                createFolder: (parentUid, title) => service.createFolderInParent(instanceName, parentUid, title),
                onConfirm: async (folderPath) => {
                    await service.savePlacement(instanceName, targetName, record.entry, folderPath);
                    await refreshAll();
                },
            });
        },
        savePlacement: async (instanceName, targetName, selectorName, values) => {
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
            await requireService().autoMatchDatasourceCatalogForInstance(instance.name).catch(() => { });
            await refreshAll();
            void vscode.window.showInformationMessage(`Stored token for ${instance.name} in VS Code Secret Storage.`);
        },
        clearInstanceToken: async () => {
            const repository = requireRepository();
            const instance = await requireInstance(selectionState.selectedInstanceName);
            const confirmed = await vscode.window.showWarningMessage(`Clear stored token for ${instance.name}?`, { modal: true }, "Clear");
            if (confirmed !== "Clear") {
                return;
            }
            await secretStorage.deleteInstanceToken(repository.projectRootPath, instance.name);
            await refreshAll();
            void vscode.window.showInformationMessage(`Cleared stored token for ${instance.name}.`);
        },
        saveOverride: async (instanceName, targetName, selectorName, values) => {
            const service = requireService();
            const record = await requireDashboardRecord(selectorName);
            const overridePath = await service.saveOverrideFromForm(instanceName, targetName, record.entry, values);
            await refreshAll();
            void vscode.window.showInformationMessage(`Saved override file: ${overridePath}`);
        },
        createRevision: async (selectorName) => {
            const service = requireService();
            const record = await requireDashboardRecord(selectorName);
            const revision = await service.createRevisionFromWorkingCopy(record.entry);
            await refreshAll();
            void vscode.window.showInformationMessage(`Created revision ${revision.id} from working copy.`);
        },
        checkoutRevision: async (selectorName, revisionId) => {
            const service = requireService();
            const record = await requireDashboardRecord(selectorName);
            const revision = await service.checkoutRevision(record.entry, revisionId);
            selectionState.setDashboard(selectorName);
            await refreshAll();
            void vscode.window.showInformationMessage(`Checked out revision ${revision.id}.`);
        },
        deployRevision: async (selectorName, revisionId, instanceName, targetName) => {
            const service = requireService();
            const record = await requireDashboardRecord(selectorName);
            const summary = await service.deployRevision(record.entry, revisionId, instanceName, targetName);
            await service.checkoutRevision(record.entry, revisionId);
            await refreshAll();
            void vscode.window.showInformationMessage(`Revision deploy complete: ${summary.dashboardResults.length} dashboard(s) deployed to ${instanceName}/${targetName}.`);
        },
        deployLatestRevision: async (selectorName, instanceName, targetName) => {
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
            void vscode.window.showInformationMessage(`Latest revision ${latest.record.id} deployed to ${instanceName}/${targetName}.`);
        },
        pullTarget: async (selectorName, instanceName, targetName) => {
            const service = requireService();
            const record = await requireDashboardRecord(selectorName);
            selectionState.setDashboard(selectorName);
            selectionState.setInstance(instanceName);
            selectionState.setTarget(targetName);
            const summary = await service.pullDashboards([record.entry], instanceName, targetName);
            await refreshAll();
            void vscode.window.showInformationMessage(`Pull complete: ${summary.updatedCount} updated, ${summary.skippedCount} unchanged from ${instanceName}/${targetName}.`);
        },
        setActiveTarget: async (instanceName, targetName) => {
            selectionState.setInstance(instanceName);
            selectionState.setTarget(targetName);
            await refreshAll();
        },
        pullSelected: async () => {
            await pullDashboards();
        },
        pullAllDashboards: async (instanceName, targetName) => {
            const repository = requireRepository();
            const service = requireService();
            const entries = (await repository.listDashboardRecords()).map((record) => record.entry);
            if (entries.length === 0) {
                throw new Error("No dashboards available in the manifest.");
            }
            const target = await pickRequiredDeploymentTarget(instanceName, targetName);
            const summary = await service.pullDashboards(entries, target.instanceName, target.name);
            await refreshAll();
            void vscode.window.showInformationMessage(`Pull complete: ${summary.updatedCount} updated, ${summary.skippedCount} unchanged from ${target.instanceName}/${target.name}.`);
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
            void vscode.window.showInformationMessage(`Generated override with ${result.variableCount} variable(s): ${result.overridePath}`);
        },
        removeDashboard: async () => {
            const repository = requireRepository();
            const selectorName = selectionState.selectedDashboardSelectorName;
            if (!selectorName) {
                return;
            }
            const confirmed = await vscode.window.showWarningMessage(`Remove ${selectorName} from the project?`, { modal: true }, "Remove Entry Only", "Remove Entry And Files");
            if (!confirmed) {
                return;
            }
            const result = await repository.removeDashboardFromProject(selectorName, {
                deleteFiles: confirmed === "Remove Entry And Files",
            });
            selectionState.setDashboard(undefined);
            await refreshAll();
            void vscode.window.showInformationMessage(result.removedPaths.length > 0
                ? `Removed ${selectorName} and deleted ${result.removedPaths.length} local file(s).`
                : `Removed ${selectorName} from the manifest.`);
        },
        selectActiveInstance: async () => {
            const repository = requireRepository();
            const targets = await repository.listAllDeploymentTargets();
            const picks = [
                ...targets.map((target) => ({
                    label: `${target.instanceName}/${target.name}`,
                    description: target.instanceName === selectionState.selectedInstanceName && target.name === selectionState.selectedTargetName
                        ? "Active"
                        : undefined,
                    action: "select",
                    instanceName: target.instanceName,
                    targetName: target.name,
                })),
                {
                    label: "$(add) Create deployment target",
                    description: "Create a new deployment target and make it active",
                    action: "create",
                    instanceName: undefined,
                    targetName: undefined,
                },
                {
                    label: "$(circle-slash) Clear active target",
                    description: "Unset the default target for deploy/override flows",
                    action: "clear",
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
    detailsProvider = new detailsViewProvider_1.DetailsViewProvider(() => repository, () => service, selectionState, actionHandlers, missingProjectMessage);
    const dashboardSelectionDisposable = dashboardTreeView.onDidChangeSelection((event) => {
        const item = event.selection[0];
        if (item instanceof dashboardTreeProvider_1.DashboardTreeItem) {
            selectionState.setDashboard(item.record.selectorName);
            instancesProvider.refresh();
            void detailsProvider.refresh();
        }
        else if (item instanceof dashboardTreeProvider_1.DashboardInstanceTreeItem) {
            selectionState.setDashboard(item.record.selectorName);
            selectionState.setInstance(item.instance.name);
            void repository?.deploymentTargetByName(item.instance.name, repository_1.DEFAULT_DEPLOYMENT_TARGET).then((target) => {
                selectionState.setTarget(target?.name);
            });
            instancesProvider.refresh();
            void detailsProvider.refresh();
        }
        else if (item instanceof dashboardTreeProvider_1.DashboardTargetTreeItem) {
            selectionState.setDashboard(item.record.selectorName);
            selectionState.setInstance(item.target.instanceName);
            selectionState.setTarget(item.target.name);
            instancesProvider.refresh();
            void detailsProvider.refresh();
        }
    });
    const instanceSelectionDisposable = instanceTreeView.onDidChangeSelection((event) => {
        const item = event.selection[0];
        if (item instanceof instanceTreeProvider_1.InstanceTreeItem) {
            selectionState.setInstance(item.instance.name);
            void repository?.deploymentTargetByName(item.instance.name, repository_1.DEFAULT_DEPLOYMENT_TARGET).then((target) => {
                selectionState.setTarget(target?.name);
            });
            void detailsProvider.refresh();
        }
        else if (item instanceof instanceTreeProvider_1.DeploymentTargetTreeItem) {
            selectionState.setInstance(item.target.instanceName);
            selectionState.setTarget(item.target.name);
            void detailsProvider.refresh();
        }
        else if (item instanceof instanceTreeProvider_1.InstanceTargetDashboardTreeItem) {
            selectionState.setDashboard(item.record.selectorName);
            selectionState.setInstance(item.target.instanceName);
            selectionState.setTarget(item.target.name);
            void detailsProvider.refresh();
        }
    });
    const backupSelectionDisposable = backupTreeView.onDidChangeSelection((event) => {
        const item = event.selection[0];
        if (item instanceof backupTreeProvider_1.BackupTreeItem ||
            item instanceof backupTreeProvider_1.BackupInstanceTreeItem ||
            item instanceof backupTreeProvider_1.BackupTargetTreeItem ||
            item instanceof backupTreeProvider_1.BackupDashboardTreeItem) {
            selectionState.setBackup(item.backup.rootPath);
            void detailsProvider.refresh();
        }
    });
    const selectionStateDisposable = selectionState.onDidChange(() => {
        if (repository) {
            void context.workspaceState.update(activeTargetStorageKey(repository.projectRootPath), selectionState.selectedInstanceName && selectionState.selectedTargetName
                ? `${selectionState.selectedInstanceName}/${selectionState.selectedTargetName}`
                : undefined);
        }
        instancesProvider.refresh();
        updateStatusBar();
        void detailsProvider.refresh();
    });
    context.subscriptions.push(output, activeInstanceStatusBar, dashboardTreeView, instanceTreeView, backupTreeView, dashboardSelectionDisposable, instanceSelectionDisposable, backupSelectionDisposable, selectionStateDisposable, vscode.window.registerWebviewViewProvider("grafanaDashboards.details", detailsProvider), vscode.commands.registerCommand("grafanaDashboards.initializeProject", () => actionHandlers.initializeProject()), vscode.commands.registerCommand("grafanaDashboards.createBackup", (item) => createBackupCommand(item)), vscode.commands.registerCommand("grafanaDashboards.createAllDashboardsBackup", () => createAllDashboardsBackupCommand()), vscode.commands.registerCommand("grafanaDashboards.restoreBackup", (item) => restoreBackupCommand(item)), vscode.commands.registerCommand("grafanaDashboards.openBackupFolder", (item) => openBackupFolder(item)), vscode.commands.registerCommand("grafanaDashboards.deleteBackup", (item) => deleteBackup(item)), vscode.commands.registerCommand("grafanaDashboards.selectActiveInstance", () => actionHandlers.selectActiveInstance()), vscode.commands.registerCommand("grafanaDashboards.refresh", async () => {
        await resolveProject();
        await refreshAll();
    }), vscode.commands.registerCommand("grafanaDashboards.createManifestFromExample", () => actionHandlers.createManifestFromExample()), vscode.commands.registerCommand("grafanaDashboards.addDashboard", () => actionHandlers.addDashboard()), vscode.commands.registerCommand("grafanaDashboards.createInstance", () => actionHandlers.createInstance("")), vscode.commands.registerCommand("grafanaDashboards.createDeploymentTarget", (item) => actionHandlers.createDeploymentTarget(typeof item === "string"
        ? item
        : item instanceof instanceTreeProvider_1.InstanceTreeItem
            ? item.instance.name
            : selectionState.selectedInstanceName ?? "", "")), vscode.commands.registerCommand("grafanaDashboards.pickPlacementFolder", async () => {
        const target = await requireDeploymentTarget();
        const record = await requireDashboardRecord();
        await actionHandlers.pickPlacementFolder(target.instanceName, target.name, record.selectorName);
    }), vscode.commands.registerCommand("grafanaDashboards.removeInstance", (item) => removeInstance(item)), vscode.commands.registerCommand("grafanaDashboards.removeDeploymentTarget", (item) => removeDeploymentTarget(item)), vscode.commands.registerCommand("grafanaDashboards.setInstanceToken", (item) => setInstanceToken(item)), vscode.commands.registerCommand("grafanaDashboards.clearInstanceToken", (item) => clearInstanceToken(item)), vscode.commands.registerCommand("grafanaDashboards.openDashboardJson", (item) => openDashboardJson(item)), vscode.commands.registerCommand("grafanaDashboards.removeDashboard", (item) => removeDashboard(item)), vscode.commands.registerCommand("grafanaDashboards.pullDashboard", (item) => pullDashboards(item)), vscode.commands.registerCommand("grafanaDashboards.pullAllDashboards", (item) => pullAllDashboards(item)), vscode.commands.registerCommand("grafanaDashboards.renderDashboard", (item) => renderDashboardCommand(item)), vscode.commands.registerCommand("grafanaDashboards.renderTarget", (item) => renderTargetCommand(item)), vscode.commands.registerCommand("grafanaDashboards.renderInstance", (item) => renderInstanceCommand(item)), vscode.commands.registerCommand("grafanaDashboards.renderAllInstances", () => renderAllInstancesCommand()), vscode.commands.registerCommand("grafanaDashboards.deployAllDashboards", () => deployAllDashboardsCommand()), vscode.commands.registerCommand("grafanaDashboards.openRenderFolder", (item) => openRenderFolder(item)), vscode.commands.registerCommand("grafanaDashboards.deployDashboard", (item) => deployDashboards(item)), vscode.commands.registerCommand("grafanaDashboards.openOverrideFile", (item) => openOverrideFile(item)), vscode.commands.registerCommand("grafanaDashboards.generateOverride", (item) => generateOverride(item)));
    async function requireDashboardRecord(selectorName) {
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
    async function requireInstance(instanceName) {
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
    async function requireDeploymentTarget(instanceName, targetName) {
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
    async function requireBackup(backupName) {
        const repository = requireRepository();
        const resolvedKey = backupName ?? selectionState.selectedBackupName;
        if (!resolvedKey) {
            throw new Error("Select a backup first.");
        }
        const backups = await repository.listBackups();
        const backup = backups.find((candidate) => candidate.rootPath === resolvedKey) ??
            backups.find((candidate) => candidate.name === resolvedKey);
        if (!backup) {
            throw new Error(`Backup not found: ${resolvedKey}`);
        }
        return backup;
    }
    function isDashboardScopeItem(item) {
        return item instanceof dashboardTreeProvider_1.DashboardTreeItem || item instanceof dashboardTreeProvider_1.DashboardInstanceTreeItem || item instanceof dashboardTreeProvider_1.DashboardTargetTreeItem;
    }
    function isInstanceTargetDashboardItem(item) {
        return item instanceof instanceTreeProvider_1.InstanceTargetDashboardTreeItem;
    }
    async function dashboardScopeContext(item) {
        const repository = requireRepository();
        if (item instanceof dashboardTreeProvider_1.DashboardTargetTreeItem) {
            return {
                record: item.record,
                targets: [item.target],
                label: `${item.record.selectorName} on ${item.target.instanceName}/${item.target.name}`,
            };
        }
        if (item instanceof dashboardTreeProvider_1.DashboardInstanceTreeItem) {
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
    async function pickDashboardSourceTarget(item) {
        const { record, targets } = await dashboardScopeContext(item);
        const selection = await vscode.window.showQuickPick(targets.map((target) => ({
            label: `${target.instanceName}/${target.name}`,
            target,
        })), {
            title: item instanceof dashboardTreeProvider_1.DashboardInstanceTreeItem
                ? `Choose source target for ${record.selectorName} in ${item.instance.name}`
                : `Choose source target for ${record.selectorName}`,
            placeHolder: "Pull should use one concrete Grafana target as the source of truth",
        });
        if (!selection) {
            throw new Error("No source target selected.");
        }
        return {
            record,
            target: selection.target,
            label: `${record.selectorName} from ${selection.target.instanceName}/${selection.target.name}`,
        };
    }
    async function pickDashboardEntries(item) {
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
        const picks = await vscode.window.showQuickPick(records.map((record) => ({
            label: record.selectorName,
            description: record.title ?? record.entry.uid,
            detail: record.entry.path,
            record,
        })), {
            canPickMany: true,
            title: "Select dashboards",
        });
        if (!picks || picks.length === 0) {
            throw new Error("No dashboards selected.");
        }
        return picks.map((pick) => pick.record.entry);
    }
    async function allDashboardEntries() {
        const repository = requireRepository();
        const records = await repository.listDashboardRecords();
        if (records.length === 0) {
            throw new Error("No dashboards available in the manifest.");
        }
        return records.map((record) => record.entry);
    }
    async function pickTargetForInstance(instanceName) {
        const repository = requireRepository();
        const targets = await repository.listDeploymentTargets(instanceName);
        if (targets.length === 0) {
            throw new Error(`No deployment targets found for ${instanceName}.`);
        }
        const selection = await vscode.window.showQuickPick(targets.map((target) => ({
            label: `${target.instanceName}/${target.name}`,
            target,
        })), {
            title: `Choose source target in ${instanceName}`,
            placeHolder: "Pull should use one concrete Grafana target as the source of truth",
        });
        if (!selection) {
            throw new Error("No source target selected.");
        }
        return selection.target;
    }
    function isBackupScopeItem(item) {
        return (isDashboardScopeItem(item) ||
            isInstanceTargetDashboardItem(item) ||
            item instanceof instanceTreeProvider_1.InstanceTreeItem ||
            item instanceof instanceTreeProvider_1.DeploymentTargetTreeItem);
    }
    async function backupSpecsForItem(item) {
        const repository = requireRepository();
        if (item instanceof dashboardTreeProvider_1.DashboardTreeItem) {
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
        if (item instanceof dashboardTreeProvider_1.DashboardInstanceTreeItem) {
            const targets = await repository.listDeploymentTargets(item.instance.name);
            return {
                scope: "instance",
                specs: targets.map((target) => ({
                    instanceName: target.instanceName,
                    targetName: target.name,
                    entries: [item.record.entry],
                })),
                label: `${item.record.selectorName} in ${item.instance.name}`,
            };
        }
        if (item instanceof dashboardTreeProvider_1.DashboardTargetTreeItem) {
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
        if (item instanceof instanceTreeProvider_1.InstanceTreeItem) {
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
        if (item instanceof instanceTreeProvider_1.DeploymentTargetTreeItem) {
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
    function backupRestoreSelectionForItem(item) {
        if (!item || item instanceof backupTreeProvider_1.BackupTreeItem) {
            return { kind: "backup" };
        }
        if (item instanceof backupTreeProvider_1.BackupInstanceTreeItem) {
            return {
                kind: "instance",
                instanceName: item.instance.instanceName,
            };
        }
        if (item instanceof backupTreeProvider_1.BackupTargetTreeItem) {
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
    async function pickInstanceIfNeeded(explicitInstanceName) {
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
    async function pickRequiredInstance(explicitInstanceName) {
        const instance = await pickInstanceIfNeeded(explicitInstanceName);
        if (!instance) {
            throw new Error("Choose a concrete instance.");
        }
        return instance;
    }
    async function pickDeploymentTargetIfNeeded(explicitInstanceName, explicitTargetName) {
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
        const selection = await vscode.window.showQuickPick(targets.map((target) => ({
            label: `${target.instanceName}/${target.name}`,
            target,
        })), {
            title: "Choose deployment target",
        });
        if (!selection) {
            throw new Error("No deployment target selected.");
        }
        return selection.target;
    }
    async function pickRequiredDeploymentTarget(explicitInstanceName, explicitTargetName) {
        return pickDeploymentTargetIfNeeded(explicitInstanceName, explicitTargetName);
    }
    async function openFile(filePath) {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.window.showTextDocument(document, { preview: false });
    }
    async function openDashboardJson(item) {
        const record = item?.record ?? (await requireDashboardRecord());
        await openFile(record.absolutePath);
    }
    async function removeDashboard(item) {
        const selectorName = item?.record.selectorName ?? selectionState.selectedDashboardSelectorName;
        if (!selectorName) {
            throw new Error("Select a dashboard first.");
        }
        selectionState.setDashboard(selectorName);
        await actionHandlers.removeDashboard();
    }
    async function pullDashboards(item) {
        const service = requireService();
        if (isDashboardScopeItem(item)) {
            const scopedTarget = item instanceof dashboardTreeProvider_1.DashboardTargetTreeItem
                ? {
                    record: item.record,
                    target: item.target,
                    label: `${item.record.selectorName} from ${item.target.instanceName}/${item.target.name}`,
                }
                : await pickDashboardSourceTarget(item);
            const summary = await service.pullDashboards([scopedTarget.record.entry], scopedTarget.target.instanceName, scopedTarget.target.name);
            await refreshAll();
            void vscode.window.showInformationMessage(`Pull complete for ${scopedTarget.label}: ${summary.updatedCount} updated, ${summary.skippedCount} unchanged.`);
            return;
        }
        if (isInstanceTargetDashboardItem(item)) {
            const summary = await service.pullDashboards([item.record.entry], item.target.instanceName, item.target.name);
            await refreshAll();
            void vscode.window.showInformationMessage(`Pull complete for ${item.record.selectorName} from ${item.target.instanceName}/${item.target.name}: ${summary.updatedCount} updated, ${summary.skippedCount} unchanged.`);
            return;
        }
        if (item instanceof instanceTreeProvider_1.InstanceTreeItem) {
            const target = await pickTargetForInstance(item.instance.name);
            const entries = await allDashboardEntries();
            const summary = await service.pullDashboards(entries, target.instanceName, target.name);
            await refreshAll();
            void vscode.window.showInformationMessage(`Pull complete for all dashboards from ${target.instanceName}/${target.name}: ${summary.updatedCount} updated, ${summary.skippedCount} unchanged.`);
            return;
        }
        if (item instanceof instanceTreeProvider_1.DeploymentTargetTreeItem) {
            const entries = await allDashboardEntries();
            const summary = await service.pullDashboards(entries, item.target.instanceName, item.target.name);
            await refreshAll();
            void vscode.window.showInformationMessage(`Pull complete for all dashboards from ${item.target.instanceName}/${item.target.name}: ${summary.updatedCount} updated, ${summary.skippedCount} unchanged.`);
            return;
        }
        const entries = await pickDashboardEntries();
        const target = await pickRequiredDeploymentTarget();
        const summary = await service.pullDashboards(entries, target.instanceName, target.name);
        await refreshAll();
        void vscode.window.showInformationMessage(`Pull complete: ${summary.updatedCount} updated, ${summary.skippedCount} unchanged from ${target.instanceName}/${target.name}.`);
    }
    async function renderDashboardCommand(item) {
        const service = requireService();
        if (isInstanceTargetDashboardItem(item)) {
            await service.renderDashboards([item.record.entry], item.target.instanceName, item.target.name, "dashboard");
            await refreshAll();
            void vscode.window.showInformationMessage(`Render complete for ${item.record.selectorName} on ${item.target.instanceName}/${item.target.name}.`);
            return;
        }
        if (item) {
            const { record, targets, label } = await dashboardScopeContext(item);
            for (const target of targets) {
                await service.renderDashboards([record.entry], target.instanceName, target.name, "dashboard");
            }
            await refreshAll();
            void vscode.window.showInformationMessage(`Render complete for ${label}: ${targets.length} target(s) updated.`);
            return;
        }
        await actionHandlers.renderSelected(selectionState.selectedDashboardSelectorName);
    }
    async function renderTargetCommand(item) {
        const instanceName = item?.target.instanceName;
        const targetName = item?.target.name;
        await actionHandlers.renderTarget(instanceName, targetName);
    }
    async function renderInstanceCommand(item) {
        const instanceName = item?.instance.name;
        await actionHandlers.renderInstance(instanceName);
    }
    async function renderAllInstancesCommand() {
        await actionHandlers.renderAllInstances();
    }
    async function openRenderFolder(item) {
        const instanceName = item instanceof instanceTreeProvider_1.InstanceTreeItem ? item.instance.name : item instanceof instanceTreeProvider_1.DeploymentTargetTreeItem ? item.target.instanceName : undefined;
        const targetName = item instanceof instanceTreeProvider_1.DeploymentTargetTreeItem ? item.target.name : undefined;
        await actionHandlers.openRenderFolder(instanceName, targetName);
    }
    async function pullAllDashboards(item) {
        if (item instanceof instanceTreeProvider_1.InstanceTreeItem) {
            const target = await pickTargetForInstance(item.instance.name);
            await actionHandlers.pullAllDashboards(target.instanceName, target.name);
            return;
        }
        const instanceName = item instanceof instanceTreeProvider_1.DeploymentTargetTreeItem ? item.target.instanceName : undefined;
        const targetName = item instanceof instanceTreeProvider_1.DeploymentTargetTreeItem ? item.target.name : undefined;
        await actionHandlers.pullAllDashboards(instanceName, targetName);
    }
    async function deployDashboards(item) {
        const service = requireService();
        if (isDashboardScopeItem(item)) {
            const { record, targets, label } = await dashboardScopeContext(item);
            let deployedCount = 0;
            for (const target of targets) {
                const summary = await service.deployDashboards([record.entry], target.instanceName, target.name);
                deployedCount += summary.dashboardResults.length;
            }
            await refreshAll();
            void vscode.window.showInformationMessage(`Deploy complete for ${label}: ${deployedCount} deployment(s) across ${targets.length} target(s).`);
            return;
        }
        if (isInstanceTargetDashboardItem(item)) {
            const summary = await service.deployDashboards([item.record.entry], item.target.instanceName, item.target.name);
            await refreshAll();
            void vscode.window.showInformationMessage(`Deploy complete for ${item.record.selectorName} to ${item.target.instanceName}/${item.target.name}: ${summary.dashboardResults.length} dashboard(s) deployed.`);
            return;
        }
        if (item instanceof instanceTreeProvider_1.InstanceTreeItem) {
            const entries = await allDashboardEntries();
            const targets = await requireRepository().listDeploymentTargets(item.instance.name);
            let deployedCount = 0;
            for (const target of targets) {
                const summary = await service.deployDashboards(entries, target.instanceName, target.name);
                deployedCount += summary.dashboardResults.length;
            }
            await refreshAll();
            void vscode.window.showInformationMessage(`Deploy complete for all dashboards in ${item.instance.name}: ${deployedCount} deployment(s) across ${targets.length} target(s).`);
            return;
        }
        if (item instanceof instanceTreeProvider_1.DeploymentTargetTreeItem) {
            const entries = await allDashboardEntries();
            const summary = await service.deployDashboards(entries, item.target.instanceName, item.target.name);
            await refreshAll();
            void vscode.window.showInformationMessage(`Deploy complete for all dashboards to ${item.target.instanceName}/${item.target.name}: ${summary.dashboardResults.length} dashboard(s) deployed.`);
            return;
        }
        const entries = await pickDashboardEntries();
        const target = await pickRequiredDeploymentTarget();
        const summary = await service.deployDashboards(entries, target.instanceName, target.name);
        await refreshAll();
        void vscode.window.showInformationMessage(`Deploy complete: ${summary.dashboardResults.length} dashboard(s) deployed${summary.instanceName && summary.deploymentTargetName
            ? ` to ${summary.instanceName}/${summary.deploymentTargetName}`
            : ""}.`);
    }
    async function openOverrideFile(item) {
        const repository = requireRepository();
        const target = item instanceof instanceTreeProvider_1.DeploymentTargetTreeItem
            ? item.target
            : item instanceof instanceTreeProvider_1.InstanceTreeItem
                ? await requireDeploymentTarget(item.instance.name, repository_1.DEFAULT_DEPLOYMENT_TARGET)
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
    async function generateOverride(item) {
        const service = requireService();
        const record = item?.record ?? (await requireDashboardRecord());
        const target = await pickRequiredDeploymentTarget();
        const result = await service.generateOverride(target.instanceName, target.name, record.entry);
        selectionState.setDashboard((0, manifest_1.selectorNameForEntry)(record.entry));
        selectionState.setInstance(target.instanceName);
        selectionState.setTarget(target.name);
        await refreshAll();
        void vscode.window.showInformationMessage(`Generated override with ${result.variableCount} variable(s): ${result.overridePath}`);
    }
    async function createAllDashboardsBackupCommand() {
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
        const backup = await service.createBackup(targets.map((target) => ({
            instanceName: target.instanceName,
            targetName: target.name,
            entries,
        })), "multi-instance");
        selectionState.setBackup(backup.rootPath);
        await refreshAll();
        void vscode.window.showInformationMessage(`Created backup ${backup.name} for all dashboards across ${backup.instanceCount} instance(s) and ${backup.targetCount} target(s).`);
    }
    async function createBackupCommand(item) {
        const service = requireService();
        if (item && isBackupScopeItem(item)) {
            const { scope, specs, label } = await backupSpecsForItem(item);
            const backup = await service.createBackup(specs, scope);
            selectionState.setBackup(backup.rootPath);
            await refreshAll();
            void vscode.window.showInformationMessage(`Created ${scope} backup ${backup.name} for ${label}.`);
            return;
        }
        await createAllDashboardsBackupCommand();
    }
    async function setInstanceToken(item) {
        if (item) {
            selectionState.setInstance(item.instance.name);
        }
        await actionHandlers.setInstanceToken();
    }
    async function clearInstanceToken(item) {
        if (item) {
            selectionState.setInstance(item.instance.name);
        }
        await actionHandlers.clearInstanceToken();
    }
    async function removeInstance(item) {
        if (item) {
            selectionState.setInstance(item.instance.name);
            selectionState.setTarget(undefined);
        }
        await actionHandlers.removeInstance();
    }
    async function removeDeploymentTarget(item) {
        if (item) {
            selectionState.setInstance(item.target.instanceName);
            selectionState.setTarget(item.target.name);
        }
        await actionHandlers.removeDeploymentTarget();
    }
    async function restoreBackupCommand(item) {
        const service = requireService();
        const backup = item?.backup ?? (await requireBackup());
        const selection = backupRestoreSelectionForItem(item);
        selectionState.setBackup(backup.rootPath);
        const summary = await service.restoreBackup(backup, selection);
        await refreshAll();
        void vscode.window.showInformationMessage(`Backup restore complete: ${summary.dashboardCount} dashboard(s) restored across ${summary.targetCount} target(s).`);
    }
    async function openBackupFolder(item) {
        const backup = item?.backup ?? (await requireBackup());
        selectionState.setBackup(backup.rootPath);
        await vscode.env.openExternal(vscode.Uri.file(backup.rootPath));
    }
    async function deleteBackup(item) {
        const repository = requireRepository();
        const backup = item?.backup ?? (await requireBackup());
        selectionState.setBackup(backup.rootPath);
        const confirmed = await vscode.window.showWarningMessage(`Delete backup ${backup.name}?`, { modal: true }, "Delete");
        if (confirmed !== "Delete") {
            return;
        }
        await repository.deleteBackup(backup.name);
        selectionState.setBackup(undefined);
        await refreshAll();
        void vscode.window.showInformationMessage(`Deleted backup ${backup.name}.`);
    }
    async function deployAllDashboardsCommand() {
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
        void vscode.window.showInformationMessage(`Deploy complete for all dashboards: ${deployedCount} deployment(s) across ${targets.length} target(s).`);
    }
    await refreshAll();
}
function deactivate() { }
//# sourceMappingURL=extension.js.map