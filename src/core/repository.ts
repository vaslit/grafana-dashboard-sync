import fs from "node:fs/promises";
import path from "node:path";

import { stableJsonStringify } from "./json";
import { findManifestEntryBySelector, selectorNameForEntry, validateManifest } from "./manifest";
import { PROJECT_CONFIG_FILE, ProjectLayout, defaultProjectLayout } from "./projectLocator";
import {
  AlertManifestContactPointEntry,
  AlertManifestRuleEntry,
  AlertRuleRecord,
  AlertsManifest,
  BackupDashboardRecord,
  BackupManifest,
  BackupRecord,
  BackupInstanceRecord,
  BackupScope,
  BackupTargetRecord,
  DashboardDetailsModel,
  DashboardManifest,
  DashboardManifestEntry,
  DashboardRevisionSnapshot,
  DashboardRevisionRecord,
  DashboardVersionIndex,
  DatasourceCatalogFile,
  DashboardFolderOverridesFile,
  DashboardOverrideFile,
  DashboardOverrideValue,
  DashboardTargetRevisionState,
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

async function copyDirectoryTree(sourceDir: string, targetDir: string): Promise<void> {
  if (!(await exists(sourceDir))) {
    return;
  }

  await ensureDir(targetDir);
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await copyDirectoryTree(sourcePath, targetPath);
      continue;
    }

    await ensureDir(path.dirname(targetPath));
    await fs.copyFile(sourcePath, targetPath);
  }
}

function normalizeGrafanaUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function normalizeGrafanaUrlList(values: string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const next = normalizeGrafanaUrl(value);
    if (!next || seen.has(next)) {
      continue;
    }
    normalized.push(next);
    seen.add(next);
  }
  return normalized;
}

function parseGrafanaFallbackUrls(value: string | undefined): string[] {
  return normalizeGrafanaUrlList((value ?? "").split(/\r?\n|,/));
}

interface ProjectRepositoryOptions {
  resolveToken?: (instanceName?: string) => Promise<string | undefined>;
  resolvePassword?: (instanceName?: string) => Promise<string | undefined>;
}

export const DEFAULT_DEPLOYMENT_TARGET = "default";

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

function sanitizeFileSegment(value: string): string {
  const normalized = value
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+|\.+$/g, "");
  return normalized || "item";
}

function emptyAlertsManifest(instanceName: string, targetName: string): AlertsManifest {
  return {
    version: 1,
    instanceName,
    targetName,
    generatedAt: new Date().toISOString(),
    rules: {},
    contactPoints: {},
  };
}

function normalizeAlertRuleEntry(entry: AlertManifestRuleEntry): AlertManifestRuleEntry {
  return {
    uid: entry.uid.trim(),
    title: entry.title.trim() || entry.uid.trim(),
    path: normalizeRelativePath(entry.path),
    contactPointKeys: [...new Set(entry.contactPointKeys.map((key) => key.trim()).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b),
    ),
    contactPointStatus: entry.contactPointStatus,
    ...(entry.lastExportedAt ? { lastExportedAt: entry.lastExportedAt } : {}),
    ...(entry.lastAppliedAt ? { lastAppliedAt: entry.lastAppliedAt } : {}),
  };
}

function normalizeAlertContactPointEntry(entry: AlertManifestContactPointEntry): AlertManifestContactPointEntry {
  return {
    key: entry.key.trim(),
    path: normalizeRelativePath(entry.path),
    name: entry.name.trim(),
    ...(entry.uid?.trim() ? { uid: entry.uid.trim() } : {}),
    ...(entry.type?.trim() ? { type: entry.type.trim() } : {}),
  };
}

function validateAlertsManifest(
  manifest: AlertsManifest,
  filePath: string,
  expectedInstanceName?: string,
  expectedTargetName?: string,
): AlertsManifest {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`Invalid alerts manifest: ${filePath}`);
  }
  if (manifest.version !== 1) {
    throw new Error(`Invalid alerts manifest version: ${filePath}`);
  }
  if (typeof manifest.instanceName !== "string" || !manifest.instanceName.trim()) {
    throw new Error(`Invalid alerts manifest instanceName: ${filePath}`);
  }
  if (typeof manifest.targetName !== "string" || !manifest.targetName.trim()) {
    throw new Error(`Invalid alerts manifest targetName: ${filePath}`);
  }
  if (expectedInstanceName && manifest.instanceName !== expectedInstanceName) {
    throw new Error(`Alerts manifest instanceName mismatch: ${filePath}`);
  }
  if (expectedTargetName && manifest.targetName !== expectedTargetName) {
    throw new Error(`Alerts manifest targetName mismatch: ${filePath}`);
  }
  if (!manifest.rules || typeof manifest.rules !== "object" || Array.isArray(manifest.rules)) {
    throw new Error(`Invalid alerts manifest rules: ${filePath}`);
  }
  if (!manifest.contactPoints || typeof manifest.contactPoints !== "object" || Array.isArray(manifest.contactPoints)) {
    throw new Error(`Invalid alerts manifest contactPoints: ${filePath}`);
  }

  const rules: AlertsManifest["rules"] = {};
  for (const [uid, rawRule] of Object.entries(manifest.rules)) {
    if (!uid.trim()) {
      throw new Error(`Invalid alerts manifest rule uid: ${filePath}`);
    }
    if (!rawRule || typeof rawRule !== "object" || Array.isArray(rawRule)) {
      throw new Error(`Invalid alerts manifest rule entry: ${filePath}`);
    }
    const entry = rawRule as AlertManifestRuleEntry;
    if (typeof entry.uid !== "string" || !entry.uid.trim()) {
      throw new Error(`Invalid alerts manifest rule.uid: ${filePath}`);
    }
    if (typeof entry.title !== "string" || !entry.title.trim()) {
      throw new Error(`Invalid alerts manifest rule.title: ${filePath}`);
    }
    if (typeof entry.path !== "string" || !entry.path.trim()) {
      throw new Error(`Invalid alerts manifest rule.path: ${filePath}`);
    }
    if (!Array.isArray(entry.contactPointKeys)) {
      throw new Error(`Invalid alerts manifest rule.contactPointKeys: ${filePath}`);
    }
    if (!["linked", "missing", "policy-managed"].includes(entry.contactPointStatus)) {
      throw new Error(`Invalid alerts manifest rule.contactPointStatus: ${filePath}`);
    }
    rules[uid] = normalizeAlertRuleEntry(entry);
  }

  const contactPoints: AlertsManifest["contactPoints"] = {};
  for (const [key, rawContactPoint] of Object.entries(manifest.contactPoints)) {
    if (!key.trim()) {
      throw new Error(`Invalid alerts manifest contact point key: ${filePath}`);
    }
    if (!rawContactPoint || typeof rawContactPoint !== "object" || Array.isArray(rawContactPoint)) {
      throw new Error(`Invalid alerts manifest contact point entry: ${filePath}`);
    }
    const entry = rawContactPoint as AlertManifestContactPointEntry;
    if (typeof entry.key !== "string" || !entry.key.trim()) {
      throw new Error(`Invalid alerts manifest contact point key: ${filePath}`);
    }
    if (typeof entry.path !== "string" || !entry.path.trim()) {
      throw new Error(`Invalid alerts manifest contact point path: ${filePath}`);
    }
    if (typeof entry.name !== "string" || !entry.name.trim()) {
      throw new Error(`Invalid alerts manifest contact point name: ${filePath}`);
    }
    contactPoints[key] = normalizeAlertContactPointEntry(entry);
  }

  return {
    version: 1,
    instanceName: manifest.instanceName,
    targetName: manifest.targetName,
    generatedAt:
      typeof manifest.generatedAt === "string" && manifest.generatedAt.trim()
        ? manifest.generatedAt
        : new Date().toISOString(),
    rules,
    contactPoints,
  };
}

function toRelativeConfigPath(projectRootPath: string, absolutePath: string): string {
  const relativePath = normalizeRelativePath(path.relative(projectRootPath, absolutePath));
  return relativePath || ".";
}

function normalizeDashboardTargetRevisionState(
  rawState: Record<string, unknown>,
  filePath: string,
  targetKey: string,
  revisionId: string,
): DashboardTargetRevisionState {
  const variableOverridesRaw = rawState.variableOverrides ?? {};
  const datasourceBindingsRaw = rawState.datasourceBindings ?? {};

  if (!variableOverridesRaw || typeof variableOverridesRaw !== "object" || Array.isArray(variableOverridesRaw)) {
    throw new Error(`Invalid dashboard target revision state in ${filePath} for ${targetKey}@${revisionId}`);
  }

  if (!datasourceBindingsRaw || typeof datasourceBindingsRaw !== "object" || Array.isArray(datasourceBindingsRaw)) {
    throw new Error(`Invalid dashboard target revision datasource bindings in ${filePath} for ${targetKey}@${revisionId}`);
  }

  const datasourceBindings: Record<string, string> = {};
  for (const [bindingKey, bindingValue] of Object.entries(datasourceBindingsRaw as Record<string, unknown>)) {
    if (!bindingKey.trim() || typeof bindingValue !== "string" || !bindingValue.trim()) {
      throw new Error(`Invalid dashboard target revision datasource binding in ${filePath} for ${targetKey}@${revisionId}`);
    }
    datasourceBindings[bindingKey] = bindingValue.trim();
  }

  return {
    variableOverrides: variableOverridesRaw as Record<string, DashboardOverrideValue>,
    datasourceBindings,
  };
}

function normalizeDashboardTargetState(
  rawState: Record<string, unknown>,
  filePath: string,
  targetKey: string,
): DashboardOverrideFile {
  const currentRevisionId =
    typeof rawState.currentRevisionId === "string" && rawState.currentRevisionId.trim()
      ? rawState.currentRevisionId.trim()
      : undefined;
  const dashboardUid =
    typeof rawState.dashboardUid === "string" && rawState.dashboardUid.trim()
      ? rawState.dashboardUid.trim()
      : undefined;
  const folderPath =
    typeof rawState.folderPath === "string" && rawState.folderPath.trim()
      ? rawState.folderPath.trim()
      : undefined;
  const revisionStatesRaw = rawState.revisionStates ?? {};
  if (!revisionStatesRaw || typeof revisionStatesRaw !== "object" || Array.isArray(revisionStatesRaw)) {
    throw new Error(`Invalid dashboard target revision states in ${filePath} for ${targetKey}`);
  }

  const revisionStates: Record<string, DashboardTargetRevisionState> = {};
  for (const [revisionId, revisionState] of Object.entries(revisionStatesRaw as Record<string, unknown>)) {
    if (!revisionId.trim() || !revisionState || typeof revisionState !== "object" || Array.isArray(revisionState)) {
      throw new Error(`Invalid dashboard target revision state in ${filePath} for ${targetKey}`);
    }
    revisionStates[revisionId] = normalizeDashboardTargetRevisionState(
      revisionState as Record<string, unknown>,
      filePath,
      targetKey,
      revisionId,
    );
  }

  return {
    ...(currentRevisionId ? { currentRevisionId } : {}),
    ...(dashboardUid ? { dashboardUid } : {}),
    ...(folderPath ? { folderPath } : {}),
    revisionStates,
  };
}

function emptyDashboardTargetState(): DashboardOverrideFile {
  return {
    revisionStates: {},
  };
}

function defaultWorkspaceConfig(layout: ProjectLayout): WorkspaceProjectConfig {
  return {
    version: 5,
    layout: {
      dashboardsDir: toRelativeConfigPath(layout.projectRootPath, layout.dashboardsDir),
      backupsDir: toRelativeConfigPath(layout.projectRootPath, layout.backupsDir),
      rendersDir: toRelativeConfigPath(layout.projectRootPath, layout.rendersDir),
      alertsDir: toRelativeConfigPath(layout.projectRootPath, layout.alertsDir),
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
  if (config.version !== 5) {
    throw new Error(`Invalid workspace config version: ${filePath}`);
  }
  if (!config.layout || typeof config.layout !== "object" || Array.isArray(config.layout)) {
    throw new Error(`Invalid workspace config: ${filePath}`);
  }
  for (const [key, value] of Object.entries({
    dashboardsDir: config.layout.dashboardsDir,
    backupsDir: config.layout.backupsDir,
    rendersDir: config.layout.rendersDir,
    alertsDir: config.layout.alertsDir,
  })) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`Invalid workspace config ${key}: ${filePath}`);
    }
  }
  if (
    typeof config.layout.maxBackups !== "number" ||
    !Number.isInteger(config.layout.maxBackups) ||
    config.layout.maxBackups <= 0
  ) {
    throw new Error(`Invalid workspace config maxBackups: ${filePath}`);
  }
  if (config.devTarget !== undefined) {
    if (!config.devTarget || typeof config.devTarget !== "object" || Array.isArray(config.devTarget)) {
      throw new Error(`Invalid workspace config devTarget: ${filePath}`);
    }
    if (typeof config.devTarget.instanceName !== "string" || !config.devTarget.instanceName.trim()) {
      throw new Error(`Invalid workspace config devTarget.instanceName: ${filePath}`);
    }
    if (typeof config.devTarget.targetName !== "string" || !config.devTarget.targetName.trim()) {
      throw new Error(`Invalid workspace config devTarget.targetName: ${filePath}`);
    }
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
    if (
      instanceConfig.grafanaFallbackUrls !== undefined &&
      (!Array.isArray(instanceConfig.grafanaFallbackUrls) ||
        instanceConfig.grafanaFallbackUrls.some((value) => typeof value !== "string"))
    ) {
      throw new Error(`Invalid workspace config grafanaFallbackUrls: ${filePath}`);
    }
    if (instanceConfig.grafanaUsername !== undefined && typeof instanceConfig.grafanaUsername !== "string") {
      throw new Error(`Invalid workspace config grafanaUsername: ${filePath}`);
    }
    if (!instanceConfig.targets || typeof instanceConfig.targets !== "object" || Array.isArray(instanceConfig.targets)) {
      throw new Error(`Invalid workspace config targets: ${filePath}`);
    }
    for (const targetName of Object.keys(instanceConfig.targets)) {
      if (!targetName.trim()) {
        throw new Error(`Invalid workspace config target name: ${filePath}`);
      }
    }
    const primaryGrafanaUrl = instanceConfig.grafanaUrl ? normalizeGrafanaUrl(instanceConfig.grafanaUrl) : undefined;
    const fallbackGrafanaUrls = normalizeGrafanaUrlList(
      (instanceConfig.grafanaFallbackUrls ?? []).filter((value) => normalizeGrafanaUrl(value) !== primaryGrafanaUrl),
    );
    if (!primaryGrafanaUrl && fallbackGrafanaUrls.length > 0) {
      throw new Error(`Invalid workspace config grafanaFallbackUrls: ${filePath}`);
    }
    normalizedInstances[instanceName] = {
      ...(primaryGrafanaUrl ? { grafanaUrl: primaryGrafanaUrl } : {}),
      ...(fallbackGrafanaUrls.length > 0 ? { grafanaFallbackUrls: fallbackGrafanaUrls } : {}),
      ...(instanceConfig.grafanaUsername ? { grafanaUsername: instanceConfig.grafanaUsername } : {}),
      targets: Object.fromEntries(Object.keys(instanceConfig.targets).map((targetName) => [targetName, {}])),
    };
  }

  return {
    ...config,
    ...(config.devTarget
      ? {
          devTarget: {
            instanceName: config.devTarget.instanceName.trim(),
            targetName: config.devTarget.targetName.trim(),
          },
        }
      : {}),
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
      const normalizedOverride = normalizeDashboardTargetState(
        override as unknown as Record<string, unknown>,
        filePath,
        targetKey,
      );
      targets[targetKey] = normalizedOverride;
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

function validateBackupManifest(manifest: BackupManifest, filePath: string): BackupManifest {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`Invalid backup manifest: ${filePath}`);
  }
  if (manifest.version !== 2 || manifest.kind !== "grouped-backup") {
    throw new Error(`Invalid backup manifest: ${filePath}`);
  }
  if (!["dashboard", "target", "instance", "multi-instance"].includes(manifest.scope)) {
    throw new Error(`Invalid backup manifest: ${filePath}`);
  }
  for (const key of ["backupName", "generatedAt"] as const) {
    if (typeof manifest[key] !== "string" || !manifest[key].trim()) {
      throw new Error(`Invalid backup manifest: ${filePath}`);
    }
  }
  for (const key of ["instanceCount", "targetCount", "dashboardCount", "retentionLimit"] as const) {
    if (!Number.isInteger(manifest[key]) || manifest[key] < 0) {
      throw new Error(`Invalid backup manifest: ${filePath}`);
    }
  }
  if (!Array.isArray(manifest.instances)) {
    throw new Error(`Invalid backup manifest: ${filePath}`);
  }
  for (const instance of manifest.instances) {
    if (!instance || typeof instance !== "object" || Array.isArray(instance)) {
      throw new Error(`Invalid backup manifest: ${filePath}`);
    }
    if (typeof instance.instanceName !== "string" || !instance.instanceName.trim()) {
      throw new Error(`Invalid backup manifest: ${filePath}`);
    }
    if (!Number.isInteger(instance.targetCount) || instance.targetCount < 0) {
      throw new Error(`Invalid backup manifest: ${filePath}`);
    }
    if (!Number.isInteger(instance.dashboardCount) || instance.dashboardCount < 0) {
      throw new Error(`Invalid backup manifest: ${filePath}`);
    }
    if (!Array.isArray(instance.targets)) {
      throw new Error(`Invalid backup manifest: ${filePath}`);
    }
    for (const target of instance.targets) {
      if (!target || typeof target !== "object" || Array.isArray(target)) {
        throw new Error(`Invalid backup manifest: ${filePath}`);
      }
      for (const key of ["instanceName", "targetName"] as const) {
        if (typeof target[key] !== "string" || !target[key].trim()) {
          throw new Error(`Invalid backup manifest: ${filePath}`);
        }
      }
      if (!Number.isInteger(target.dashboardCount) || target.dashboardCount < 0) {
        throw new Error(`Invalid backup manifest: ${filePath}`);
      }
      if (!Array.isArray(target.dashboards)) {
        throw new Error(`Invalid backup manifest: ${filePath}`);
      }
      for (const dashboard of target.dashboards) {
        for (const key of ["selectorName", "baseUid", "effectiveDashboardUid", "path", "title", "snapshotPath"] as const) {
          if (typeof dashboard[key] !== "string" || !dashboard[key].trim()) {
            throw new Error(`Invalid backup manifest: ${filePath}`);
          }
        }
        if (dashboard.folderPath !== undefined && (typeof dashboard.folderPath !== "string" || !dashboard.folderPath.trim())) {
          throw new Error(`Invalid backup manifest: ${filePath}`);
        }
      }
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
  readonly dashboardsDir: string;
  readonly backupsDir: string;
  readonly rendersDir: string;
  readonly alertsDir: string;
  readonly maxBackups: number;
  private readonly resolveToken: (instanceName?: string) => Promise<string | undefined>;
  private readonly resolvePassword: (instanceName?: string) => Promise<string | undefined>;

  constructor(layoutOrRootPath: ProjectLayout | string, options?: ProjectRepositoryOptions) {
    const layout = typeof layoutOrRootPath === "string" ? defaultProjectLayout(layoutOrRootPath) : layoutOrRootPath;
    this.workspaceRootPath = layout.workspaceRootPath;
    this.projectRootPath = layout.projectRootPath;
    this.workspaceConfigPath = layout.workspaceConfigPath;
    this.configPath = layout.configPath;
    this.dashboardsDir = layout.dashboardsDir;
    this.backupsDir = layout.backupsDir;
    this.rendersDir = layout.rendersDir;
    this.alertsDir = layout.alertsDir;
    this.maxBackups = layout.maxBackups;
    this.resolveToken = options?.resolveToken ?? (async () => undefined);
    this.resolvePassword = options?.resolvePassword ?? (async () => undefined);
  }

  async ensureProjectLayout(): Promise<void> {
    await ensureDir(this.dashboardsDir);
    await ensureDir(this.backupsDir);
    await ensureDir(this.rendersDir);
    await ensureDir(this.alertsDir);
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

  alertsRootPath(instanceName: string, targetName: string): string {
    return path.join(this.alertsDir, instanceName, targetName);
  }

  alertsManifestPath(instanceName: string, targetName: string): string {
    return path.join(this.alertsRootPath(instanceName, targetName), "manifest.json");
  }

  alertsRulesDirPath(instanceName: string, targetName: string): string {
    return path.join(this.alertsRootPath(instanceName, targetName), "rules");
  }

  alertsContactPointsDirPath(instanceName: string, targetName: string): string {
    return path.join(this.alertsRootPath(instanceName, targetName), "contact-points");
  }

  alertRuleFilePath(instanceName: string, targetName: string, uid: string): string {
    return path.join(this.alertsRulesDirPath(instanceName, targetName), `${sanitizeFileSegment(uid)}.json`);
  }

  alertContactPointFilePath(instanceName: string, targetName: string, key: string): string {
    return path.join(this.alertsContactPointsDirPath(instanceName, targetName), `${sanitizeFileSegment(key)}.json`);
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
    return path.join(
      path.dirname(this.dashboardPath(entry)),
      ".versions",
      sanitizeFileSegment(this.dashboardOverrideDashboardKey(entry)),
    );
  }

  dashboardVersionIndexPath(entry: DashboardManifestEntry): string {
    return path.join(this.dashboardVersionsDirPath(entry), "index.json");
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
        dashboardsDir: this.dashboardsDir,
        backupsDir: this.backupsDir,
        rendersDir: this.rendersDir,
        alertsDir: this.alertsDir,
        maxBackups: this.maxBackups,
      });
    }

    const config = await this.readJsonFile<WorkspaceProjectConfig>(this.workspaceConfigPath);
    return validateWorkspaceProjectConfig(config, this.workspaceConfigPath);
  }

  async saveWorkspaceConfig(config: WorkspaceProjectConfig): Promise<void> {
    const validConfig = validateWorkspaceProjectConfig(config, this.workspaceConfigPath);
    await this.ensureProjectLayout();
    await this.writeJsonFile(this.workspaceConfigPath, {
      ...validConfig,
    });
  }

  async migrateWorkspaceConfig(): Promise<boolean> {
    if (!(await this.workspaceConfigExists())) {
      return false;
    }

    await this.loadWorkspaceConfig();
    return false;
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
    return false;
  }

  async createManifestFromExample(): Promise<void> {
    await this.ensureProjectLayout();
    const manifestExamplePath = path.join(this.projectRootPath, "dashboard-manifest.example.json");
    if (await exists(manifestExamplePath)) {
      const manifest = await this.readJsonFile<DashboardManifest>(manifestExamplePath);
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

  backupRootPath(backupName: string): string {
    return path.join(this.backupsDir, backupName);
  }

  backupManifestPath(backupName: string): string {
    return path.join(this.backupRootPath(backupName), "backup_manifest.json");
  }

  backupSnapshotPath(
    backupName: string,
    instanceName: string,
    targetName: string,
    dashboardPath: string,
  ): string {
    return path.join(this.backupRootPath(backupName), "instances", instanceName, "targets", targetName, "dashboards", dashboardPath);
  }

  async createBackupSnapshot(
    scope: BackupScope,
    targets: Array<{
      instanceName: string;
      targetName: string;
      dashboards: Array<BackupDashboardRecord & { dashboard: Record<string, unknown> }>;
    }>,
    backupName = ProjectRepository.timestamp(),
  ): Promise<BackupRecord> {
    await this.ensureProjectLayout();
    const backupRoot = this.backupRootPath(backupName);
    await ensureDir(backupRoot);

    const targetRecords: BackupTargetRecord[] = [];
    for (const target of targets) {
      const dashboards: BackupDashboardRecord[] = [];
      for (const dashboard of target.dashboards) {
        const snapshotPath = this.backupSnapshotPath(backupName, target.instanceName, target.targetName, dashboard.path);
        await this.writeJsonFile(snapshotPath, dashboard.dashboard);
        dashboards.push({
          selectorName: dashboard.selectorName,
          baseUid: dashboard.baseUid,
          effectiveDashboardUid: dashboard.effectiveDashboardUid,
          path: dashboard.path,
          ...(dashboard.folderPath ? { folderPath: dashboard.folderPath } : {}),
          title: dashboard.title,
          snapshotPath: path.relative(backupRoot, snapshotPath).replace(/\\/g, "/"),
        });
      }
      targetRecords.push({
        instanceName: target.instanceName,
        targetName: target.targetName,
        dashboardCount: dashboards.length,
        dashboards,
      });
    }

    const groupedInstances = new Map<string, BackupTargetRecord[]>();
    for (const target of targetRecords) {
      const current = groupedInstances.get(target.instanceName) ?? [];
      current.push(target);
      groupedInstances.set(target.instanceName, current);
    }

    const instances: BackupInstanceRecord[] = [...groupedInstances.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([instanceName, instanceTargets]) => ({
        instanceName,
        targetCount: instanceTargets.length,
        dashboardCount: instanceTargets.reduce((sum, target) => sum + target.dashboardCount, 0),
        targets: instanceTargets.sort((left, right) => left.targetName.localeCompare(right.targetName)),
      }));

    const backupManifest: BackupManifest = {
      version: 2,
      kind: "grouped-backup",
      backupName,
      generatedAt: new Date().toISOString(),
      scope,
      instanceCount: instances.length,
      targetCount: targetRecords.length,
      dashboardCount: targetRecords.reduce((sum, target) => sum + target.dashboardCount, 0),
      instances,
      retentionLimit: this.maxBackups,
    };

    await this.writeJsonFile(this.backupManifestPath(backupName), backupManifest);
    await this.pruneManagedBackups();
    return this.readBackupRecord(backupName);
  }

  async listBackups(): Promise<BackupRecord[]> {
    if (!(await exists(this.backupsDir))) {
      return [];
    }

    const entries = await fs.readdir(this.backupsDir, { withFileTypes: true });
    const backups: BackupRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const manifestPath = this.backupManifestPath(entry.name);
      if (!(await exists(manifestPath))) {
        continue;
      }

      try {
        const manifest = validateBackupManifest(await this.readJsonFile<BackupManifest>(manifestPath), manifestPath);
        backups.push({
          name: manifest.backupName,
          rootPath: this.backupRootPath(manifest.backupName),
          manifestPath,
          generatedAt: manifest.generatedAt,
          scope: manifest.scope,
          instanceCount: manifest.instanceCount,
          targetCount: manifest.targetCount,
          dashboardCount: manifest.dashboardCount,
          instances: manifest.instances,
        });
      } catch {
        continue;
      }
    }

    return backups.sort((left, right) => right.name.localeCompare(left.name));
  }

  async readBackupRecord(backupName: string): Promise<BackupRecord> {
    const backups = await this.listBackups();
    const record = backups.find((backup) => backup.name === backupName);
    if (!record) {
      throw new Error(`Backup not found: ${backupName}`);
    }
    return record;
  }

  async readBackupDashboardSnapshot(
    backup: BackupRecord,
    dashboard: BackupDashboardRecord,
  ): Promise<Record<string, unknown>> {
    return this.readJsonFile<Record<string, unknown>>(path.join(backup.rootPath, dashboard.snapshotPath));
  }

  async deleteBackup(backupName: string): Promise<void> {
    const backupRoot = this.backupRootPath(backupName);
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
      targets: {
        [DEFAULT_DEPLOYMENT_TARGET]: {},
      },
    };
    config.devTarget ??= {
      instanceName: sanitized,
      targetName: DEFAULT_DEPLOYMENT_TARGET,
    };
    await this.saveWorkspaceConfig(config);
    return {
      name: sanitized,
      dirPath,
      envPath: this.workspaceConfigPath,
      envExists: Boolean(config.instances[sanitized]?.grafanaUrl),
    };
  }

  async removeInstance(instanceName: string): Promise<void> {
    const instance = await this.instanceByName(instanceName);
    if (!instance) {
      throw new Error(`Instance not found: ${instanceName}`);
    }

    const config = await this.loadWorkspaceConfig();
    delete config.instances[instanceName];
    if (config.devTarget?.instanceName === instanceName) {
      config.devTarget = undefined;
    }
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

  async getDevTarget(): Promise<WorkspaceProjectConfig["devTarget"]> {
    const config = await this.loadWorkspaceConfig();
    return config.devTarget;
  }

  async setDevTarget(instanceName: string, targetName: string): Promise<void> {
    const target = await this.deploymentTargetByName(instanceName, targetName);
    if (!target) {
      throw new Error(`Deployment target not found: ${instanceName}/${targetName}`);
    }
    const config = await this.loadWorkspaceConfig();
    config.devTarget = {
      instanceName,
      targetName,
    };
    await this.saveWorkspaceConfig(config);
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

  async renameDeploymentTarget(
    instanceName: string,
    targetName: string,
    nextTargetName: string,
  ): Promise<DeploymentTargetRecord> {
    const target = await this.deploymentTargetByName(instanceName, targetName);
    if (!target) {
      throw new Error(`Deployment target not found: ${instanceName}/${targetName}`);
    }

    const sanitized = nextTargetName.trim();
    if (!sanitized) {
      throw new Error("Deployment target name must not be empty.");
    }
    if (sanitized === targetName) {
      return {
        instanceName,
        name: sanitized,
        dirPath: `${this.workspaceConfigPath}#instances.${instanceName}.targets.${sanitized}`,
      };
    }

    const config = await this.loadWorkspaceConfig();
    const instance = config.instances[instanceName];
    if (!instance) {
      throw new Error(`Instance not found: ${instanceName}`);
    }
    if (instance.targets[sanitized]) {
      throw new Error(`Deployment target already exists: ${instanceName}/${sanitized}`);
    }

    instance.targets[sanitized] = instance.targets[targetName] ?? {};
    delete instance.targets[targetName];
    if (config.devTarget?.instanceName === instanceName && config.devTarget.targetName === targetName) {
      config.devTarget.targetName = sanitized;
    }
    await this.saveWorkspaceConfig(config);

    const currentKey = this.dashboardOverrideTargetKey(instanceName, targetName);
    const nextKey = this.dashboardOverrideTargetKey(instanceName, sanitized);
    const records = await this.listDashboardRecords();
    const processedOverrideFiles = new Set<string>();

    for (const record of records) {
      const overrideFilePath = this.dashboardOverridesFilePath(record.entry);
      if (processedOverrideFiles.has(overrideFilePath)) {
        continue;
      }
      processedOverrideFiles.add(overrideFilePath);

      const file = await this.readDashboardOverridesFile(record.entry);
      if (!file) {
        continue;
      }

      let changed = false;
      for (const dashboardEntry of Object.values(file.dashboards)) {
        const targetState = dashboardEntry.targets[currentKey];
        if (!targetState) {
          continue;
        }
        if (dashboardEntry.targets[nextKey]) {
          throw new Error(`Target override key already exists in ${overrideFilePath}: ${nextKey}`);
        }
        dashboardEntry.targets[nextKey] = targetState;
        delete dashboardEntry.targets[currentKey];
        changed = true;
      }

      if (changed) {
        await this.saveDashboardOverridesFile(record.entry, file);
      }
    }

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

    const targets = await this.listDeploymentTargets(instanceName);
    if (targets.length <= 1) {
      throw new Error("Cannot remove the last remaining deployment target.");
    }

    const config = await this.loadWorkspaceConfig();
    delete config.instances[instanceName]?.targets[targetName];
    if (config.devTarget?.instanceName === instanceName && config.devTarget.targetName === targetName) {
      config.devTarget = undefined;
    }
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
      ...(instance.grafanaFallbackUrls?.length ? { GRAFANA_URL_FALLBACKS: instance.grafanaFallbackUrls.join("\n") } : {}),
      ...(instance.grafanaUsername ? { GRAFANA_USERNAME: instance.grafanaUsername } : {}),
    };
  }

  async loadConnectionConfig(instanceName?: string): Promise<EffectiveConnectionConfig> {
    if (!instanceName) {
      throw new Error("Choose a concrete instance. Global root connection is no longer supported.");
    }

    const instanceValues = await this.loadInstanceEnvValues(instanceName);
    const baseUrl = instanceValues.GRAFANA_URL?.trim();
    const fallbackUrls = parseGrafanaFallbackUrls(instanceValues.GRAFANA_URL_FALLBACKS);
    const username = instanceValues.GRAFANA_USERNAME?.trim();
    const token = (await this.resolveToken(instanceName))?.trim();
    const password = (await this.resolvePassword(instanceName))?.trim();

    if (!baseUrl) {
      throw new Error("GRAFANA_URL is not configured in workspace config for this instance.");
    }
    if (token) {
      return {
        baseUrl: baseUrl.replace(/\/+$/, ""),
        baseUrls: normalizeGrafanaUrlList([baseUrl, ...fallbackUrls]),
        authKind: "bearer",
        token,
        sourceLabel: `${PROJECT_CONFIG_FILE} -> instances.${instanceName}`,
      };
    }
    if (username && password) {
      return {
        baseUrl: baseUrl.replace(/\/+$/, ""),
        baseUrls: normalizeGrafanaUrlList([baseUrl, ...fallbackUrls]),
        authKind: "basic",
        username,
        password,
        sourceLabel: `${PROJECT_CONFIG_FILE} -> instances.${instanceName}`,
      };
    }
    if (username && !password) {
      throw new Error("Grafana password is not configured. Use Set Instance Password.");
    }

    throw new Error("Grafana credentials are not configured. Use Set Instance Token or configure username/password.");
  }

  async saveInstanceEnvValues(instanceName: string, values: Record<string, string>): Promise<void> {
    const config = await this.loadWorkspaceConfig();
    const instance = config.instances[instanceName];
    if (!instance) {
      throw new Error(`Instance not found: ${instanceName}`);
    }

    config.instances[instanceName] = {
      ...instance,
      ...(values.GRAFANA_URL?.trim() ? { grafanaUrl: normalizeGrafanaUrl(values.GRAFANA_URL) } : { grafanaUrl: undefined }),
      ...(parseGrafanaFallbackUrls(values.GRAFANA_URL_FALLBACKS).length > 0
        ? {
            grafanaFallbackUrls: parseGrafanaFallbackUrls(values.GRAFANA_URL_FALLBACKS).filter(
              (value) => value !== normalizeGrafanaUrl(values.GRAFANA_URL ?? ""),
            ),
          }
        : { grafanaFallbackUrls: undefined }),
      ...(values.GRAFANA_USERNAME?.trim()
        ? { grafanaUsername: values.GRAFANA_USERNAME.trim() }
        : { grafanaUsername: undefined }),
    };
    await this.saveWorkspaceConfig(config);
  }

  async createInstanceEnvFromTemplate(instanceName: string): Promise<string> {
    const config = await this.loadWorkspaceConfig();
    config.instances[instanceName] ??= {
      grafanaUrl: "http://localhost:3000",
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

  async deleteDashboardRevisionSnapshot(entry: DashboardManifestEntry, revisionId: string): Promise<boolean> {
    return removeFileIfExists(this.dashboardRevisionSnapshotPath(entry, revisionId));
  }

  async deleteDashboardVersionHistory(entry: DashboardManifestEntry): Promise<string[]> {
    const removedPaths: string[] = [];
    const versionsDir = this.dashboardVersionsDirPath(entry);
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
    current.dashboards[dashboardKey]!.targets[targetKey] = normalizeDashboardTargetState(
      overrideFile as unknown as Record<string, unknown>,
      this.dashboardOverridesFilePath(entry),
      targetKey,
    );
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
    const passwordFromSecret = (await this.resolvePassword(instanceName))?.trim();
    const tokenSourceLabel = tokenFromSecret
      ? "VS Code Secret Storage"
      : undefined;
    const passwordSourceLabel = passwordFromSecret
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
      passwordConfigured: Boolean(passwordSourceLabel),
      passwordSourceLabel,
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

  async readAlertsManifest(instanceName: string, targetName: string): Promise<AlertsManifest | undefined> {
    const filePath = this.alertsManifestPath(instanceName, targetName);
    if (!(await exists(filePath))) {
      return undefined;
    }
    const raw = await this.readJsonFile<AlertsManifest>(filePath);
    return validateAlertsManifest(raw, filePath, instanceName, targetName);
  }

  async loadAlertsManifest(instanceName: string, targetName: string): Promise<AlertsManifest> {
    return (
      (await this.readAlertsManifest(instanceName, targetName)) ??
      emptyAlertsManifest(instanceName, targetName)
    );
  }

  async saveAlertsManifest(instanceName: string, targetName: string, manifest: AlertsManifest): Promise<string> {
    const filePath = this.alertsManifestPath(instanceName, targetName);
    const valid = validateAlertsManifest(manifest, filePath, instanceName, targetName);
    await this.writeJsonFile(filePath, valid);
    return filePath;
  }

  async saveAlertRuleJson(
    instanceName: string,
    targetName: string,
    uid: string,
    rule: Record<string, unknown>,
  ): Promise<string> {
    const manifest = await this.loadAlertsManifest(instanceName, targetName);
    const entry = manifest.rules[uid];
    if (!entry) {
      throw new Error(`Alert is not exported locally: ${uid}`);
    }
    const filePath = path.join(this.alertsRootPath(instanceName, targetName), normalizeRelativePath(entry.path));
    await this.writeJsonFile(filePath, rule);
    return filePath;
  }

  async readAlertRuleJson(
    instanceName: string,
    targetName: string,
    uid: string,
  ): Promise<Record<string, unknown> | undefined> {
    const manifest = await this.readAlertsManifest(instanceName, targetName);
    const rule = manifest?.rules[uid];
    if (!rule) {
      return undefined;
    }
    const filePath = path.join(this.alertsRootPath(instanceName, targetName), normalizeRelativePath(rule.path));
    if (!(await exists(filePath))) {
      return undefined;
    }
    return this.readJsonFile<Record<string, unknown>>(filePath);
  }

  async readAlertContactPointJson(
    instanceName: string,
    targetName: string,
    key: string,
  ): Promise<Record<string, unknown> | undefined> {
    const manifest = await this.readAlertsManifest(instanceName, targetName);
    const contactPoint = manifest?.contactPoints[key];
    if (!contactPoint) {
      return undefined;
    }
    const filePath = path.join(this.alertsRootPath(instanceName, targetName), normalizeRelativePath(contactPoint.path));
    if (!(await exists(filePath))) {
      return undefined;
    }
    return this.readJsonFile<Record<string, unknown>>(filePath);
  }

  async listTargetAlertRecords(instanceName: string, targetName: string): Promise<AlertRuleRecord[]> {
    const manifest = await this.readAlertsManifest(instanceName, targetName);
    if (!manifest) {
      return [];
    }

    const root = this.alertsRootPath(instanceName, targetName);
    const records = await Promise.all(
      Object.entries(manifest.rules).map(async ([uid, rule]): Promise<AlertRuleRecord> => {
        const absolutePath = path.join(root, normalizeRelativePath(rule.path));
        return {
          uid,
          title: rule.title,
          instanceName,
          targetName,
          path: normalizeRelativePath(rule.path),
          absolutePath,
          exists: await exists(absolutePath),
          contactPointKeys: [...rule.contactPointKeys],
          contactPointStatus: rule.contactPointStatus,
          ...(rule.lastExportedAt ? { lastExportedAt: rule.lastExportedAt } : {}),
          ...(rule.lastAppliedAt ? { lastAppliedAt: rule.lastAppliedAt } : {}),
        };
      }),
    );

    return records.sort((left, right) => left.title.localeCompare(right.title) || left.uid.localeCompare(right.uid));
  }

  async listTrackedAlertUids(instanceName: string, targetName: string): Promise<string[]> {
    const manifest = await this.readAlertsManifest(instanceName, targetName);
    if (!manifest) {
      return [];
    }

    return Object.keys(manifest.rules).sort((left, right) => left.localeCompare(right));
  }

  async alertRecordByUid(
    instanceName: string,
    targetName: string,
    uid: string,
  ): Promise<AlertRuleRecord | undefined> {
    const records = await this.listTargetAlertRecords(instanceName, targetName);
    return records.find((record) => record.uid === uid);
  }

  async removeAlertFromProject(
    instanceName: string,
    targetName: string,
    uid: string,
  ): Promise<{ entry: AlertManifestRuleEntry; removedPaths: string[]; removedContactPointKeys: string[] }> {
    const manifest = await this.loadAlertsManifest(instanceName, targetName);
    const entry = manifest.rules[uid];
    if (!entry) {
      throw new Error(`Alert is not exported locally: ${uid}`);
    }

    delete manifest.rules[uid];
    manifest.generatedAt = new Date().toISOString();

    const removedPaths: string[] = [];
    const removedContactPointKeys: string[] = [];
    const rulePath = path.join(this.alertsRootPath(instanceName, targetName), normalizeRelativePath(entry.path));
    if (await removeFileIfExists(rulePath)) {
      removedPaths.push(rulePath);
    }

    for (const key of entry.contactPointKeys) {
      const stillUsed = Object.values(manifest.rules).some((rule) => rule.contactPointKeys.includes(key));
      if (stillUsed) {
        continue;
      }

      const contactPoint = manifest.contactPoints[key];
      delete manifest.contactPoints[key];
      removedContactPointKeys.push(key);
      if (!contactPoint) {
        continue;
      }

      const contactPointPath = path.join(
        this.alertsRootPath(instanceName, targetName),
        normalizeRelativePath(contactPoint.path),
      );
      if (await removeFileIfExists(contactPointPath)) {
        removedPaths.push(contactPointPath);
      }
    }

    await this.saveAlertsManifest(instanceName, targetName, manifest);
    return {
      entry,
      removedPaths,
      removedContactPointKeys,
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
