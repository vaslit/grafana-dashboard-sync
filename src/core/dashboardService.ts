import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { buildManifestEntriesFromRemoteDashboards } from "./dashboardCatalog";
import {
  applyDatasourceMappingsToDashboard,
  autoMatchDatasourceCatalogInstance,
  findMissingDatasourceMappings,
  mergePulledDatasourceCatalog,
  normalizeDashboardDatasourceRefs,
  renameDatasourceSourceNames,
  ensureDatasourceCatalogInstances,
  normalizeDashboardDatasourceRefsFromCatalog,
} from "./datasourceMappings";
import { buildDashboardDatasourceDescriptors, extractDashboardDatasourceRefs } from "./datasourceRefs";
import { stableJsonStringify } from "./json";
import { selectorNameForEntry } from "./manifest";
import {
  applyOverridesToDashboard,
  extractSupportedVariables,
  generateOverrideFileFromDashboard,
  normalizeOverrideValue,
  normalizeCurrentForStorage,
  parseOverrideInput,
  serializeOverrideValue,
} from "./overrides";
import { DEFAULT_DEPLOYMENT_TARGET, ProjectRepository } from "./repository";
import {
  BackupRecord,
  DashboardManifestEntry,
  DashboardOverrideFile,
  DashboardOverrideValue,
  DashboardRevisionListItem,
  DashboardRevisionRecord,
  DashboardRevisionSnapshot,
  DashboardVersionIndex,
  DatasourceCatalogFile,
  DeploymentTargetRecord,
  DeploySummary,
  RenderManifest,
  RenderManifestDashboardRecord,
  RenderScope,
  GrafanaApi,
  GrafanaDashboardSummary,
  GrafanaDatasourceSummary,
  GrafanaFolder,
  LiveTargetVersionStatus,
  LogSink,
  OverrideEditorVariableModel,
  OverrideGenerationResult,
  PullDashboardResult,
  PullFileResult,
  PullSummary,
  TargetBackupDashboardRecord,
  TargetBackupScope,
} from "./types";
import { GrafanaClient } from "./grafanaClient";

interface PlacementDetails {
  baseFolderPath?: string;
  overrideFolderPath?: string;
  effectiveFolderPath?: string;
  baseDashboardUid: string;
  overrideDashboardUid?: string;
  effectiveDashboardUid?: string;
}

interface DashboardComparableSnapshot {
  dashboard: Record<string, unknown>;
  folderPath?: string;
}

function sanitizeDashboardForStorage(dashboard: Record<string, unknown>): Record<string, unknown> {
  const nextDashboard = structuredClone(dashboard);
  delete nextDashboard.id;
  delete nextDashboard.version;
  delete nextDashboard.iteration;
  return nextDashboard;
}

function normalizeFolderPath(pathValue: string | undefined): string | undefined {
  const normalized = (pathValue ?? "")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
  return normalized || undefined;
}

function isDefaultTarget(targetName: string): boolean {
  return targetName === DEFAULT_DEPLOYMENT_TARGET;
}

function buildFolderPathByUid(folderUid: string, folders: GrafanaFolder[]): string | undefined {
  const folderMap = new Map(folders.map((folder) => [folder.uid, folder]));
  const segments: string[] = [];
  let currentUid: string | undefined = folderUid;
  const visited = new Set<string>();

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

function folderPathFromChain(chain: GrafanaFolder[]): string | undefined {
  if (chain.length === 0) {
    return undefined;
  }
  return chain.map((folder) => folder.title).join("/");
}

function backupScopeForEntries(entries: DashboardManifestEntry[]): TargetBackupScope {
  return entries.length === 1 ? "dashboard" : "target";
}

function renderScopeForEntries(entries: DashboardManifestEntry[]): RenderScope {
  return entries.length === 1 ? "dashboard" : "target";
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(stableJsonStringify(value)).digest("hex");
}

function revisionId(now = new Date(), hash = randomUUID().replace(/-/g, "")): string {
  return `${ProjectRepository.timestamp(now)}__${hash.slice(0, 8)}`;
}

async function collectFolderPaths(
  client: GrafanaApi,
  parentUid?: string,
  parentPath?: string,
): Promise<string[]> {
  const folders = await client.listFolders(parentUid);
  const paths: string[] = [];

  for (const folder of folders) {
    const currentPath = parentPath ? `${parentPath}/${folder.title}` : folder.title;
    paths.push(currentPath);
    paths.push(...(await collectFolderPaths(client, folder.uid, currentPath)));
  }

  return paths;
}

export class DashboardService {
  constructor(
    private readonly repository: ProjectRepository,
    private readonly log: LogSink,
    private readonly clientFactory: (instanceName?: string) => Promise<GrafanaApi> = async (instanceName?: string) =>
      new GrafanaClient(await repository.loadConnectionConfig(instanceName)),
  ) {}

  async listRemoteDashboards(instanceName?: string): Promise<GrafanaDashboardSummary[]> {
    const client = await this.clientFactory(instanceName);
    return client.listDashboards();
  }

  async listRemoteDatasources(instanceName?: string): Promise<GrafanaDatasourceSummary[]> {
    const client = await this.clientFactory(instanceName);
    return client.listDatasources();
  }

  async listRemoteFolderPaths(instanceName?: string): Promise<string[]> {
    const client = await this.clientFactory(instanceName);
    const folderPaths = await collectFolderPaths(client);
    return [...new Set(folderPaths)].sort((left, right) => left.localeCompare(right));
  }

  async createDeploymentTarget(instanceName: string, targetName: string): Promise<DeploymentTargetRecord> {
    const target = await this.repository.createDeploymentTarget(instanceName, targetName);
    await this.materializeManagedOverridesForTarget(target.instanceName, target.name);
    return target;
  }

  private async managedVariableNames(entry: DashboardManifestEntry): Promise<Set<string>> {
    const overrides = await this.repository.readDashboardOverrides(entry);
    const targets = overrides?.dashboards[entry.uid]?.targets ?? {};
    const managed = new Set<string>();
    for (const override of Object.values(targets)) {
      for (const variableName of Object.keys(override.variables ?? {})) {
        managed.add(variableName);
      }
    }
    return managed;
  }

  private normalizeDashboardForVersionComparison(
    dashboard: Record<string, unknown>,
    managedVariableNames: ReadonlySet<string>,
    baseUid: string,
  ): Record<string, unknown> {
    const nextDashboard = structuredClone(dashboard);
    nextDashboard.uid = baseUid;
    if (managedVariableNames.size === 0) {
      return nextDashboard;
    }

    const templating = nextDashboard.templating;
    if (!templating || typeof templating !== "object" || Array.isArray(templating)) {
      return nextDashboard;
    }
    const list = Array.isArray((templating as { list?: unknown }).list) ? (templating as { list: unknown[] }).list : [];
    (templating as { list: unknown[] }).list = list.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return item;
      }
      const variable = item as Record<string, unknown>;
      const name = typeof variable.name === "string" ? variable.name : undefined;
      const type = typeof variable.type === "string" ? variable.type : undefined;
      if (!name || !type || !managedVariableNames.has(name)) {
        return variable;
      }

      const nextVariable: Record<string, unknown> = {
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

  private revisionHashes(
    entry: DashboardManifestEntry,
    snapshot: DashboardRevisionSnapshot,
    managedVariableNames: ReadonlySet<string>,
  ): { contentHash: string; templateHash: string } {
    const contentHash = hashValue({
      dashboard: snapshot.dashboard,
      ...(snapshot.folderPath ? { folderPath: snapshot.folderPath } : {}),
    });
    const templateHash = hashValue(
      this.normalizeDashboardForVersionComparison(snapshot.dashboard, managedVariableNames, entry.uid),
    );
    return { contentHash, templateHash };
  }

  private async repositoryRevisionSnapshot(
    sourceRepository: ProjectRepository,
    entry: DashboardManifestEntry,
  ): Promise<DashboardRevisionSnapshot> {
    const dashboard = await sourceRepository.readDashboardJson(entry);
    const folderMeta = await sourceRepository.readFolderMetadata(entry);
    return {
      version: 1,
      dashboard,
      ...(normalizeFolderPath(folderMeta?.path) ? { folderPath: normalizeFolderPath(folderMeta?.path) } : {}),
    };
  }

  private async ensureDashboardVersionIndex(entry: DashboardManifestEntry): Promise<DashboardVersionIndex> {
    const existing = await this.repository.readDashboardVersionIndex(entry);
    if (existing?.revisions.length) {
      return existing;
    }

    const snapshot = await this.repositoryRevisionSnapshot(this.repository, entry);
    const managedVariableNames = await this.managedVariableNames(entry);
    const { contentHash, templateHash } = this.revisionHashes(entry, snapshot, managedVariableNames);
    const id = revisionId(new Date(), contentHash);
    await this.repository.saveDashboardRevisionSnapshot(entry, id, snapshot);
    const index: DashboardVersionIndex = {
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

  private async findRevisionByHash(
    entry: DashboardManifestEntry,
    hash: string,
    field: "contentHash" | "templateHash" = "contentHash",
  ): Promise<DashboardRevisionRecord | undefined> {
    const index = await this.ensureDashboardVersionIndex(entry);
    return index.revisions.find((revision) => revision[field] === hash);
  }

  private async createOrReuseRevision(
    entry: DashboardManifestEntry,
    snapshot: DashboardRevisionSnapshot,
    source: DashboardRevisionRecord["source"],
    options?: { checkout?: boolean },
  ): Promise<DashboardRevisionRecord> {
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
    const record: DashboardRevisionRecord = {
      id,
      createdAt: new Date().toISOString(),
      contentHash,
      templateHash,
      snapshotPath: this.repository.dashboardRevisionSnapshotPath(entry, id),
      ...(snapshot.folderPath ? { baseFolderPath: snapshot.folderPath } : {}),
      source,
    };
    const nextIndex: DashboardVersionIndex = {
      checkedOutRevisionId: options?.checkout ? id : index.checkedOutRevisionId,
      revisions: [record, ...index.revisions],
    };
    await this.repository.saveDashboardVersionIndex(entry, nextIndex);
    return record;
  }

  private async checkoutRevisionSnapshot(
    entry: DashboardManifestEntry,
    revision: DashboardRevisionRecord,
    snapshot: DashboardRevisionSnapshot,
    options?: { folderUid?: string },
  ): Promise<void> {
    await this.repository.saveDashboardJson(entry, snapshot.dashboard);
    const existingFolderMeta = await this.repository.readFolderMetadata(entry);
    const normalizedPath = normalizeFolderPath(snapshot.folderPath);
    const preservedUid = normalizedPath && existingFolderMeta?.path === normalizedPath ? existingFolderMeta.uid : undefined;
    const nextFolderUid = options?.folderUid ?? preservedUid;
    if (!normalizedPath && !nextFolderUid) {
      await this.repository.deleteFolderMetadata(entry);
    } else {
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

  async listDashboardRevisions(entry: DashboardManifestEntry): Promise<DashboardRevisionListItem[]> {
    const index = await this.ensureDashboardVersionIndex(entry);
    return index.revisions.map((record) => ({
      record,
      isCheckedOut: index.checkedOutRevisionId === record.id,
    }));
  }

  async checkoutRevision(entry: DashboardManifestEntry, revisionIdValue: string): Promise<DashboardRevisionRecord> {
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

  async createRevisionFromWorkingCopy(entry: DashboardManifestEntry): Promise<DashboardRevisionRecord> {
    const snapshot = await this.repositoryRevisionSnapshot(this.repository, entry);
    return this.createOrReuseRevision(entry, snapshot, { kind: "manual" }, { checkout: true });
  }

  private async ensureWorkingCopyCheckedOutRevision(
    entry: DashboardManifestEntry,
    source: DashboardRevisionRecord["source"],
  ): Promise<DashboardRevisionRecord> {
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

  async currentCheckedOutRevision(entry: DashboardManifestEntry): Promise<DashboardRevisionRecord | undefined> {
    const index = await this.ensureDashboardVersionIndex(entry);
    return index.revisions.find((revision) => revision.id === index.checkedOutRevisionId);
  }

  private async liveTargetComparableSnapshot(
    entry: DashboardManifestEntry,
    instanceName: string,
    targetName: string,
  ): Promise<{ snapshot: DashboardComparableSnapshot; effectiveDashboardUid?: string }> {
    const client = await this.clientFactory(instanceName);
    const overrideFile = await this.materializeDashboardUidForTarget(this.repository, instanceName, targetName, entry);
    const effectiveDashboardUid = this.effectiveDashboardUidForTarget(entry, targetName, overrideFile);
    if (!effectiveDashboardUid) {
      throw new Error(`Dashboard UID is not materialized for ${selectorNameForEntry(entry)} on ${instanceName}/${targetName}.`);
    }

    const response = await client.getDashboardByUid(effectiveDashboardUid);
    const catalog = await this.repository.readDatasourceCatalog();
    const normalizedDashboard = normalizeDashboardDatasourceRefsFromCatalog(
      {
        ...sanitizeDashboardForStorage(response.dashboard),
        uid: entry.uid,
      },
      catalog,
      instanceName,
    );
    return {
      snapshot: {
        dashboard: normalizedDashboard,
      },
      effectiveDashboardUid,
    };
  }

  async listLiveTargetVersionStatuses(entry: DashboardManifestEntry): Promise<LiveTargetVersionStatus[]> {
    const index = await this.ensureDashboardVersionIndex(entry);
    const managedVariableNames = await this.managedVariableNames(entry);
    const targets = await this.repository.listAllDeploymentTargets();
    const statuses = await Promise.all(
      targets.map(async (target) => {
        try {
          const { snapshot, effectiveDashboardUid } = await this.liveTargetComparableSnapshot(
            entry,
            target.instanceName,
            target.name,
          );
          const templateHash = hashValue(
            this.normalizeDashboardForVersionComparison(snapshot.dashboard, managedVariableNames, entry.uid),
          );
          const matched = index.revisions.find((revision) => revision.templateHash === templateHash);
          return {
            instanceName: target.instanceName,
            targetName: target.name,
            effectiveDashboardUid,
            matchedRevisionId: matched?.id,
            state: matched ? "matched" : "unversioned",
          } as LiveTargetVersionStatus;
        } catch (error) {
          return {
            instanceName: target.instanceName,
            targetName: target.name,
            state: "error",
            detail: String(error),
          } as LiveTargetVersionStatus;
        }
      }),
    );
    return statuses.sort((left, right) => {
      const instanceOrder = left.instanceName.localeCompare(right.instanceName);
      return instanceOrder !== 0 ? instanceOrder : left.targetName.localeCompare(right.targetName);
    });
  }

  private async rawTargetBackupItems(
    entries: DashboardManifestEntry[],
    instanceName: string,
    targetName: string,
  ): Promise<Array<TargetBackupDashboardRecord & { dashboard: Record<string, unknown> }>> {
    const client = await this.clientFactory(instanceName);
    const folders = await client.listFolders();
    const items: Array<TargetBackupDashboardRecord & { dashboard: Record<string, unknown> }> = [];

    for (const entry of entries) {
      const overrideFile = await this.materializeDashboardUidForTarget(this.repository, instanceName, targetName, entry);
      const effectiveDashboardUid = this.effectiveDashboardUidForTarget(entry, targetName, overrideFile);
      if (!effectiveDashboardUid) {
        throw new Error(`Dashboard UID is not materialized for ${selectorNameForEntry(entry)} on ${instanceName}/${targetName}.`);
      }

      const response = await client.getDashboardByUid(effectiveDashboardUid);
      const folderPath = response.meta.folderUid
        ? buildFolderPathByUid(response.meta.folderUid, folders) || normalizeFolderPath(response.meta.folderTitle)
        : undefined;
      items.push({
        selectorName: selectorNameForEntry(entry),
        baseUid: entry.uid,
        effectiveDashboardUid,
        path: entry.path,
        ...(normalizeFolderPath(folderPath) ? { folderPath: normalizeFolderPath(folderPath) } : {}),
        title:
          typeof response.dashboard.title === "string" && response.dashboard.title.trim()
            ? response.dashboard.title.trim()
            : selectorNameForEntry(entry),
        snapshotPath: "",
        dashboard: sanitizeDashboardForStorage(response.dashboard),
      });
    }

    return items;
  }

  async createTargetBackup(
    entries: DashboardManifestEntry[],
    instanceName: string,
    targetName: string,
    scope: TargetBackupScope = backupScopeForEntries(entries),
  ): Promise<BackupRecord> {
    const items = await this.rawTargetBackupItems(entries, instanceName, targetName);
    const backup = await this.repository.createTargetBackupSnapshot(instanceName, targetName, scope, items);
    this.log.info(`Created ${scope} backup ${backup.name} for ${instanceName}/${targetName}`);
    return backup;
  }

  private async desiredFolderPathForSnapshot(
    sourceRepository: ProjectRepository,
    entry: DashboardManifestEntry,
    instanceName: string,
    targetName: string,
    snapshotFolderPath?: string,
  ): Promise<string | undefined> {
    const overrideFile = await sourceRepository.readTargetOverrideFile(instanceName, targetName, entry);
    const relativeFolder = path.dirname(entry.path).replace(/\\/g, "/");
    return (
      normalizeFolderPath(overrideFile?.folderPath) ??
      normalizeFolderPath(snapshotFolderPath) ??
      (relativeFolder && relativeFolder !== "_root" ? normalizeFolderPath(path.basename(relativeFolder)) : undefined)
    );
  }

  async renderDashboards(
    entries: DashboardManifestEntry[],
    instanceName: string,
    targetName: string,
    scope: RenderScope = renderScopeForEntries(entries),
  ): Promise<RenderManifest> {
    return this.renderDashboardSnapshots(
      await Promise.all(
        entries.map(async (entry) => ({
          entry,
          snapshot: await this.repositoryRevisionSnapshot(this.repository, entry),
          revisionId: (await this.currentCheckedOutRevision(entry))?.id,
        })),
      ),
      instanceName,
      targetName,
      scope,
      {
        sourceRepository: this.repository,
      },
    );
  }

  async renderRevision(
    entry: DashboardManifestEntry,
    revisionIdValue: string,
    instanceName: string,
    targetName: string,
  ): Promise<RenderManifest> {
    const snapshot = await this.repository.readDashboardRevisionSnapshot(entry, revisionIdValue);
    if (!snapshot) {
      throw new Error(`Revision snapshot not found: ${revisionIdValue}`);
    }
    return this.renderDashboardSnapshots(
      [
        {
          entry,
          snapshot,
          revisionId: revisionIdValue,
        },
      ],
      instanceName,
      targetName,
      "dashboard",
      {
        sourceRepository: this.repository,
      },
    );
  }

  async openRenderFolder(instanceName: string, targetName: string): Promise<string> {
    await this.repository.ensureProjectLayout();
    return this.repository.renderRootPath(instanceName, targetName);
  }

  private async ensureExplicitFolderPath(
    client: GrafanaApi,
    folderCache: GrafanaFolder[],
    folderPath?: string,
    finalUid?: string,
  ): Promise<string | undefined> {
    const desiredPath = normalizeFolderPath(folderPath);
    if (!desiredPath) {
      return undefined;
    }

    const segments = desiredPath.split("/").filter(Boolean);
    let parentUid: string | undefined;
    let currentFolder: GrafanaFolder | undefined;

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

  async restoreTargetBackup(backup: BackupRecord): Promise<DeploySummary> {
    const client = await this.clientFactory(backup.instanceName);
    const connection = await this.repository.loadConnectionConfig(backup.instanceName);
    const folderCache = await client.listFolders();
    const dashboardResults: DeploySummary["dashboardResults"] = [];

    for (const dashboard of backup.dashboards) {
      const rawDashboard = await this.repository.readBackupDashboardSnapshot(backup, dashboard);
      const folderUid = await this.ensureExplicitFolderPath(client, folderCache, dashboard.folderPath);
      const response = await client.upsertDashboard({
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
        targetBaseUrl: connection.baseUrl,
        deploymentTargetName: backup.targetName,
      });
    }

    return {
      instanceName: backup.instanceName,
      deploymentTargetName: backup.targetName,
      dashboardResults,
    };
  }

  async pullDashboardRevisionFromTarget(
    entry: DashboardManifestEntry,
    instanceName: string,
    targetName: string,
  ): Promise<DashboardRevisionRecord> {
    const client = await this.clientFactory(instanceName);
    const folders = await client.listFolders();
    const overrideFile = await this.materializeDashboardUidForTarget(this.repository, instanceName, targetName, entry);
    const effectiveDashboardUid = this.effectiveDashboardUidForTarget(entry, targetName, overrideFile);
    if (!effectiveDashboardUid) {
      throw new Error(`Dashboard UID is not materialized for ${selectorNameForEntry(entry)} on ${instanceName}/${targetName}.`);
    }

    const response = await client.getDashboardByUid(effectiveDashboardUid);
    const normalizedDashboard = normalizeDashboardDatasourceRefsFromCatalog(
      {
        ...sanitizeDashboardForStorage(response.dashboard),
        uid: entry.uid,
      },
      await this.repository.readDatasourceCatalog(),
      instanceName,
    );
    const folderPath =
      response.meta.folderUid ? buildFolderPathByUid(response.meta.folderUid, folders) : undefined;
    const snapshot: DashboardRevisionSnapshot = {
      version: 1,
      dashboard: normalizedDashboard,
      ...(normalizeFolderPath(folderPath) ? { folderPath: normalizeFolderPath(folderPath) } : {}),
    };
    const revision = await this.createOrReuseRevision(
      entry,
      snapshot,
      {
        kind: "pull",
        instanceName,
        targetName,
        effectiveDashboardUid,
      },
      { checkout: true },
    );
    await this.checkoutRevisionSnapshot(entry, revision, snapshot, {
      folderUid: response.meta.folderUid,
    });
    return revision;
  }

  async deployRevision(
    entry: DashboardManifestEntry,
    revisionIdValue: string,
    instanceName: string,
    targetName: string,
  ): Promise<DeploySummary> {
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
    const renderManifest = await this.renderDashboardSnapshots(
      [{ entry, snapshot, revisionId: revision.id }],
      instanceName,
      targetName,
      "dashboard",
      { sourceRepository: this.repository },
    );
    await this.createTargetBackup([entry], instanceName, targetName, "dashboard");
    return this.deployRenderedManifest(renderManifest, instanceName, targetName, client, connection.baseUrl, folderCache);
  }

  private effectiveDashboardUidForTarget(
    entry: DashboardManifestEntry,
    targetName: string,
    overrideFile: DashboardOverrideFile | undefined,
  ): string | undefined {
    if (isDefaultTarget(targetName)) {
      return entry.uid;
    }

    const dashboardUid = overrideFile?.dashboardUid?.trim();
    return dashboardUid || undefined;
  }

  private async materializeDashboardUidForTarget(
    sourceRepository: ProjectRepository,
    instanceName: string,
    targetName: string,
    entry: DashboardManifestEntry,
  ): Promise<DashboardOverrideFile | undefined> {
    const existingOverride = await sourceRepository.readTargetOverrideFile(instanceName, targetName, entry);
    if (isDefaultTarget(targetName)) {
      return existingOverride;
    }

    const existingDashboardUid = existingOverride?.dashboardUid?.trim();
    if (existingDashboardUid) {
      return existingOverride;
    }

    const nextOverride: DashboardOverrideFile = {
      dashboardUid: randomUUID(),
      ...(existingOverride?.folderPath ? { folderPath: existingOverride.folderPath } : {}),
      variables: existingOverride?.variables ?? {},
    };
    await sourceRepository.saveTargetOverrideFile(instanceName, targetName, entry, nextOverride);
    return nextOverride;
  }

  private async materializeDashboardUidsForInstance(
    sourceRepository: ProjectRepository,
    instanceName: string,
  ): Promise<void> {
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

  private async validateInstanceEffectiveDashboardUids(
    sourceRepository: ProjectRepository,
    instanceName: string,
  ): Promise<void> {
    const targets = await sourceRepository.listDeploymentTargets(instanceName);
    const records = await sourceRepository.listDashboardRecords();
    const seen = new Map<string, string>();

    for (const target of targets) {
      for (const record of records) {
        const overrideFile = await sourceRepository.readTargetOverrideFile(target.instanceName, target.name, record.entry);
        const effectiveDashboardUid = this.effectiveDashboardUidForTarget(record.entry, target.name, overrideFile);
        if (!effectiveDashboardUid) {
          throw new Error(
            `Dashboard UID is not materialized for ${selectorNameForEntry(record.entry)} on ${target.instanceName}/${target.name}.`,
          );
        }

        const location = `${selectorNameForEntry(record.entry)} on ${target.instanceName}/${target.name}`;
        const previous = seen.get(effectiveDashboardUid);
        if (previous) {
          throw new Error(
            `Duplicate effective dashboard UID "${effectiveDashboardUid}" for ${previous} and ${location}.`,
          );
        }

        seen.set(effectiveDashboardUid, location);
      }
    }
  }

  async listFolderChildren(instanceName: string, parentUid?: string): Promise<GrafanaFolder[]> {
    const client = await this.clientFactory(instanceName);
    const folders = await client.listFolders(parentUid);
    return [...folders].sort((left, right) => left.title.localeCompare(right.title));
  }

  async createFolderInParent(instanceName: string, parentUid: string | undefined, title: string): Promise<GrafanaFolder> {
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

  async resolveFolderPathChain(instanceName: string, folderPath?: string): Promise<GrafanaFolder[]> {
    const normalized = normalizeFolderPath(folderPath);
    if (!normalized) {
      return [];
    }

    const segments = normalized.split("/");
    const chain: GrafanaFolder[] = [];
    let parentUid: string | undefined;

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

  async ensureDatasourceCatalogInstance(instanceName: string): Promise<boolean> {
    const catalog = await this.repository.readDatasourceCatalog();
    const instances = await this.repository.listInstances();
    const nextCatalog = ensureDatasourceCatalogInstances(
      catalog,
      [...new Set([...instances.map((instance) => instance.name), instanceName])],
    );

    if (stableJsonStringify(nextCatalog) === stableJsonStringify(catalog)) {
      return false;
    }

    await this.repository.saveDatasourceCatalog(nextCatalog);
    return true;
  }

  async autoMatchDatasourceCatalogForInstance(instanceName: string): Promise<boolean> {
    const targetDatasources = await this.listRemoteDatasources(instanceName);
    const catalog = await this.repository.readDatasourceCatalog();
    const nextCatalog = autoMatchDatasourceCatalogInstance(catalog, instanceName, targetDatasources);
    if (stableJsonStringify(nextCatalog) === stableJsonStringify(catalog)) {
      return false;
    }

    await this.repository.saveDatasourceCatalog(nextCatalog);
    return true;
  }

  async suggestManifestEntriesForRemoteDashboards(
    dashboards: GrafanaDashboardSummary[],
  ): Promise<DashboardManifestEntry[]> {
    const manifest = await this.repository.loadManifest();
    return buildManifestEntriesFromRemoteDashboards(dashboards, manifest.dashboards);
  }

  async pullDashboards(
    entries: DashboardManifestEntry[],
    instanceName?: string,
    targetName = DEFAULT_DEPLOYMENT_TARGET,
  ): Promise<PullSummary> {
    if (!instanceName) {
      throw new Error("Choose a concrete Grafana instance and deployment target for pull.");
    }

    const client = await this.clientFactory(instanceName);
    const folders = await client.listFolders();
    const datasources = instanceName ? await client.listDatasources().catch(() => []) : [];
    const instances = await this.repository.listInstances();
    const instanceNames = [...new Set([...instances.map((instance) => instance.name), ...(instanceName ? [instanceName] : [])])];
    const datasourcesByInstance = new Map<string, GrafanaDatasourceSummary[]>();
    if (instanceName) {
      datasourcesByInstance.set(instanceName, datasources);
      for (const instance of instances) {
        if (instance.name === instanceName) {
          continue;
        }
        datasourcesByInstance.set(instance.name, await this.listRemoteDatasources(instance.name).catch(() => []));
      }
    }
    let datasourceCatalog = ensureDatasourceCatalogInstances(await this.repository.readDatasourceCatalog(), instanceNames);
    let datasourceCatalogChanged = false;
    let updatedCount = 0;
    let skippedCount = 0;
    const dashboardResults: PullDashboardResult[] = [];

    for (const entry of entries) {
      if (await this.repository.dashboardExists(entry)) {
        await this.ensureDashboardVersionIndex(entry);
      }
      const selectorName = selectorNameForEntry(entry);
      this.log.info(`Pulling ${selectorName} from ${instanceName}/${targetName}`);
      const overrideFile = await this.materializeDashboardUidForTarget(this.repository, instanceName, targetName, entry);
      const effectiveDashboardUid = this.effectiveDashboardUidForTarget(entry, targetName, overrideFile);
      if (!effectiveDashboardUid) {
        throw new Error(`Dashboard UID is not materialized for ${selectorName} on ${instanceName}/${targetName}.`);
      }

      const response = await client.getDashboardByUid(effectiveDashboardUid);
      const pulledDashboard = sanitizeDashboardForStorage(response.dashboard);
      if (isDefaultTarget(targetName) && pulledDashboard.uid !== entry.uid) {
        throw new Error(
          `Pulled dashboard UID mismatch for ${selectorName} on ${instanceName}/${targetName}: expected ${entry.uid}, got ${String(pulledDashboard.uid ?? "")}.`,
        );
      }

      const datasourceDescriptors = buildDashboardDatasourceDescriptors(pulledDashboard, datasources);
      const nextCatalogState = mergePulledDatasourceCatalog(
        datasourceCatalog,
        instanceName,
        datasourceDescriptors,
        instanceNames,
        datasourcesByInstance,
      );
      if (stableJsonStringify(nextCatalogState.catalog) !== stableJsonStringify(datasourceCatalog)) {
        datasourceCatalog = nextCatalogState.catalog;
        datasourceCatalogChanged = true;
      }
      const dashboard = {
        ...normalizeDashboardDatasourceRefs(pulledDashboard, nextCatalogState.sourceNamesByUid),
        uid: entry.uid,
      };

      const fileResults: PullFileResult[] = [];

      const dashboardOutcome = await this.repository.syncPulledFile({
        sourceContent: stableJsonStringify(dashboard),
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
      } else {
        skippedCount += 1;
      }

      const folderMetaPath = this.repository.folderMetaPathForEntry(entry);
      if (folderMetaPath && response.meta.folderUid) {
        const existingFolderMeta = await this.repository.readFolderMetadata(entry);
        const preserveFolderPath = await this.repository.hasAnyFolderPathOverride(entry);
        const pulledFolderPath =
          buildFolderPathByUid(response.meta.folderUid, folders) ||
          normalizeFolderPath(
            response.meta.folderTitle ||
              folders.find((folder) => folder.uid === response.meta.folderUid)?.title ||
              path.basename(path.dirname(entry.path)),
          );
        const folderPath =
          preserveFolderPath && existingFolderMeta?.path
            ? normalizeFolderPath(existingFolderMeta.path)
            : pulledFolderPath;
        const snapshot: DashboardRevisionSnapshot = {
          version: 1,
          dashboard,
          ...(folderPath ? { folderPath } : {}),
        };
        await this.createOrReuseRevision(
          entry,
          snapshot,
          {
            kind: "pull",
            instanceName,
            targetName,
            effectiveDashboardUid,
          },
          { checkout: true },
        );

        const folderMetaOutcome = await this.repository.syncPulledFile({
          sourceContent: stableJsonStringify({
            ...(folderPath ? { path: folderPath } : {}),
            uid: response.meta.folderUid,
          }),
          targetPath: folderMetaPath,
        });

        fileResults.push({
          kind: "folderMeta",
          relativePath: path.posix.join(path.dirname(entry.path).replace(/\\/g, "/"), ".folder.json"),
          status: folderMetaOutcome.status,
          targetPath: folderMetaPath,
        });

        if (folderMetaOutcome.status === "updated") {
          updatedCount += 1;
        } else {
          skippedCount += 1;
        }
      }
      else {
        await this.createOrReuseRevision(
          entry,
          {
            version: 1,
            dashboard,
          },
          {
            kind: "pull",
            instanceName,
            targetName,
            effectiveDashboardUid,
          },
          { checkout: true },
        );
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

  async deployDashboards(
    entries: DashboardManifestEntry[],
    instanceName?: string,
    targetName = DEFAULT_DEPLOYMENT_TARGET,
  ): Promise<DeploySummary> {
    return this.deployDashboardsFromRepository(this.repository, entries, instanceName, targetName);
  }

  private async deployDashboardsFromRepository(
    sourceRepository: ProjectRepository,
    entries: DashboardManifestEntry[],
    instanceName?: string,
    targetName = DEFAULT_DEPLOYMENT_TARGET,
  ): Promise<DeploySummary> {
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
    const renderManifest = await this.renderDashboardSnapshots(
      await Promise.all(
        entries.map(async (entry) => ({
          entry,
          snapshot: await this.repositoryRevisionSnapshot(sourceRepository, entry),
          revisionId:
            sourceRepository === this.repository ? (await this.currentCheckedOutRevision(entry))?.id : undefined,
        })),
      ),
      instanceName,
      targetName,
      renderScopeForEntries(entries),
      {
        sourceRepository,
      },
    );
    await this.createTargetBackup(entries, instanceName, targetName, backupScopeForEntries(entries));
    return this.deployRenderedManifest(renderManifest, instanceName, targetName, client, connection.baseUrl, folderCache);
  }

  private async renderDashboardSnapshots(
    items: Array<{ entry: DashboardManifestEntry; snapshot: DashboardRevisionSnapshot; revisionId?: string }>,
    instanceName: string,
    targetName: string,
    scope: RenderScope,
    injected?: {
      sourceRepository?: ProjectRepository;
    },
  ): Promise<RenderManifest> {
    const sourceRepository = injected?.sourceRepository ?? this.repository;
    await this.repository.clearRenderRoot(instanceName, targetName);
    const dashboards: RenderManifestDashboardRecord[] = [];

    for (const { entry, snapshot, revisionId } of items) {
      const renderedDashboard = await this.renderDashboardForTarget(
        sourceRepository,
        entry,
        snapshot.dashboard,
        instanceName,
        targetName,
      );
      const folderPath = await this.desiredFolderPathForSnapshot(
        sourceRepository,
        entry,
        instanceName,
        targetName,
        snapshot.folderPath,
      );
      const renderPath = this.repository.renderDashboardPath(instanceName, targetName, entry);
      await this.repository.writeJsonFile(renderPath, sanitizeDashboardForStorage(renderedDashboard));
      dashboards.push({
        selectorName: selectorNameForEntry(entry),
        baseUid: entry.uid,
        effectiveDashboardUid: typeof renderedDashboard.uid === "string" ? renderedDashboard.uid : entry.uid,
        path: entry.path,
        ...(folderPath ? { folderPath } : {}),
        title: typeof renderedDashboard.title === "string" ? renderedDashboard.title : selectorNameForEntry(entry),
        renderPath: path.relative(this.repository.renderRootPath(instanceName, targetName), renderPath).replace(/\\/g, "/"),
        ...(revisionId ? { revisionId } : {}),
      });
    }

    const manifest: RenderManifest = {
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

  private async deployRenderedManifest(
    manifest: RenderManifest,
    instanceName: string,
    targetName: string,
    client: GrafanaApi,
    connectionBaseUrl: string,
    folderCache: GrafanaFolder[],
  ): Promise<DeploySummary> {
    const dashboardResults: DeploySummary["dashboardResults"] = [];
    for (const rendered of manifest.dashboards) {
      const entry: DashboardManifestEntry = {
        name: rendered.selectorName,
        uid: rendered.baseUid,
        path: rendered.path,
      };
      const renderedDashboard = await this.repository.readJsonFile<Record<string, unknown>>(
        path.join(this.repository.renderRootPath(instanceName, targetName), rendered.renderPath),
      );
      const folderMeta = await this.repository.readFolderMetadata(entry);
      const finalFolderUid =
        folderMeta?.uid && normalizeFolderPath(folderMeta.path) === normalizeFolderPath(rendered.folderPath)
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

  async generateOverride(
    instanceName: string,
    targetName: string,
    entry: DashboardManifestEntry,
  ): Promise<OverrideGenerationResult> {
    const dashboard = await this.repository.readDashboardJson(entry);
    const overrideFile = generateOverrideFileFromDashboard(dashboard);
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

  async buildOverrideEditorVariables(
    instanceName: string,
    targetName: string,
    entry: DashboardManifestEntry,
  ): Promise<OverrideEditorVariableModel[]> {
    const dashboard = await this.repository.readDashboardJson(entry);
    const defaultsFile = await this.repository.readTargetDefaultsFile(instanceName, targetName);
    const savedOverride = await this.repository.readTargetOverrideFile(instanceName, targetName, entry);
    const effectiveDashboard = applyOverridesToDashboard(dashboard, defaultsFile, savedOverride);
    const targets = await this.repository.listAllDeploymentTargets();
    const globallyManagedVariableNames = new Set<string>();
    for (const target of targets) {
      const overrideFile = await this.repository.readTargetOverrideFile(target.instanceName, target.name, entry);
      for (const variableName of Object.keys(overrideFile?.variables ?? {})) {
        globallyManagedVariableNames.add(variableName);
      }
    }

    return extractSupportedVariables(effectiveDashboard, savedOverride).map((descriptor) => {
      const hasManagedOverride = descriptor.savedOverride !== undefined || globallyManagedVariableNames.has(descriptor.name);
      return {
      name: descriptor.name,
      type: descriptor.type,
      currentText: String(descriptor.currentText ?? ""),
      currentValue: String(descriptor.currentValue ?? ""),
      savedOverride:
        descriptor.savedOverride !== undefined
          ? serializeOverrideValue(descriptor.savedOverride)
          : hasManagedOverride
            ? serializeOverrideValue(
                normalizeCurrentForStorage({
                  text: descriptor.currentText,
                  value: descriptor.currentValue,
                }),
              )
            : "",
      hasSavedOverride: hasManagedOverride,
      overrideOptions: descriptor.overrideOptions,
      };
    });
  }

  async saveOverrideFromForm(
    instanceName: string,
    targetName: string,
    entry: DashboardManifestEntry,
    values: Record<string, string>,
  ): Promise<string> {
    await this.materializeDashboardUidForTarget(this.repository, instanceName, targetName, entry);
    const dashboard = await this.repository.readDashboardJson(entry);
    const supportedVariables = new Map(
      extractSupportedVariables(dashboard).map((descriptor) => [descriptor.name, descriptor]),
    );
    const targets = await this.repository.listAllDeploymentTargets();
    const existingOverrideFiles = new Map(
      await Promise.all(
        targets.map(
          async (target) =>
            [`${target.instanceName}/${target.name}`, await this.repository.readTargetOverrideFile(target.instanceName, target.name, entry)] as const,
        ),
      ),
    );
    const managedByOtherInstances = new Set<string>();
    for (const target of targets) {
      if (target.instanceName === instanceName && target.name === targetName) {
        continue;
      }
      for (const variableName of Object.keys(existingOverrideFiles.get(`${target.instanceName}/${target.name}`)?.variables ?? {})) {
        managedByOtherInstances.add(variableName);
      }
    }

    const currentVariables: DashboardOverrideFile["variables"] = {};
    const enabledVariableNames = Object.keys(values)
      .filter((key) => key.startsWith("override_enabled__"))
      .map((key) => key.slice("override_enabled__".length));
    const enabledVariableNameSet = new Set(enabledVariableNames);

    for (const name of enabledVariableNames) {
      const rawValue = values[`override_value__${name}`] ?? "";
      const parsed = parseOverrideInput(rawValue);
      if (parsed !== undefined) {
        const descriptor = supportedVariables.get(name);
        if (descriptor?.type === "custom" && (descriptor.overrideOptions?.length ?? 0) > 0) {
          const allowedValues = new Set(descriptor.overrideOptions!.map((option) => option.value));
          const normalizedOverride = normalizeOverrideValue(parsed);
          const selectedValues = Array.isArray(normalizedOverride.value)
            ? normalizedOverride.value
            : [normalizedOverride.value];
          const invalidValues = selectedValues
            .map((value) => serializeOverrideValue(value as DashboardOverrideValue))
            .filter((value) => !allowedValues.has(value));
          if (invalidValues.length > 0) {
            throw new Error(
              `Override value ${invalidValues.map((value) => `"${value}"`).join(", ")} is not available in custom variable "${name}".`,
            );
          }
        }
        currentVariables[name] = parsed;
      }
    }

    const nextManagedVariableNames = new Set<string>([...managedByOtherInstances, ...enabledVariableNameSet]);
    const effectiveVariablesByTarget = new Map<string, Record<string, DashboardOverrideValue>>();

    for (const target of targets) {
      const defaultsFile = await this.repository.readTargetDefaultsFile(target.instanceName, target.name);
      const overrideFile = existingOverrideFiles.get(`${target.instanceName}/${target.name}`);
      const effectiveDashboard = applyOverridesToDashboard(dashboard, defaultsFile, overrideFile);
      const effectiveVariables = Object.fromEntries(
        extractSupportedVariables(effectiveDashboard).map((descriptor) => [
          descriptor.name,
          normalizeCurrentForStorage({
            text: descriptor.currentText,
            value: descriptor.currentValue,
          }),
        ]),
      ) as Record<string, DashboardOverrideValue>;
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
          existingVariables[variableName] = currentVariables[variableName]!;
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

  private async materializeManagedOverridesForTarget(instanceName: string, targetName: string): Promise<void> {
    const records = await this.repository.listDashboardRecords();
    const allTargets = await this.repository.listAllDeploymentTargets();
    const currentTargetKey = `${instanceName}/${targetName}` as `${string}/${string}`;

    for (const record of records) {
      const materializedOverride = await this.materializeDashboardUidForTarget(this.repository, instanceName, targetName, record.entry);
      const dashboard = await this.repository.readDashboardJson(record.entry);
      const supportedVariables = extractSupportedVariables(dashboard);

      const existingOverrideFiles = new Map(
        await Promise.all(
          allTargets.map(
            async (target) =>
              [`${target.instanceName}/${target.name}`, await this.repository.readTargetOverrideFile(target.instanceName, target.name, record.entry)] as const,
          ),
        ),
      );
      existingOverrideFiles.set(currentTargetKey, materializedOverride);

      const managedVariableNames = new Set<string>();
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

      const defaultsFile = await this.repository.readTargetDefaultsFile(instanceName, targetName);
      const existingOverride = existingOverrideFiles.get(currentTargetKey);
      const effectiveDashboard = applyOverridesToDashboard(dashboard, defaultsFile, existingOverride);
      const effectivePlacement = await this.buildPlacementDetails(instanceName, targetName, record.entry);
      const effectiveVariables = Object.fromEntries(
        extractSupportedVariables(effectiveDashboard).map((descriptor) => [
          descriptor.name,
          normalizeCurrentForStorage({
            text: descriptor.currentText,
            value: descriptor.currentValue,
          }),
        ]),
      ) as Record<string, DashboardOverrideValue>;

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

  async buildPlacementDetails(
    instanceName: string,
    targetName: string,
    entry: DashboardManifestEntry,
  ): Promise<PlacementDetails> {
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

  async savePlacement(
    instanceName: string,
    targetName: string,
    entry: DashboardManifestEntry,
    folderPath: string | undefined,
  ): Promise<string> {
    await this.materializeDashboardUidForTarget(this.repository, instanceName, targetName, entry);
    const existingOverride = (await this.repository.readTargetOverrideFile(instanceName, targetName, entry)) ?? { variables: {} };
    const normalizedFolderPath = normalizeFolderPath(folderPath);
    const nextOverride: DashboardOverrideFile = {
      ...(existingOverride.dashboardUid ? { dashboardUid: existingOverride.dashboardUid } : {}),
      ...(normalizedFolderPath ? { folderPath: normalizedFolderPath } : {}),
      variables: existingOverride.variables ?? {},
    };
    await this.repository.saveTargetOverrideFile(instanceName, targetName, entry, nextOverride);
    return this.repository.dashboardOverridesFilePath(entry);
  }

  async saveDatasourceSelections(
    instanceName: string,
    selectorName: string,
    values: Array<{
      currentSourceName: string;
      nextSourceName: string;
      targetUid?: string;
      targetName?: string;
    }>,
  ): Promise<void> {
    const record = await this.repository.dashboardRecordBySelector(selectorName);
    if (!record) {
      throw new Error(`Dashboard selector not found: ${selectorName}`);
    }

    const dashboard = await this.repository.readDashboardJson(record.entry);
    const dashboardSourceNames = new Set(extractDashboardDatasourceRefs(dashboard).map((ref) => ref.sourceUid));
    const instances = await this.repository.listInstances();
    const catalog = ensureDatasourceCatalogInstances(
      await this.repository.readDatasourceCatalog(),
      [...new Set([...instances.map((instance) => instance.name), instanceName])],
    );

    for (const sourceName of dashboardSourceNames) {
      catalog.datasources[sourceName] ??= { instances: {} };
    }

    const renameMap = new Map<string, string>();
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

    const nextDatasourceEntries: DatasourceCatalogFile["datasources"] = {};
    for (const [sourceName, entry] of Object.entries(catalog.datasources)) {
      const nextSourceName = renameMap.get(sourceName) ?? sourceName;
      if (nextDatasourceEntries[nextSourceName]) {
        throw new Error(`Datasource source name already exists: ${nextSourceName}`);
      }
      nextDatasourceEntries[nextSourceName] = structuredClone(entry);
    }

    const renamePairs = Object.fromEntries(
      [...renameMap.entries()].filter(([currentSourceName, nextSourceName]) => currentSourceName !== nextSourceName),
    );
    const nextCatalog: DatasourceCatalogFile = {
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
        const nextDashboard = renameDatasourceSourceNames(currentDashboard, renamePairs);
        if (stableJsonStringify(nextDashboard) === stableJsonStringify(currentDashboard)) {
          continue;
        }
        await this.repository.saveDashboardJson(currentRecord.entry, nextDashboard);
      }
    }

    await this.repository.saveDatasourceCatalog(nextCatalog);
  }

  private async renderDashboardForTarget(
    sourceRepository: ProjectRepository,
    entry: DashboardManifestEntry,
    baseDashboard: Record<string, unknown>,
    instanceName: string,
    targetName: string,
  ): Promise<Record<string, unknown>> {
    const defaultsFile = await sourceRepository.readTargetDefaultsFile(instanceName, targetName);
    const overrideFile = await this.materializeDashboardUidForTarget(sourceRepository, instanceName, targetName, entry);
    const datasourceCatalog = await sourceRepository.readDatasourceCatalog();
    const dashboardWithVariableOverrides = applyOverridesToDashboard(baseDashboard, defaultsFile, overrideFile);
    dashboardWithVariableOverrides.uid = this.effectiveDashboardUidForTarget(entry, targetName, overrideFile);
    const missingMappings = findMissingDatasourceMappings(dashboardWithVariableOverrides, datasourceCatalog, instanceName);
    if (missingMappings.length > 0) {
      throw new Error(
        `Datasource mappings are missing for ${selectorNameForEntry(entry)} on ${instanceName}: ${missingMappings.join(", ")}`,
      );
    }
    return applyDatasourceMappingsToDashboard(dashboardWithVariableOverrides, datasourceCatalog, instanceName);
  }

  private async ensureFolder(
    sourceRepository: ProjectRepository,
    client: GrafanaApi,
    folderCache: GrafanaFolder[],
    entry: DashboardManifestEntry,
    instanceName: string,
    targetName: string,
  ): Promise<string | undefined> {
    const folderMeta = await sourceRepository.readFolderMetadata(entry);
    return this.ensureFolderForSnapshot(
      sourceRepository,
      client,
      folderCache,
      entry,
      instanceName,
      targetName,
      folderMeta?.path,
    );
  }

  private async ensureFolderForSnapshot(
    sourceRepository: ProjectRepository,
    client: GrafanaApi,
    folderCache: GrafanaFolder[],
    entry: DashboardManifestEntry,
    instanceName: string,
    targetName: string,
    snapshotFolderPath?: string,
  ): Promise<string | undefined> {
    const folderMeta = await sourceRepository.readFolderMetadata(entry);
    const overrideFile = await sourceRepository.readTargetOverrideFile(instanceName, targetName, entry);
    const relativeFolder = path.dirname(entry.path).replace(/\\/g, "/");
    const desiredPath =
      normalizeFolderPath(overrideFile?.folderPath) ??
      normalizeFolderPath(snapshotFolderPath) ??
      (relativeFolder && relativeFolder !== "_root" ? normalizeFolderPath(path.basename(relativeFolder)) : undefined);

    if (!desiredPath) {
      return undefined;
    }

    const segments = desiredPath.split("/").filter(Boolean);
    let parentUid: string | undefined;
    let currentFolder: GrafanaFolder | undefined;

    for (const [index, segment] of segments.entries()) {
      let siblings: GrafanaFolder[];
      try {
        siblings = parentUid ? await client.listFolders(parentUid) : folderCache;
      } catch (error) {
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
        } catch (error) {
          if (segments.length > 1) {
            throw new Error(`Could not create nested folder path "${desiredPath}": ${String(error)}`);
          }
          throw error;
        }

        if (!parentUid) {
          folderCache.push(currentFolder);
        }
      } else if (!parentUid && !folderCache.some((folder) => folder.uid === currentFolder?.uid)) {
        folderCache.push(currentFolder);
      }

      parentUid = currentFolder.uid;
    }

    return currentFolder?.uid;
  }
}
