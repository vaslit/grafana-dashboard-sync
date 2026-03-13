"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectRepository = exports.DEFAULT_DEPLOYMENT_TARGET = void 0;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const env_1 = require("./env");
const json_1 = require("./json");
const manifest_1 = require("./manifest");
const projectLocator_1 = require("./projectLocator");
async function exists(filePath) {
    try {
        await promises_1.default.access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
async function ensureDir(dirPath) {
    await promises_1.default.mkdir(dirPath, { recursive: true });
}
async function removeFileIfExists(filePath) {
    if (!(await exists(filePath))) {
        return false;
    }
    await promises_1.default.unlink(filePath);
    return true;
}
async function copyDirectoryTree(sourceDir, targetDir, options) {
    if (!(await exists(sourceDir))) {
        return;
    }
    await ensureDir(targetDir);
    const entries = await promises_1.default.readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
        const sourcePath = node_path_1.default.join(sourceDir, entry.name);
        const targetPath = node_path_1.default.join(targetDir, entry.name);
        if (entry.isDirectory()) {
            await copyDirectoryTree(sourcePath, targetPath, options);
            continue;
        }
        if (options?.sanitizeEnvFiles && entry.name === ".env") {
            const content = await promises_1.default.readFile(sourcePath, "utf8");
            const parsed = (0, env_1.parseEnv)(content);
            const { GRAFANA_TOKEN: _ignored, ...safeValues } = parsed;
            await promises_1.default.writeFile(targetPath, (0, env_1.stringifyEnv)(safeValues), "utf8");
            continue;
        }
        await ensureDir(node_path_1.default.dirname(targetPath));
        await promises_1.default.copyFile(sourcePath, targetPath);
    }
}
exports.DEFAULT_DEPLOYMENT_TARGET = "default";
function normalizeRelativePath(relativePath) {
    return relativePath.replace(/\\/g, "/");
}
function toRelativeConfigPath(projectRootPath, absolutePath) {
    const relativePath = normalizeRelativePath(node_path_1.default.relative(projectRootPath, absolutePath));
    return relativePath || ".";
}
function targetNameFromOverrideTargetKey(targetKey) {
    const slashIndex = targetKey.indexOf("/");
    return slashIndex >= 0 ? targetKey.slice(slashIndex + 1) : targetKey;
}
function defaultWorkspaceConfig(layout) {
    return {
        version: 2,
        layout: {
            dashboardsDir: toRelativeConfigPath(layout.projectRootPath, layout.dashboardsDir),
            instancesDir: toRelativeConfigPath(layout.projectRootPath, layout.instancesDir),
            backupsDir: toRelativeConfigPath(layout.projectRootPath, layout.backupsDir),
            rendersDir: toRelativeConfigPath(layout.projectRootPath, layout.rendersDir),
            maxBackups: layout.maxBackups,
        },
        dashboards: [],
        datasources: {},
        instances: {},
    };
}
function validateWorkspaceProjectConfig(config, filePath) {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
        throw new Error(`Invalid workspace config: ${filePath}`);
    }
    if (config.version !== 2) {
        throw new Error(`Invalid workspace config version: ${filePath}`);
    }
    if (!config.layout || typeof config.layout !== "object" || Array.isArray(config.layout)) {
        throw new Error(`Invalid workspace config: ${filePath}`);
    }
    for (const [key, value] of Object.entries({
        dashboardsDir: config.layout.dashboardsDir,
        instancesDir: config.layout.instancesDir,
        backupsDir: config.layout.backupsDir,
        rendersDir: config.layout.rendersDir,
    })) {
        if (typeof value !== "string" || !value.trim()) {
            throw new Error(`Invalid workspace config ${key}: ${filePath}`);
        }
    }
    if (typeof config.layout.maxBackups !== "number" ||
        !Number.isInteger(config.layout.maxBackups) ||
        config.layout.maxBackups <= 0) {
        throw new Error(`Invalid workspace config maxBackups: ${filePath}`);
    }
    const manifestErrors = (0, manifest_1.validateManifest)({ dashboards: config.dashboards });
    if (manifestErrors.length > 0) {
        throw new Error(manifestErrors.join("\n"));
    }
    validateDatasourceCatalogFile({ datasources: config.datasources }, filePath);
    if (!config.instances || typeof config.instances !== "object" || Array.isArray(config.instances)) {
        throw new Error(`Invalid workspace config instances: ${filePath}`);
    }
    for (const [instanceName, instanceConfig] of Object.entries(config.instances)) {
        if (!instanceName.trim()) {
            throw new Error(`Invalid workspace config instance name: ${filePath}`);
        }
        if (!instanceConfig || typeof instanceConfig !== "object" || Array.isArray(instanceConfig)) {
            throw new Error(`Invalid workspace config instance: ${filePath}`);
        }
        if (instanceConfig.grafanaUrl !== undefined && typeof instanceConfig.grafanaUrl !== "string") {
            throw new Error(`Invalid workspace config grafanaUrl: ${filePath}`);
        }
        if (instanceConfig.grafanaNamespace !== undefined && typeof instanceConfig.grafanaNamespace !== "string") {
            throw new Error(`Invalid workspace config grafanaNamespace: ${filePath}`);
        }
        if (!instanceConfig.targets || typeof instanceConfig.targets !== "object" || Array.isArray(instanceConfig.targets)) {
            throw new Error(`Invalid workspace config targets: ${filePath}`);
        }
        for (const targetName of Object.keys(instanceConfig.targets)) {
            if (!targetName.trim()) {
                throw new Error(`Invalid workspace config target name: ${filePath}`);
            }
        }
    }
    return config;
}
function validateDatasourceCatalogFile(mappingFile, filePath) {
    if (!mappingFile || typeof mappingFile !== "object" || Array.isArray(mappingFile)) {
        throw new Error(`Invalid datasource catalog file: ${filePath}`);
    }
    const datasources = mappingFile.datasources ?? {};
    if (!datasources || typeof datasources !== "object" || Array.isArray(datasources)) {
        throw new Error(`Invalid datasource catalog file: ${filePath}`);
    }
    for (const [sourceName, entry] of Object.entries(datasources)) {
        if (!sourceName.trim()) {
            throw new Error(`Invalid datasource catalog file: ${filePath}`);
        }
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw new Error(`Invalid datasource catalog file: ${filePath}`);
        }
        const instances = entry.instances ?? {};
        if (!instances || typeof instances !== "object" || Array.isArray(instances)) {
            throw new Error(`Invalid datasource catalog file: ${filePath}`);
        }
        for (const [instanceName, target] of Object.entries(instances)) {
            if (!instanceName.trim()) {
                throw new Error(`Invalid datasource catalog file: ${filePath}`);
            }
            if (!target || typeof target !== "object" || Array.isArray(target)) {
                throw new Error(`Invalid datasource catalog file: ${filePath}`);
            }
            if (target.uid !== undefined && (typeof target.uid !== "string" || !target.uid.trim())) {
                throw new Error(`Invalid datasource catalog file: ${filePath}`);
            }
            if (target.name !== undefined && typeof target.name !== "string") {
                throw new Error(`Invalid datasource catalog file: ${filePath}`);
            }
        }
    }
    return {
        datasources,
    };
}
function validateDashboardFolderOverridesFile(overridesFile, filePath) {
    if (!overridesFile || typeof overridesFile !== "object" || Array.isArray(overridesFile)) {
        throw new Error(`Invalid dashboard overrides file: ${filePath}`);
    }
    const dashboards = overridesFile.dashboards ?? {};
    if (!dashboards || typeof dashboards !== "object" || Array.isArray(dashboards)) {
        throw new Error(`Invalid dashboard overrides file: ${filePath}`);
    }
    for (const [dashboardKey, dashboardEntry] of Object.entries(dashboards)) {
        if (!dashboardKey.trim()) {
            throw new Error(`Invalid dashboard overrides file: ${filePath}`);
        }
        if (!dashboardEntry || typeof dashboardEntry !== "object" || Array.isArray(dashboardEntry)) {
            throw new Error(`Invalid dashboard overrides file: ${filePath}`);
        }
        const targets = dashboardEntry.targets ?? {};
        if (!targets || typeof targets !== "object" || Array.isArray(targets)) {
            throw new Error(`Invalid dashboard overrides file: ${filePath}`);
        }
        for (const [targetKey, override] of Object.entries(targets)) {
            if (!targetKey.trim()) {
                throw new Error(`Invalid dashboard overrides file: ${filePath}`);
            }
            if (!override || typeof override !== "object" || Array.isArray(override)) {
                throw new Error(`Invalid dashboard overrides file: ${filePath}`);
            }
            if (override.dashboardUid !== undefined && (typeof override.dashboardUid !== "string" || !override.dashboardUid.trim())) {
                throw new Error(`Invalid dashboard overrides file: ${filePath}`);
            }
            if (targetNameFromOverrideTargetKey(targetKey) === exports.DEFAULT_DEPLOYMENT_TARGET && override.dashboardUid !== undefined) {
                throw new Error(`Invalid dashboard overrides file: ${filePath}`);
            }
            if (override.folderPath !== undefined && (typeof override.folderPath !== "string" || !override.folderPath.trim())) {
                throw new Error(`Invalid dashboard overrides file: ${filePath}`);
            }
            if (!override.variables || typeof override.variables !== "object" || Array.isArray(override.variables)) {
                throw new Error(`Invalid dashboard overrides file: ${filePath}`);
            }
        }
    }
    return {
        dashboards,
    };
}
function validateDashboardRevisionSnapshot(snapshot, filePath) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
        throw new Error(`Invalid dashboard revision snapshot: ${filePath}`);
    }
    if (snapshot.version !== 1) {
        throw new Error(`Invalid dashboard revision snapshot: ${filePath}`);
    }
    if (!snapshot.dashboard || typeof snapshot.dashboard !== "object" || Array.isArray(snapshot.dashboard)) {
        throw new Error(`Invalid dashboard revision snapshot: ${filePath}`);
    }
    if (snapshot.folderPath !== undefined && (typeof snapshot.folderPath !== "string" || !snapshot.folderPath.trim())) {
        throw new Error(`Invalid dashboard revision snapshot: ${filePath}`);
    }
    return snapshot;
}
function validateDashboardVersionIndex(index, filePath) {
    if (!index || typeof index !== "object" || Array.isArray(index)) {
        throw new Error(`Invalid dashboard version index: ${filePath}`);
    }
    if (index.checkedOutRevisionId !== undefined && (typeof index.checkedOutRevisionId !== "string" || !index.checkedOutRevisionId.trim())) {
        throw new Error(`Invalid dashboard version index: ${filePath}`);
    }
    if (!Array.isArray(index.revisions)) {
        throw new Error(`Invalid dashboard version index: ${filePath}`);
    }
    for (const revision of index.revisions) {
        if (!revision || typeof revision !== "object" || Array.isArray(revision)) {
            throw new Error(`Invalid dashboard version index: ${filePath}`);
        }
        for (const key of ["id", "createdAt", "contentHash", "templateHash", "snapshotPath"]) {
            if (typeof revision[key] !== "string" || !revision[key].trim()) {
                throw new Error(`Invalid dashboard version index: ${filePath}`);
            }
        }
        if (revision.baseFolderPath !== undefined && (typeof revision.baseFolderPath !== "string" || !revision.baseFolderPath.trim())) {
            throw new Error(`Invalid dashboard version index: ${filePath}`);
        }
        if (!revision.source || typeof revision.source !== "object" || Array.isArray(revision.source)) {
            throw new Error(`Invalid dashboard version index: ${filePath}`);
        }
        if (typeof revision.source.kind !== "string" || !revision.source.kind.trim()) {
            throw new Error(`Invalid dashboard version index: ${filePath}`);
        }
    }
    return index;
}
function validateTargetBackupManifest(manifest, filePath) {
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
        throw new Error(`Invalid backup manifest: ${filePath}`);
    }
    if (manifest.version !== 1 || manifest.kind !== "target-backup") {
        throw new Error(`Invalid backup manifest: ${filePath}`);
    }
    if (manifest.scope !== "dashboard" && manifest.scope !== "target") {
        throw new Error(`Invalid backup manifest: ${filePath}`);
    }
    for (const key of ["backupName", "generatedAt", "instanceName", "targetName"]) {
        if (typeof manifest[key] !== "string" || !manifest[key].trim()) {
            throw new Error(`Invalid backup manifest: ${filePath}`);
        }
    }
    if (!Number.isInteger(manifest.dashboardCount) || manifest.dashboardCount < 0) {
        throw new Error(`Invalid backup manifest: ${filePath}`);
    }
    if (!Array.isArray(manifest.dashboards)) {
        throw new Error(`Invalid backup manifest: ${filePath}`);
    }
    for (const dashboard of manifest.dashboards) {
        for (const key of ["selectorName", "baseUid", "effectiveDashboardUid", "path", "title", "snapshotPath"]) {
            if (typeof dashboard[key] !== "string" || !dashboard[key].trim()) {
                throw new Error(`Invalid backup manifest: ${filePath}`);
            }
        }
        if (dashboard.folderPath !== undefined && (typeof dashboard.folderPath !== "string" || !dashboard.folderPath.trim())) {
            throw new Error(`Invalid backup manifest: ${filePath}`);
        }
    }
    return manifest;
}
function validateRenderManifest(manifest, filePath) {
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
        throw new Error(`Invalid render manifest: ${filePath}`);
    }
    if (manifest.version !== 1) {
        throw new Error(`Invalid render manifest: ${filePath}`);
    }
    if (manifest.scope !== "dashboard" && manifest.scope !== "target") {
        throw new Error(`Invalid render manifest: ${filePath}`);
    }
    for (const key of ["instanceName", "targetName", "generatedAt"]) {
        if (typeof manifest[key] !== "string" || !manifest[key].trim()) {
            throw new Error(`Invalid render manifest: ${filePath}`);
        }
    }
    if (!Array.isArray(manifest.dashboards)) {
        throw new Error(`Invalid render manifest: ${filePath}`);
    }
    for (const dashboard of manifest.dashboards) {
        for (const key of ["selectorName", "baseUid", "effectiveDashboardUid", "path", "title", "renderPath"]) {
            if (typeof dashboard[key] !== "string" || !dashboard[key].trim()) {
                throw new Error(`Invalid render manifest: ${filePath}`);
            }
        }
        if (dashboard.folderPath !== undefined && (typeof dashboard.folderPath !== "string" || !dashboard.folderPath.trim())) {
            throw new Error(`Invalid render manifest: ${filePath}`);
        }
        if (dashboard.revisionId !== undefined && (typeof dashboard.revisionId !== "string" || !dashboard.revisionId.trim())) {
            throw new Error(`Invalid render manifest: ${filePath}`);
        }
    }
    return manifest;
}
class ProjectRepository {
    workspaceRootPath;
    projectRootPath;
    workspaceConfigPath;
    configPath;
    manifestPath;
    datasourceCatalogPath;
    manifestExamplePath;
    dashboardsDir;
    instancesDir;
    backupsDir;
    rendersDir;
    rootEnvPath;
    maxBackups;
    resolveToken;
    constructor(layoutOrRootPath, options) {
        const layout = typeof layoutOrRootPath === "string" ? (0, projectLocator_1.defaultProjectLayout)(layoutOrRootPath) : layoutOrRootPath;
        this.workspaceRootPath = layout.workspaceRootPath;
        this.projectRootPath = layout.projectRootPath;
        this.workspaceConfigPath = layout.workspaceConfigPath;
        this.configPath = layout.configPath;
        this.manifestPath = layout.manifestPath;
        this.datasourceCatalogPath = node_path_1.default.join(layout.projectRootPath, "datasources.json");
        this.manifestExamplePath = layout.manifestExamplePath;
        this.dashboardsDir = layout.dashboardsDir;
        this.instancesDir = layout.instancesDir;
        this.backupsDir = layout.backupsDir;
        this.rendersDir = layout.rendersDir;
        this.rootEnvPath = layout.rootEnvPath;
        this.maxBackups = layout.maxBackups;
        this.resolveToken = options?.resolveToken ?? (async () => undefined);
    }
    async ensureProjectLayout() {
        await ensureDir(this.dashboardsDir);
        await ensureDir(this.instancesDir);
        await ensureDir(this.backupsDir);
        await ensureDir(this.rendersDir);
    }
    dashboardPath(entry) {
        return node_path_1.default.join(this.dashboardsDir, entry.path);
    }
    dashboardFolderPath(entry) {
        return node_path_1.default.dirname(this.dashboardPath(entry));
    }
    renderRootPath(instanceName, targetName) {
        return node_path_1.default.join(this.rendersDir, instanceName, targetName);
    }
    renderManifestPath(instanceName, targetName) {
        return node_path_1.default.join(this.renderRootPath(instanceName, targetName), ".render-manifest.json");
    }
    renderDashboardPath(instanceName, targetName, entry) {
        return node_path_1.default.join(this.renderRootPath(instanceName, targetName), entry.path);
    }
    folderMetaPathForEntry(entry) {
        const dashboardPath = this.dashboardPath(entry);
        const relativeDir = node_path_1.default.relative(this.dashboardsDir, node_path_1.default.dirname(dashboardPath)).replace(/\\/g, "/");
        if (!relativeDir) {
            return undefined;
        }
        return node_path_1.default.join(node_path_1.default.dirname(dashboardPath), ".folder.json");
    }
    dashboardOverridesFilePath(entry) {
        return node_path_1.default.join(node_path_1.default.dirname(this.dashboardPath(entry)), ".overrides.json");
    }
    dashboardVersionsDirPath(entry) {
        return node_path_1.default.join(node_path_1.default.dirname(this.dashboardPath(entry)), ".versions");
    }
    dashboardVersionIndexPath(entry) {
        return node_path_1.default.join(node_path_1.default.dirname(this.dashboardPath(entry)), ".versions.json");
    }
    dashboardRevisionSnapshotPath(entry, revisionId) {
        return node_path_1.default.join(this.dashboardVersionsDirPath(entry), `${revisionId}.json`);
    }
    dashboardOverrideTargetKey(instanceName, targetName) {
        return `${instanceName}/${targetName}`;
    }
    dashboardOverrideDashboardKey(entry) {
        return entry.uid;
    }
    targetOverridePath(instanceName, targetName, entry) {
        return `${this.dashboardOverridesFilePath(entry)}#${this.dashboardOverrideTargetKey(instanceName, targetName)}`;
    }
    targetDefaultsPath(instanceName, targetName) {
        return `${projectLocator_1.PROJECT_CONFIG_FILE}#instances.${instanceName}.targets.${targetName}.defaults`;
    }
    overridePath(instanceName, entry) {
        return this.targetOverridePath(instanceName, exports.DEFAULT_DEPLOYMENT_TARGET, entry);
    }
    defaultsPath(instanceName) {
        return `${projectLocator_1.PROJECT_CONFIG_FILE}#instances.${instanceName}.targets.${exports.DEFAULT_DEPLOYMENT_TARGET}.defaults`;
    }
    instanceEnvPath(instanceName) {
        return node_path_1.default.join(this.instancesDir, instanceName, ".env");
    }
    instanceEnvExamplePath(instanceName) {
        return node_path_1.default.join(this.instancesDir, instanceName, ".env.example");
    }
    async readJsonFile(filePath) {
        return JSON.parse(await promises_1.default.readFile(filePath, "utf8"));
    }
    async writeJsonFile(filePath, value) {
        await ensureDir(node_path_1.default.dirname(filePath));
        await promises_1.default.writeFile(filePath, (0, json_1.stableJsonStringify)(value), "utf8");
    }
    async readTextFileIfExists(filePath) {
        if (!(await exists(filePath))) {
            return undefined;
        }
        return promises_1.default.readFile(filePath, "utf8");
    }
    async writeTextFile(filePath, content) {
        await ensureDir(node_path_1.default.dirname(filePath));
        await promises_1.default.writeFile(filePath, content, "utf8");
    }
    async workspaceConfigExists() {
        return exists(this.workspaceConfigPath);
    }
    async loadWorkspaceConfig() {
        if (!(await this.workspaceConfigExists())) {
            return defaultWorkspaceConfig({
                workspaceRootPath: this.workspaceRootPath,
                projectRootPath: this.projectRootPath,
                workspaceConfigPath: this.workspaceConfigPath,
                configPath: this.configPath,
                manifestPath: this.manifestPath,
                manifestExamplePath: this.manifestExamplePath,
                legacyDatasourceCatalogPath: this.datasourceCatalogPath,
                dashboardsDir: this.dashboardsDir,
                instancesDir: this.instancesDir,
                backupsDir: this.backupsDir,
                rendersDir: this.rendersDir,
                rootEnvPath: this.rootEnvPath,
                maxBackups: this.maxBackups,
            });
        }
        const config = await this.readJsonFile(this.workspaceConfigPath);
        return validateWorkspaceProjectConfig(config, this.workspaceConfigPath);
    }
    async saveWorkspaceConfig(config) {
        const validConfig = validateWorkspaceProjectConfig(config, this.workspaceConfigPath);
        await this.ensureProjectLayout();
        await this.writeJsonFile(this.workspaceConfigPath, validConfig);
    }
    async migrateWorkspaceConfig() {
        const configExists = await this.workspaceConfigExists();
        const rawConfig = configExists ? await this.readJsonFile(this.workspaceConfigPath) : {};
        const migratedConfig = defaultWorkspaceConfig({
            workspaceRootPath: this.workspaceRootPath,
            projectRootPath: this.projectRootPath,
            workspaceConfigPath: this.workspaceConfigPath,
            configPath: this.configPath,
            manifestPath: this.manifestPath,
            manifestExamplePath: this.manifestExamplePath,
            legacyDatasourceCatalogPath: this.datasourceCatalogPath,
            dashboardsDir: this.dashboardsDir,
            instancesDir: this.instancesDir,
            backupsDir: this.backupsDir,
            rendersDir: this.rendersDir,
            rootEnvPath: this.rootEnvPath,
            maxBackups: this.maxBackups,
        });
        if (rawConfig.version === 2) {
            const nextRawConfig = structuredClone(rawConfig);
            const layout = (nextRawConfig.layout ??= {});
            layout.rendersDir ??= toRelativeConfigPath(this.projectRootPath, this.rendersDir);
            const current = validateWorkspaceProjectConfig(nextRawConfig, this.workspaceConfigPath);
            migratedConfig.layout = current.layout;
            migratedConfig.dashboards = current.dashboards;
            migratedConfig.datasources = current.datasources;
            migratedConfig.instances = current.instances;
        }
        if (migratedConfig.dashboards.length === 0 && (await exists(this.manifestPath))) {
            const legacyManifest = await this.readJsonFile(this.manifestPath);
            const errors = (0, manifest_1.validateManifest)(legacyManifest);
            if (errors.length > 0) {
                throw new Error(errors.join("\n"));
            }
            migratedConfig.dashboards = legacyManifest.dashboards;
        }
        if (Object.keys(migratedConfig.datasources).length === 0 && (await exists(this.datasourceCatalogPath))) {
            migratedConfig.datasources = validateDatasourceCatalogFile(await this.readJsonFile(this.datasourceCatalogPath), this.datasourceCatalogPath).datasources;
        }
        const instanceNames = new Set(Object.keys(migratedConfig.instances));
        if (await exists(this.instancesDir)) {
            const directoryEntries = await promises_1.default.readdir(this.instancesDir, { withFileTypes: true });
            for (const entry of directoryEntries) {
                if (entry.isDirectory()) {
                    instanceNames.add(entry.name);
                }
            }
        }
        for (const instanceName of instanceNames) {
            const currentConfig = {
                ...(migratedConfig.instances[instanceName] ?? { targets: {} }),
                targets: { ...(migratedConfig.instances[instanceName]?.targets ?? {}) },
            };
            const legacyEnvPath = this.instanceEnvPath(instanceName);
            if ((!currentConfig.grafanaUrl || !currentConfig.grafanaNamespace) && (await exists(legacyEnvPath))) {
                const parsed = (0, env_1.parseEnv)(await promises_1.default.readFile(legacyEnvPath, "utf8"));
                if (!currentConfig.grafanaUrl && parsed.GRAFANA_URL?.trim()) {
                    currentConfig.grafanaUrl = parsed.GRAFANA_URL.trim();
                }
                if (!currentConfig.grafanaNamespace && parsed.GRAFANA_NAMESPACE?.trim()) {
                    currentConfig.grafanaNamespace = parsed.GRAFANA_NAMESPACE.trim();
                }
            }
            if (Object.keys(currentConfig.targets).length === 0) {
                currentConfig.targets[exports.DEFAULT_DEPLOYMENT_TARGET] = {};
            }
            migratedConfig.instances[instanceName] = currentConfig;
        }
        const nextConfig = validateWorkspaceProjectConfig(migratedConfig, this.workspaceConfigPath);
        const changed = !configExists ||
            (configExists &&
                (0, json_1.stableJsonStringify)(nextConfig) !==
                    (0, json_1.stableJsonStringify)(rawConfig.version === 2 ? rawConfig : {}));
        if (changed) {
            await this.saveWorkspaceConfig(nextConfig);
        }
        await this.migrateDeploymentTargets();
        return changed;
    }
    async manifestExists() {
        const config = await this.loadWorkspaceConfig();
        return config.dashboards.length > 0;
    }
    async loadManifest() {
        const config = await this.loadWorkspaceConfig();
        return { dashboards: config.dashboards };
    }
    async saveManifest(manifest) {
        const errors = (0, manifest_1.validateManifest)(manifest);
        if (errors.length > 0) {
            throw new Error(errors.join("\n"));
        }
        const config = await this.loadWorkspaceConfig();
        await this.saveWorkspaceConfig({
            ...config,
            dashboards: manifest.dashboards,
        });
    }
    async migrateDeploymentTargets() {
        const instances = (await exists(this.instancesDir))
            ? (await promises_1.default.readdir(this.instancesDir, { withFileTypes: true }))
                .filter((entry) => entry.isDirectory())
                .map((entry) => ({ name: entry.name }))
            : [];
        const manifest = (await exists(this.manifestPath))
            ? await this.readJsonFile(this.manifestPath)
            : await this.loadManifest().catch(() => ({ dashboards: [] }));
        let changed = false;
        for (const instance of instances) {
            const legacyDefaultsPath = node_path_1.default.join(this.instancesDir, instance.name, "defaults.json");
            if (await exists(legacyDefaultsPath)) {
                const legacyDefaults = await this.readJsonFile(legacyDefaultsPath);
                const config = await this.loadWorkspaceConfig();
                config.instances[instance.name] ??= {
                    grafanaNamespace: "default",
                    targets: {},
                };
                config.instances[instance.name].targets[exports.DEFAULT_DEPLOYMENT_TARGET] ??= {};
                if (!config.instances[instance.name].targets[exports.DEFAULT_DEPLOYMENT_TARGET].defaults) {
                    config.instances[instance.name].targets[exports.DEFAULT_DEPLOYMENT_TARGET].defaults = legacyDefaults.variables;
                    await this.saveWorkspaceConfig(config);
                }
                changed = true;
            }
            for (const entry of manifest.dashboards) {
                const legacyOverridePath = node_path_1.default.join(this.instancesDir, instance.name, entry.path);
                if (await exists(legacyOverridePath)) {
                    const current = await this.readTargetOverrideFile(instance.name, exports.DEFAULT_DEPLOYMENT_TARGET, entry);
                    if (!current) {
                        const legacyOverride = await this.readJsonFile(legacyOverridePath);
                        await this.saveTargetOverrideFile(instance.name, exports.DEFAULT_DEPLOYMENT_TARGET, entry, legacyOverride);
                    }
                    changed = true;
                }
            }
            const legacyTargetsDir = node_path_1.default.join(this.instancesDir, instance.name, "targets");
            if (await exists(legacyTargetsDir)) {
                const targetEntries = await promises_1.default.readdir(legacyTargetsDir, { withFileTypes: true });
                for (const targetEntry of targetEntries) {
                    if (!targetEntry.isDirectory()) {
                        continue;
                    }
                    const targetName = targetEntry.name;
                    const config = await this.loadWorkspaceConfig();
                    config.instances[instance.name] ??= {
                        grafanaNamespace: "default",
                        targets: {},
                    };
                    config.instances[instance.name].targets[targetName] ??= {};
                    const legacyTargetDefaultsPath = node_path_1.default.join(legacyTargetsDir, targetName, "defaults.json");
                    if ((await exists(legacyTargetDefaultsPath)) &&
                        !config.instances[instance.name].targets[targetName].defaults) {
                        const legacyDefaults = await this.readJsonFile(legacyTargetDefaultsPath);
                        config.instances[instance.name].targets[targetName].defaults = legacyDefaults.variables;
                    }
                    await this.saveWorkspaceConfig(config);
                    for (const entry of manifest.dashboards) {
                        const legacyTargetOverridePath = node_path_1.default.join(legacyTargetsDir, targetName, entry.path);
                        if (!(await exists(legacyTargetOverridePath))) {
                            continue;
                        }
                        const current = await this.readTargetOverrideFile(instance.name, targetName, entry);
                        if (!current) {
                            const legacyOverride = await this.readJsonFile(legacyTargetOverridePath);
                            await this.saveTargetOverrideFile(instance.name, targetName, entry, legacyOverride);
                        }
                    }
                    changed = true;
                }
            }
        }
        return changed;
    }
    async createManifestFromExample() {
        await this.ensureProjectLayout();
        if (await exists(this.manifestExamplePath)) {
            const manifest = await this.readJsonFile(this.manifestExamplePath);
            const errors = (0, manifest_1.validateManifest)(manifest);
            if (errors.length > 0) {
                throw new Error(errors.join("\n"));
            }
            await this.saveManifest(manifest);
            return;
        }
        await this.saveManifest({ dashboards: [] });
    }
    async addManifestEntry(entry) {
        const manifest = await this.loadManifest();
        await this.saveManifest({
            dashboards: [...manifest.dashboards, entry],
        });
    }
    async addManifestEntries(entries) {
        if (entries.length === 0) {
            return;
        }
        const manifest = await this.loadManifest();
        await this.saveManifest({
            dashboards: [...manifest.dashboards, ...entries],
        });
    }
    async removeDashboardFromProject(selectorName, options) {
        const manifest = await this.loadManifest();
        const entry = (0, manifest_1.findManifestEntryBySelector)(manifest, selectorName);
        if (!entry) {
            throw new Error(`Dashboard selector not found: ${selectorName}`);
        }
        const remainingDashboards = manifest.dashboards.filter((candidate) => (0, manifest_1.selectorNameForEntry)(candidate) !== selectorName);
        await this.saveManifest({ dashboards: remainingDashboards });
        if (!options?.deleteFiles) {
            return {
                entry,
                removedPaths: [],
            };
        }
        const removedPaths = [];
        const dashboardPath = this.dashboardPath(entry);
        if (await removeFileIfExists(dashboardPath)) {
            removedPaths.push(dashboardPath);
        }
        const folderMetaPath = this.folderMetaPathForEntry(entry);
        const entryFolder = node_path_1.default.dirname(entry.path).replace(/\\/g, "/");
        const folderStillUsed = remainingDashboards.some((candidate) => node_path_1.default.dirname(candidate.path).replace(/\\/g, "/") === entryFolder);
        if (folderMetaPath && !folderStillUsed && (await removeFileIfExists(folderMetaPath))) {
            removedPaths.push(folderMetaPath);
        }
        const overridesFile = await this.readDashboardOverridesFile(entry);
        if (overridesFile) {
            const dashboardKey = this.dashboardOverrideDashboardKey(entry);
            if (overridesFile.dashboards[dashboardKey]) {
                delete overridesFile.dashboards[dashboardKey];
                const overridesPath = this.dashboardOverridesFilePath(entry);
                await this.saveDashboardOverridesFile(entry, overridesFile);
                removedPaths.push(overridesPath);
            }
        }
        removedPaths.push(...(await this.deleteDashboardVersionHistory(entry)));
        return {
            entry,
            removedPaths,
        };
    }
    backupTargetsRootPath() {
        return node_path_1.default.join(this.backupsDir, "targets");
    }
    backupRootPath(instanceName, targetName, backupName) {
        return node_path_1.default.join(this.backupTargetsRootPath(), instanceName, targetName, backupName);
    }
    backupManifestPath(instanceName, targetName, backupName) {
        return node_path_1.default.join(this.backupRootPath(instanceName, targetName, backupName), "backup_manifest.json");
    }
    backupSnapshotPath(instanceName, targetName, backupName, dashboardPath) {
        return node_path_1.default.join(this.backupRootPath(instanceName, targetName, backupName), "dashboards", dashboardPath);
    }
    async createTargetBackupSnapshot(instanceName, targetName, scope, dashboards, backupName = ProjectRepository.timestamp()) {
        await this.ensureProjectLayout();
        const backupRoot = this.backupRootPath(instanceName, targetName, backupName);
        await ensureDir(backupRoot);
        const manifestDashboards = [];
        for (const dashboard of dashboards) {
            const snapshotPath = this.backupSnapshotPath(instanceName, targetName, backupName, dashboard.path);
            await this.writeJsonFile(snapshotPath, dashboard.dashboard);
            manifestDashboards.push({
                selectorName: dashboard.selectorName,
                baseUid: dashboard.baseUid,
                effectiveDashboardUid: dashboard.effectiveDashboardUid,
                path: dashboard.path,
                ...(dashboard.folderPath ? { folderPath: dashboard.folderPath } : {}),
                title: dashboard.title,
                snapshotPath: node_path_1.default.relative(backupRoot, snapshotPath).replace(/\\/g, "/"),
            });
        }
        const backupManifest = {
            version: 1,
            kind: "target-backup",
            backupName,
            generatedAt: new Date().toISOString(),
            scope,
            instanceName,
            targetName,
            dashboardCount: manifestDashboards.length,
            dashboards: manifestDashboards,
            retentionLimit: this.maxBackups,
        };
        await this.writeJsonFile(this.backupManifestPath(instanceName, targetName, backupName), backupManifest);
        await this.pruneManagedBackups();
        return this.readBackupRecord(instanceName, targetName, backupName);
    }
    async listBackups() {
        const targetsRoot = this.backupTargetsRootPath();
        if (!(await exists(targetsRoot))) {
            return [];
        }
        const instanceEntries = await promises_1.default.readdir(targetsRoot, { withFileTypes: true });
        const backups = [];
        for (const instanceEntry of instanceEntries) {
            if (!instanceEntry.isDirectory()) {
                continue;
            }
            const instancePath = node_path_1.default.join(targetsRoot, instanceEntry.name);
            const targetEntries = await promises_1.default.readdir(instancePath, { withFileTypes: true });
            for (const targetEntry of targetEntries) {
                if (!targetEntry.isDirectory()) {
                    continue;
                }
                const targetPath = node_path_1.default.join(instancePath, targetEntry.name);
                const backupEntries = await promises_1.default.readdir(targetPath, { withFileTypes: true });
                for (const backupEntry of backupEntries) {
                    if (!backupEntry.isDirectory()) {
                        continue;
                    }
                    const manifestPath = this.backupManifestPath(instanceEntry.name, targetEntry.name, backupEntry.name);
                    if (!(await exists(manifestPath))) {
                        continue;
                    }
                    try {
                        const manifest = validateTargetBackupManifest(await this.readJsonFile(manifestPath), manifestPath);
                        backups.push({
                            name: manifest.backupName,
                            rootPath: this.backupRootPath(manifest.instanceName, manifest.targetName, manifest.backupName),
                            manifestPath,
                            generatedAt: manifest.generatedAt,
                            scope: manifest.scope,
                            instanceName: manifest.instanceName,
                            targetName: manifest.targetName,
                            dashboardCount: manifest.dashboardCount,
                            dashboards: manifest.dashboards,
                        });
                    }
                    catch {
                        continue;
                    }
                }
            }
        }
        return backups.sort((left, right) => {
            const dateOrder = right.name.localeCompare(left.name);
            if (dateOrder !== 0) {
                return dateOrder;
            }
            const instanceOrder = left.instanceName.localeCompare(right.instanceName);
            return instanceOrder !== 0 ? instanceOrder : left.targetName.localeCompare(right.targetName);
        });
    }
    async readBackupRecord(instanceName, targetName, backupName) {
        const backups = await this.listBackups();
        const record = backups.find((backup) => backup.name === backupName && backup.instanceName === instanceName && backup.targetName === targetName);
        if (!record) {
            throw new Error(`Backup not found: ${instanceName}/${targetName}/${backupName}`);
        }
        return record;
    }
    async readBackupDashboardSnapshot(backup, dashboard) {
        return this.readJsonFile(node_path_1.default.join(backup.rootPath, dashboard.snapshotPath));
    }
    async deleteBackup(instanceName, targetName, backupName) {
        const backupRoot = this.backupRootPath(instanceName, targetName, backupName);
        if (await exists(backupRoot)) {
            await promises_1.default.rm(backupRoot, { recursive: true, force: true });
        }
    }
    async pruneManagedBackups() {
        const backups = await this.listBackups();
        const staleBackups = backups.slice(this.maxBackups);
        for (const backup of staleBackups) {
            await promises_1.default.rm(backup.rootPath, { recursive: true, force: true });
        }
    }
    async updateManifestEntry(currentSelector, nextEntry) {
        const manifest = await this.loadManifest();
        const currentEntry = (0, manifest_1.findManifestEntryBySelector)(manifest, currentSelector);
        if (!currentEntry) {
            throw new Error(`Dashboard selector not found: ${currentSelector}`);
        }
        const currentIndex = manifest.dashboards.findIndex((entry) => (0, manifest_1.selectorNameForEntry)(entry) === currentSelector);
        const currentDashboardPath = this.dashboardPath(currentEntry);
        const nextDashboardPath = this.dashboardPath(nextEntry);
        if (currentEntry.path !== nextEntry.path &&
            (await exists(currentDashboardPath)) &&
            !(await exists(nextDashboardPath))) {
            await ensureDir(node_path_1.default.dirname(nextDashboardPath));
            await promises_1.default.rename(currentDashboardPath, nextDashboardPath);
        }
        const currentFolderMetaPath = this.folderMetaPathForEntry(currentEntry);
        const nextFolderMetaPath = this.folderMetaPathForEntry(nextEntry);
        if (currentFolderMetaPath &&
            nextFolderMetaPath &&
            currentFolderMetaPath !== nextFolderMetaPath &&
            (await exists(currentFolderMetaPath)) &&
            !(await exists(nextFolderMetaPath))) {
            await ensureDir(node_path_1.default.dirname(nextFolderMetaPath));
            await promises_1.default.copyFile(currentFolderMetaPath, nextFolderMetaPath);
        }
        if (currentEntry.path !== nextEntry.path || currentEntry.uid !== nextEntry.uid) {
            const currentOverrides = await this.readDashboardOverridesFile(currentEntry);
            if (currentOverrides?.dashboards[this.dashboardOverrideDashboardKey(currentEntry)]) {
                const currentOverridesPath = this.dashboardOverridesFilePath(currentEntry);
                const nextOverridesPath = this.dashboardOverridesFilePath(nextEntry);
                if (currentOverridesPath === nextOverridesPath) {
                    currentOverrides.dashboards[this.dashboardOverrideDashboardKey(nextEntry)] =
                        currentOverrides.dashboards[this.dashboardOverrideDashboardKey(currentEntry)];
                    delete currentOverrides.dashboards[this.dashboardOverrideDashboardKey(currentEntry)];
                    await this.saveDashboardOverridesFile(nextEntry, currentOverrides);
                }
                else {
                    const nextOverrides = (await this.readDashboardOverridesFile(nextEntry)) ?? { dashboards: {} };
                    nextOverrides.dashboards[this.dashboardOverrideDashboardKey(nextEntry)] =
                        currentOverrides.dashboards[this.dashboardOverrideDashboardKey(currentEntry)];
                    delete currentOverrides.dashboards[this.dashboardOverrideDashboardKey(currentEntry)];
                    await this.saveDashboardOverridesFile(nextEntry, nextOverrides);
                    await this.saveDashboardOverridesFile(currentEntry, currentOverrides);
                }
            }
        }
        const currentVersionIndex = await this.readDashboardVersionIndex(currentEntry);
        if (currentVersionIndex) {
            const migratedIndex = {
                ...currentVersionIndex,
                revisions: currentVersionIndex.revisions.map((revision) => ({
                    ...revision,
                    snapshotPath: this.dashboardRevisionSnapshotPath(nextEntry, revision.id),
                })),
            };
            for (const revision of currentVersionIndex.revisions) {
                const snapshot = await this.readDashboardRevisionSnapshot(currentEntry, revision.id);
                if (!snapshot) {
                    continue;
                }
                const nextSnapshot = currentEntry.uid === nextEntry.uid
                    ? snapshot
                    : {
                        ...snapshot,
                        dashboard: {
                            ...snapshot.dashboard,
                            uid: nextEntry.uid,
                        },
                    };
                await this.saveDashboardRevisionSnapshot(nextEntry, revision.id, nextSnapshot);
            }
            await this.saveDashboardVersionIndex(nextEntry, migratedIndex);
            if (this.dashboardVersionIndexPath(currentEntry) !== this.dashboardVersionIndexPath(nextEntry)) {
                await this.deleteDashboardVersionHistory(currentEntry);
            }
        }
        const dashboards = [...manifest.dashboards];
        dashboards[currentIndex] = nextEntry;
        await this.saveManifest({ dashboards });
    }
    async listDashboardRecords() {
        const manifest = await this.loadManifest();
        const records = [];
        for (const entry of manifest.dashboards) {
            const absolutePath = this.dashboardPath(entry);
            const record = {
                entry,
                selectorName: (0, manifest_1.selectorNameForEntry)(entry),
                absolutePath,
                exists: await exists(absolutePath),
                folderMetaPath: this.folderMetaPathForEntry(entry),
            };
            if (record.exists) {
                try {
                    const json = await this.readJsonFile(absolutePath);
                    if (typeof json.title === "string" && json.title.trim()) {
                        record.title = json.title;
                    }
                }
                catch {
                    record.title = undefined;
                }
            }
            records.push(record);
        }
        return records;
    }
    async dashboardRecordBySelector(selectorName) {
        const records = await this.listDashboardRecords();
        return records.find((record) => record.selectorName === selectorName);
    }
    async listInstances() {
        const config = await this.loadWorkspaceConfig();
        const instances = [];
        for (const instanceName of Object.keys(config.instances)) {
            const dirPath = node_path_1.default.join(this.instancesDir, instanceName);
            instances.push({
                name: instanceName,
                dirPath,
                envPath: this.workspaceConfigPath,
                envExists: Boolean(config.instances[instanceName]?.grafanaUrl),
                envExamplePath: this.instanceEnvExamplePath(instanceName),
                defaultsPath: this.defaultsPath(instanceName),
                defaultsExists: Boolean(config.instances[instanceName]?.targets[exports.DEFAULT_DEPLOYMENT_TARGET]?.defaults),
            });
        }
        return instances.sort((left, right) => left.name.localeCompare(right.name));
    }
    async instanceByName(instanceName) {
        const instances = await this.listInstances();
        return instances.find((instance) => instance.name === instanceName);
    }
    async createInstance(instanceName) {
        const sanitized = instanceName.trim();
        if (!sanitized) {
            throw new Error("Instance name must not be empty.");
        }
        await this.ensureProjectLayout();
        const dirPath = node_path_1.default.join(this.instancesDir, sanitized);
        const config = await this.loadWorkspaceConfig();
        config.instances[sanitized] ??= {
            grafanaUrl: "http://localhost:3000",
            grafanaNamespace: "default",
            targets: {
                [exports.DEFAULT_DEPLOYMENT_TARGET]: {},
            },
        };
        await this.saveWorkspaceConfig(config);
        return {
            name: sanitized,
            dirPath,
            envPath: this.workspaceConfigPath,
            envExists: Boolean(config.instances[sanitized]?.grafanaUrl),
            envExamplePath: this.instanceEnvExamplePath(sanitized),
            defaultsPath: this.defaultsPath(sanitized),
            defaultsExists: Boolean(config.instances[sanitized]?.targets[exports.DEFAULT_DEPLOYMENT_TARGET]?.defaults),
        };
    }
    async removeInstance(instanceName) {
        const instance = await this.instanceByName(instanceName);
        if (!instance) {
            throw new Error(`Instance not found: ${instanceName}`);
        }
        const config = await this.loadWorkspaceConfig();
        delete config.instances[instanceName];
        await this.saveWorkspaceConfig(config);
    }
    async listDeploymentTargets(instanceName) {
        const config = await this.loadWorkspaceConfig();
        const instance = config.instances[instanceName];
        if (!instance) {
            return [];
        }
        const targets = [];
        for (const targetName of Object.keys(instance.targets)) {
            targets.push({
                instanceName,
                name: targetName,
                dirPath: `${this.workspaceConfigPath}#instances.${instanceName}.targets.${targetName}`,
                defaultsPath: this.targetDefaultsPath(instanceName, targetName),
                defaultsExists: Boolean(instance.targets[targetName]?.defaults),
            });
        }
        return targets.sort((left, right) => left.name.localeCompare(right.name));
    }
    async deploymentTargetByName(instanceName, targetName) {
        const targets = await this.listDeploymentTargets(instanceName);
        return targets.find((target) => target.name === targetName);
    }
    async listAllDeploymentTargets() {
        const instances = await this.listInstances();
        const targets = await Promise.all(instances.map((instance) => this.listDeploymentTargets(instance.name)));
        return targets.flat().sort((left, right) => {
            const instanceOrder = left.instanceName.localeCompare(right.instanceName);
            return instanceOrder !== 0 ? instanceOrder : left.name.localeCompare(right.name);
        });
    }
    async createDeploymentTarget(instanceName, targetName) {
        const sanitized = targetName.trim();
        if (!sanitized) {
            throw new Error("Deployment target name must not be empty.");
        }
        const instance = await this.instanceByName(instanceName);
        if (!instance) {
            throw new Error(`Instance not found: ${instanceName}`);
        }
        const config = await this.loadWorkspaceConfig();
        const currentInstance = config.instances[instanceName];
        if (!currentInstance) {
            throw new Error(`Instance not found: ${instanceName}`);
        }
        currentInstance.targets[sanitized] ??= {};
        await this.saveWorkspaceConfig(config);
        return {
            instanceName,
            name: sanitized,
            dirPath: `${this.workspaceConfigPath}#instances.${instanceName}.targets.${sanitized}`,
            defaultsPath: this.targetDefaultsPath(instanceName, sanitized),
            defaultsExists: Boolean(currentInstance.targets[sanitized]?.defaults),
        };
    }
    async removeDeploymentTarget(instanceName, targetName) {
        const target = await this.deploymentTargetByName(instanceName, targetName);
        if (!target) {
            throw new Error(`Deployment target not found: ${instanceName}/${targetName}`);
        }
        if (target.name === exports.DEFAULT_DEPLOYMENT_TARGET) {
            throw new Error("Default deployment target cannot be removed.");
        }
        const config = await this.loadWorkspaceConfig();
        delete config.instances[instanceName]?.targets[targetName];
        await this.saveWorkspaceConfig(config);
    }
    async loadRootEnvValues() {
        return {};
    }
    async loadInstanceEnvValues(instanceName) {
        const config = await this.loadWorkspaceConfig();
        const instance = config.instances[instanceName];
        if (!instance) {
            return {};
        }
        return {
            ...(instance.grafanaUrl ? { GRAFANA_URL: instance.grafanaUrl } : {}),
            ...(instance.grafanaNamespace ? { GRAFANA_NAMESPACE: instance.grafanaNamespace } : {}),
        };
    }
    async loadConnectionConfig(instanceName) {
        if (!instanceName) {
            throw new Error("Choose a concrete instance. Global root connection is no longer supported.");
        }
        const instanceValues = await this.loadInstanceEnvValues(instanceName);
        const baseUrl = instanceValues.GRAFANA_URL?.trim();
        const token = (await this.resolveToken(instanceName))?.trim();
        if (!baseUrl) {
            throw new Error("GRAFANA_URL is not configured in workspace config for this instance.");
        }
        if (!token) {
            throw new Error("Grafana token is not configured. Use Set Instance Token.");
        }
        return {
            baseUrl: baseUrl.replace(/\/+$/, ""),
            token,
            namespace: instanceValues.GRAFANA_NAMESPACE?.trim() || "default",
            sourceLabel: `${projectLocator_1.PROJECT_CONFIG_FILE} -> instances.${instanceName}`,
        };
    }
    async saveInstanceEnvValues(instanceName, values) {
        const config = await this.loadWorkspaceConfig();
        const instance = config.instances[instanceName];
        if (!instance) {
            throw new Error(`Instance not found: ${instanceName}`);
        }
        config.instances[instanceName] = {
            ...instance,
            ...(values.GRAFANA_URL?.trim() ? { grafanaUrl: values.GRAFANA_URL.trim() } : { grafanaUrl: undefined }),
            ...(values.GRAFANA_NAMESPACE?.trim()
                ? { grafanaNamespace: values.GRAFANA_NAMESPACE.trim() }
                : { grafanaNamespace: "default" }),
        };
        await this.saveWorkspaceConfig(config);
    }
    async createInstanceEnvFromTemplate(instanceName) {
        const config = await this.loadWorkspaceConfig();
        config.instances[instanceName] ??= {
            grafanaUrl: "http://localhost:3000",
            grafanaNamespace: "default",
            targets: {
                [exports.DEFAULT_DEPLOYMENT_TARGET]: {},
            },
        };
        await this.saveWorkspaceConfig(config);
        return this.workspaceConfigPath;
    }
    async readDashboardJson(entry) {
        const filePath = this.dashboardPath(entry);
        if (!(await exists(filePath))) {
            throw new Error(`Dashboard file not found: ${filePath}`);
        }
        return this.readJsonFile(filePath);
    }
    async saveDashboardJson(entry, dashboard) {
        await this.writeJsonFile(this.dashboardPath(entry), dashboard);
    }
    async readRenderManifest(instanceName, targetName) {
        const filePath = this.renderManifestPath(instanceName, targetName);
        if (!(await exists(filePath))) {
            return undefined;
        }
        return validateRenderManifest(await this.readJsonFile(filePath), filePath);
    }
    async saveRenderManifest(instanceName, targetName, manifest) {
        const filePath = this.renderManifestPath(instanceName, targetName);
        await this.writeJsonFile(filePath, validateRenderManifest(manifest, filePath));
        return filePath;
    }
    async clearRenderRoot(instanceName, targetName) {
        const rootPath = this.renderRootPath(instanceName, targetName);
        if (await exists(rootPath)) {
            await promises_1.default.rm(rootPath, { recursive: true, force: true });
        }
    }
    async readFolderMetadata(entry) {
        const filePath = this.folderMetaPathForEntry(entry);
        if (!filePath || !(await exists(filePath))) {
            return undefined;
        }
        const raw = await this.readJsonFile(filePath);
        const uid = typeof raw.uid === "string" && raw.uid.trim() ? raw.uid.trim() : undefined;
        const pathValue = typeof raw.path === "string" && raw.path.trim()
            ? raw.path.trim()
            : typeof raw.title === "string" && raw.title.trim()
                ? raw.title.trim()
                : undefined;
        if (!uid && !pathValue) {
            return undefined;
        }
        return {
            ...(uid ? { uid } : {}),
            ...(pathValue ? { path: pathValue } : {}),
        };
    }
    async saveFolderMetadata(entry, folderMetadata) {
        const filePath = this.folderMetaPathForEntry(entry);
        if (!filePath) {
            return;
        }
        await this.writeJsonFile(filePath, {
            ...(folderMetadata.path ? { path: folderMetadata.path } : {}),
            ...(folderMetadata.uid ? { uid: folderMetadata.uid } : {}),
        });
    }
    async deleteFolderMetadata(entry) {
        const filePath = this.folderMetaPathForEntry(entry);
        if (!filePath) {
            return false;
        }
        return removeFileIfExists(filePath);
    }
    async readTargetOverrideFile(instanceName, targetName, entry) {
        const filePath = this.dashboardOverridesFilePath(entry);
        if (!(await exists(filePath))) {
            return undefined;
        }
        const file = validateDashboardFolderOverridesFile(await this.readJsonFile(filePath), filePath);
        return file.dashboards[this.dashboardOverrideDashboardKey(entry)]?.targets[this.dashboardOverrideTargetKey(instanceName, targetName)];
    }
    async readDashboardOverrides(entry) {
        const filePath = this.dashboardOverridesFilePath(entry);
        if (!(await exists(filePath))) {
            return undefined;
        }
        return validateDashboardFolderOverridesFile(await this.readJsonFile(filePath), filePath);
    }
    async readDashboardOverridesFile(entry) {
        return this.readDashboardOverrides(entry);
    }
    async saveDashboardOverridesFile(entry, file) {
        const filePath = this.dashboardOverridesFilePath(entry);
        const validFile = validateDashboardFolderOverridesFile(file, filePath);
        if (Object.keys(validFile.dashboards).length === 0) {
            if (await exists(filePath)) {
                await promises_1.default.rm(filePath, { force: true });
            }
            return filePath;
        }
        await this.writeJsonFile(filePath, validFile);
        return filePath;
    }
    async readOverrideFile(instanceName, entry) {
        return this.readTargetOverrideFile(instanceName, exports.DEFAULT_DEPLOYMENT_TARGET, entry);
    }
    async readDashboardVersionIndex(entry) {
        const filePath = this.dashboardVersionIndexPath(entry);
        if (!(await exists(filePath))) {
            return undefined;
        }
        return validateDashboardVersionIndex(await this.readJsonFile(filePath), filePath);
    }
    async saveDashboardVersionIndex(entry, index) {
        const filePath = this.dashboardVersionIndexPath(entry);
        await this.writeJsonFile(filePath, validateDashboardVersionIndex(index, filePath));
        return filePath;
    }
    async readDashboardRevisionSnapshot(entry, revisionId) {
        const filePath = this.dashboardRevisionSnapshotPath(entry, revisionId);
        if (!(await exists(filePath))) {
            return undefined;
        }
        return validateDashboardRevisionSnapshot(await this.readJsonFile(filePath), filePath);
    }
    async saveDashboardRevisionSnapshot(entry, revisionId, snapshot) {
        const filePath = this.dashboardRevisionSnapshotPath(entry, revisionId);
        await this.writeJsonFile(filePath, validateDashboardRevisionSnapshot(snapshot, filePath));
        return filePath;
    }
    async deleteDashboardVersionHistory(entry) {
        const removedPaths = [];
        const indexPath = this.dashboardVersionIndexPath(entry);
        const versionsDir = this.dashboardVersionsDirPath(entry);
        if (await removeFileIfExists(indexPath)) {
            removedPaths.push(indexPath);
        }
        if (await exists(versionsDir)) {
            await promises_1.default.rm(versionsDir, { recursive: true, force: true });
            removedPaths.push(versionsDir);
        }
        return removedPaths;
    }
    async hasAnyFolderPathOverride(entry) {
        const file = await this.readDashboardOverridesFile(entry);
        const targets = file?.dashboards[this.dashboardOverrideDashboardKey(entry)]?.targets ?? {};
        return Object.values(targets).some((override) => typeof override?.folderPath === "string" && override.folderPath.trim());
    }
    async saveTargetOverrideFile(instanceName, targetName, entry, overrideFile) {
        const current = (await this.readDashboardOverridesFile(entry)) ?? { dashboards: {} };
        const dashboardKey = this.dashboardOverrideDashboardKey(entry);
        const targetKey = this.dashboardOverrideTargetKey(instanceName, targetName);
        current.dashboards[dashboardKey] ??= { targets: {} };
        current.dashboards[dashboardKey].targets[targetKey] = overrideFile;
        await this.saveDashboardOverridesFile(entry, current);
        return this.targetOverridePath(instanceName, targetName, entry);
    }
    async saveOverrideFile(instanceName, entry, overrideFile) {
        return this.saveTargetOverrideFile(instanceName, exports.DEFAULT_DEPLOYMENT_TARGET, entry, overrideFile);
    }
    async readTargetDefaultsFile(instanceName, targetName) {
        const config = await this.loadWorkspaceConfig();
        const defaults = config.instances[instanceName]?.targets[targetName]?.defaults;
        if (!defaults) {
            return undefined;
        }
        return {
            variables: defaults,
        };
    }
    async readDefaultsFile(instanceName) {
        return this.readTargetDefaultsFile(instanceName, exports.DEFAULT_DEPLOYMENT_TARGET);
    }
    async saveTargetDefaultsFile(instanceName, targetName, defaultsFile) {
        const config = await this.loadWorkspaceConfig();
        const instance = config.instances[instanceName];
        if (!instance) {
            throw new Error(`Instance not found: ${instanceName}`);
        }
        instance.targets[targetName] ??= {};
        instance.targets[targetName].defaults = defaultsFile.variables;
        await this.saveWorkspaceConfig(config);
        return this.targetDefaultsPath(instanceName, targetName);
    }
    async readDatasourceCatalog() {
        const config = await this.loadWorkspaceConfig();
        return {
            datasources: validateDatasourceCatalogFile({
                datasources: config.datasources,
            }, this.workspaceConfigPath).datasources,
        };
    }
    async saveDatasourceCatalog(catalogFile) {
        const validCatalog = validateDatasourceCatalogFile(catalogFile, this.workspaceConfigPath);
        const config = await this.loadWorkspaceConfig();
        await this.saveWorkspaceConfig({
            ...config,
            datasources: validCatalog.datasources,
        });
        return this.workspaceConfigPath;
    }
    async loadDashboardDetails(selectorName) {
        const record = await this.dashboardRecordBySelector(selectorName);
        if (!record) {
            return undefined;
        }
        return {
            entry: record.entry,
            selectorName: record.selectorName,
            exists: record.exists,
            title: record.title,
        };
    }
    async loadInstanceDetails(instanceName) {
        const instance = await this.instanceByName(instanceName);
        if (!instance) {
            return undefined;
        }
        const envValues = await this.loadInstanceEnvValues(instanceName);
        const tokenFromSecret = (await this.resolveToken(instanceName))?.trim();
        const tokenSourceLabel = tokenFromSecret
            ? "VS Code Secret Storage"
            : undefined;
        let mergedConnection;
        try {
            mergedConnection = await this.loadConnectionConfig(instanceName);
        }
        catch {
            mergedConnection = undefined;
        }
        return {
            instance,
            envValues,
            mergedConnection,
            hasConnection: Boolean(mergedConnection),
            tokenConfigured: Boolean(tokenSourceLabel),
            tokenSourceLabel,
        };
    }
    async loadDeploymentTargetDetails(instanceName, targetName) {
        const target = await this.deploymentTargetByName(instanceName, targetName);
        if (!target) {
            return undefined;
        }
        return {
            target,
            defaultsValues: (await this.readTargetDefaultsFile(instanceName, targetName))?.variables ?? {},
        };
    }
    static timestamp(now = new Date()) {
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, "0");
        const day = String(now.getDate()).padStart(2, "0");
        const hours = String(now.getHours()).padStart(2, "0");
        const minutes = String(now.getMinutes()).padStart(2, "0");
        const seconds = String(now.getSeconds()).padStart(2, "0");
        return `${year}${month}${day}_${hours}${minutes}${seconds}`;
    }
    async syncPulledFile(options) {
        const { sourceContent, targetPath, backupPath, previousPath } = options;
        if (backupPath) {
            await ensureDir(node_path_1.default.dirname(backupPath));
            await promises_1.default.writeFile(backupPath, sourceContent, "utf8");
        }
        if (await exists(targetPath)) {
            const currentContent = await promises_1.default.readFile(targetPath, "utf8");
            if (currentContent === sourceContent) {
                return {
                    status: "skipped",
                    hadPrevious: false,
                };
            }
            if (previousPath) {
                await ensureDir(node_path_1.default.dirname(previousPath));
                await promises_1.default.writeFile(previousPath, currentContent, "utf8");
            }
            await ensureDir(node_path_1.default.dirname(targetPath));
            await promises_1.default.writeFile(targetPath, sourceContent, "utf8");
            return {
                status: "updated",
                hadPrevious: Boolean(previousPath),
            };
        }
        await ensureDir(node_path_1.default.dirname(targetPath));
        await promises_1.default.writeFile(targetPath, sourceContent, "utf8");
        return {
            status: "updated",
            hadPrevious: false,
        };
    }
}
exports.ProjectRepository = ProjectRepository;
//# sourceMappingURL=repository.js.map