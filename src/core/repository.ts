import fs from "node:fs/promises";
import path from "node:path";

import { parseEnv, stringifyEnv } from "./env";
import { stableJsonStringify } from "./json";
import { findManifestEntryBySelector, selectorNameForEntry, validateManifest } from "./manifest";
import { PROJECT_CONFIG_FILE, ProjectLayout, defaultProjectLayout } from "./projectLocator";
import {
  BackupManifest,
  BackupRecord,
  DashboardDetailsModel,
  DashboardManifest,
  DashboardManifestEntry,
  DashboardRevisionSnapshot,
  DashboardRevisionRecord,
  DashboardVersionIndex,
  DatasourceCatalogFile,
  DashboardFolderOverridesFile,
  DashboardOverrideFile,
  DashboardRecord,
  DeploymentTargetDetailsModel,
  DeploymentTargetRecord,
  EffectiveConnectionConfig,
  FolderMetadata,
  InstanceDetailsModel,
  InstanceRecord,
  RenderManifest,
  RenderManifestDashboardRecord,
  RenderScope,
  TargetBackupDashboardRecord,
  TargetBackupScope,
  WorkspaceInstanceConfig,
  WorkspaceProjectConfig,
} from "./types";

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function removeFileIfExists(filePath: string): Promise<boolean> {
  if (!(await exists(filePath))) {
    return false;
  }
  await fs.unlink(filePath);
  return true;
}

async function copyDirectoryTree(
  sourceDir: string,
  targetDir: string,
  options?: { sanitizeEnvFiles?: boolean },
): Promise<void> {
  if (!(await exists(sourceDir))) {
    return;
  }

  await ensureDir(targetDir);
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await copyDirectoryTree(sourcePath, targetPath, options);
      continue;
    }

    if (options?.sanitizeEnvFiles && entry.name === ".env") {
      const content = await fs.readFile(sourcePath, "utf8");
      const parsed = parseEnv(content);
      const { GRAFANA_TOKEN: _ignored, ...safeValues } = parsed;
      await fs.writeFile(targetPath, stringifyEnv(safeValues), "utf8");
      continue;
    }

    await ensureDir(path.dirname(targetPath));
    await fs.copyFile(sourcePath, targetPath);
  }
}

interface ProjectRepositoryOptions {
  resolveToken?: (instanceName?: string) => Promise<string | undefined>;
}

export const DEFAULT_DEPLOYMENT_TARGET = "default";

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

function toRelativeConfigPath(projectRootPath: string, absolutePath: string): string {
  const relativePath = normalizeRelativePath(path.relative(projectRootPath, absolutePath));
  return relativePath || ".";
}

function targetNameFromOverrideTargetKey(targetKey: string): string {
  const slashIndex = targetKey.indexOf("/");
  return slashIndex >= 0 ? targetKey.slice(slashIndex + 1) : targetKey;
}

function defaultWorkspaceConfig(layout: ProjectLayout): WorkspaceProjectConfig {
  return {
    version: 2,
    layout: {
      dashboardsDir: toRelativeConfigPath(layout.projectRootPath, layout.dashboardsDir),
      backupsDir: toRelativeConfigPath(layout.projectRootPath, layout.backupsDir),
      rendersDir: toRelativeConfigPath(layout.projectRootPath, layout.rendersDir),
      maxBackups: layout.maxBackups,
    },
    dashboards: [],
    datasources: {},
    instances: {},
  };
}

function validateWorkspaceProjectConfig(config: WorkspaceProjectConfig, filePath: string): WorkspaceProjectConfig {
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
    backupsDir: config.layout.backupsDir,
    rendersDir: config.layout.rendersDir,
  })) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`Invalid workspace config ${key}: ${filePath}`);
    }
  }
  if (config.layout.instancesDir !== undefined && (typeof config.layout.instancesDir !== "string" || !config.layout.instancesDir.trim())) {
    throw new Error(`Invalid workspace config instancesDir: ${filePath}`);
  }
  if (
    typeof config.layout.maxBackups !== "number" ||
    !Number.isInteger(config.layout.maxBackups) ||
    config.layout.maxBackups <= 0
  ) {
    throw new Error(`Invalid workspace config maxBackups: ${filePath}`);
  }

  const manifestErrors = validateManifest({ dashboards: config.dashboards });
  if (manifestErrors.length > 0) {
    throw new Error(manifestErrors.join("\n"));
  }
  validateDatasourceCatalogFile({ datasources: config.datasources }, filePath);

  if (!config.instances || typeof config.instances !== "object" || Array.isArray(config.instances)) {
    throw new Error(`Invalid workspace config instances: ${filePath}`);
  }
  const normalizedInstances: WorkspaceProjectConfig["instances"] = {};
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
    normalizedInstances[instanceName] = {
      ...(instanceConfig.grafanaUrl ? { grafanaUrl: instanceConfig.grafanaUrl } : {}),
      ...(instanceConfig.grafanaNamespace ? { grafanaNamespace: instanceConfig.grafanaNamespace } : {}),
      targets: Object.fromEntries(Object.keys(instanceConfig.targets).map((targetName) => [targetName, {}])),
    };
  }

  return {
    ...config,
    instances: normalizedInstances,
  };
}

function validateDatasourceCatalogFile(
  mappingFile: DatasourceCatalogFile,
  filePath: string,
): DatasourceCatalogFile {
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

function validateDashboardFolderOverridesFile(
  overridesFile: DashboardFolderOverridesFile,
  filePath: string,
): DashboardFolderOverridesFile {
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
      if (targetNameFromOverrideTargetKey(targetKey) === DEFAULT_DEPLOYMENT_TARGET && override.dashboardUid !== undefined) {
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

function validateDashboardRevisionSnapshot(
  snapshot: DashboardRevisionSnapshot,
  filePath: string,
): DashboardRevisionSnapshot {
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

function validateDashboardVersionIndex(
  index: DashboardVersionIndex,
  filePath: string,
): DashboardVersionIndex {
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
    for (const key of ["id", "createdAt", "contentHash", "templateHash", "snapshotPath"] as const) {
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

function validateTargetBackupManifest(manifest: BackupManifest, filePath: string): BackupManifest {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`Invalid backup manifest: ${filePath}`);
  }
  if (manifest.version !== 1 || manifest.kind !== "target-backup") {
    throw new Error(`Invalid backup manifest: ${filePath}`);
  }
  if (manifest.scope !== "dashboard" && manifest.scope !== "target") {
    throw new Error(`Invalid backup manifest: ${filePath}`);
  }
  for (const key of ["backupName", "generatedAt", "instanceName", "targetName"] as const) {
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
    for (const key of ["selectorName", "baseUid", "effectiveDashboardUid", "path", "title", "snapshotPath"] as const) {
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

function validateRenderManifest(manifest: RenderManifest, filePath: string): RenderManifest {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`Invalid render manifest: ${filePath}`);
  }
  if (manifest.version !== 1) {
    throw new Error(`Invalid render manifest: ${filePath}`);
  }
  if (manifest.scope !== "dashboard" && manifest.scope !== "target") {
    throw new Error(`Invalid render manifest: ${filePath}`);
  }
  for (const key of ["instanceName", "targetName", "generatedAt"] as const) {
    if (typeof manifest[key] !== "string" || !manifest[key].trim()) {
      throw new Error(`Invalid render manifest: ${filePath}`);
    }
  }
  if (!Array.isArray(manifest.dashboards)) {
    throw new Error(`Invalid render manifest: ${filePath}`);
  }
  for (const dashboard of manifest.dashboards) {
    for (const key of ["selectorName", "baseUid", "effectiveDashboardUid", "path", "title", "renderPath"] as const) {
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

export class ProjectRepository {
  readonly workspaceRootPath: string;
  readonly projectRootPath: string;
  readonly workspaceConfigPath: string;
  readonly configPath?: string;
  readonly manifestPath: string;
  readonly datasourceCatalogPath: string;
  readonly manifestExamplePath: string;
  readonly dashboardsDir: string;
  readonly instancesDir: string;
  readonly backupsDir: string;
  readonly rendersDir: string;
  readonly rootEnvPath: string;
  readonly maxBackups: number;
  private readonly resolveToken: (instanceName?: string) => Promise<string | undefined>;

  constructor(layoutOrRootPath: ProjectLayout | string, options?: ProjectRepositoryOptions) {
    const layout = typeof layoutOrRootPath === "string" ? defaultProjectLayout(layoutOrRootPath) : layoutOrRootPath;
    this.workspaceRootPath = layout.workspaceRootPath;
    this.projectRootPath = layout.projectRootPath;
    this.workspaceConfigPath = layout.workspaceConfigPath;
    this.configPath = layout.configPath;
    this.manifestPath = layout.manifestPath;
    this.datasourceCatalogPath = path.join(layout.projectRootPath, "datasources.json");
    this.manifestExamplePath = layout.manifestExamplePath;
    this.dashboardsDir = layout.dashboardsDir;
    this.instancesDir = layout.instancesDir;
    this.backupsDir = layout.backupsDir;
    this.rendersDir = layout.rendersDir;
    this.rootEnvPath = layout.rootEnvPath;
    this.maxBackups = layout.maxBackups;
    this.resolveToken = options?.resolveToken ?? (async () => undefined);
  }

  async ensureProjectLayout(): Promise<void> {
    await ensureDir(this.dashboardsDir);
    await ensureDir(this.backupsDir);
    await ensureDir(this.rendersDir);
  }

  dashboardPath(entry: DashboardManifestEntry): string {
    return path.join(this.dashboardsDir, entry.path);
  }

  async dashboardExists(entry: DashboardManifestEntry): Promise<boolean> {
    return exists(this.dashboardPath(entry));
  }

  dashboardFolderPath(entry: DashboardManifestEntry): string {
    return path.dirname(this.dashboardPath(entry));
  }

  renderRootPath(instanceName: string, targetName: string): string {
    return path.join(this.rendersDir, instanceName, targetName);
  }

  renderManifestPath(instanceName: string, targetName: string): string {
    return path.join(this.renderRootPath(instanceName, targetName), ".render-manifest.json");
  }

  renderDashboardPath(instanceName: string, targetName: string, entry: DashboardManifestEntry): string {
    return path.join(this.renderRootPath(instanceName, targetName), entry.path);
  }

  folderMetaPathForEntry(entry: DashboardManifestEntry): string | undefined {
    const dashboardPath = this.dashboardPath(entry);
    const relativeDir = path.relative(this.dashboardsDir, path.dirname(dashboardPath)).replace(/\\/g, "/");
    if (!relativeDir) {
      return undefined;
    }
    return path.join(path.dirname(dashboardPath), ".folder.json");
  }

  dashboardOverridesFilePath(entry: DashboardManifestEntry): string {
    return path.join(path.dirname(this.dashboardPath(entry)), ".overrides.json");
  }

  dashboardVersionsDirPath(entry: DashboardManifestEntry): string {
    return path.join(path.dirname(this.dashboardPath(entry)), ".versions");
  }

  dashboardVersionIndexPath(entry: DashboardManifestEntry): string {
    return path.join(path.dirname(this.dashboardPath(entry)), ".versions.json");
  }

  dashboardRevisionSnapshotPath(entry: DashboardManifestEntry, revisionId: string): string {
    return path.join(this.dashboardVersionsDirPath(entry), `${revisionId}.json`);
  }

  dashboardOverrideTargetKey(instanceName: string, targetName: string): string {
    return `${instanceName}/${targetName}`;
  }

  dashboardOverrideDashboardKey(entry: DashboardManifestEntry): string {
    return entry.uid;
  }

  targetOverridePath(instanceName: string, targetName: string, entry: DashboardManifestEntry): string {
    return `${this.dashboardOverridesFilePath(entry)}#${this.dashboardOverrideTargetKey(instanceName, targetName)}`;
  }

  overridePath(instanceName: string, entry: DashboardManifestEntry): string {
    return this.targetOverridePath(instanceName, DEFAULT_DEPLOYMENT_TARGET, entry);
  }

  instanceEnvPath(instanceName: string): string {
    return path.join(this.instancesDir, instanceName, ".env");
  }

  instanceEnvExamplePath(instanceName: string): string {
    return path.join(this.instancesDir, instanceName, ".env.example");
  }

  async readJsonFile<T>(filePath: string): Promise<T> {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  }

  async writeJsonFile(filePath: string, value: unknown): Promise<void> {
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, stableJsonStringify(value), "utf8");
  }

  async readTextFileIfExists(filePath: string): Promise<string | undefined> {
    if (!(await exists(filePath))) {
      return undefined;
    }
    return fs.readFile(filePath, "utf8");
  }

  async writeTextFile(filePath: string, content: string): Promise<void> {
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, content, "utf8");
  }

  async workspaceConfigExists(): Promise<boolean> {
    return exists(this.workspaceConfigPath);
  }

  async loadWorkspaceConfig(): Promise<WorkspaceProjectConfig> {
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

    const config = await this.readJsonFile<WorkspaceProjectConfig>(this.workspaceConfigPath);
    return validateWorkspaceProjectConfig(config, this.workspaceConfigPath);
  }

  async saveWorkspaceConfig(config: WorkspaceProjectConfig): Promise<void> {
    const validConfig = validateWorkspaceProjectConfig(config, this.workspaceConfigPath);
    await this.ensureProjectLayout();
    const { instancesDir: _legacyInstancesDir, ...layout } = validConfig.layout;
    await this.writeJsonFile(this.workspaceConfigPath, {
      ...validConfig,
      layout,
    });
  }

  async migrateWorkspaceConfig(): Promise<boolean> {
    const configExists = await this.workspaceConfigExists();
    const rawConfig = configExists ? await this.readJsonFile<Record<string, unknown>>(this.workspaceConfigPath) : {};
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
      const nextRawConfig = structuredClone(rawConfig) as Record<string, unknown>;
      const layout = ((nextRawConfig.layout as Record<string, unknown> | undefined) ??= {});
      layout.rendersDir ??= toRelativeConfigPath(this.projectRootPath, this.rendersDir);
      const current = validateWorkspaceProjectConfig(nextRawConfig as unknown as WorkspaceProjectConfig, this.workspaceConfigPath);
      migratedConfig.layout = current.layout;
      migratedConfig.dashboards = current.dashboards;
      migratedConfig.datasources = current.datasources;
      migratedConfig.instances = current.instances;
    }

    if (migratedConfig.dashboards.length === 0 && (await exists(this.manifestPath))) {
      const legacyManifest = await this.readJsonFile<DashboardManifest>(this.manifestPath);
      const errors = validateManifest(legacyManifest);
      if (errors.length > 0) {
        throw new Error(errors.join("\n"));
      }
      migratedConfig.dashboards = legacyManifest.dashboards;
    }

    if (Object.keys(migratedConfig.datasources).length === 0 && (await exists(this.datasourceCatalogPath))) {
      migratedConfig.datasources = validateDatasourceCatalogFile(
        await this.readJsonFile<DatasourceCatalogFile>(this.datasourceCatalogPath),
        this.datasourceCatalogPath,
      ).datasources;
    }

    const instanceNames = new Set<string>(Object.keys(migratedConfig.instances));
    if (await exists(this.instancesDir)) {
      const directoryEntries = await fs.readdir(this.instancesDir, { withFileTypes: true });
      for (const entry of directoryEntries) {
        if (entry.isDirectory()) {
          instanceNames.add(entry.name);
        }
      }
    }

    for (const instanceName of instanceNames) {
      const currentConfig: WorkspaceInstanceConfig = {
        ...(migratedConfig.instances[instanceName] ?? { targets: {} }),
        targets: { ...(migratedConfig.instances[instanceName]?.targets ?? {}) },
      };
      const legacyEnvPath = this.instanceEnvPath(instanceName);
      if ((!currentConfig.grafanaUrl || !currentConfig.grafanaNamespace) && (await exists(legacyEnvPath))) {
        const parsed = parseEnv(await fs.readFile(legacyEnvPath, "utf8"));
        if (!currentConfig.grafanaUrl && parsed.GRAFANA_URL?.trim()) {
          currentConfig.grafanaUrl = parsed.GRAFANA_URL.trim();
        }
        if (!currentConfig.grafanaNamespace && parsed.GRAFANA_NAMESPACE?.trim()) {
          currentConfig.grafanaNamespace = parsed.GRAFANA_NAMESPACE.trim();
        }
      }

      if (Object.keys(currentConfig.targets).length === 0) {
        currentConfig.targets[DEFAULT_DEPLOYMENT_TARGET] = {};
      }

      migratedConfig.instances[instanceName] = currentConfig;
    }

    const nextConfig = validateWorkspaceProjectConfig(migratedConfig, this.workspaceConfigPath);
    const changed =
      !configExists ||
      (configExists &&
        stableJsonStringify(nextConfig) !==
          stableJsonStringify(rawConfig.version === 2 ? (rawConfig as unknown as WorkspaceProjectConfig) : ({} as WorkspaceProjectConfig)));
    if (changed) {
      await this.saveWorkspaceConfig(nextConfig);
    }
    await this.migrateDeploymentTargets();
    return changed;
  }

  async manifestExists(): Promise<boolean> {
    const config = await this.loadWorkspaceConfig();
    return config.dashboards.length > 0;
  }

  async loadManifest(): Promise<DashboardManifest> {
    const config = await this.loadWorkspaceConfig();
    return { dashboards: config.dashboards };
  }

  async saveManifest(manifest: DashboardManifest): Promise<void> {
    const errors = validateManifest(manifest);
    if (errors.length > 0) {
      throw new Error(errors.join("\n"));
    }
    const config = await this.loadWorkspaceConfig();
    await this.saveWorkspaceConfig({
      ...config,
      dashboards: manifest.dashboards,
    });
  }

  async migrateDeploymentTargets(): Promise<boolean> {
    const instances =
      (await exists(this.instancesDir))
        ? (await fs.readdir(this.instancesDir, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => ({ name: entry.name }))
        : [];
    const manifest =
      (await exists(this.manifestPath))
        ? await this.readJsonFile<DashboardManifest>(this.manifestPath)
        : await this.loadManifest().catch(() => ({ dashboards: [] as DashboardManifestEntry[] }));
    let changed = false;

    for (const instance of instances) {
      for (const entry of manifest.dashboards) {
        const legacyOverridePath = path.join(this.instancesDir, instance.name, entry.path);
        if (await exists(legacyOverridePath)) {
          const current = await this.readTargetOverrideFile(instance.name, DEFAULT_DEPLOYMENT_TARGET, entry);
          if (!current) {
            const legacyOverride = await this.readJsonFile<DashboardOverrideFile>(legacyOverridePath);
            await this.saveTargetOverrideFile(instance.name, DEFAULT_DEPLOYMENT_TARGET, entry, legacyOverride);
          }
          changed = true;
        }
      }

      const legacyTargetsDir = path.join(this.instancesDir, instance.name, "targets");
      if (await exists(legacyTargetsDir)) {
        const targetEntries = await fs.readdir(legacyTargetsDir, { withFileTypes: true });
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
          config.instances[instance.name]!.targets[targetName] ??= {};
          await this.saveWorkspaceConfig(config);

          for (const entry of manifest.dashboards) {
            const legacyTargetOverridePath = path.join(legacyTargetsDir, targetName, entry.path);
            if (!(await exists(legacyTargetOverridePath))) {
              continue;
            }
            const current = await this.readTargetOverrideFile(instance.name, targetName, entry);
            if (!current) {
              const legacyOverride = await this.readJsonFile<DashboardOverrideFile>(legacyTargetOverridePath);
              await this.saveTargetOverrideFile(instance.name, targetName, entry, legacyOverride);
            }
          }
          changed = true;
        }
      }
    }

    return changed;
  }

  async createManifestFromExample(): Promise<void> {
    await this.ensureProjectLayout();
    if (await exists(this.manifestExamplePath)) {
      const manifest = await this.readJsonFile<DashboardManifest>(this.manifestExamplePath);
      const errors = validateManifest(manifest);
      if (errors.length > 0) {
        throw new Error(errors.join("\n"));
      }
      await this.saveManifest(manifest);
      return;
    }

    await this.saveManifest({ dashboards: [] });
  }

  async addManifestEntry(entry: DashboardManifestEntry): Promise<void> {
    const manifest = await this.loadManifest();
    await this.saveManifest({
      dashboards: [...manifest.dashboards, entry],
    });
  }

  async addManifestEntries(entries: DashboardManifestEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    const manifest = await this.loadManifest();
    await this.saveManifest({
      dashboards: [...manifest.dashboards, ...entries],
    });
  }

  async removeDashboardFromProject(
    selectorName: string,
    options?: { deleteFiles?: boolean },
  ): Promise<{ entry: DashboardManifestEntry; removedPaths: string[] }> {
    const manifest = await this.loadManifest();
    const entry = findManifestEntryBySelector(manifest, selectorName);
    if (!entry) {
      throw new Error(`Dashboard selector not found: ${selectorName}`);
    }

    const remainingDashboards = manifest.dashboards.filter(
      (candidate) => selectorNameForEntry(candidate) !== selectorName,
    );
    await this.saveManifest({ dashboards: remainingDashboards });

    if (!options?.deleteFiles) {
      return {
        entry,
        removedPaths: [],
      };
    }

    const removedPaths: string[] = [];
    const dashboardPath = this.dashboardPath(entry);
    if (await removeFileIfExists(dashboardPath)) {
      removedPaths.push(dashboardPath);
    }

    const folderMetaPath = this.folderMetaPathForEntry(entry);
    const entryFolder = path.dirname(entry.path).replace(/\\/g, "/");
    const folderStillUsed = remainingDashboards.some(
      (candidate) => path.dirname(candidate.path).replace(/\\/g, "/") === entryFolder,
    );
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

  backupTargetsRootPath(): string {
    return path.join(this.backupsDir, "targets");
  }

  backupRootPath(instanceName: string, targetName: string, backupName: string): string {
    return path.join(this.backupTargetsRootPath(), instanceName, targetName, backupName);
  }

  backupManifestPath(instanceName: string, targetName: string, backupName: string): string {
    return path.join(this.backupRootPath(instanceName, targetName, backupName), "backup_manifest.json");
  }

  backupSnapshotPath(
    instanceName: string,
    targetName: string,
    backupName: string,
    dashboardPath: string,
  ): string {
    return path.join(this.backupRootPath(instanceName, targetName, backupName), "dashboards", dashboardPath);
  }

  async createTargetBackupSnapshot(
    instanceName: string,
    targetName: string,
    scope: TargetBackupScope,
    dashboards: Array<TargetBackupDashboardRecord & { dashboard: Record<string, unknown> }>,
    backupName = ProjectRepository.timestamp(),
  ): Promise<BackupRecord> {
    await this.ensureProjectLayout();
    const backupRoot = this.backupRootPath(instanceName, targetName, backupName);
    await ensureDir(backupRoot);
    const manifestDashboards: TargetBackupDashboardRecord[] = [];
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
        snapshotPath: path.relative(backupRoot, snapshotPath).replace(/\\/g, "/"),
      });
    }

    const backupManifest: BackupManifest = {
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

  async listBackups(): Promise<BackupRecord[]> {
    const targetsRoot = this.backupTargetsRootPath();
    if (!(await exists(targetsRoot))) {
      return [];
    }

    const instanceEntries = await fs.readdir(targetsRoot, { withFileTypes: true });
    const backups: BackupRecord[] = [];
    for (const instanceEntry of instanceEntries) {
      if (!instanceEntry.isDirectory()) {
        continue;
      }
      const instancePath = path.join(targetsRoot, instanceEntry.name);
      const targetEntries = await fs.readdir(instancePath, { withFileTypes: true });
      for (const targetEntry of targetEntries) {
        if (!targetEntry.isDirectory()) {
          continue;
        }
        const targetPath = path.join(instancePath, targetEntry.name);
        const backupEntries = await fs.readdir(targetPath, { withFileTypes: true });
        for (const backupEntry of backupEntries) {
          if (!backupEntry.isDirectory()) {
            continue;
          }
          const manifestPath = this.backupManifestPath(instanceEntry.name, targetEntry.name, backupEntry.name);
          if (!(await exists(manifestPath))) {
            continue;
          }

          try {
            const manifest = validateTargetBackupManifest(
              await this.readJsonFile<BackupManifest>(manifestPath),
              manifestPath,
            );
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
          } catch {
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

  async readBackupRecord(instanceName: string, targetName: string, backupName: string): Promise<BackupRecord> {
    const backups = await this.listBackups();
    const record = backups.find(
      (backup) =>
        backup.name === backupName && backup.instanceName === instanceName && backup.targetName === targetName,
    );
    if (!record) {
      throw new Error(`Backup not found: ${instanceName}/${targetName}/${backupName}`);
    }
    return record;
  }

  async readBackupDashboardSnapshot(
    backup: BackupRecord,
    dashboard: TargetBackupDashboardRecord,
  ): Promise<Record<string, unknown>> {
    return this.readJsonFile<Record<string, unknown>>(path.join(backup.rootPath, dashboard.snapshotPath));
  }

  async deleteBackup(instanceName: string, targetName: string, backupName: string): Promise<void> {
    const backupRoot = this.backupRootPath(instanceName, targetName, backupName);
    if (await exists(backupRoot)) {
      await fs.rm(backupRoot, { recursive: true, force: true });
    }
  }

  private async pruneManagedBackups(): Promise<void> {
    const backups = await this.listBackups();
    const staleBackups = backups.slice(this.maxBackups);
    for (const backup of staleBackups) {
      await fs.rm(backup.rootPath, { recursive: true, force: true });
    }
  }

  async updateManifestEntry(
    currentSelector: string,
    nextEntry: DashboardManifestEntry,
  ): Promise<void> {
    const manifest = await this.loadManifest();
    const currentEntry = findManifestEntryBySelector(manifest, currentSelector);
    if (!currentEntry) {
      throw new Error(`Dashboard selector not found: ${currentSelector}`);
    }

    const currentIndex = manifest.dashboards.findIndex((entry) => selectorNameForEntry(entry) === currentSelector);
    const currentDashboardPath = this.dashboardPath(currentEntry);
    const nextDashboardPath = this.dashboardPath(nextEntry);
    if (
      currentEntry.path !== nextEntry.path &&
      (await exists(currentDashboardPath)) &&
      !(await exists(nextDashboardPath))
    ) {
      await ensureDir(path.dirname(nextDashboardPath));
      await fs.rename(currentDashboardPath, nextDashboardPath);
    }

    const currentFolderMetaPath = this.folderMetaPathForEntry(currentEntry);
    const nextFolderMetaPath = this.folderMetaPathForEntry(nextEntry);
    if (
      currentFolderMetaPath &&
      nextFolderMetaPath &&
      currentFolderMetaPath !== nextFolderMetaPath &&
      (await exists(currentFolderMetaPath)) &&
      !(await exists(nextFolderMetaPath))
    ) {
      await ensureDir(path.dirname(nextFolderMetaPath));
      await fs.copyFile(currentFolderMetaPath, nextFolderMetaPath);
    }

    if (currentEntry.path !== nextEntry.path || currentEntry.uid !== nextEntry.uid) {
      const currentOverrides = await this.readDashboardOverridesFile(currentEntry);
      if (currentOverrides?.dashboards[this.dashboardOverrideDashboardKey(currentEntry)]) {
        const currentOverridesPath = this.dashboardOverridesFilePath(currentEntry);
        const nextOverridesPath = this.dashboardOverridesFilePath(nextEntry);
        if (currentOverridesPath === nextOverridesPath) {
          currentOverrides.dashboards[this.dashboardOverrideDashboardKey(nextEntry)] =
            currentOverrides.dashboards[this.dashboardOverrideDashboardKey(currentEntry)]!;
          delete currentOverrides.dashboards[this.dashboardOverrideDashboardKey(currentEntry)];
          await this.saveDashboardOverridesFile(nextEntry, currentOverrides);
        } else {
          const nextOverrides = (await this.readDashboardOverridesFile(nextEntry)) ?? { dashboards: {} };
          nextOverrides.dashboards[this.dashboardOverrideDashboardKey(nextEntry)] =
            currentOverrides.dashboards[this.dashboardOverrideDashboardKey(currentEntry)]!;
          delete currentOverrides.dashboards[this.dashboardOverrideDashboardKey(currentEntry)];
          await this.saveDashboardOverridesFile(nextEntry, nextOverrides);
          await this.saveDashboardOverridesFile(currentEntry, currentOverrides);
        }
      }
    }

    const currentVersionIndex = await this.readDashboardVersionIndex(currentEntry);
    if (currentVersionIndex) {
      const migratedIndex: DashboardVersionIndex = {
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

        const nextSnapshot: DashboardRevisionSnapshot =
          currentEntry.uid === nextEntry.uid
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

  async listDashboardRecords(): Promise<DashboardRecord[]> {
    const manifest = await this.loadManifest();
    const records: DashboardRecord[] = [];

    for (const entry of manifest.dashboards) {
      const absolutePath = this.dashboardPath(entry);
      const record: DashboardRecord = {
        entry,
        selectorName: selectorNameForEntry(entry),
        absolutePath,
        exists: await exists(absolutePath),
        folderMetaPath: this.folderMetaPathForEntry(entry),
      };

      if (record.exists) {
        try {
          const json = await this.readJsonFile<Record<string, unknown>>(absolutePath);
          if (typeof json.title === "string" && json.title.trim()) {
            record.title = json.title;
          }
        } catch {
          record.title = undefined;
        }
      }

      records.push(record);
    }

    return records;
  }

  async dashboardRecordBySelector(selectorName: string): Promise<DashboardRecord | undefined> {
    const records = await this.listDashboardRecords();
    return records.find((record) => record.selectorName === selectorName);
  }

  async listInstances(): Promise<InstanceRecord[]> {
    const config = await this.loadWorkspaceConfig();
    const instances: InstanceRecord[] = [];

    for (const instanceName of Object.keys(config.instances)) {
      const dirPath = `${this.workspaceConfigPath}#instances.${instanceName}`;
      instances.push({
        name: instanceName,
        dirPath,
        envPath: this.workspaceConfigPath,
        envExists: Boolean(config.instances[instanceName]?.grafanaUrl),
        envExamplePath: this.instanceEnvExamplePath(instanceName),
      });
    }

    return instances.sort((left, right) => left.name.localeCompare(right.name));
  }

  async instanceByName(instanceName: string): Promise<InstanceRecord | undefined> {
    const instances = await this.listInstances();
    return instances.find((instance) => instance.name === instanceName);
  }

  async createInstance(instanceName: string): Promise<InstanceRecord> {
    const sanitized = instanceName.trim();
    if (!sanitized) {
      throw new Error("Instance name must not be empty.");
    }

    await this.ensureProjectLayout();
    const dirPath = `${this.workspaceConfigPath}#instances.${sanitized}`;
    const config = await this.loadWorkspaceConfig();
    config.instances[sanitized] ??= {
      grafanaUrl: "http://localhost:3000",
      grafanaNamespace: "default",
      targets: {
        [DEFAULT_DEPLOYMENT_TARGET]: {},
      },
    };
    await this.saveWorkspaceConfig(config);
    return {
      name: sanitized,
      dirPath,
      envPath: this.workspaceConfigPath,
      envExists: Boolean(config.instances[sanitized]?.grafanaUrl),
      envExamplePath: this.instanceEnvExamplePath(sanitized),
    };
  }

  async removeInstance(instanceName: string): Promise<void> {
    const instance = await this.instanceByName(instanceName);
    if (!instance) {
      throw new Error(`Instance not found: ${instanceName}`);
    }

    const config = await this.loadWorkspaceConfig();
    delete config.instances[instanceName];
    await this.saveWorkspaceConfig(config);
  }

  async listDeploymentTargets(instanceName: string): Promise<DeploymentTargetRecord[]> {
    const config = await this.loadWorkspaceConfig();
    const instance = config.instances[instanceName];
    if (!instance) {
      return [];
    }
    const targets: DeploymentTargetRecord[] = [];
    for (const targetName of Object.keys(instance.targets)) {
      targets.push({
        instanceName,
        name: targetName,
        dirPath: `${this.workspaceConfigPath}#instances.${instanceName}.targets.${targetName}`,
      });
    }

    return targets.sort((left, right) => left.name.localeCompare(right.name));
  }

  async deploymentTargetByName(instanceName: string, targetName: string): Promise<DeploymentTargetRecord | undefined> {
    const targets = await this.listDeploymentTargets(instanceName);
    return targets.find((target) => target.name === targetName);
  }

  async listAllDeploymentTargets(): Promise<DeploymentTargetRecord[]> {
    const instances = await this.listInstances();
    const targets = await Promise.all(instances.map((instance) => this.listDeploymentTargets(instance.name)));
    return targets.flat().sort((left, right) => {
      const instanceOrder = left.instanceName.localeCompare(right.instanceName);
      return instanceOrder !== 0 ? instanceOrder : left.name.localeCompare(right.name);
    });
  }

  async createDeploymentTarget(instanceName: string, targetName: string): Promise<DeploymentTargetRecord> {
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
    };
  }

  async removeDeploymentTarget(instanceName: string, targetName: string): Promise<void> {
    const target = await this.deploymentTargetByName(instanceName, targetName);
    if (!target) {
      throw new Error(`Deployment target not found: ${instanceName}/${targetName}`);
    }

    if (target.name === DEFAULT_DEPLOYMENT_TARGET) {
      throw new Error("Default deployment target cannot be removed.");
    }

    const config = await this.loadWorkspaceConfig();
    delete config.instances[instanceName]?.targets[targetName];
    await this.saveWorkspaceConfig(config);
  }

  async loadRootEnvValues(): Promise<Record<string, string>> {
    return {};
  }

  async loadInstanceEnvValues(instanceName: string): Promise<Record<string, string>> {
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

  async loadConnectionConfig(instanceName?: string): Promise<EffectiveConnectionConfig> {
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
      sourceLabel: `${PROJECT_CONFIG_FILE} -> instances.${instanceName}`,
    };
  }

  async saveInstanceEnvValues(instanceName: string, values: Record<string, string>): Promise<void> {
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

  async createInstanceEnvFromTemplate(instanceName: string): Promise<string> {
    const config = await this.loadWorkspaceConfig();
    config.instances[instanceName] ??= {
      grafanaUrl: "http://localhost:3000",
      grafanaNamespace: "default",
      targets: {
        [DEFAULT_DEPLOYMENT_TARGET]: {},
      },
    };
    await this.saveWorkspaceConfig(config);
    return this.workspaceConfigPath;
  }

  async readDashboardJson(entry: DashboardManifestEntry): Promise<Record<string, unknown>> {
    const filePath = this.dashboardPath(entry);
    if (!(await exists(filePath))) {
      throw new Error(`Dashboard file not found: ${filePath}`);
    }
    return this.readJsonFile<Record<string, unknown>>(filePath);
  }

  async saveDashboardJson(entry: DashboardManifestEntry, dashboard: Record<string, unknown>): Promise<void> {
    await this.writeJsonFile(this.dashboardPath(entry), dashboard);
  }

  async readRenderManifest(instanceName: string, targetName: string): Promise<RenderManifest | undefined> {
    const filePath = this.renderManifestPath(instanceName, targetName);
    if (!(await exists(filePath))) {
      return undefined;
    }
    return validateRenderManifest(await this.readJsonFile<RenderManifest>(filePath), filePath);
  }

  async saveRenderManifest(instanceName: string, targetName: string, manifest: RenderManifest): Promise<string> {
    const filePath = this.renderManifestPath(instanceName, targetName);
    await this.writeJsonFile(filePath, validateRenderManifest(manifest, filePath));
    return filePath;
  }

  async clearRenderRoot(instanceName: string, targetName: string): Promise<void> {
    const rootPath = this.renderRootPath(instanceName, targetName);
    if (await exists(rootPath)) {
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  }

  async readFolderMetadata(entry: DashboardManifestEntry): Promise<FolderMetadata | undefined> {
    const filePath = this.folderMetaPathForEntry(entry);
    if (!filePath || !(await exists(filePath))) {
      return undefined;
    }
    const raw = await this.readJsonFile<Record<string, unknown>>(filePath);
    const uid = typeof raw.uid === "string" && raw.uid.trim() ? raw.uid.trim() : undefined;
    const pathValue =
      typeof raw.path === "string" && raw.path.trim()
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

  async saveFolderMetadata(entry: DashboardManifestEntry, folderMetadata: FolderMetadata): Promise<void> {
    const filePath = this.folderMetaPathForEntry(entry);
    if (!filePath) {
      return;
    }
    await this.writeJsonFile(filePath, {
      ...(folderMetadata.path ? { path: folderMetadata.path } : {}),
      ...(folderMetadata.uid ? { uid: folderMetadata.uid } : {}),
    });
  }

  async deleteFolderMetadata(entry: DashboardManifestEntry): Promise<boolean> {
    const filePath = this.folderMetaPathForEntry(entry);
    if (!filePath) {
      return false;
    }
    return removeFileIfExists(filePath);
  }

  async readTargetOverrideFile(
    instanceName: string,
    targetName: string,
    entry: DashboardManifestEntry,
  ): Promise<DashboardOverrideFile | undefined> {
    const filePath = this.dashboardOverridesFilePath(entry);
    if (!(await exists(filePath))) {
      return undefined;
    }

    const file = validateDashboardFolderOverridesFile(
      await this.readJsonFile<DashboardFolderOverridesFile>(filePath),
      filePath,
    );
    return file.dashboards[this.dashboardOverrideDashboardKey(entry)]?.targets[this.dashboardOverrideTargetKey(instanceName, targetName)];
  }

  async readDashboardOverrides(entry: DashboardManifestEntry): Promise<DashboardFolderOverridesFile | undefined> {
    const filePath = this.dashboardOverridesFilePath(entry);
    if (!(await exists(filePath))) {
      return undefined;
    }
    return validateDashboardFolderOverridesFile(
      await this.readJsonFile<DashboardFolderOverridesFile>(filePath),
      filePath,
    );
  }

  private async readDashboardOverridesFile(entry: DashboardManifestEntry): Promise<DashboardFolderOverridesFile | undefined> {
    return this.readDashboardOverrides(entry);
  }

  private async saveDashboardOverridesFile(entry: DashboardManifestEntry, file: DashboardFolderOverridesFile): Promise<string> {
    const filePath = this.dashboardOverridesFilePath(entry);
    const validFile = validateDashboardFolderOverridesFile(file, filePath);
    if (Object.keys(validFile.dashboards).length === 0) {
      if (await exists(filePath)) {
        await fs.rm(filePath, { force: true });
      }
      return filePath;
    }
    await this.writeJsonFile(filePath, validFile);
    return filePath;
  }

  async readOverrideFile(instanceName: string, entry: DashboardManifestEntry): Promise<DashboardOverrideFile | undefined> {
    return this.readTargetOverrideFile(instanceName, DEFAULT_DEPLOYMENT_TARGET, entry);
  }

  async readDashboardVersionIndex(entry: DashboardManifestEntry): Promise<DashboardVersionIndex | undefined> {
    const filePath = this.dashboardVersionIndexPath(entry);
    if (!(await exists(filePath))) {
      return undefined;
    }
    return validateDashboardVersionIndex(await this.readJsonFile<DashboardVersionIndex>(filePath), filePath);
  }

  async saveDashboardVersionIndex(entry: DashboardManifestEntry, index: DashboardVersionIndex): Promise<string> {
    const filePath = this.dashboardVersionIndexPath(entry);
    await this.writeJsonFile(filePath, validateDashboardVersionIndex(index, filePath));
    return filePath;
  }

  async readDashboardRevisionSnapshot(
    entry: DashboardManifestEntry,
    revisionId: string,
  ): Promise<DashboardRevisionSnapshot | undefined> {
    const filePath = this.dashboardRevisionSnapshotPath(entry, revisionId);
    if (!(await exists(filePath))) {
      return undefined;
    }
    return validateDashboardRevisionSnapshot(await this.readJsonFile<DashboardRevisionSnapshot>(filePath), filePath);
  }

  async saveDashboardRevisionSnapshot(
    entry: DashboardManifestEntry,
    revisionId: string,
    snapshot: DashboardRevisionSnapshot,
  ): Promise<string> {
    const filePath = this.dashboardRevisionSnapshotPath(entry, revisionId);
    await this.writeJsonFile(filePath, validateDashboardRevisionSnapshot(snapshot, filePath));
    return filePath;
  }

  async deleteDashboardVersionHistory(entry: DashboardManifestEntry): Promise<string[]> {
    const removedPaths: string[] = [];
    const indexPath = this.dashboardVersionIndexPath(entry);
    const versionsDir = this.dashboardVersionsDirPath(entry);
    if (await removeFileIfExists(indexPath)) {
      removedPaths.push(indexPath);
    }
    if (await exists(versionsDir)) {
      await fs.rm(versionsDir, { recursive: true, force: true });
      removedPaths.push(versionsDir);
    }
    return removedPaths;
  }

  async hasAnyFolderPathOverride(entry: DashboardManifestEntry): Promise<boolean> {
    const file = await this.readDashboardOverridesFile(entry);
    const targets = file?.dashboards[this.dashboardOverrideDashboardKey(entry)]?.targets ?? {};
    return Object.values(targets).some((override) => typeof override?.folderPath === "string" && override.folderPath.trim());
  }

  async saveTargetOverrideFile(
    instanceName: string,
    targetName: string,
    entry: DashboardManifestEntry,
    overrideFile: DashboardOverrideFile,
  ): Promise<string> {
    const current = (await this.readDashboardOverridesFile(entry)) ?? { dashboards: {} };
    const dashboardKey = this.dashboardOverrideDashboardKey(entry);
    const targetKey = this.dashboardOverrideTargetKey(instanceName, targetName);
    current.dashboards[dashboardKey] ??= { targets: {} };
    current.dashboards[dashboardKey]!.targets[targetKey] = overrideFile;
    await this.saveDashboardOverridesFile(entry, current);
    return this.targetOverridePath(instanceName, targetName, entry);
  }

  async saveOverrideFile(
    instanceName: string,
    entry: DashboardManifestEntry,
    overrideFile: DashboardOverrideFile,
  ): Promise<string> {
    return this.saveTargetOverrideFile(instanceName, DEFAULT_DEPLOYMENT_TARGET, entry, overrideFile);
  }

  async readDatasourceCatalog(): Promise<DatasourceCatalogFile> {
    const config = await this.loadWorkspaceConfig();
    return {
      datasources: validateDatasourceCatalogFile(
        {
          datasources: config.datasources,
        },
        this.workspaceConfigPath,
      ).datasources,
    };
  }

  async saveDatasourceCatalog(catalogFile: DatasourceCatalogFile): Promise<string> {
    const validCatalog = validateDatasourceCatalogFile(catalogFile, this.workspaceConfigPath);
    const config = await this.loadWorkspaceConfig();
    await this.saveWorkspaceConfig({
      ...config,
      datasources: validCatalog.datasources,
    });
    return this.workspaceConfigPath;
  }

  async loadDashboardDetails(selectorName: string): Promise<DashboardDetailsModel | undefined> {
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

  async loadInstanceDetails(instanceName: string): Promise<InstanceDetailsModel | undefined> {
    const instance = await this.instanceByName(instanceName);
    if (!instance) {
      return undefined;
    }

    const envValues = await this.loadInstanceEnvValues(instanceName);
    const tokenFromSecret = (await this.resolveToken(instanceName))?.trim();
    const tokenSourceLabel = tokenFromSecret
      ? "VS Code Secret Storage"
      : undefined;
    let mergedConnection: EffectiveConnectionConfig | undefined;

    try {
      mergedConnection = await this.loadConnectionConfig(instanceName);
    } catch {
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

  async loadDeploymentTargetDetails(
    instanceName: string,
    targetName: string,
  ): Promise<DeploymentTargetDetailsModel | undefined> {
    const target = await this.deploymentTargetByName(instanceName, targetName);
    if (!target) {
      return undefined;
    }

    return {
      target,
    };
  }

  static timestamp(now = new Date()): string {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const seconds = String(now.getSeconds()).padStart(2, "0");
    return `${year}${month}${day}_${hours}${minutes}${seconds}`;
  }

  async syncPulledFile(options: {
    sourceContent: string;
    targetPath: string;
    backupPath?: string;
    previousPath?: string;
  }): Promise<{ status: "updated" | "skipped"; hadPrevious: boolean }> {
    const { sourceContent, targetPath, backupPath, previousPath } = options;
    if (backupPath) {
      await ensureDir(path.dirname(backupPath));
      await fs.writeFile(backupPath, sourceContent, "utf8");
    }

    if (await exists(targetPath)) {
      const currentContent = await fs.readFile(targetPath, "utf8");
      if (currentContent === sourceContent) {
        return {
          status: "skipped",
          hadPrevious: false,
        };
      }

      if (previousPath) {
        await ensureDir(path.dirname(previousPath));
        await fs.writeFile(previousPath, currentContent, "utf8");
      }
      await ensureDir(path.dirname(targetPath));
      await fs.writeFile(targetPath, sourceContent, "utf8");
      return {
        status: "updated",
        hadPrevious: Boolean(previousPath),
      };
    }

    await ensureDir(path.dirname(targetPath));
    await fs.writeFile(targetPath, sourceContent, "utf8");
    return {
      status: "updated",
      hadPrevious: false,
    };
  }
}
