"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DashboardService = void 0;
const node_crypto_1 = require("node:crypto");
const node_path_1 = __importDefault(require("node:path"));
const dashboardCatalog_1 = require("./dashboardCatalog");
const datasourceMappings_1 = require("./datasourceMappings");
const datasourceRefs_1 = require("./datasourceRefs");
const json_1 = require("./json");
const manifest_1 = require("./manifest");
const overrides_1 = require("./overrides");
const repository_1 = require("./repository");
const grafanaClient_1 = require("./grafanaClient");
function sanitizeDashboardForStorage(dashboard) {
    const nextDashboard = structuredClone(dashboard);
    delete nextDashboard.id;
    delete nextDashboard.version;
    delete nextDashboard.iteration;
    return nextDashboard;
}
function normalizeFolderPath(pathValue) {
    const normalized = (pathValue ?? "")
        .split("/")
        .map((segment) => segment.trim())
        .filter(Boolean)
        .join("/");
    return normalized || undefined;
}
function isDefaultTarget(targetName) {
    return targetName === repository_1.DEFAULT_DEPLOYMENT_TARGET;
}
function buildFolderPathByUid(folderUid, folders) {
    const folderMap = new Map(folders.map((folder) => [folder.uid, folder]));
    const segments = [];
    let currentUid = folderUid;
    const visited = new Set();
    while (currentUid) {
        if (visited.has(currentUid)) {
            break;
        }
        visited.add(currentUid);
        const currentFolder = folderMap.get(currentUid);
        if (!currentFolder) {
            return undefined;
        }
        segments.unshift(currentFolder.title);
        currentUid = currentFolder.parentUid;
    }
    return segments.length > 0 ? segments.join("/") : undefined;
}
function folderPathFromChain(chain) {
    if (chain.length === 0) {
        return undefined;
    }
    return chain.map((folder) => folder.title).join("/");
}
function backupScopeForEntries(entries) {
    return entries.length === 1 ? "dashboard" : "target";
}
function renderScopeForEntries(entries) {
    return entries.length === 1 ? "dashboard" : "target";
}
function hashValue(value) {
    return (0, node_crypto_1.createHash)("sha256").update((0, json_1.stableJsonStringify)(value)).digest("hex");
}
function revisionId(now = new Date(), hash = (0, node_crypto_1.randomUUID)().replace(/-/g, "")) {
    return `${repository_1.ProjectRepository.timestamp(now)}__${hash.slice(0, 8)}`;
}
async function collectFolderPaths(client, parentUid, parentPath) {
    const folders = await client.listFolders(parentUid);
    const paths = [];
    for (const folder of folders) {
        const currentPath = parentPath ? `${parentPath}/${folder.title}` : folder.title;
        paths.push(currentPath);
        paths.push(...(await collectFolderPaths(client, folder.uid, currentPath)));
    }
    return paths;
}
class DashboardService {
    repository;
    log;
    clientFactory;
    constructor(repository, log, clientFactory = async (instanceName) => new grafanaClient_1.GrafanaClient(await repository.loadConnectionConfig(instanceName))) {
        this.repository = repository;
        this.log = log;
        this.clientFactory = clientFactory;
    }
    async listRemoteDashboards(instanceName) {
        const client = await this.clientFactory(instanceName);
        return client.listDashboards();
    }
    async listRemoteDatasources(instanceName) {
        const client = await this.clientFactory(instanceName);
        return client.listDatasources();
    }
    async listRemoteFolderPaths(instanceName) {
        const client = await this.clientFactory(instanceName);
        const folderPaths = await collectFolderPaths(client);
        return [...new Set(folderPaths)].sort((left, right) => left.localeCompare(right));
    }
    async createDeploymentTarget(instanceName, targetName) {
        const target = await this.repository.createDeploymentTarget(instanceName, targetName);
        await this.materializeManagedOverridesForTarget(target.instanceName, target.name);
        return target;
    }
    async managedVariableNames(entry) {
        const overrides = await this.repository.readDashboardOverrides(entry);
        const targets = overrides?.dashboards[entry.uid]?.targets ?? {};
        const managed = new Set();
        for (const override of Object.values(targets)) {
            for (const variableName of Object.keys(override.variables ?? {})) {
                managed.add(variableName);
            }
        }
        return managed;
    }
    normalizeDashboardForVersionComparison(dashboard, managedVariableNames, baseUid) {
        const nextDashboard = structuredClone(dashboard);
        nextDashboard.uid = baseUid;
        if (managedVariableNames.size === 0) {
            return nextDashboard;
        }
        const templating = nextDashboard.templating;
        if (!templating || typeof templating !== "object" || Array.isArray(templating)) {
            return nextDashboard;
        }
        const list = Array.isArray(templating.list) ? templating.list : [];
        templating.list = list.map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
                return item;
            }
            const variable = item;
            const name = typeof variable.name === "string" ? variable.name : undefined;
            const type = typeof variable.type === "string" ? variable.type : undefined;
            if (!name || !type || !managedVariableNames.has(name)) {
                return variable;
            }
            const nextVariable = {
                ...variable,
                current: {
                    text: "__managed__",
                    value: "__managed__",
                },
            };
            if (type === "constant") {
                nextVariable.query = "__managed__";
            }
            return nextVariable;
        });
        return nextDashboard;
    }
    revisionHashes(entry, snapshot, managedVariableNames) {
        const contentHash = hashValue({
            dashboard: snapshot.dashboard,
            ...(snapshot.folderPath ? { folderPath: snapshot.folderPath } : {}),
        });
        const templateHash = hashValue(this.normalizeDashboardForVersionComparison(snapshot.dashboard, managedVariableNames, entry.uid));
        return { contentHash, templateHash };
    }
    async repositoryRevisionSnapshot(sourceRepository, entry) {
        const dashboard = await sourceRepository.readDashboardJson(entry);
        const folderMeta = await sourceRepository.readFolderMetadata(entry);
        return {
            version: 1,
            dashboard,
            ...(normalizeFolderPath(folderMeta?.path) ? { folderPath: normalizeFolderPath(folderMeta?.path) } : {}),
        };
    }
    async ensureDashboardVersionIndex(entry) {
        const existing = await this.repository.readDashboardVersionIndex(entry);
        if (existing?.revisions.length) {
            return existing;
        }
        const snapshot = await this.repositoryRevisionSnapshot(this.repository, entry);
        const managedVariableNames = await this.managedVariableNames(entry);
        const { contentHash, templateHash } = this.revisionHashes(entry, snapshot, managedVariableNames);
        const id = revisionId(new Date(), contentHash);
        await this.repository.saveDashboardRevisionSnapshot(entry, id, snapshot);
        const index = {
            checkedOutRevisionId: id,
            revisions: [
                {
                    id,
                    createdAt: new Date().toISOString(),
                    contentHash,
                    templateHash,
                    snapshotPath: this.repository.dashboardRevisionSnapshotPath(entry, id),
                    ...(snapshot.folderPath ? { baseFolderPath: snapshot.folderPath } : {}),
                    source: {
                        kind: "migration",
                    },
                },
            ],
        };
        await this.repository.saveDashboardVersionIndex(entry, index);
        return index;
    }
    async findRevisionByHash(entry, hash, field = "contentHash") {
        const index = await this.ensureDashboardVersionIndex(entry);
        return index.revisions.find((revision) => revision[field] === hash);
    }
    async createOrReuseRevision(entry, snapshot, source, options) {
        const index = await this.ensureDashboardVersionIndex(entry);
        const managedVariableNames = await this.managedVariableNames(entry);
        const { contentHash, templateHash } = this.revisionHashes(entry, snapshot, managedVariableNames);
        const existing = index.revisions.find((revision) => revision.contentHash === contentHash);
        if (existing) {
            if (options?.checkout && index.checkedOutRevisionId !== existing.id) {
                await this.repository.saveDashboardVersionIndex(entry, {
                    ...index,
                    checkedOutRevisionId: existing.id,
                });
            }
            return existing;
        }
        const id = revisionId(new Date(), contentHash);
        await this.repository.saveDashboardRevisionSnapshot(entry, id, snapshot);
        const record = {
            id,
            createdAt: new Date().toISOString(),
            contentHash,
            templateHash,
            snapshotPath: this.repository.dashboardRevisionSnapshotPath(entry, id),
            ...(snapshot.folderPath ? { baseFolderPath: snapshot.folderPath } : {}),
            source,
        };
        const nextIndex = {
            checkedOutRevisionId: options?.checkout ? id : index.checkedOutRevisionId,
            revisions: [record, ...index.revisions],
        };
        await this.repository.saveDashboardVersionIndex(entry, nextIndex);
        return record;
    }
    async checkoutRevisionSnapshot(entry, revision, snapshot, options) {
        await this.repository.saveDashboardJson(entry, snapshot.dashboard);
        const existingFolderMeta = await this.repository.readFolderMetadata(entry);
        const normalizedPath = normalizeFolderPath(snapshot.folderPath);
        const preservedUid = normalizedPath && existingFolderMeta?.path === normalizedPath ? existingFolderMeta.uid : undefined;
        const nextFolderUid = options?.folderUid ?? preservedUid;
        if (!normalizedPath && !nextFolderUid) {
            await this.repository.deleteFolderMetadata(entry);
        }
        else {
            await this.repository.saveFolderMetadata(entry, {
                ...(normalizedPath ? { path: normalizedPath } : {}),
                ...(nextFolderUid ? { uid: nextFolderUid } : {}),
            });
        }
        const index = await this.ensureDashboardVersionIndex(entry);
        if (index.checkedOutRevisionId !== revision.id) {
            await this.repository.saveDashboardVersionIndex(entry, {
                ...index,
                checkedOutRevisionId: revision.id,
            });
        }
    }
    async listDashboardRevisions(entry) {
        const index = await this.ensureDashboardVersionIndex(entry);
        return index.revisions.map((record) => ({
            record,
            isCheckedOut: index.checkedOutRevisionId === record.id,
        }));
    }
    async checkoutRevision(entry, revisionIdValue) {
        const index = await this.ensureDashboardVersionIndex(entry);
        const revision = index.revisions.find((candidate) => candidate.id === revisionIdValue);
        if (!revision) {
            throw new Error(`Revision not found: ${revisionIdValue}`);
        }
        const snapshot = await this.repository.readDashboardRevisionSnapshot(entry, revision.id);
        if (!snapshot) {
            throw new Error(`Revision snapshot not found: ${revision.id}`);
        }
        await this.checkoutRevisionSnapshot(entry, revision, snapshot);
        return revision;
    }
    async createRevisionFromWorkingCopy(entry) {
        const snapshot = await this.repositoryRevisionSnapshot(this.repository, entry);
        return this.createOrReuseRevision(entry, snapshot, { kind: "manual" }, { checkout: true });
    }
    async ensureWorkingCopyCheckedOutRevision(entry, source) {
        const snapshot = await this.repositoryRevisionSnapshot(this.repository, entry);
        const index = await this.ensureDashboardVersionIndex(entry);
        const managedVariableNames = await this.managedVariableNames(entry);
        const { contentHash } = this.revisionHashes(entry, snapshot, managedVariableNames);
        const currentRevision = index.revisions.find((revision) => revision.id === index.checkedOutRevisionId);
        if (currentRevision?.contentHash === contentHash) {
            return currentRevision;
        }
        return this.createOrReuseRevision(entry, snapshot, source, { checkout: true });
    }
    async currentCheckedOutRevision(entry) {
        const index = await this.ensureDashboardVersionIndex(entry);
        return index.revisions.find((revision) => revision.id === index.checkedOutRevisionId);
    }
    async liveTargetComparableSnapshot(entry, instanceName, targetName) {
        const client = await this.clientFactory(instanceName);
        const overrideFile = await this.materializeDashboardUidForTarget(this.repository, instanceName, targetName, entry);
        const effectiveDashboardUid = this.effectiveDashboardUidForTarget(entry, targetName, overrideFile);
        if (!effectiveDashboardUid) {
            throw new Error(`Dashboard UID is not materialized for ${(0, manifest_1.selectorNameForEntry)(entry)} on ${instanceName}/${targetName}.`);
        }
        const response = await client.getDashboardByUid(effectiveDashboardUid);
        const catalog = await this.repository.readDatasourceCatalog();
        const normalizedDashboard = (0, datasourceMappings_1.normalizeDashboardDatasourceRefsFromCatalog)({
            ...sanitizeDashboardForStorage(response.dashboard),
            uid: entry.uid,
        }, catalog, instanceName);
        return {
            snapshot: {
                dashboard: normalizedDashboard,
            },
            effectiveDashboardUid,
        };
    }
    async listLiveTargetVersionStatuses(entry) {
        const index = await this.ensureDashboardVersionIndex(entry);
        const managedVariableNames = await this.managedVariableNames(entry);
        const targets = await this.repository.listAllDeploymentTargets();
        const statuses = await Promise.all(targets.map(async (target) => {
            try {
                const { snapshot, effectiveDashboardUid } = await this.liveTargetComparableSnapshot(entry, target.instanceName, target.name);
                const templateHash = hashValue(this.normalizeDashboardForVersionComparison(snapshot.dashboard, managedVariableNames, entry.uid));
                const matched = index.revisions.find((revision) => revision.templateHash === templateHash);
                return {
                    instanceName: target.instanceName,
                    targetName: target.name,
                    effectiveDashboardUid,
                    matchedRevisionId: matched?.id,
                    state: matched ? "matched" : "unversioned",
                };
            }
            catch (error) {
                return {
                    instanceName: target.instanceName,
                    targetName: target.name,
                    state: "error",
                    detail: String(error),
                };
            }
        }));
        return statuses.sort((left, right) => {
            const instanceOrder = left.instanceName.localeCompare(right.instanceName);
            return instanceOrder !== 0 ? instanceOrder : left.targetName.localeCompare(right.targetName);
        });
    }
    async matchedRevisionIdForTarget(entry, instanceName, targetName) {
        const index = await this.ensureDashboardVersionIndex(entry);
        const managedVariableNames = await this.managedVariableNames(entry);
        const { snapshot } = await this.liveTargetComparableSnapshot(entry, instanceName, targetName);
        const templateHash = hashValue(this.normalizeDashboardForVersionComparison(snapshot.dashboard, managedVariableNames, entry.uid));
        return index.revisions.find((revision) => revision.templateHash === templateHash)?.id;
    }
    async rawTargetBackupItems(entries, instanceName, targetName) {
        const client = await this.clientFactory(instanceName);
        const folders = await client.listFolders();
        const items = [];
        for (const entry of entries) {
            const overrideFile = await this.materializeDashboardUidForTarget(this.repository, instanceName, targetName, entry);
            const effectiveDashboardUid = this.effectiveDashboardUidForTarget(entry, targetName, overrideFile);
            if (!effectiveDashboardUid) {
                throw new Error(`Dashboard UID is not materialized for ${(0, manifest_1.selectorNameForEntry)(entry)} on ${instanceName}/${targetName}.`);
            }
            const response = await client.getDashboardByUid(effectiveDashboardUid);
            const folderPath = response.meta.folderUid
                ? buildFolderPathByUid(response.meta.folderUid, folders) || normalizeFolderPath(response.meta.folderTitle)
                : undefined;
            items.push({
                selectorName: (0, manifest_1.selectorNameForEntry)(entry),
                baseUid: entry.uid,
                effectiveDashboardUid,
                path: entry.path,
                ...(normalizeFolderPath(folderPath) ? { folderPath: normalizeFolderPath(folderPath) } : {}),
                title: typeof response.dashboard.title === "string" && response.dashboard.title.trim()
                    ? response.dashboard.title.trim()
                    : (0, manifest_1.selectorNameForEntry)(entry),
                snapshotPath: "",
                dashboard: sanitizeDashboardForStorage(response.dashboard),
            });
        }
        return items;
    }
    mergeBackupCaptureSpecs(specs) {
        const merged = new Map();
        for (const spec of specs) {
            const targetKey = `${spec.instanceName}/${spec.targetName}`;
            const targetEntries = merged.get(targetKey) ?? new Map();
            for (const entry of spec.entries) {
                targetEntries.set((0, manifest_1.selectorNameForEntry)(entry), entry);
            }
            merged.set(targetKey, targetEntries);
        }
        return [...merged.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([targetKey, targetEntries]) => {
            const [instanceName, targetName] = targetKey.split("/", 2);
            return {
                instanceName,
                targetName,
                entries: [...targetEntries.values()],
            };
        });
    }
    async createBackup(specs, scope) {
        const mergedSpecs = this.mergeBackupCaptureSpecs(specs).filter((spec) => spec.entries.length > 0);
        if (mergedSpecs.length === 0) {
            throw new Error("No dashboards available for backup.");
        }
        const targets = await Promise.all(mergedSpecs.map(async (spec) => ({
            instanceName: spec.instanceName,
            targetName: spec.targetName,
            dashboards: await this.rawTargetBackupItems(spec.entries, spec.instanceName, spec.targetName),
        })));
        const backup = await this.repository.createBackupSnapshot(scope, targets);
        this.log.info(`Created ${scope} backup ${backup.name} across ${backup.targetCount} target(s).`);
        return backup;
    }
    async createTargetBackup(entries, instanceName, targetName, scope = backupScopeForEntries(entries)) {
        return this.createBackup([
            {
                instanceName,
                targetName,
                entries,
            },
        ], scope);
    }
    async desiredFolderPathForSnapshot(sourceRepository, entry, instanceName, targetName, snapshotFolderPath) {
        const overrideFile = await sourceRepository.readTargetOverrideFile(instanceName, targetName, entry);
        const relativeFolder = node_path_1.default.dirname(entry.path).replace(/\\/g, "/");
        return (normalizeFolderPath(overrideFile?.folderPath) ??
            normalizeFolderPath(snapshotFolderPath) ??
            (relativeFolder && relativeFolder !== "_root" ? normalizeFolderPath(node_path_1.default.basename(relativeFolder)) : undefined));
    }
    async renderDashboards(entries, instanceName, targetName, scope = renderScopeForEntries(entries)) {
        return this.renderDashboardSnapshots(await Promise.all(entries.map(async (entry) => ({
            entry,
            snapshot: await this.repositoryRevisionSnapshot(this.repository, entry),
            revisionId: (await this.currentCheckedOutRevision(entry))?.id,
        }))), instanceName, targetName, scope, {
            sourceRepository: this.repository,
        });
    }
    async renderRevision(entry, revisionIdValue, instanceName, targetName) {
        const snapshot = await this.repository.readDashboardRevisionSnapshot(entry, revisionIdValue);
        if (!snapshot) {
            throw new Error(`Revision snapshot not found: ${revisionIdValue}`);
        }
        return this.renderDashboardSnapshots([
            {
                entry,
                snapshot,
                revisionId: revisionIdValue,
            },
        ], instanceName, targetName, "dashboard", {
            sourceRepository: this.repository,
        });
    }
    async openRenderFolder(instanceName, targetName) {
        await this.repository.ensureProjectLayout();
        return this.repository.renderRootPath(instanceName, targetName);
    }
    async ensureExplicitFolderPath(client, folderCache, folderPath, finalUid) {
        const desiredPath = normalizeFolderPath(folderPath);
        if (!desiredPath) {
            return undefined;
        }
        const segments = desiredPath.split("/").filter(Boolean);
        let parentUid;
        let currentFolder;
        for (const [index, segment] of segments.entries()) {
            const siblings = parentUid ? await client.listFolders(parentUid) : folderCache;
            currentFolder = siblings.find((folder) => folder.title === segment);
            if (!currentFolder) {
                currentFolder = await client.createFolder({
                    title: segment,
                    ...(index === segments.length - 1 && finalUid ? { uid: finalUid } : {}),
                    ...(parentUid ? { parentUid } : {}),
                });
                if (!parentUid) {
                    folderCache.push(currentFolder);
                }
            }
            parentUid = currentFolder.uid;
        }
        return currentFolder?.uid;
    }
    selectedBackupTargets(backup, selection) {
        switch (selection.kind) {
            case "backup":
                return backup.instances.flatMap((instance) => instance.targets.map((target) => ({
                    instanceName: instance.instanceName,
                    targetName: target.targetName,
                    dashboards: target.dashboards,
                })));
            case "instance": {
                const instance = backup.instances.find((candidate) => candidate.instanceName === selection.instanceName);
                if (!instance) {
                    throw new Error(`Backup instance not found: ${selection.instanceName}`);
                }
                return instance.targets.map((target) => ({
                    instanceName: instance.instanceName,
                    targetName: target.targetName,
                    dashboards: target.dashboards,
                }));
            }
            case "target": {
                const instance = backup.instances.find((candidate) => candidate.instanceName === selection.instanceName);
                const target = instance?.targets.find((candidate) => candidate.targetName === selection.targetName);
                if (!instance || !target) {
                    throw new Error(`Backup target not found: ${selection.instanceName}/${selection.targetName}`);
                }
                return [
                    {
                        instanceName: instance.instanceName,
                        targetName: target.targetName,
                        dashboards: target.dashboards,
                    },
                ];
            }
            case "dashboard": {
                const instance = backup.instances.find((candidate) => candidate.instanceName === selection.instanceName);
                const target = instance?.targets.find((candidate) => candidate.targetName === selection.targetName);
                const dashboard = target?.dashboards.find((candidate) => candidate.selectorName === selection.selectorName);
                if (!instance || !target || !dashboard) {
                    throw new Error(`Backup dashboard not found: ${selection.instanceName}/${selection.targetName}/${selection.selectorName}`);
                }
                return [
                    {
                        instanceName: instance.instanceName,
                        targetName: target.targetName,
                        dashboards: [dashboard],
                    },
                ];
            }
        }
    }
    async restoreBackup(backup, selection = { kind: "backup" }) {
        const selectedTargets = this.selectedBackupTargets(backup, selection);
        const dashboardResults = [];
        const restoredInstances = new Set();
        const restoredTargets = new Set();
        const clients = new Map();
        for (const target of selectedTargets) {
            let runtime = clients.get(target.instanceName);
            if (!runtime) {
                const client = await this.clientFactory(target.instanceName);
                const connection = await this.repository.loadConnectionConfig(target.instanceName);
                runtime = {
                    client,
                    baseUrl: connection.baseUrl,
                    folderCache: await client.listFolders(),
                };
                clients.set(target.instanceName, runtime);
            }
            restoredInstances.add(target.instanceName);
            restoredTargets.add(`${target.instanceName}/${target.targetName}`);
            for (const dashboard of target.dashboards) {
                const rawDashboard = await this.repository.readBackupDashboardSnapshot(backup, dashboard);
                const folderUid = await this.ensureExplicitFolderPath(runtime.client, runtime.folderCache, dashboard.folderPath);
                const response = await runtime.client.upsertDashboard({
                    dashboard: sanitizeDashboardForStorage(rawDashboard),
                    folderUid,
                    message: `Restore backup ${backup.name} from VS Code`,
                });
                dashboardResults.push({
                    entry: {
                        name: dashboard.selectorName,
                        uid: dashboard.baseUid,
                        path: dashboard.path,
                    },
                    selectorName: dashboard.selectorName,
                    dashboardTitle: dashboard.title,
                    folderUid,
                    url: response.url,
                    targetBaseUrl: runtime.baseUrl,
                    deploymentTargetName: target.targetName,
                });
            }
        }
        return {
            instanceCount: restoredInstances.size,
            targetCount: restoredTargets.size,
            dashboardCount: dashboardResults.length,
            dashboardResults,
        };
    }
    async pullDashboardRevisionFromTarget(entry, instanceName, targetName) {
        const client = await this.clientFactory(instanceName);
        const folders = await client.listFolders();
        const overrideFile = await this.materializeDashboardUidForTarget(this.repository, instanceName, targetName, entry);
        const effectiveDashboardUid = this.effectiveDashboardUidForTarget(entry, targetName, overrideFile);
        if (!effectiveDashboardUid) {
            throw new Error(`Dashboard UID is not materialized for ${(0, manifest_1.selectorNameForEntry)(entry)} on ${instanceName}/${targetName}.`);
        }
        const response = await client.getDashboardByUid(effectiveDashboardUid);
        const normalizedDashboard = (0, datasourceMappings_1.normalizeDashboardDatasourceRefsFromCatalog)({
            ...sanitizeDashboardForStorage(response.dashboard),
            uid: entry.uid,
        }, await this.repository.readDatasourceCatalog(), instanceName);
        const folderPath = response.meta.folderUid ? buildFolderPathByUid(response.meta.folderUid, folders) : undefined;
        const snapshot = {
            version: 1,
            dashboard: normalizedDashboard,
            ...(normalizeFolderPath(folderPath) ? { folderPath: normalizeFolderPath(folderPath) } : {}),
        };
        const revision = await this.createOrReuseRevision(entry, snapshot, {
            kind: "pull",
            instanceName,
            targetName,
            effectiveDashboardUid,
        }, { checkout: true });
        await this.checkoutRevisionSnapshot(entry, revision, snapshot, {
            folderUid: response.meta.folderUid,
        });
        return revision;
    }
    async deployRevision(entry, revisionIdValue, instanceName, targetName) {
        const index = await this.ensureDashboardVersionIndex(entry);
        const revision = index.revisions.find((candidate) => candidate.id === revisionIdValue);
        if (!revision) {
            throw new Error(`Revision not found: ${revisionIdValue}`);
        }
        const snapshot = await this.repository.readDashboardRevisionSnapshot(entry, revision.id);
        if (!snapshot) {
            throw new Error(`Revision snapshot not found: ${revision.id}`);
        }
        const client = await this.clientFactory(instanceName);
        const connection = await this.repository.loadConnectionConfig(instanceName);
        const folderCache = await client.listFolders();
        const renderManifest = await this.renderDashboardSnapshots([{ entry, snapshot, revisionId: revision.id }], instanceName, targetName, "dashboard", { sourceRepository: this.repository });
        await this.createTargetBackup([entry], instanceName, targetName, "dashboard");
        return this.deployRenderedManifest(renderManifest, instanceName, targetName, client, connection.baseUrl, folderCache);
    }
    effectiveDashboardUidForTarget(entry, targetName, overrideFile) {
        if (isDefaultTarget(targetName)) {
            return entry.uid;
        }
        const dashboardUid = overrideFile?.dashboardUid?.trim();
        return dashboardUid || undefined;
    }
    async materializeDashboardUidForTarget(sourceRepository, instanceName, targetName, entry) {
        const existingOverride = await sourceRepository.readTargetOverrideFile(instanceName, targetName, entry);
        if (isDefaultTarget(targetName)) {
            return existingOverride;
        }
        const existingDashboardUid = existingOverride?.dashboardUid?.trim();
        if (existingDashboardUid) {
            return existingOverride;
        }
        const nextOverride = {
            dashboardUid: (0, node_crypto_1.randomUUID)(),
            ...(existingOverride?.folderPath ? { folderPath: existingOverride.folderPath } : {}),
            variables: existingOverride?.variables ?? {},
        };
        await sourceRepository.saveTargetOverrideFile(instanceName, targetName, entry, nextOverride);
        return nextOverride;
    }
    async materializeDashboardUidsForInstance(sourceRepository, instanceName) {
        const targets = await sourceRepository.listDeploymentTargets(instanceName);
        const records = await sourceRepository.listDashboardRecords();
        for (const target of targets) {
            if (isDefaultTarget(target.name)) {
                continue;
            }
            for (const record of records) {
                await this.materializeDashboardUidForTarget(sourceRepository, target.instanceName, target.name, record.entry);
            }
        }
    }
    async validateInstanceEffectiveDashboardUids(sourceRepository, instanceName) {
        const targets = await sourceRepository.listDeploymentTargets(instanceName);
        const records = await sourceRepository.listDashboardRecords();
        const seen = new Map();
        for (const target of targets) {
            for (const record of records) {
                const overrideFile = await sourceRepository.readTargetOverrideFile(target.instanceName, target.name, record.entry);
                const effectiveDashboardUid = this.effectiveDashboardUidForTarget(record.entry, target.name, overrideFile);
                if (!effectiveDashboardUid) {
                    throw new Error(`Dashboard UID is not materialized for ${(0, manifest_1.selectorNameForEntry)(record.entry)} on ${target.instanceName}/${target.name}.`);
                }
                const location = `${(0, manifest_1.selectorNameForEntry)(record.entry)} on ${target.instanceName}/${target.name}`;
                const previous = seen.get(effectiveDashboardUid);
                if (previous) {
                    throw new Error(`Duplicate effective dashboard UID "${effectiveDashboardUid}" for ${previous} and ${location}.`);
                }
                seen.set(effectiveDashboardUid, location);
            }
        }
    }
    async listFolderChildren(instanceName, parentUid) {
        const client = await this.clientFactory(instanceName);
        const folders = await client.listFolders(parentUid);
        return [...folders].sort((left, right) => left.title.localeCompare(right.title));
    }
    async createFolderInParent(instanceName, parentUid, title) {
        const normalizedTitle = title.trim();
        if (!normalizedTitle) {
            throw new Error("Folder name must not be empty.");
        }
        const client = await this.clientFactory(instanceName);
        return client.createFolder({
            title: normalizedTitle,
            ...(parentUid ? { parentUid } : {}),
        });
    }
    async resolveFolderPathChain(instanceName, folderPath) {
        const normalized = normalizeFolderPath(folderPath);
        if (!normalized) {
            return [];
        }
        const segments = normalized.split("/");
        const chain = [];
        let parentUid;
        for (const segment of segments) {
            const children = await this.listFolderChildren(instanceName, parentUid);
            const folder = children.find((candidate) => candidate.title === segment);
            if (!folder) {
                break;
            }
            chain.push(folder);
            parentUid = folder.uid;
        }
        return chain;
    }
    async ensureDatasourceCatalogInstance(instanceName) {
        const catalog = await this.repository.readDatasourceCatalog();
        const instances = await this.repository.listInstances();
        const nextCatalog = (0, datasourceMappings_1.ensureDatasourceCatalogInstances)(catalog, [...new Set([...instances.map((instance) => instance.name), instanceName])]);
        if ((0, json_1.stableJsonStringify)(nextCatalog) === (0, json_1.stableJsonStringify)(catalog)) {
            return false;
        }
        await this.repository.saveDatasourceCatalog(nextCatalog);
        return true;
    }
    async autoMatchDatasourceCatalogForInstance(instanceName) {
        const targetDatasources = await this.listRemoteDatasources(instanceName);
        const catalog = await this.repository.readDatasourceCatalog();
        const nextCatalog = (0, datasourceMappings_1.autoMatchDatasourceCatalogInstance)(catalog, instanceName, targetDatasources);
        if ((0, json_1.stableJsonStringify)(nextCatalog) === (0, json_1.stableJsonStringify)(catalog)) {
            return false;
        }
        await this.repository.saveDatasourceCatalog(nextCatalog);
        return true;
    }
    async suggestManifestEntriesForRemoteDashboards(dashboards) {
        const manifest = await this.repository.loadManifest();
        return (0, dashboardCatalog_1.buildManifestEntriesFromRemoteDashboards)(dashboards, manifest.dashboards);
    }
    async pullDashboards(entries, instanceName, targetName = repository_1.DEFAULT_DEPLOYMENT_TARGET) {
        if (!instanceName) {
            throw new Error("Choose a concrete Grafana instance and deployment target for pull.");
        }
        const client = await this.clientFactory(instanceName);
        const folders = await client.listFolders();
        const datasources = instanceName ? await client.listDatasources().catch(() => []) : [];
        const instances = await this.repository.listInstances();
        const instanceNames = [...new Set([...instances.map((instance) => instance.name), ...(instanceName ? [instanceName] : [])])];
        const datasourcesByInstance = new Map();
        if (instanceName) {
            datasourcesByInstance.set(instanceName, datasources);
            for (const instance of instances) {
                if (instance.name === instanceName) {
                    continue;
                }
                datasourcesByInstance.set(instance.name, await this.listRemoteDatasources(instance.name).catch(() => []));
            }
        }
        let datasourceCatalog = (0, datasourceMappings_1.ensureDatasourceCatalogInstances)(await this.repository.readDatasourceCatalog(), instanceNames);
        let datasourceCatalogChanged = false;
        let updatedCount = 0;
        let skippedCount = 0;
        const dashboardResults = [];
        for (const entry of entries) {
            if (await this.repository.dashboardExists(entry)) {
                await this.ensureDashboardVersionIndex(entry);
            }
            const selectorName = (0, manifest_1.selectorNameForEntry)(entry);
            this.log.info(`Pulling ${selectorName} from ${instanceName}/${targetName}`);
            const overrideFile = await this.materializeDashboardUidForTarget(this.repository, instanceName, targetName, entry);
            const effectiveDashboardUid = this.effectiveDashboardUidForTarget(entry, targetName, overrideFile);
            if (!effectiveDashboardUid) {
                throw new Error(`Dashboard UID is not materialized for ${selectorName} on ${instanceName}/${targetName}.`);
            }
            const response = await client.getDashboardByUid(effectiveDashboardUid);
            const pulledDashboard = sanitizeDashboardForStorage(response.dashboard);
            if (isDefaultTarget(targetName) && pulledDashboard.uid !== entry.uid) {
                throw new Error(`Pulled dashboard UID mismatch for ${selectorName} on ${instanceName}/${targetName}: expected ${entry.uid}, got ${String(pulledDashboard.uid ?? "")}.`);
            }
            const datasourceDescriptors = (0, datasourceRefs_1.buildDashboardDatasourceDescriptors)(pulledDashboard, datasources);
            const nextCatalogState = (0, datasourceMappings_1.mergePulledDatasourceCatalog)(datasourceCatalog, instanceName, datasourceDescriptors, instanceNames, datasourcesByInstance);
            if ((0, json_1.stableJsonStringify)(nextCatalogState.catalog) !== (0, json_1.stableJsonStringify)(datasourceCatalog)) {
                datasourceCatalog = nextCatalogState.catalog;
                datasourceCatalogChanged = true;
            }
            const dashboard = {
                ...(0, datasourceMappings_1.normalizeDashboardDatasourceRefs)(pulledDashboard, nextCatalogState.sourceNamesByUid),
                uid: entry.uid,
            };
            const fileResults = [];
            const dashboardOutcome = await this.repository.syncPulledFile({
                sourceContent: (0, json_1.stableJsonStringify)(dashboard),
                targetPath: this.repository.dashboardPath(entry),
            });
            fileResults.push({
                kind: "dashboard",
                relativePath: entry.path,
                status: dashboardOutcome.status,
                targetPath: this.repository.dashboardPath(entry),
            });
            if (dashboardOutcome.status === "updated") {
                updatedCount += 1;
            }
            else {
                skippedCount += 1;
            }
            const folderMetaPath = this.repository.folderMetaPathForEntry(entry);
            if (folderMetaPath && response.meta.folderUid) {
                const existingFolderMeta = await this.repository.readFolderMetadata(entry);
                const preserveFolderPath = await this.repository.hasAnyFolderPathOverride(entry);
                const pulledFolderPath = buildFolderPathByUid(response.meta.folderUid, folders) ||
                    normalizeFolderPath(response.meta.folderTitle ||
                        folders.find((folder) => folder.uid === response.meta.folderUid)?.title ||
                        node_path_1.default.basename(node_path_1.default.dirname(entry.path)));
                const folderPath = preserveFolderPath && existingFolderMeta?.path
                    ? normalizeFolderPath(existingFolderMeta.path)
                    : pulledFolderPath;
                const snapshot = {
                    version: 1,
                    dashboard,
                    ...(folderPath ? { folderPath } : {}),
                };
                await this.createOrReuseRevision(entry, snapshot, {
                    kind: "pull",
                    instanceName,
                    targetName,
                    effectiveDashboardUid,
                }, { checkout: true });
                const folderMetaOutcome = await this.repository.syncPulledFile({
                    sourceContent: (0, json_1.stableJsonStringify)({
                        ...(folderPath ? { path: folderPath } : {}),
                        uid: response.meta.folderUid,
                    }),
                    targetPath: folderMetaPath,
                });
                fileResults.push({
                    kind: "folderMeta",
                    relativePath: node_path_1.default.posix.join(node_path_1.default.dirname(entry.path).replace(/\\/g, "/"), ".folder.json"),
                    status: folderMetaOutcome.status,
                    targetPath: folderMetaPath,
                });
                if (folderMetaOutcome.status === "updated") {
                    updatedCount += 1;
                }
                else {
                    skippedCount += 1;
                }
            }
            else {
                await this.createOrReuseRevision(entry, {
                    version: 1,
                    dashboard,
                }, {
                    kind: "pull",
                    instanceName,
                    targetName,
                    effectiveDashboardUid,
                }, { checkout: true });
            }
            dashboardResults.push({
                entry,
                selectorName,
                fileResults,
            });
        }
        if (datasourceCatalogChanged) {
            await this.repository.saveDatasourceCatalog(datasourceCatalog);
        }
        return {
            updatedCount,
            skippedCount,
            previousLocalBackupCount: 0,
            dashboardResults,
        };
    }
    async deployDashboards(entries, instanceName, targetName = repository_1.DEFAULT_DEPLOYMENT_TARGET) {
        return this.deployDashboardsFromRepository(this.repository, entries, instanceName, targetName);
    }
    async deployDashboardsFromRepository(sourceRepository, entries, instanceName, targetName = repository_1.DEFAULT_DEPLOYMENT_TARGET) {
        if (!instanceName) {
            throw new Error("Choose a concrete Grafana instance and deployment target for deploy.");
        }
        const client = await this.clientFactory(instanceName);
        const connection = await this.repository.loadConnectionConfig(instanceName);
        const folderCache = await client.listFolders();
        await this.materializeDashboardUidsForInstance(sourceRepository, instanceName);
        await this.validateInstanceEffectiveDashboardUids(sourceRepository, instanceName);
        if (sourceRepository === this.repository) {
            for (const entry of entries) {
                await this.ensureWorkingCopyCheckedOutRevision(entry, {
                    kind: "deploy",
                    instanceName,
                    targetName,
                });
            }
        }
        const renderManifest = await this.renderDashboardSnapshots(await Promise.all(entries.map(async (entry) => ({
            entry,
            snapshot: await this.repositoryRevisionSnapshot(sourceRepository, entry),
            revisionId: sourceRepository === this.repository ? (await this.currentCheckedOutRevision(entry))?.id : undefined,
        }))), instanceName, targetName, renderScopeForEntries(entries), {
            sourceRepository,
        });
        await this.createTargetBackup(entries, instanceName, targetName, backupScopeForEntries(entries));
        return this.deployRenderedManifest(renderManifest, instanceName, targetName, client, connection.baseUrl, folderCache);
    }
    async renderDashboardSnapshots(items, instanceName, targetName, scope, injected) {
        const sourceRepository = injected?.sourceRepository ?? this.repository;
        await this.repository.clearRenderRoot(instanceName, targetName);
        const dashboards = [];
        for (const { entry, snapshot, revisionId } of items) {
            const renderedDashboard = await this.renderDashboardForTarget(sourceRepository, entry, snapshot.dashboard, instanceName, targetName);
            const folderPath = await this.desiredFolderPathForSnapshot(sourceRepository, entry, instanceName, targetName, snapshot.folderPath);
            const renderPath = this.repository.renderDashboardPath(instanceName, targetName, entry);
            await this.repository.writeJsonFile(renderPath, sanitizeDashboardForStorage(renderedDashboard));
            dashboards.push({
                selectorName: (0, manifest_1.selectorNameForEntry)(entry),
                baseUid: entry.uid,
                effectiveDashboardUid: typeof renderedDashboard.uid === "string" ? renderedDashboard.uid : entry.uid,
                path: entry.path,
                ...(folderPath ? { folderPath } : {}),
                title: typeof renderedDashboard.title === "string" ? renderedDashboard.title : (0, manifest_1.selectorNameForEntry)(entry),
                renderPath: node_path_1.default.relative(this.repository.renderRootPath(instanceName, targetName), renderPath).replace(/\\/g, "/"),
                ...(revisionId ? { revisionId } : {}),
            });
        }
        const manifest = {
            version: 1,
            instanceName,
            targetName,
            generatedAt: new Date().toISOString(),
            scope,
            dashboards,
        };
        await this.repository.saveRenderManifest(instanceName, targetName, manifest);
        return manifest;
    }
    async deployRenderedManifest(manifest, instanceName, targetName, client, connectionBaseUrl, folderCache) {
        const dashboardResults = [];
        for (const rendered of manifest.dashboards) {
            const entry = {
                name: rendered.selectorName,
                uid: rendered.baseUid,
                path: rendered.path,
            };
            const renderedDashboard = await this.repository.readJsonFile(node_path_1.default.join(this.repository.renderRootPath(instanceName, targetName), rendered.renderPath));
            const folderMeta = await this.repository.readFolderMetadata(entry);
            const finalFolderUid = folderMeta?.uid && normalizeFolderPath(folderMeta.path) === normalizeFolderPath(rendered.folderPath)
                ? folderMeta.uid
                : undefined;
            const folderUid = await this.ensureExplicitFolderPath(client, folderCache, rendered.folderPath, finalFolderUid);
            const response = await client.upsertDashboard({
                dashboard: sanitizeDashboardForStorage(renderedDashboard),
                folderUid,
                message: `Deploy ${rendered.selectorName} from VS Code`,
            });
            dashboardResults.push({
                entry,
                selectorName: rendered.selectorName,
                dashboardTitle: rendered.title,
                folderUid,
                url: response.url,
                targetBaseUrl: connectionBaseUrl,
                deploymentTargetName: targetName,
            });
        }
        return {
            instanceName,
            deploymentTargetName: targetName,
            dashboardResults,
        };
    }
    async generateOverride(instanceName, targetName, entry) {
        const dashboard = await this.repository.readDashboardJson(entry);
        const overrideFile = (0, overrides_1.generateOverrideFileFromDashboard)(dashboard);
        const variableCount = Object.keys(overrideFile.variables).length;
        if (variableCount === 0) {
            throw new Error("No supported dashboard variables found. Only custom, textbox, and constant are supported.");
        }
        await this.materializeDashboardUidForTarget(this.repository, instanceName, targetName, entry);
        const existingOverride = (await this.repository.readTargetOverrideFile(instanceName, targetName, entry)) ?? { variables: {} };
        const overridePath = await this.repository.saveTargetOverrideFile(instanceName, targetName, entry, {
            ...existingOverride,
            variables: overrideFile.variables,
        });
        return {
            overridePath,
            variableCount,
        };
    }
    async buildOverrideEditorVariables(instanceName, targetName, entry) {
        const dashboard = await this.repository.readDashboardJson(entry);
        const savedOverride = await this.repository.readTargetOverrideFile(instanceName, targetName, entry);
        const effectiveDashboard = (0, overrides_1.applyOverridesToDashboard)(dashboard, savedOverride);
        const targets = await this.repository.listAllDeploymentTargets();
        const globallyManagedVariableNames = new Set();
        for (const target of targets) {
            const overrideFile = await this.repository.readTargetOverrideFile(target.instanceName, target.name, entry);
            for (const variableName of Object.keys(overrideFile?.variables ?? {})) {
                globallyManagedVariableNames.add(variableName);
            }
        }
        return (0, overrides_1.extractSupportedVariables)(effectiveDashboard, savedOverride).map((descriptor) => {
            const hasManagedOverride = descriptor.savedOverride !== undefined || globallyManagedVariableNames.has(descriptor.name);
            return {
                name: descriptor.name,
                type: descriptor.type,
                currentText: String(descriptor.currentText ?? ""),
                currentValue: String(descriptor.currentValue ?? ""),
                savedOverride: descriptor.savedOverride !== undefined
                    ? (0, overrides_1.serializeOverrideValue)(descriptor.savedOverride)
                    : hasManagedOverride
                        ? (0, overrides_1.serializeOverrideValue)((0, overrides_1.normalizeCurrentForStorage)({
                            text: descriptor.currentText,
                            value: descriptor.currentValue,
                        }))
                        : "",
                hasSavedOverride: hasManagedOverride,
                overrideOptions: descriptor.overrideOptions,
            };
        });
    }
    async saveOverrideFromForm(instanceName, targetName, entry, values) {
        await this.materializeDashboardUidForTarget(this.repository, instanceName, targetName, entry);
        const dashboard = await this.repository.readDashboardJson(entry);
        const supportedVariables = new Map((0, overrides_1.extractSupportedVariables)(dashboard).map((descriptor) => [descriptor.name, descriptor]));
        const targets = await this.repository.listAllDeploymentTargets();
        const existingOverrideFiles = new Map(await Promise.all(targets.map(async (target) => [`${target.instanceName}/${target.name}`, await this.repository.readTargetOverrideFile(target.instanceName, target.name, entry)])));
        const managedByOtherInstances = new Set();
        for (const target of targets) {
            if (target.instanceName === instanceName && target.name === targetName) {
                continue;
            }
            for (const variableName of Object.keys(existingOverrideFiles.get(`${target.instanceName}/${target.name}`)?.variables ?? {})) {
                managedByOtherInstances.add(variableName);
            }
        }
        const currentVariables = {};
        const enabledVariableNames = Object.keys(values)
            .filter((key) => key.startsWith("override_enabled__"))
            .map((key) => key.slice("override_enabled__".length));
        const enabledVariableNameSet = new Set(enabledVariableNames);
        for (const name of enabledVariableNames) {
            const rawValue = values[`override_value__${name}`] ?? "";
            const parsed = (0, overrides_1.parseOverrideInput)(rawValue);
            if (parsed !== undefined) {
                const descriptor = supportedVariables.get(name);
                if (descriptor?.type === "custom" && (descriptor.overrideOptions?.length ?? 0) > 0) {
                    const allowedValues = new Set(descriptor.overrideOptions.map((option) => option.value));
                    const normalizedOverride = (0, overrides_1.normalizeOverrideValue)(parsed);
                    const selectedValues = Array.isArray(normalizedOverride.value)
                        ? normalizedOverride.value
                        : [normalizedOverride.value];
                    const invalidValues = selectedValues
                        .map((value) => (0, overrides_1.serializeOverrideValue)(value))
                        .filter((value) => !allowedValues.has(value));
                    if (invalidValues.length > 0) {
                        throw new Error(`Override value ${invalidValues.map((value) => `"${value}"`).join(", ")} is not available in custom variable "${name}".`);
                    }
                }
                currentVariables[name] = parsed;
            }
        }
        const nextManagedVariableNames = new Set([...managedByOtherInstances, ...enabledVariableNameSet]);
        const effectiveVariablesByTarget = new Map();
        for (const target of targets) {
            const overrideFile = existingOverrideFiles.get(`${target.instanceName}/${target.name}`);
            const effectiveDashboard = (0, overrides_1.applyOverridesToDashboard)(dashboard, overrideFile);
            const effectiveVariables = Object.fromEntries((0, overrides_1.extractSupportedVariables)(effectiveDashboard).map((descriptor) => [
                descriptor.name,
                (0, overrides_1.normalizeCurrentForStorage)({
                    text: descriptor.currentText,
                    value: descriptor.currentValue,
                }),
            ]));
            effectiveVariablesByTarget.set(`${target.instanceName}/${target.name}`, effectiveVariables);
        }
        for (const target of targets) {
            const existingOverride = existingOverrideFiles.get(`${target.instanceName}/${target.name}`);
            const existingVariables = {
                ...(existingOverride?.variables ?? {}),
            };
            const existingFolderPath = normalizeFolderPath(existingOverride?.folderPath);
            for (const variableName of supportedVariables.keys()) {
                const managed = nextManagedVariableNames.has(variableName);
                if (!managed) {
                    delete existingVariables[variableName];
                    continue;
                }
                if (target.instanceName === instanceName && target.name === targetName && variableName in currentVariables) {
                    existingVariables[variableName] = currentVariables[variableName];
                    continue;
                }
                if (existingVariables[variableName] !== undefined) {
                    continue;
                }
                const seededValue = effectiveVariablesByTarget.get(`${target.instanceName}/${target.name}`)?.[variableName];
                if (seededValue !== undefined) {
                    existingVariables[variableName] = seededValue;
                }
            }
            await this.repository.saveTargetOverrideFile(target.instanceName, target.name, entry, {
                ...(existingOverride?.dashboardUid ? { dashboardUid: existingOverride.dashboardUid } : {}),
                ...(existingFolderPath ? { folderPath: existingFolderPath } : {}),
                variables: existingVariables,
            });
        }
        return this.repository.targetOverridePath(instanceName, targetName, entry);
    }
    async materializeManagedOverridesForTarget(instanceName, targetName) {
        const records = await this.repository.listDashboardRecords();
        const allTargets = await this.repository.listAllDeploymentTargets();
        const currentTargetKey = `${instanceName}/${targetName}`;
        for (const record of records) {
            const materializedOverride = await this.materializeDashboardUidForTarget(this.repository, instanceName, targetName, record.entry);
            const dashboard = await this.repository.readDashboardJson(record.entry);
            const supportedVariables = (0, overrides_1.extractSupportedVariables)(dashboard);
            const existingOverrideFiles = new Map(await Promise.all(allTargets.map(async (target) => [`${target.instanceName}/${target.name}`, await this.repository.readTargetOverrideFile(target.instanceName, target.name, record.entry)])));
            existingOverrideFiles.set(currentTargetKey, materializedOverride);
            const managedVariableNames = new Set();
            for (const [targetKey, overrideFile] of existingOverrideFiles) {
                if (targetKey === currentTargetKey) {
                    continue;
                }
                for (const variableName of Object.keys(overrideFile?.variables ?? {})) {
                    managedVariableNames.add(variableName);
                }
            }
            if (managedVariableNames.size === 0 && supportedVariables.length === 0) {
                continue;
            }
            const existingOverride = existingOverrideFiles.get(currentTargetKey);
            const effectiveDashboard = (0, overrides_1.applyOverridesToDashboard)(dashboard, existingOverride);
            const effectivePlacement = await this.buildPlacementDetails(instanceName, targetName, record.entry);
            const effectiveVariables = Object.fromEntries((0, overrides_1.extractSupportedVariables)(effectiveDashboard).map((descriptor) => [
                descriptor.name,
                (0, overrides_1.normalizeCurrentForStorage)({
                    text: descriptor.currentText,
                    value: descriptor.currentValue,
                }),
            ]));
            const nextVariables = {
                ...(existingOverride?.variables ?? {}),
            };
            const nextFolderPath = normalizeFolderPath(existingOverride?.folderPath) ?? effectivePlacement.effectiveFolderPath;
            let changed = false;
            for (const variable of supportedVariables) {
                if (!managedVariableNames.has(variable.name)) {
                    continue;
                }
                if (nextVariables[variable.name] !== undefined) {
                    continue;
                }
                const seededValue = effectiveVariables[variable.name];
                if (seededValue === undefined) {
                    continue;
                }
                nextVariables[variable.name] = seededValue;
                changed = true;
            }
            if (!changed) {
                if (!nextFolderPath || existingOverride?.folderPath) {
                    continue;
                }
            }
            await this.repository.saveTargetOverrideFile(instanceName, targetName, record.entry, {
                ...(existingOverride?.dashboardUid ? { dashboardUid: existingOverride.dashboardUid } : {}),
                ...(nextFolderPath ? { folderPath: nextFolderPath } : {}),
                variables: nextVariables,
            });
        }
    }
    async buildPlacementDetails(instanceName, targetName, entry) {
        const folderMeta = await this.repository.readFolderMetadata(entry);
        const overrideFile = await this.repository.readTargetOverrideFile(instanceName, targetName, entry);
        const baseFolderPath = normalizeFolderPath(folderMeta?.path);
        const overrideFolderPath = normalizeFolderPath(overrideFile?.folderPath);
        const overrideDashboardUid = overrideFile?.dashboardUid?.trim() || undefined;
        return {
            baseFolderPath,
            overrideFolderPath,
            effectiveFolderPath: overrideFolderPath ?? baseFolderPath,
            baseDashboardUid: entry.uid,
            overrideDashboardUid,
            effectiveDashboardUid: this.effectiveDashboardUidForTarget(entry, targetName, overrideFile),
        };
    }
    async savePlacement(instanceName, targetName, entry, folderPath) {
        await this.materializeDashboardUidForTarget(this.repository, instanceName, targetName, entry);
        const existingOverride = (await this.repository.readTargetOverrideFile(instanceName, targetName, entry)) ?? { variables: {} };
        const normalizedFolderPath = normalizeFolderPath(folderPath);
        const nextOverride = {
            ...(existingOverride.dashboardUid ? { dashboardUid: existingOverride.dashboardUid } : {}),
            ...(normalizedFolderPath ? { folderPath: normalizedFolderPath } : {}),
            variables: existingOverride.variables ?? {},
        };
        await this.repository.saveTargetOverrideFile(instanceName, targetName, entry, nextOverride);
        return this.repository.dashboardOverridesFilePath(entry);
    }
    async saveDatasourceSelections(instanceName, selectorName, values) {
        const record = await this.repository.dashboardRecordBySelector(selectorName);
        if (!record) {
            throw new Error(`Dashboard selector not found: ${selectorName}`);
        }
        const dashboard = await this.repository.readDashboardJson(record.entry);
        const dashboardSourceNames = new Set((0, datasourceRefs_1.extractDashboardDatasourceRefs)(dashboard).map((ref) => ref.sourceUid));
        const instances = await this.repository.listInstances();
        const catalog = (0, datasourceMappings_1.ensureDatasourceCatalogInstances)(await this.repository.readDatasourceCatalog(), [...new Set([...instances.map((instance) => instance.name), instanceName])]);
        for (const sourceName of dashboardSourceNames) {
            catalog.datasources[sourceName] ??= { instances: {} };
        }
        const renameMap = new Map();
        for (const value of values) {
            const currentSourceName = value.currentSourceName.trim();
            const nextSourceName = value.nextSourceName.trim();
            if (!currentSourceName || !dashboardSourceNames.has(currentSourceName)) {
                continue;
            }
            if (!nextSourceName) {
                throw new Error("Source datasource name must not be empty.");
            }
            renameMap.set(currentSourceName, nextSourceName);
        }
        const nextDatasourceEntries = {};
        for (const [sourceName, entry] of Object.entries(catalog.datasources)) {
            const nextSourceName = renameMap.get(sourceName) ?? sourceName;
            if (nextDatasourceEntries[nextSourceName]) {
                throw new Error(`Datasource source name already exists: ${nextSourceName}`);
            }
            nextDatasourceEntries[nextSourceName] = structuredClone(entry);
        }
        const renamePairs = Object.fromEntries([...renameMap.entries()].filter(([currentSourceName, nextSourceName]) => currentSourceName !== nextSourceName));
        const nextCatalog = {
            datasources: nextDatasourceEntries,
        };
        for (const value of values) {
            const currentSourceName = value.currentSourceName.trim();
            const nextSourceName = value.nextSourceName.trim();
            if (!currentSourceName || !nextSourceName || !dashboardSourceNames.has(currentSourceName)) {
                continue;
            }
            const entry = nextCatalog.datasources[nextSourceName];
            entry.instances[instanceName] = value.targetUid?.trim()
                ? {
                    uid: value.targetUid.trim(),
                    ...(value.targetName?.trim() ? { name: value.targetName.trim() } : {}),
                }
                : {};
        }
        if (Object.keys(renamePairs).length > 0) {
            const records = await this.repository.listDashboardRecords();
            for (const currentRecord of records) {
                const currentDashboard = await this.repository.readDashboardJson(currentRecord.entry);
                const nextDashboard = (0, datasourceMappings_1.renameDatasourceSourceNames)(currentDashboard, renamePairs);
                if ((0, json_1.stableJsonStringify)(nextDashboard) === (0, json_1.stableJsonStringify)(currentDashboard)) {
                    continue;
                }
                await this.repository.saveDashboardJson(currentRecord.entry, nextDashboard);
            }
        }
        await this.repository.saveDatasourceCatalog(nextCatalog);
    }
    async renderDashboardForTarget(sourceRepository, entry, baseDashboard, instanceName, targetName) {
        const overrideFile = await this.materializeDashboardUidForTarget(sourceRepository, instanceName, targetName, entry);
        const datasourceCatalog = await sourceRepository.readDatasourceCatalog();
        const dashboardWithVariableOverrides = (0, overrides_1.applyOverridesToDashboard)(baseDashboard, overrideFile);
        dashboardWithVariableOverrides.uid = this.effectiveDashboardUidForTarget(entry, targetName, overrideFile);
        const missingMappings = (0, datasourceMappings_1.findMissingDatasourceMappings)(dashboardWithVariableOverrides, datasourceCatalog, instanceName);
        if (missingMappings.length > 0) {
            throw new Error(`Datasource mappings are missing for ${(0, manifest_1.selectorNameForEntry)(entry)} on ${instanceName}: ${missingMappings.join(", ")}`);
        }
        return (0, datasourceMappings_1.applyDatasourceMappingsToDashboard)(dashboardWithVariableOverrides, datasourceCatalog, instanceName);
    }
    async ensureFolder(sourceRepository, client, folderCache, entry, instanceName, targetName) {
        const folderMeta = await sourceRepository.readFolderMetadata(entry);
        return this.ensureFolderForSnapshot(sourceRepository, client, folderCache, entry, instanceName, targetName, folderMeta?.path);
    }
    async ensureFolderForSnapshot(sourceRepository, client, folderCache, entry, instanceName, targetName, snapshotFolderPath) {
        const folderMeta = await sourceRepository.readFolderMetadata(entry);
        const overrideFile = await sourceRepository.readTargetOverrideFile(instanceName, targetName, entry);
        const relativeFolder = node_path_1.default.dirname(entry.path).replace(/\\/g, "/");
        const desiredPath = normalizeFolderPath(overrideFile?.folderPath) ??
            normalizeFolderPath(snapshotFolderPath) ??
            (relativeFolder && relativeFolder !== "_root" ? normalizeFolderPath(node_path_1.default.basename(relativeFolder)) : undefined);
        if (!desiredPath) {
            return undefined;
        }
        const segments = desiredPath.split("/").filter(Boolean);
        let parentUid;
        let currentFolder;
        for (const [index, segment] of segments.entries()) {
            let siblings;
            try {
                siblings = parentUid ? await client.listFolders(parentUid) : folderCache;
            }
            catch (error) {
                if (segments.length > 1) {
                    throw new Error(`Nested folder path "${desiredPath}" requires Grafana nested folders support: ${String(error)}`);
                }
                throw error;
            }
            currentFolder = siblings.find((folder) => folder.title === segment);
            if (!currentFolder) {
                try {
                    currentFolder = await client.createFolder({
                        title: segment,
                        ...(index === segments.length - 1 && folderMeta?.uid ? { uid: folderMeta.uid } : {}),
                        ...(parentUid ? { parentUid } : {}),
                    });
                }
                catch (error) {
                    if (segments.length > 1) {
                        throw new Error(`Could not create nested folder path "${desiredPath}": ${String(error)}`);
                    }
                    throw error;
                }
                if (!parentUid) {
                    folderCache.push(currentFolder);
                }
            }
            else if (!parentUid && !folderCache.some((folder) => folder.uid === currentFolder?.uid)) {
                folderCache.push(currentFolder);
            }
            parentUid = currentFolder.uid;
        }
        return currentFolder?.uid;
    }
}
exports.DashboardService = DashboardService;
//# sourceMappingURL=dashboardService.js.map