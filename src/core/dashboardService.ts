import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { URL } from "node:url";

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
  AlertDetailsModel,
  AlertDatasourceSelectionModel,
  AlertLinkStatus,
  AlertRuleRecord,
  AlertStorageFileResult,
  AlertSyncStatus,
  AlertUploadContactPointResult,
  AlertsManifest,
  CopyAlertSummary,
  ExportSelectedAlertsSummary,
  BackupDashboardRecord,
  BackupRecord,
  BackupRestoreSelection,
  BackupScope,
  DashboardManifestEntry,
  DashboardOverrideValue,
  DashboardRevisionListItem,
  DashboardRevisionRecord,
  DashboardRevisionSnapshot,
  DashboardTargetRevisionState,
  DashboardTargetState,
  DashboardVersionIndex,
  DatasourceCatalogFile,
  DeploymentTargetRecord,
  DeploySummary,
  GlobalDatasourceUsageRow,
  RenderManifest,
  RenderManifestDashboardRecord,
  RenderScope,
  GrafanaApi,
  GrafanaDashboardSummary,
  GrafanaDatasourceSummary,
  GrafanaFolder,
  GrafanaAlertRuleSummary,
  LiveTargetVersionStatus,
  LogSink,
  OverrideEditorVariableModel,
  OverrideGenerationResult,
  PullDashboardResult,
  PullFileResult,
  PullSummary,
  RestoreSummary,
  TargetDashboardSummaryRow,
  TargetDatasourceBindingRow,
  UploadAlertSummary,
} from "./types";
import { GrafanaClient } from "./grafanaClient";

interface PlacementDetails {
  currentRevisionId?: string;
  baseFolderPath?: string;
  overrideFolderPath?: string;
  effectiveFolderPath?: string;
  baseDashboardUid: string;
  overrideDashboardUid?: string;
  effectiveDashboardUid?: string;
}

interface BackupCaptureTargetSpec {
  instanceName: string;
  targetName: string;
  entries: DashboardManifestEntry[];
}

interface DashboardComparableSnapshot {
  dashboard: Record<string, unknown>;
  folderPath?: string;
}

interface TargetRevisionState {
  targetState: DashboardTargetState;
  revisionState: DashboardTargetRevisionState;
  revision: DashboardRevisionRecord;
  snapshot: DashboardRevisionSnapshot;
}

interface AlertDatasourceRef {
  refId: string;
  datasourceUid: string;
  datasourceName?: string;
  datasourceType?: string;
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

function removeUndefinedKeys(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, candidate]) => candidate !== undefined));
}

function normalizeAlertRuleForStorage(rule: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(rule);
  delete next.id;
  delete next.updated;
  delete next.provenance;
  return next;
}

function normalizeAlertRuleForUpload(rule: Record<string, unknown>): Record<string, unknown> {
  const next = normalizeAlertRuleForStorage(rule);
  return removeUndefinedKeys(next);
}

function normalizeContactPointForStorage(contactPoint: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(contactPoint);
  delete next.provenance;
  delete next.version;
  return next;
}

function normalizeContactPointForUpload(contactPoint: Record<string, unknown>): Record<string, unknown> {
  const next = normalizeContactPointForStorage(contactPoint);
  return removeUndefinedKeys(next);
}

function normalizeContactPointKeySegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^\w-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "item";
}

function contactPointKeyFor(contactPoint: Record<string, unknown>): string {
  const uid = typeof contactPoint.uid === "string" ? contactPoint.uid.trim() : "";
  if (uid) {
    return `uid__${uid}`;
  }
  const name = typeof contactPoint.name === "string" ? contactPoint.name : "contact-point";
  const type = typeof contactPoint.type === "string" ? contactPoint.type : "unknown";
  return `name__${normalizeContactPointKeySegment(name)}__type__${normalizeContactPointKeySegment(type)}`;
}

function alertUid(rule: Record<string, unknown>): string | undefined {
  const value = rule.uid;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function alertTitle(rule: Record<string, unknown>): string {
  return typeof rule.title === "string" && rule.title.trim() ? rule.title.trim() : alertUid(rule) ?? "alert";
}

function alertReceiver(rule: Record<string, unknown>): string | undefined {
  const rawSettings = rule.notification_settings;
  if (!rawSettings || typeof rawSettings !== "object" || Array.isArray(rawSettings)) {
    return undefined;
  }
  const receiver = (rawSettings as { receiver?: unknown }).receiver;
  return typeof receiver === "string" && receiver.trim() ? receiver.trim() : undefined;
}

function alertFolderUid(rule: Record<string, unknown>): string | undefined {
  const raw = rule.folderUID ?? rule.folderUid;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function alertRuleGroup(rule: Record<string, unknown>): string | undefined {
  const raw = rule.ruleGroup;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function alertIsPaused(rule: Record<string, unknown>): boolean {
  return rule.isPaused === true;
}

function extractAlertDatasourceRefs(rule: Record<string, unknown>): AlertDatasourceRef[] {
  const data = Array.isArray(rule.data) ? rule.data : [];
  const refs: AlertDatasourceRef[] = [];

  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }

    const record = item as Record<string, unknown>;
    const datasourceUid =
      typeof record.datasourceUid === "string" && record.datasourceUid.trim()
        ? record.datasourceUid.trim()
        : undefined;
    if (!datasourceUid || datasourceUid === "__expr__") {
      continue;
    }

    const model =
      record.model && typeof record.model === "object" && !Array.isArray(record.model)
        ? (record.model as Record<string, unknown>)
        : undefined;
    const datasource =
      model?.datasource && typeof model.datasource === "object" && !Array.isArray(model.datasource)
        ? (model.datasource as Record<string, unknown>)
        : undefined;
    const refId =
      typeof record.refId === "string" && record.refId.trim()
        ? record.refId.trim()
        : typeof model?.refId === "string" && model.refId.trim()
          ? model.refId.trim()
          : datasourceUid;

    refs.push({
      refId,
      datasourceUid,
      ...(typeof datasource?.name === "string" && datasource.name.trim()
        ? { datasourceName: datasource.name.trim() }
        : {}),
      ...(typeof datasource?.type === "string" && datasource.type.trim()
        ? { datasourceType: datasource.type.trim() }
        : {}),
    });
  }

  return refs;
}

function alertDatasourceSelectionModel(rule: Record<string, unknown>): AlertDatasourceSelectionModel | undefined {
  const refs = extractAlertDatasourceRefs(rule);
  if (refs.length === 0) {
    return undefined;
  }

  const refIds = [...new Set(refs.map((ref) => ref.refId))].sort((left, right) => left.localeCompare(right));
  const sourceUids = [...new Set(refs.map((ref) => ref.datasourceUid))].sort((left, right) => left.localeCompare(right));
  const sourceTypes = [...new Set(refs.map((ref) => ref.datasourceType).filter((value): value is string => Boolean(value)))].sort(
    (left, right) => left.localeCompare(right),
  );
  const firstRef = refs[0];

  return {
    refIds,
    sourceUids,
    sourceTypes,
    targetUid: firstRef?.datasourceUid,
    ...(firstRef?.datasourceName ? { targetName: firstRef.datasourceName } : {}),
  };
}

function applyAlertDatasourceSelection(
  rule: Record<string, unknown>,
  selection: { uid: string; name?: string },
): Record<string, unknown> {
  const nextRule = structuredClone(rule);
  const data = Array.isArray(nextRule.data) ? nextRule.data : [];
  nextRule.data = data.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return item;
    }

    const record = item as Record<string, unknown>;
    const datasourceUid =
      typeof record.datasourceUid === "string" && record.datasourceUid.trim()
        ? record.datasourceUid.trim()
        : undefined;
    if (!datasourceUid || datasourceUid === "__expr__") {
      return record;
    }

    const nextRecord: Record<string, unknown> = {
      ...record,
      datasourceUid: selection.uid,
    };
    const model =
      nextRecord.model && typeof nextRecord.model === "object" && !Array.isArray(nextRecord.model)
        ? ({ ...(nextRecord.model as Record<string, unknown>) } as Record<string, unknown>)
        : undefined;
    const datasource =
      model?.datasource && typeof model.datasource === "object" && !Array.isArray(model.datasource)
        ? ({ ...(model.datasource as Record<string, unknown>) } as Record<string, unknown>)
        : undefined;
    if (model && datasource) {
      datasource.uid = selection.uid;
      if (selection.name) {
        datasource.name = selection.name;
      }
      model.datasource = datasource;
      nextRecord.model = model;
    }
    return nextRecord;
  });

  return nextRule;
}

function backupScopeForEntries(entries: DashboardManifestEntry[]): BackupScope {
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

  private isGrafanaNotFoundError(error: unknown): boolean {
    return String(error).includes("failed with 404");
  }

  private isGrafanaInternalServerError(error: unknown): boolean {
    return String(error).includes("failed with 500");
  }

  private async upsertAlertRuleWithGroupFallback(
    client: GrafanaApi,
    rule: Record<string, unknown>,
    existingRemoteRule?: Record<string, unknown>,
  ): Promise<"updated" | "skipped"> {
    const uid = alertUid(rule);
    if (!uid) {
      throw new Error("Alert rule UID is required for upload.");
    }

    if (existingRemoteRule) {
      const normalizedRemoteRule = normalizeAlertRuleForUpload(existingRemoteRule);
      if (stableJsonStringify(normalizedRemoteRule) === stableJsonStringify(rule)) {
        return "skipped";
      }
    }

    try {
      if (existingRemoteRule) {
        await client.updateAlertRule(uid, rule);
      } else {
        await client.createAlertRule(rule);
      }
      return "updated";
    } catch (error) {
      if (!this.isGrafanaInternalServerError(error)) {
        throw error;
      }
    }

    const folderUid = alertFolderUid(rule);
    const group = alertRuleGroup(rule);
    if (!folderUid || !group) {
      throw new Error(`Grafana rejected direct alert rule upsert for ${uid}, and folderUID/ruleGroup are missing.`);
    }

    const remoteGroup = await client.getAlertRuleGroup(folderUid, group);
    const rawRules = Array.isArray(remoteGroup.rules) ? remoteGroup.rules : [];
    const nextRules = [
      ...rawRules.filter((candidate) => alertUid(candidate as Record<string, unknown>) !== uid),
      rule,
    ];
    const nextGroup = {
      ...remoteGroup,
      rules: nextRules,
    };
    await client.updateAlertRuleGroup(folderUid, group, nextGroup);
    return "updated";
  }

  private async ruleWithGroupPauseState(
    client: GrafanaApi,
    rule: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const uid = alertUid(rule);
    const folderUid = alertFolderUid(rule);
    const group = alertRuleGroup(rule);
    if (!uid || !folderUid || !group) {
      return rule;
    }

    try {
      const remoteGroup = await client.getAlertRuleGroup(folderUid, group);
      const rawRules = Array.isArray(remoteGroup.rules) ? remoteGroup.rules : [];
      const groupRule = rawRules.find((candidate) => alertUid(candidate as Record<string, unknown>) === uid) as
        | Record<string, unknown>
        | undefined;
      if (groupRule && typeof groupRule.isPaused === "boolean") {
        return {
          ...rule,
          isPaused: groupRule.isPaused,
        };
      }
    } catch (error) {
      if (!this.isGrafanaNotFoundError(error)) {
        throw error;
      }
    }

    return rule;
  }

  private async syncAlertPauseStateWithGroup(
    client: GrafanaApi,
    rule: Record<string, unknown>,
    options?: { forceUpdate?: boolean },
  ): Promise<"updated" | "skipped"> {
    const uid = alertUid(rule);
    const folderUid = alertFolderUid(rule);
    const group = alertRuleGroup(rule);
    if (!uid || !folderUid || !group) {
      return "skipped";
    }

    const desiredPaused = alertIsPaused(rule);
    let remoteGroup: Record<string, unknown>;
    try {
      remoteGroup = await client.getAlertRuleGroup(folderUid, group);
    } catch (error) {
      if (this.isGrafanaNotFoundError(error)) {
        return "skipped";
      }
      throw error;
    }

    const rawRules = Array.isArray(remoteGroup.rules) ? remoteGroup.rules : [];
    const nextRules: Record<string, unknown>[] = [];
    let changed = false;
    let found = false;

    for (const candidate of rawRules) {
      const candidateRule = candidate as Record<string, unknown>;
      if (alertUid(candidateRule) !== uid) {
        nextRules.push(candidateRule);
        continue;
      }

      found = true;
      const currentPaused = candidateRule.isPaused === true;
      if (currentPaused !== desiredPaused) {
        changed = true;
      }
      nextRules.push({
        ...candidateRule,
        isPaused: desiredPaused,
      });
    }

    if (!found) {
      nextRules.push({
        ...rule,
        isPaused: desiredPaused,
      });
      changed = true;
    }

    if (!changed && options?.forceUpdate !== true) {
      return "skipped";
    }

    await client.updateAlertRuleGroup(folderUid, group, {
      ...remoteGroup,
      rules: nextRules,
    });
    return "updated";
  }

  async listRemoteAlertRules(instanceName?: string): Promise<GrafanaAlertRuleSummary[]> {
    if (!instanceName) {
      throw new Error("Choose a concrete Grafana instance for alerts.");
    }
    const client = await this.clientFactory(instanceName);
    const rules = await client.listAlertRules();
    const summaries: GrafanaAlertRuleSummary[] = [];
    for (const rule of rules) {
      const uid = alertUid(rule);
      if (!uid) {
        continue;
      }
      const receiver = alertReceiver(rule);
      summaries.push({
        uid,
        title: alertTitle(rule),
        ...(receiver ? { receiver } : {}),
      });
    }
    return summaries.sort((left, right) => left.title.localeCompare(right.title) || left.uid.localeCompare(right.uid));
  }

  async exportAlerts(
    instanceName?: string,
    targetName = DEFAULT_DEPLOYMENT_TARGET,
    selectedUids?: string[],
  ): Promise<ExportSelectedAlertsSummary> {
    if (!instanceName) {
      throw new Error("Choose a concrete Grafana instance and deployment target for alerts pull.");
    }

    const target = await this.repository.deploymentTargetByName(instanceName, targetName);
    if (!target) {
      throw new Error(`Deployment target not found: ${instanceName}/${targetName}`);
    }

    const client = await this.clientFactory(instanceName);
    this.log.info(`Exporting alerts from ${instanceName}/${targetName}`);

    const [remoteRules, remoteContactPoints] = await Promise.all([
      client.listAlertRules(),
      client.listContactPoints(),
    ]);

    const ruleByUid = new Map<string, Record<string, unknown>>();
    for (const rule of remoteRules) {
      const uid = alertUid(rule);
      if (uid) {
        ruleByUid.set(uid, rule);
      }
    }

    const requestedUids = [...new Set((selectedUids ?? []).map((uid) => uid.trim()).filter(Boolean))];
    const effectiveUids = requestedUids.length > 0 ? requestedUids : [...ruleByUid.keys()].sort((a, b) => a.localeCompare(b));
    if (effectiveUids.length === 0) {
      throw new Error(`No alert rules available in ${instanceName}.`);
    }
    const missingUids = effectiveUids.filter((uid) => !ruleByUid.has(uid));
    if (missingUids.length > 0) {
      throw new Error(`Selected alert rules are not available in ${instanceName}: ${missingUids.join(", ")}`);
    }

    const nowIso = new Date().toISOString();
    const targetRoot = this.repository.alertsRootPath(instanceName, target.name);
    const remoteContactPointsByName = new Map<string, Array<Record<string, unknown>>>();
    for (const contactPoint of remoteContactPoints) {
      const name = typeof contactPoint.name === "string" ? contactPoint.name.trim() : "";
      if (!name) {
        continue;
      }
      const bucket = remoteContactPointsByName.get(name) ?? [];
      bucket.push(contactPoint);
      remoteContactPointsByName.set(name, bucket);
    }

    const previousManifest = await this.repository.loadAlertsManifest(instanceName, target.name);
    const nextManifest: AlertsManifest = {
      ...previousManifest,
      generatedAt: previousManifest.generatedAt,
      rules: {
        ...previousManifest.rules,
      },
      contactPoints: {
        ...previousManifest.contactPoints,
      },
    };

    let updatedCount = 0;
    let skippedCount = 0;
    const fileResults: AlertStorageFileResult[] = [];

    const makeRelativePath = (targetPath: string): string => path.relative(this.repository.projectRootPath, targetPath).replace(/\\/g, "/");
    const usedContactPointKeys = new Set(Object.keys(nextManifest.contactPoints));

    for (const uid of effectiveUids) {
      const remoteRule = ruleByUid.get(uid)!;
      const normalizedRule = normalizeAlertRuleForStorage(remoteRule);
      const rulePath = this.repository.alertRuleFilePath(instanceName, target.name, uid);
      const relativeRulePath = path.relative(targetRoot, rulePath).replace(/\\/g, "/");
      const ruleOutcome = await this.repository.syncPulledFile({
        sourceContent: stableJsonStringify(normalizedRule),
        targetPath: rulePath,
      });
      if (ruleOutcome.status === "updated") {
        updatedCount += 1;
      } else {
        skippedCount += 1;
      }
      fileResults.push({
        kind: "rule",
        relativePath: makeRelativePath(rulePath),
        status: ruleOutcome.status,
        targetPath: rulePath,
      });

      const receiver = alertReceiver(remoteRule);
      const linkedContactPoints = receiver ? (remoteContactPointsByName.get(receiver) ?? []) : [];
      const contactPointKeys: string[] = [];
      let contactPointStatus: AlertLinkStatus = "policy-managed";
      if (receiver) {
        contactPointStatus = linkedContactPoints.length > 0 ? "linked" : "missing";
      }

      for (const remoteContactPoint of linkedContactPoints) {
        const normalizedContactPoint = normalizeContactPointForStorage(remoteContactPoint);
        const preferredKey = contactPointKeyFor(normalizedContactPoint);
        let key = preferredKey;
        let suffix = 2;
        while (usedContactPointKeys.has(key) && nextManifest.contactPoints[key]?.uid !== normalizedContactPoint.uid) {
          key = `${preferredKey}__${suffix}`;
          suffix += 1;
        }
        usedContactPointKeys.add(key);
        contactPointKeys.push(key);

        const contactPointPath = this.repository.alertContactPointFilePath(instanceName, target.name, key);
        const relativeContactPointPath = path.relative(targetRoot, contactPointPath).replace(/\\/g, "/");
        const contactPointOutcome = await this.repository.syncPulledFile({
          sourceContent: stableJsonStringify(normalizedContactPoint),
          targetPath: contactPointPath,
        });
        if (contactPointOutcome.status === "updated") {
          updatedCount += 1;
        } else {
          skippedCount += 1;
        }
        fileResults.push({
          kind: "contactPoint",
          relativePath: makeRelativePath(contactPointPath),
          status: contactPointOutcome.status,
          targetPath: contactPointPath,
        });

        nextManifest.contactPoints[key] = {
          key,
          path: relativeContactPointPath,
          name: typeof normalizedContactPoint.name === "string" ? normalizedContactPoint.name : key,
          ...(typeof normalizedContactPoint.uid === "string" && normalizedContactPoint.uid.trim()
            ? { uid: normalizedContactPoint.uid.trim() }
            : {}),
          ...(typeof normalizedContactPoint.type === "string" && normalizedContactPoint.type.trim()
            ? { type: normalizedContactPoint.type.trim() }
            : {}),
        };
      }

      const previousEntry = nextManifest.rules[uid];
      nextManifest.rules[uid] = {
        uid,
        title: alertTitle(remoteRule),
        path: relativeRulePath,
        contactPointKeys: [...new Set(contactPointKeys)].sort((a, b) => a.localeCompare(b)),
        contactPointStatus,
        lastExportedAt: ruleOutcome.status === "updated" ? nowIso : previousEntry?.lastExportedAt ?? nowIso,
        ...(previousEntry?.lastAppliedAt ? { lastAppliedAt: previousEntry.lastAppliedAt } : {}),
      };
    }

    const manifestPath = this.repository.alertsManifestPath(instanceName, target.name);
    const manifestOutcome = await this.repository.syncPulledFile({
      sourceContent: stableJsonStringify(nextManifest),
      targetPath: manifestPath,
    });
    if (manifestOutcome.status === "updated") {
      updatedCount += 1;
    } else {
      skippedCount += 1;
    }
    fileResults.push({
      kind: "manifest",
      relativePath: makeRelativePath(manifestPath),
      status: manifestOutcome.status,
      targetPath: manifestPath,
    });

    return {
      instanceName,
      targetName: target.name,
      outputDir: this.repository.alertsRootPath(instanceName, target.name),
      manifestPath,
      selectedCount: effectiveUids.length,
      updatedCount,
      skippedCount,
      fileResults,
    };
  }

  async exportSelectedAlerts(
    instanceName: string,
    targetName: string,
    alertUids: string[],
  ): Promise<ExportSelectedAlertsSummary> {
    return this.exportAlerts(instanceName, targetName, alertUids);
  }

  private async alertSyncStatus(
    record: AlertRuleRecord,
  ): Promise<{ syncStatus: AlertSyncStatus; syncDetail?: string }> {
    if (!record.exists) {
      return {
        syncStatus: "local-only",
        syncDetail: "Local alert file is missing.",
      };
    }

    const localRule = await this.repository.readJsonFile<Record<string, unknown>>(record.absolutePath);
    const normalizedLocalRule = normalizeAlertRuleForUpload(localRule);
    const client = await this.clientFactory(record.instanceName);

    let remoteRule: Record<string, unknown> | undefined;
    try {
      remoteRule = await client.getAlertRule(record.uid);
    } catch (error) {
      if (!this.isGrafanaNotFoundError(error)) {
        return {
          syncStatus: "diverged",
          syncDetail: String(error),
        };
      }
    }

    if (!remoteRule) {
      return {
        syncStatus: record.lastAppliedAt ? "missing-remote" : "local-only",
      };
    }

    const remoteRuleWithPauseState = await this.ruleWithGroupPauseState(client, remoteRule);
    const normalizedRemoteRule = normalizeAlertRuleForUpload(remoteRuleWithPauseState);
    if (stableJsonStringify(normalizedRemoteRule) === stableJsonStringify(normalizedLocalRule)) {
      return { syncStatus: "in-sync" };
    }
    return { syncStatus: "diverged" };
  }

  async buildTargetAlertSummaryRows(
    instanceName: string,
    targetName: string,
  ): Promise<Array<{ uid: string; title: string; contactPointStatus: AlertLinkStatus; syncStatus: AlertSyncStatus; syncDetail?: string }>> {
    const records = await this.repository.listTargetAlertRecords(instanceName, targetName);
    return Promise.all(
      records.map(async (record) => {
        const sync = await this.alertSyncStatus(record);
        return {
          uid: record.uid,
          title: record.title,
          contactPointStatus: record.contactPointStatus,
          syncStatus: sync.syncStatus,
          ...(sync.syncDetail ? { syncDetail: sync.syncDetail } : {}),
        };
      }),
    );
  }

  async loadAlertDetails(
    instanceName: string,
    targetName: string,
    uid: string,
  ): Promise<AlertDetailsModel | undefined> {
    const record = await this.repository.alertRecordByUid(instanceName, targetName, uid);
    if (!record) {
      return undefined;
    }
    const manifest = await this.repository.loadAlertsManifest(instanceName, targetName);
    const contactPoints = await Promise.all(
      record.contactPointKeys.map(async (key) => {
        const entry = manifest.contactPoints[key];
        if (!entry) {
          return undefined;
        }
        const absolutePath = path.join(this.repository.alertsRootPath(instanceName, targetName), entry.path);
        return {
          key,
          path: entry.path,
          absolutePath,
          exists: (await this.repository.readTextFileIfExists(absolutePath)) !== undefined,
          name: entry.name,
          ...(entry.uid ? { uid: entry.uid } : {}),
          ...(entry.type ? { type: entry.type } : {}),
        };
      }),
    );
    const localRule = record.exists
      ? await this.repository.readJsonFile<Record<string, unknown>>(record.absolutePath).catch(() => undefined)
      : undefined;
    const sync = await this.alertSyncStatus(record);
    return {
      rule: record,
      contactPoints: contactPoints.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
      isPaused: localRule ? alertIsPaused(localRule) : false,
      datasourceSelection: localRule ? alertDatasourceSelectionModel(localRule) : undefined,
      syncStatus: sync.syncStatus,
      ...(sync.syncDetail ? { syncDetail: sync.syncDetail } : {}),
    };
  }

  async saveAlertSettings(
    instanceName: string,
    targetName: string,
    uid: string,
    settings: {
      isPaused: boolean;
      datasourceUid?: string;
      datasourceName?: string;
    },
  ): Promise<string> {
    const record = await this.repository.alertRecordByUid(instanceName, targetName, uid);
    if (!record) {
      throw new Error(`Alert is not exported locally: ${uid}`);
    }
    if (!record.exists) {
      throw new Error(`Local alert file is missing: ${uid}`);
    }

    let nextRule = await this.repository.readJsonFile<Record<string, unknown>>(record.absolutePath);
    nextRule = {
      ...nextRule,
      isPaused: settings.isPaused,
    };
    if (settings.datasourceUid?.trim()) {
      nextRule = applyAlertDatasourceSelection(nextRule, {
        uid: settings.datasourceUid.trim(),
        ...(settings.datasourceName?.trim() ? { name: settings.datasourceName.trim() } : {}),
      });
    }

    await this.repository.saveAlertRuleJson(instanceName, targetName, uid, nextRule);
    return record.absolutePath;
  }

  async copyAlertToTarget(
    sourceInstanceName: string,
    sourceTargetName: string,
    uid: string,
    destinationInstanceName: string,
    destinationTargetName: string,
    datasourceSelection?: { uid: string; name?: string },
  ): Promise<CopyAlertSummary> {
    const sourceTarget = await this.repository.deploymentTargetByName(sourceInstanceName, sourceTargetName);
    if (!sourceTarget) {
      throw new Error(`Deployment target not found: ${sourceInstanceName}/${sourceTargetName}`);
    }
    const destinationTarget = await this.repository.deploymentTargetByName(destinationInstanceName, destinationTargetName);
    if (!destinationTarget) {
      throw new Error(`Deployment target not found: ${destinationInstanceName}/${destinationTargetName}`);
    }

    const sourceManifest = await this.repository.loadAlertsManifest(sourceInstanceName, sourceTarget.name);
    const sourceEntry = sourceManifest.rules[uid];
    if (!sourceEntry) {
      throw new Error(`Alert is not exported locally: ${uid}`);
    }

    const localRule = await this.repository.readAlertRuleJson(sourceInstanceName, sourceTarget.name, uid);
    if (!localRule) {
      throw new Error(`Local alert file is missing: ${uid}`);
    }

    const destinationManifest = await this.repository.loadAlertsManifest(destinationInstanceName, destinationTarget.name);
    let destinationUid = randomUUID();
    while (destinationManifest.rules[destinationUid]) {
      destinationUid = randomUUID();
    }

    let nextRule = normalizeAlertRuleForStorage(localRule);
    nextRule = {
      ...nextRule,
      uid: destinationUid,
    };
    if (datasourceSelection?.uid.trim()) {
      nextRule = applyAlertDatasourceSelection(nextRule, {
        uid: datasourceSelection.uid.trim(),
        ...(datasourceSelection.name?.trim() ? { name: datasourceSelection.name.trim() } : {}),
      });
    }

    const copiedContactPointKeys: string[] = [];
    for (const sourceKey of sourceEntry.contactPointKeys) {
      const localContactPoint = await this.repository.readAlertContactPointJson(sourceInstanceName, sourceTarget.name, sourceKey);
      if (!localContactPoint) {
        continue;
      }

      const nextContactPoint = normalizeContactPointForStorage({
        ...localContactPoint,
        uid: randomUUID(),
      });
      const preferredKey = contactPointKeyFor(nextContactPoint);
      let key = preferredKey;
      let suffix = 2;
      while (destinationManifest.contactPoints[key]) {
        key = `${preferredKey}__${suffix}`;
        suffix += 1;
      }

      const contactPointPath = this.repository.alertContactPointFilePath(destinationInstanceName, destinationTarget.name, key);
      const relativeContactPointPath = path
        .relative(this.repository.alertsRootPath(destinationInstanceName, destinationTarget.name), contactPointPath)
        .replace(/\\/g, "/");

      await this.repository.writeJsonFile(contactPointPath, nextContactPoint);
      destinationManifest.contactPoints[key] = {
        key,
        path: relativeContactPointPath,
        name:
          typeof nextContactPoint.name === "string" && nextContactPoint.name.trim()
            ? nextContactPoint.name.trim()
            : key,
        ...(typeof nextContactPoint.uid === "string" && nextContactPoint.uid.trim()
          ? { uid: nextContactPoint.uid.trim() }
          : {}),
        ...(typeof nextContactPoint.type === "string" && nextContactPoint.type.trim()
          ? { type: nextContactPoint.type.trim() }
          : {}),
      };
      copiedContactPointKeys.push(key);
    }

    const rulePath = this.repository.alertRuleFilePath(destinationInstanceName, destinationTarget.name, destinationUid);
    const relativeRulePath = path
      .relative(this.repository.alertsRootPath(destinationInstanceName, destinationTarget.name), rulePath)
      .replace(/\\/g, "/");
    await this.repository.writeJsonFile(rulePath, nextRule);

    destinationManifest.generatedAt = new Date().toISOString();
    destinationManifest.rules[destinationUid] = {
      uid: destinationUid,
      title: alertTitle(nextRule),
      path: relativeRulePath,
      contactPointKeys: copiedContactPointKeys.sort((left, right) => left.localeCompare(right)),
      contactPointStatus: sourceEntry.contactPointStatus,
    };
    await this.repository.saveAlertsManifest(destinationInstanceName, destinationTarget.name, destinationManifest);

    return {
      sourceInstanceName,
      sourceTargetName: sourceTarget.name,
      sourceUid: uid,
      destinationInstanceName,
      destinationTargetName: destinationTarget.name,
      destinationUid,
      copiedContactPointCount: copiedContactPointKeys.length,
    };
  }

  async uploadAlert(
    instanceName: string,
    targetName: string,
    uid: string,
  ): Promise<UploadAlertSummary> {
    const target = await this.repository.deploymentTargetByName(instanceName, targetName);
    if (!target) {
      throw new Error(`Deployment target not found: ${instanceName}/${targetName}`);
    }

    const manifest = await this.repository.loadAlertsManifest(instanceName, target.name);
    const entry = manifest.rules[uid];
    if (!entry) {
      throw new Error(`Alert is not exported locally: ${uid}`);
    }

    const rulePath = path.join(this.repository.alertsRootPath(instanceName, target.name), entry.path);
    const localRule = await this.repository.readJsonFile<Record<string, unknown>>(rulePath);
    const normalizedLocalRule = normalizeAlertRuleForUpload(localRule);

    const client = await this.clientFactory(instanceName);
    let remoteRule: Record<string, unknown> | undefined;
    try {
      remoteRule = await client.getAlertRule(uid);
    } catch (error) {
      if (!this.isGrafanaNotFoundError(error)) {
        throw error;
      }
    }

    const remoteContactPoints = await client.listContactPoints();
    const remoteContactPointsByUid = new Map<string, Record<string, unknown>>();
    const remoteContactPointsByName = new Map<string, Array<Record<string, unknown>>>();
    for (const remoteContactPoint of remoteContactPoints) {
      const remoteUid = typeof remoteContactPoint.uid === "string" ? remoteContactPoint.uid.trim() : "";
      if (remoteUid) {
        remoteContactPointsByUid.set(remoteUid, remoteContactPoint);
      }
      const remoteName = typeof remoteContactPoint.name === "string" ? remoteContactPoint.name.trim() : "";
      if (!remoteName) {
        continue;
      }
      const bucket = remoteContactPointsByName.get(remoteName) ?? [];
      bucket.push(remoteContactPoint);
      remoteContactPointsByName.set(remoteName, bucket);
    }

    const contactPointResults: AlertUploadContactPointResult[] = [];
    for (const key of entry.contactPointKeys) {
      const localContactPoint = await this.repository.readAlertContactPointJson(instanceName, target.name, key);
      if (!localContactPoint) {
        continue;
      }
      const normalizedLocalContactPoint = normalizeContactPointForUpload(localContactPoint);
      const localUid =
        typeof normalizedLocalContactPoint.uid === "string" && normalizedLocalContactPoint.uid.trim()
          ? normalizedLocalContactPoint.uid.trim()
          : undefined;
      const localName =
        typeof normalizedLocalContactPoint.name === "string" && normalizedLocalContactPoint.name.trim()
          ? normalizedLocalContactPoint.name.trim()
          : undefined;

      const matchedRemote =
        (localUid ? remoteContactPointsByUid.get(localUid) : undefined) ??
        (localName ? (remoteContactPointsByName.get(localName) ?? [])[0] : undefined);

      if (matchedRemote) {
        const normalizedRemoteContactPoint = normalizeContactPointForUpload(matchedRemote);
        if (stableJsonStringify(normalizedRemoteContactPoint) === stableJsonStringify(normalizedLocalContactPoint)) {
          contactPointResults.push({ key, status: "skipped" });
          continue;
        }

        const matchedRemoteUid =
          typeof matchedRemote.uid === "string" && matchedRemote.uid.trim()
            ? matchedRemote.uid.trim()
            : undefined;
        if (matchedRemoteUid) {
          await client.updateContactPoint(matchedRemoteUid, normalizedLocalContactPoint);
          contactPointResults.push({ key, status: "updated" });
          continue;
        }
      }

      if (localUid) {
        try {
          await client.updateContactPoint(localUid, normalizedLocalContactPoint);
          contactPointResults.push({ key, status: "updated" });
          continue;
        } catch (error) {
          if (!this.isGrafanaNotFoundError(error)) {
            throw error;
          }
        }
      }

      await client.createContactPoint(normalizedLocalContactPoint);
      contactPointResults.push({ key, status: "updated" });
    }

    const directRuleStatus = await this.upsertAlertRuleWithGroupFallback(client, normalizedLocalRule, remoteRule);
    const pauseRuleStatus = await this.syncAlertPauseStateWithGroup(client, normalizedLocalRule, {
      forceUpdate: !remoteRule,
    });
    const ruleStatus =
      directRuleStatus === "updated" || pauseRuleStatus === "updated"
        ? "updated"
        : "skipped";

    manifest.rules[uid] = {
      ...entry,
      lastAppliedAt: new Date().toISOString(),
    };
    await this.repository.saveAlertsManifest(instanceName, target.name, manifest);

    return {
      instanceName,
      targetName: target.name,
      uid,
      ruleStatus,
      contactPointResults,
      syncStatus: "in-sync",
    };
  }

  async refreshAlertStatus(
    instanceName: string,
    targetName: string,
    uid: string,
  ): Promise<AlertSyncStatus> {
    const record = await this.repository.alertRecordByUid(instanceName, targetName, uid);
    if (!record) {
      throw new Error(`Alert is not exported locally: ${uid}`);
    }
    const sync = await this.alertSyncStatus(record);
    return sync.syncStatus;
  }

  async removeAlertFromProject(
    instanceName: string,
    targetName: string,
    uid: string,
  ): Promise<{ removedPaths: string[]; removedContactPointKeys: string[] }> {
    const result = await this.repository.removeAlertFromProject(instanceName, targetName, uid);
    return {
      removedPaths: result.removedPaths,
      removedContactPointKeys: result.removedContactPointKeys,
    };
  }

  async createDeploymentTarget(instanceName: string, targetName: string): Promise<DeploymentTargetRecord> {
    const target = await this.repository.createDeploymentTarget(instanceName, targetName);
    await this.materializeManagedOverridesForTarget(target.instanceName, target.name);
    return target;
  }

  private variableDefaultsFromDashboard(dashboard: Record<string, unknown>): Record<string, DashboardOverrideValue> {
    return Object.fromEntries(
      extractSupportedVariables(dashboard).map((descriptor) => [
        descriptor.name,
        normalizeCurrentForStorage({
          text: descriptor.currentText,
          value: descriptor.currentValue,
        }),
      ]),
    ) as Record<string, DashboardOverrideValue>;
  }

  private datasourceBindingDefaults(dashboard: Record<string, unknown>): Record<string, string> {
    return Object.fromEntries(
      extractDashboardDatasourceRefs(dashboard).map((ref) => [ref.sourceUid, ref.sourceUid]),
    );
  }

  private async managedVariableNames(entry: DashboardManifestEntry): Promise<Set<string>> {
    const overrides = await this.repository.readDashboardOverrides(entry);
    const targets = overrides?.dashboards[entry.uid]?.targets ?? {};
    const managed = new Set<string>();
    for (const override of Object.values(targets)) {
      for (const revisionState of Object.values(override.revisionStates ?? {})) {
        for (const variableName of Object.keys(revisionState.variableOverrides ?? {})) {
          managed.add(variableName);
        }
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
    });
    const templateHash = hashValue(
      this.normalizeDashboardForVersionComparison(snapshot.dashboard, managedVariableNames, entry.uid),
    );
    return { contentHash, templateHash };
  }

  private async revisionById(
    entry: DashboardManifestEntry,
    revisionIdValue: string,
  ): Promise<DashboardRevisionRecord | undefined> {
    const index = await this.ensureDashboardVersionIndex(entry);
    return index.revisions.find((candidate) => candidate.id === revisionIdValue);
  }

  private async ensureTargetState(
    entry: DashboardManifestEntry,
    instanceName: string,
    targetName: string,
    sourceRepository: ProjectRepository = this.repository,
  ): Promise<DashboardTargetState> {
    const existingState = await sourceRepository.readTargetOverrideFile(instanceName, targetName, entry);
    const existingIndex = await this.repository.readDashboardVersionIndex(entry);
    const checkedOutRevision =
      existingIndex?.revisions.find((candidate) => candidate.id === existingIndex.checkedOutRevisionId) ??
      existingIndex?.revisions[0] ??
      (await this.currentCheckedOutRevision(entry)) ??
      (await this.ensureWorkingCopyCheckedOutRevision(entry, { kind: "migration" }));
    const revision = existingState?.currentRevisionId
      ? (await this.revisionById(entry, existingState.currentRevisionId)) ?? checkedOutRevision
      : checkedOutRevision;
    if (!revision) {
      throw new Error(`Could not resolve revision for ${selectorNameForEntry(entry)}.`);
    }

    const snapshot = await this.repository.readDashboardRevisionSnapshot(entry, revision.id);
    if (!snapshot) {
      throw new Error(`Revision snapshot not found: ${revision.id}`);
    }

    const folderMeta = await sourceRepository.readFolderMetadata(entry);
    const nextState: DashboardTargetState = {
      ...(existingState?.currentRevisionId ? { currentRevisionId: existingState.currentRevisionId } : { currentRevisionId: revision.id }),
      ...(existingState?.dashboardUid ? { dashboardUid: existingState.dashboardUid } : {}),
      ...(normalizeFolderPath(existingState?.folderPath ?? folderMeta?.path ?? snapshot.folderPath)
        ? { folderPath: normalizeFolderPath(existingState?.folderPath ?? folderMeta?.path ?? snapshot.folderPath) }
        : {}),
      revisionStates: {
        ...(existingState?.revisionStates ?? {}),
      },
    };

    if (stableJsonStringify(nextState) !== stableJsonStringify(existingState ?? {})) {
      await sourceRepository.saveTargetOverrideFile(instanceName, targetName, entry, nextState);
    }

    return nextState;
  }

  private buildRevisionState(
    dashboard: Record<string, unknown>,
    inherited?: DashboardTargetRevisionState,
  ): DashboardTargetRevisionState {
    const variableDefaults = this.variableDefaultsFromDashboard(dashboard);
    const datasourceDefaults = this.datasourceBindingDefaults(dashboard);
    return {
      variableOverrides: Object.fromEntries(
        Object.keys(variableDefaults)
          .filter((variableName) => inherited?.variableOverrides?.[variableName] !== undefined)
          .map((variableName) => [variableName, inherited!.variableOverrides[variableName]!]),
      ) as Record<string, DashboardOverrideValue>,
      datasourceBindings: Object.fromEntries(
        Object.keys(datasourceDefaults).map((datasourceKey) => [
          datasourceKey,
          inherited?.datasourceBindings?.[datasourceKey] ?? datasourceKey,
        ]),
      ),
    };
  }

  private async ensureRevisionState(
    entry: DashboardManifestEntry,
    targetState: DashboardTargetState,
    revisionIdValue: string,
    inherited?: DashboardTargetRevisionState,
  ): Promise<DashboardTargetRevisionState> {
    const existing = targetState.revisionStates[revisionIdValue];
    if (existing) {
      return existing;
    }

    const snapshot = await this.repository.readDashboardRevisionSnapshot(entry, revisionIdValue);
    if (!snapshot) {
      throw new Error(`Revision snapshot not found: ${revisionIdValue}`);
    }

    const nextState = this.buildRevisionState(snapshot.dashboard, inherited);
    targetState.revisionStates[revisionIdValue] = nextState;
    return nextState;
  }

  private async targetRevisionState(
    entry: DashboardManifestEntry,
    instanceName: string,
    targetName: string,
    sourceRepository: ProjectRepository = this.repository,
  ): Promise<TargetRevisionState> {
    const state = await this.ensureTargetState(entry, instanceName, targetName, sourceRepository);
    const revisionIdValue = state.currentRevisionId;
    if (!revisionIdValue) {
      throw new Error(`Current revision is not set for ${selectorNameForEntry(entry)} on ${instanceName}/${targetName}.`);
    }
    const revision = await this.revisionById(entry, revisionIdValue);
    if (!revision) {
      throw new Error(`Revision not found: ${revisionIdValue}`);
    }
    const snapshot = await this.repository.readDashboardRevisionSnapshot(entry, revision.id);
    if (!snapshot) {
      throw new Error(`Revision snapshot not found: ${revision.id}`);
    }
    const revisionState = await this.ensureRevisionState(entry, state, revision.id);
    await this.repository.saveTargetOverrideFile(instanceName, targetName, entry, state);
    return {
      targetState: state,
      revisionState,
      revision,
      snapshot,
    };
  }

  private renameDatasourceBindings(
    dashboard: Record<string, unknown>,
    datasourceBindings: Record<string, string>,
  ): Record<string, unknown> {
    const renamePairs = Object.fromEntries(
      Object.entries(datasourceBindings).filter(([sourceName, targetSourceName]) => sourceName !== targetSourceName),
    );
    return renameDatasourceSourceNames(dashboard, renamePairs);
  }

  private async updateTargetRevision(
    entry: DashboardManifestEntry,
    instanceName: string,
    targetName: string,
    revisionIdValue: string,
    extras?: Partial<DashboardTargetState>,
  ): Promise<DashboardTargetState> {
    const state = await this.ensureTargetState(entry, instanceName, targetName);
    const inheritedRevisionState =
      state.currentRevisionId ? state.revisionStates[state.currentRevisionId] : undefined;
    await this.ensureRevisionState(entry, state, revisionIdValue, inheritedRevisionState);
    const nextState: DashboardTargetState = {
      ...state,
      currentRevisionId: revisionIdValue,
      ...(extras?.folderPath !== undefined ? { folderPath: extras.folderPath } : {}),
      ...(extras?.dashboardUid !== undefined ? { dashboardUid: extras.dashboardUid } : {}),
      ...(extras?.revisionStates ? { revisionStates: extras.revisionStates } : {}),
    };
    await this.repository.saveTargetOverrideFile(instanceName, targetName, entry, nextState);
    return nextState;
  }

  private async assertPullTargetIsDevTarget(instanceName: string, targetName: string): Promise<void> {
    const devTarget = await this.repository.getDevTarget();
    if (!devTarget) {
      throw new Error("Dev target is not configured. Use Select Dev Target first.");
    }
    if (devTarget.instanceName !== instanceName || devTarget.targetName !== targetName) {
      throw new Error(`Pull is allowed only from dev target ${devTarget.instanceName}/${devTarget.targetName}.`);
    }
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

  private async findRevisionByNormalizedTemplateHash(
    entry: DashboardManifestEntry,
    templateHash: string,
    managedVariableNames: ReadonlySet<string>,
    revisions?: DashboardRevisionRecord[],
  ): Promise<DashboardRevisionRecord | undefined> {
    const candidates = revisions ?? (await this.ensureDashboardVersionIndex(entry)).revisions;
    for (const revision of candidates) {
      const snapshot = await this.repository.readDashboardRevisionSnapshot(entry, revision.id);
      if (!snapshot) {
        continue;
      }
      const candidateHash = hashValue(
        this.normalizeDashboardForVersionComparison(snapshot.dashboard, managedVariableNames, entry.uid),
      );
      if (candidateHash === templateHash) {
        return revision;
      }
    }
    return undefined;
  }

  private async createOrReuseRevision(
    entry: DashboardManifestEntry,
    snapshot: DashboardRevisionSnapshot,
    source: DashboardRevisionRecord["source"],
    options?: { checkout?: boolean },
  ): Promise<DashboardRevisionRecord> {
    const existingIndex = await this.repository.readDashboardVersionIndex(entry);
    const index =
      existingIndex ??
      ((await this.repository.dashboardExists(entry))
        ? await this.ensureDashboardVersionIndex(entry)
        : {
            revisions: [],
          });
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

  private async createOrUpdatePulledRevision(
    entry: DashboardManifestEntry,
    snapshot: DashboardRevisionSnapshot,
    source: DashboardRevisionRecord["source"],
    options?: { checkout?: boolean },
  ): Promise<DashboardRevisionRecord> {
    const existingIndex = await this.repository.readDashboardVersionIndex(entry);
    const index =
      existingIndex ??
      ((await this.repository.dashboardExists(entry))
        ? await this.ensureDashboardVersionIndex(entry)
        : {
            revisions: [],
          });
    const managedVariableNames = await this.managedVariableNames(entry);
    const { contentHash, templateHash } = this.revisionHashes(entry, snapshot, managedVariableNames);
    const exact = index.revisions.find((revision) => revision.contentHash === contentHash);
    if (exact) {
      if (options?.checkout && index.checkedOutRevisionId !== exact.id) {
        await this.repository.saveDashboardVersionIndex(entry, {
          ...index,
          checkedOutRevisionId: exact.id,
        });
      }
      return exact;
    }

    const equivalent = await this.findRevisionByNormalizedTemplateHash(
      entry,
      templateHash,
      managedVariableNames,
      index.revisions,
    );
    if (!equivalent) {
      return this.createOrReuseRevision(entry, snapshot, source, options);
    }

    await this.repository.saveDashboardRevisionSnapshot(entry, equivalent.id, snapshot);
    const nextRecord: DashboardRevisionRecord = {
      ...equivalent,
      contentHash,
      templateHash,
      ...(snapshot.folderPath ? { baseFolderPath: snapshot.folderPath } : {}),
      source,
    };
    const nextIndex: DashboardVersionIndex = {
      checkedOutRevisionId: options?.checkout ? equivalent.id : index.checkedOutRevisionId,
      revisions: index.revisions.map((revision) => (revision.id === equivalent.id ? nextRecord : revision)),
    };
    await this.repository.saveDashboardVersionIndex(entry, nextIndex);
    return nextRecord;
  }

  private async checkoutRevisionSnapshot(
    entry: DashboardManifestEntry,
    revision: DashboardRevisionRecord,
    snapshot: DashboardRevisionSnapshot,
    options?: { folderUid?: string; folderPath?: string; updateFolderMeta?: boolean },
  ): Promise<void> {
    await this.repository.saveDashboardJson(entry, snapshot.dashboard);
    if (options?.updateFolderMeta) {
      const existingFolderMeta = await this.repository.readFolderMetadata(entry);
      const normalizedPath = normalizeFolderPath(options.folderPath ?? snapshot.folderPath);
      const preservedUid = normalizedPath && existingFolderMeta?.path === normalizedPath ? existingFolderMeta.uid : undefined;
      const nextFolderUid = options.folderUid ?? preservedUid;
      if (!normalizedPath && !nextFolderUid) {
        await this.repository.deleteFolderMetadata(entry);
      } else {
        await this.repository.saveFolderMetadata(entry, {
          ...(normalizedPath ? { path: normalizedPath } : {}),
          ...(nextFolderUid ? { uid: nextFolderUid } : {}),
        });
      }
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
    const targetRevision = await this.targetRevisionState(entry, instanceName, targetName);
    const effectiveDashboardUid = this.effectiveDashboardUidForTarget(entry, targetName, targetRevision.targetState);
    if (!effectiveDashboardUid) {
      throw new Error(`Dashboard UID is not materialized for ${selectorNameForEntry(entry)} on ${instanceName}/${targetName}.`);
    }

    const response = await client.getDashboardByUid(effectiveDashboardUid);
    const catalog = await this.repository.readDatasourceCatalog();
    const normalizedDashboard = this.renameDatasourceBindings(
      {
        ...normalizeDashboardDatasourceRefsFromCatalog(
          {
            ...sanitizeDashboardForStorage(response.dashboard),
            uid: entry.uid,
          },
          catalog,
          instanceName,
        ),
      },
      targetRevision.revisionState.datasourceBindings,
    );
    return {
      snapshot: {
        dashboard: normalizedDashboard,
        ...(normalizeFolderPath(targetRevision.targetState.folderPath)
          ? { folderPath: normalizeFolderPath(targetRevision.targetState.folderPath) }
          : {}),
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
          const targetRevision = await this.targetRevisionState(entry, target.instanceName, target.name);
          const datasourceCatalog = await this.repository.readDatasourceCatalog();
          const missingMappings = targetRevision.snapshot
            ? findMissingDatasourceMappings(
                this.renameDatasourceBindings(
                  targetRevision.snapshot.dashboard,
                  targetRevision.revisionState.datasourceBindings,
                ),
                datasourceCatalog,
                target.instanceName,
              )
            : [];
          const { snapshot, effectiveDashboardUid } = await this.liveTargetComparableSnapshot(
            entry,
            target.instanceName,
            target.name,
          );
          const templateHash = hashValue(
            this.normalizeDashboardForVersionComparison(snapshot.dashboard, managedVariableNames, entry.uid),
          );
          const matched = await this.findRevisionByNormalizedTemplateHash(
            entry,
            templateHash,
            managedVariableNames,
            index.revisions,
          );
          return {
            instanceName: target.instanceName,
            targetName: target.name,
            storedRevisionId: targetRevision.targetState.currentRevisionId,
            effectiveDashboardUid,
            ...(normalizeFolderPath(targetRevision.targetState.folderPath)
              ? { effectiveFolderPath: normalizeFolderPath(targetRevision.targetState.folderPath) }
              : {}),
            matchedRevisionId: matched?.id,
            datasourceStatus: missingMappings.length > 0 ? "missing" : "complete",
            state:
              !matched
                ? "unversioned"
                : matched.id === targetRevision.targetState.currentRevisionId
                  ? "matched"
                  : "diverged",
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

  async matchedRevisionIdForTarget(
    entry: DashboardManifestEntry,
    instanceName: string,
    targetName: string,
  ): Promise<string | undefined> {
    const managedVariableNames = await this.managedVariableNames(entry);
    const { snapshot } = await this.liveTargetComparableSnapshot(entry, instanceName, targetName);
    const templateHash = hashValue(
      this.normalizeDashboardForVersionComparison(snapshot.dashboard, managedVariableNames, entry.uid),
    );
    return (await this.findRevisionByNormalizedTemplateHash(entry, templateHash, managedVariableNames))?.id;
  }

  private async rawTargetBackupItems(
    entries: DashboardManifestEntry[],
    instanceName: string,
    targetName: string,
  ): Promise<Array<BackupDashboardRecord & { dashboard: Record<string, unknown> }>> {
    const client = await this.clientFactory(instanceName);
    const folders = await client.listFolders();
    const items: Array<BackupDashboardRecord & { dashboard: Record<string, unknown> }> = [];

    for (const entry of entries) {
      const state = await this.ensureTargetState(entry, instanceName, targetName);
      const effectiveDashboardUid = this.effectiveDashboardUidForTarget(entry, targetName, state);
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

  private mergeBackupCaptureSpecs(specs: BackupCaptureTargetSpec[]): BackupCaptureTargetSpec[] {
    const merged = new Map<string, Map<string, DashboardManifestEntry>>();

    for (const spec of specs) {
      const targetKey = `${spec.instanceName}/${spec.targetName}`;
      const targetEntries = merged.get(targetKey) ?? new Map<string, DashboardManifestEntry>();
      for (const entry of spec.entries) {
        targetEntries.set(selectorNameForEntry(entry), entry);
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

  async createBackup(
    specs: BackupCaptureTargetSpec[],
    scope: BackupScope,
  ): Promise<BackupRecord> {
    const mergedSpecs = this.mergeBackupCaptureSpecs(specs).filter((spec) => spec.entries.length > 0);
    if (mergedSpecs.length === 0) {
      throw new Error("No dashboards available for backup.");
    }

    const targets = await Promise.all(
      mergedSpecs.map(async (spec) => ({
        instanceName: spec.instanceName,
        targetName: spec.targetName,
        dashboards: await this.rawTargetBackupItems(spec.entries, spec.instanceName, spec.targetName),
      })),
    );

    const backup = await this.repository.createBackupSnapshot(scope, targets);
    this.log.info(`Created ${scope} backup ${backup.name} across ${backup.targetCount} target(s).`);
    return backup;
  }

  async createTargetBackup(
    entries: DashboardManifestEntry[],
    instanceName: string,
    targetName: string,
    scope: BackupScope = backupScopeForEntries(entries),
  ): Promise<BackupRecord> {
    return this.createBackup(
      [
        {
          instanceName,
          targetName,
          entries,
        },
      ],
      scope,
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
        entries.map(async (entry) => {
          const targetRevision = await this.targetRevisionState(entry, instanceName, targetName);
          return {
            entry,
            snapshot: targetRevision.snapshot,
            revisionId: targetRevision.revision.id,
            targetState: targetRevision.targetState,
            revisionState: targetRevision.revisionState,
          };
        }),
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
          targetState: await this.ensureTargetState(entry, instanceName, targetName),
          revisionState: this.buildRevisionState(
            snapshot.dashboard,
            (await this.targetRevisionState(entry, instanceName, targetName).catch(() => undefined))?.revisionState,
          ),
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

  private selectedBackupTargets(
    backup: BackupRecord,
    selection: BackupRestoreSelection,
  ): Array<{ instanceName: string; targetName: string; dashboards: BackupDashboardRecord[] }> {
    switch (selection.kind) {
      case "backup":
        return backup.instances.flatMap((instance) =>
          instance.targets.map((target) => ({
            instanceName: instance.instanceName,
            targetName: target.targetName,
            dashboards: target.dashboards,
          })),
        );
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
          throw new Error(
            `Backup dashboard not found: ${selection.instanceName}/${selection.targetName}/${selection.selectorName}`,
          );
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

  async restoreBackup(
    backup: BackupRecord,
    selection: BackupRestoreSelection = { kind: "backup" },
  ): Promise<RestoreSummary> {
    const selectedTargets = this.selectedBackupTargets(backup, selection);
    const dashboardResults: RestoreSummary["dashboardResults"] = [];
    const restoredInstances = new Set<string>();
    const restoredTargets = new Set<string>();
    const clients = new Map<
      string,
      {
        client: GrafanaApi;
        baseUrl: string;
        folderCache: GrafanaFolder[];
      }
    >();

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

        const entry: DashboardManifestEntry = {
          name: dashboard.selectorName,
          uid: dashboard.baseUid,
          path: dashboard.path,
        };
        const normalizedDashboard = normalizeDashboardDatasourceRefsFromCatalog(
          {
            ...sanitizeDashboardForStorage(rawDashboard),
            uid: dashboard.baseUid,
          },
          await this.repository.readDatasourceCatalog(),
          target.instanceName,
        );
        const snapshot: DashboardRevisionSnapshot = {
          version: 1,
          dashboard: normalizedDashboard,
          ...(normalizeFolderPath(dashboard.folderPath) ? { folderPath: normalizeFolderPath(dashboard.folderPath) } : {}),
        };
        const revision = await this.createOrReuseRevision(
          entry,
          snapshot,
          {
            kind: "manual",
            instanceName: target.instanceName,
            targetName: target.targetName,
            effectiveDashboardUid: dashboard.effectiveDashboardUid,
          },
        );
        const previousRevisionState = await this.targetRevisionState(entry, target.instanceName, target.targetName).catch(
          () => undefined,
        );
        const targetState = await this.updateTargetRevision(entry, target.instanceName, target.targetName, revision.id, {
          ...(normalizeFolderPath(dashboard.folderPath) ? { folderPath: normalizeFolderPath(dashboard.folderPath) } : {}),
        });
        targetState.revisionStates[revision.id] = this.buildRevisionState(
          normalizedDashboard,
          previousRevisionState?.revisionState,
        );
        await this.repository.saveTargetOverrideFile(target.instanceName, target.targetName, entry, targetState);
      }
    }

    return {
      instanceCount: restoredInstances.size,
      targetCount: restoredTargets.size,
      dashboardCount: dashboardResults.length,
      dashboardResults,
    };
  }

  async pullDashboardRevisionFromTarget(
    entry: DashboardManifestEntry,
    instanceName: string,
    targetName: string,
  ): Promise<DashboardRevisionRecord> {
    await this.assertPullTargetIsDevTarget(instanceName, targetName);
    const client = await this.clientFactory(instanceName);
    const folders = await client.listFolders();
    const targetState = await this.materializeDashboardUidForTarget(this.repository, instanceName, targetName, entry);
    const effectiveDashboardUid = this.effectiveDashboardUidForTarget(entry, targetName, targetState);
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
    const revision = await this.createOrUpdatePulledRevision(
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
      folderPath,
      updateFolderMeta: true,
    });
    const nextTargetState = await this.updateTargetRevision(entry, instanceName, targetName, revision.id, {
      ...(normalizeFolderPath(folderPath) ? { folderPath: normalizeFolderPath(folderPath) } : {}),
    });
    nextTargetState.revisionStates[revision.id] = this.buildRevisionState(
      normalizedDashboard,
      targetState?.currentRevisionId ? targetState.revisionStates[targetState.currentRevisionId] : undefined,
    );
    await this.repository.saveTargetOverrideFile(instanceName, targetName, entry, nextTargetState);
    return revision;
  }

  async deployRevision(
    entry: DashboardManifestEntry,
    revisionIdValue: string,
    instanceName: string,
    targetName: string,
  ): Promise<DeploySummary> {
    const revision = await this.revisionById(entry, revisionIdValue);
    if (!revision) {
      throw new Error(`Revision not found: ${revisionIdValue}`);
    }
    await this.updateTargetRevision(entry, instanceName, targetName, revision.id);
    return this.deployDashboards([entry], instanceName, targetName);
  }

  async setTargetRevision(
    entry: DashboardManifestEntry,
    revisionIdValue: string,
    instanceName: string,
    targetName: string,
  ): Promise<DashboardTargetState> {
    const revision = await this.revisionById(entry, revisionIdValue);
    if (!revision) {
      throw new Error(`Revision not found: ${revisionIdValue}`);
    }
    return this.updateTargetRevision(entry, instanceName, targetName, revision.id);
  }

  async deleteRevision(entry: DashboardManifestEntry, revisionIdValue: string): Promise<void> {
    const index = await this.ensureDashboardVersionIndex(entry);
    const revision = index.revisions.find((candidate) => candidate.id === revisionIdValue);
    if (!revision) {
      throw new Error(`Revision not found: ${revisionIdValue}`);
    }
    if (index.revisions.length <= 1) {
      throw new Error("Cannot delete the last remaining revision.");
    }
    if (index.checkedOutRevisionId === revisionIdValue) {
      throw new Error("Cannot delete the checked out revision.");
    }

    const targets = await this.repository.listAllDeploymentTargets();
    const activeTargets: string[] = [];
    for (const target of targets) {
      const targetState = await this.repository.readTargetOverrideFile(target.instanceName, target.name, entry);
      if (targetState?.currentRevisionId === revisionIdValue) {
        activeTargets.push(`${target.instanceName}/${target.name}`);
      }
    }
    if (activeTargets.length > 0) {
      throw new Error(`Cannot delete revision ${revisionIdValue} because it is active on: ${activeTargets.join(", ")}`);
    }

    for (const target of targets) {
      const targetState = await this.repository.readTargetOverrideFile(target.instanceName, target.name, entry);
      if (!targetState?.revisionStates?.[revisionIdValue]) {
        continue;
      }
      const nextRevisionStates = { ...targetState.revisionStates };
      delete nextRevisionStates[revisionIdValue];
      await this.repository.saveTargetOverrideFile(target.instanceName, target.name, entry, {
        ...targetState,
        revisionStates: nextRevisionStates,
      });
    }

    await this.repository.saveDashboardVersionIndex(entry, {
      ...index,
      revisions: index.revisions.filter((candidate) => candidate.id !== revisionIdValue),
    });
    await this.repository.deleteDashboardRevisionSnapshot(entry, revisionIdValue);
  }

  async dashboardBrowserUrl(
    entry: DashboardManifestEntry,
    instanceName: string,
    targetName: string,
  ): Promise<string> {
    const targetState = await this.ensureTargetState(entry, instanceName, targetName);
    const effectiveDashboardUid = this.effectiveDashboardUidForTarget(entry, targetName, targetState);
    if (!effectiveDashboardUid) {
      throw new Error(`Dashboard UID is not materialized for ${selectorNameForEntry(entry)} on ${instanceName}/${targetName}.`);
    }

    const instanceValues = await this.repository.loadInstanceEnvValues(instanceName);
    const baseUrl = instanceValues.GRAFANA_URL?.trim();
    if (!baseUrl) {
      throw new Error(`GRAFANA_URL is not configured for ${instanceName}.`);
    }

    const fallbackUrl = new URL(`d/${encodeURIComponent(effectiveDashboardUid)}`, `${baseUrl.replace(/\/+$/, "")}/`).toString();

    try {
      const client = await this.clientFactory(instanceName);
      const response = await client.getDashboardByUid(effectiveDashboardUid);
      const metaUrl = response.meta.url?.trim();
      return metaUrl ? new URL(metaUrl, `${baseUrl.replace(/\/+$/, "")}/`).toString() : fallbackUrl;
    } catch {
      return fallbackUrl;
    }
  }

  private effectiveDashboardUidForTarget(
    entry: DashboardManifestEntry,
    targetName: string,
    overrideFile: DashboardTargetState | undefined,
  ): string | undefined {
    const dashboardUid = overrideFile?.dashboardUid?.trim();
    return dashboardUid || entry.uid;
  }

  private async materializeDashboardUidForTarget(
    sourceRepository: ProjectRepository,
    instanceName: string,
    targetName: string,
    entry: DashboardManifestEntry,
  ): Promise<DashboardTargetState | undefined> {
    const existingOverride = await sourceRepository.readTargetOverrideFile(instanceName, targetName, entry);
    return existingOverride;
  }

  private async materializeDashboardUidsForInstance(
    sourceRepository: ProjectRepository,
    instanceName: string,
  ): Promise<void> {
    const targets = await sourceRepository.listDeploymentTargets(instanceName);
    const records = await sourceRepository.listDashboardRecords();

    for (const target of targets) {
      for (const record of records) {
        const overrideFile = await this.materializeDashboardUidForTarget(
          sourceRepository,
          target.instanceName,
          target.name,
          record.entry,
        );
        if (overrideFile?.dashboardUid) {
          continue;
        }
        await sourceRepository.saveTargetOverrideFile(target.instanceName, target.name, record.entry, {
          ...overrideFile,
          dashboardUid: randomUUID(),
          revisionStates: overrideFile?.revisionStates ?? {},
        });
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
    await this.assertPullTargetIsDevTarget(instanceName, targetName);

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
      const existingState = await this.materializeDashboardUidForTarget(this.repository, instanceName, targetName, entry);
      const effectiveDashboardUid = this.effectiveDashboardUidForTarget(entry, targetName, existingState);
      if (!effectiveDashboardUid) {
        throw new Error(`Dashboard UID is not materialized for ${selectorName} on ${instanceName}/${targetName}.`);
      }

      const response = await client.getDashboardByUid(effectiveDashboardUid);
      const pulledDashboard = sanitizeDashboardForStorage(response.dashboard);

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
      const pulledFolderPath =
        response.meta.folderUid
          ? buildFolderPathByUid(response.meta.folderUid, folders) ||
            normalizeFolderPath(
              response.meta.folderTitle ||
                folders.find((folder) => folder.uid === response.meta.folderUid)?.title ||
                path.basename(path.dirname(entry.path)),
            )
          : undefined;
      const snapshot: DashboardRevisionSnapshot = {
        version: 1,
        dashboard,
        ...(normalizeFolderPath(pulledFolderPath) ? { folderPath: normalizeFolderPath(pulledFolderPath) } : {}),
      };
      const revision = await this.createOrUpdatePulledRevision(
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
      if (folderMetaPath && (normalizeFolderPath(pulledFolderPath) || response.meta.folderUid)) {
        const folderMetaOutcome = await this.repository.syncPulledFile({
          sourceContent: stableJsonStringify({
            ...(normalizeFolderPath(pulledFolderPath) ? { path: normalizeFolderPath(pulledFolderPath) } : {}),
            ...(response.meta.folderUid ? { uid: response.meta.folderUid } : {}),
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

      await this.checkoutRevisionSnapshot(entry, revision, snapshot, {
        folderUid: response.meta.folderUid,
        folderPath: pulledFolderPath,
        updateFolderMeta: Boolean(folderMetaPath),
      });

      const previousRevisionState =
        existingState?.currentRevisionId ? existingState.revisionStates[existingState.currentRevisionId] : undefined;
      const previousManagedVariables = new Set(Object.keys(previousRevisionState?.variableOverrides ?? {}));
      const pulledVariableDefaults = this.variableDefaultsFromDashboard(dashboard);
      const nextTargetState = await this.updateTargetRevision(entry, instanceName, targetName, revision.id, {
        ...(normalizeFolderPath(pulledFolderPath) ? { folderPath: normalizeFolderPath(pulledFolderPath) } : {}),
      });
      const inheritedRevisionState = this.buildRevisionState(dashboard, previousRevisionState);
      nextTargetState.revisionStates[revision.id] = {
        ...inheritedRevisionState,
        variableOverrides: Object.fromEntries(
          [...previousManagedVariables]
            .filter((variableName) => pulledVariableDefaults[variableName] !== undefined)
            .map((variableName) => [variableName, pulledVariableDefaults[variableName]!]),
        ) as Record<string, DashboardOverrideValue>,
      };
      await this.repository.saveTargetOverrideFile(instanceName, targetName, entry, nextTargetState);

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

    const renderManifest = await this.renderDashboardSnapshots(
      await Promise.all(
        entries.map(async (entry) => {
          const targetRevision = await this.targetRevisionState(entry, instanceName, targetName, sourceRepository);
          return {
            entry,
            snapshot: targetRevision.snapshot,
            revisionId: targetRevision.revision.id,
            targetState: targetRevision.targetState,
            revisionState: targetRevision.revisionState,
          };
        }),
      ),
      instanceName,
      targetName,
      renderScopeForEntries(entries),
      {
        sourceRepository,
      },
    );
    try {
      await this.createTargetBackup(entries, instanceName, targetName, backupScopeForEntries(entries));
    } catch (error) {
      if (!this.isMissingDashboardError(error)) {
        throw error;
      }
      this.log.info(
        `Skipping pre-deploy backup for ${instanceName}/${targetName}: target dashboard is missing (${String(error)}).`,
      );
    }
    return this.deployRenderedManifest(renderManifest, instanceName, targetName, client, connection.baseUrl, folderCache);
  }

  private isMissingDashboardError(error: unknown): boolean {
    const message = String(error);
    return message.includes("Grafana API GET /api/dashboards/uid/") && message.includes("failed with 404");
  }

  private async renderDashboardSnapshots(
    items: Array<{
      entry: DashboardManifestEntry;
      snapshot: DashboardRevisionSnapshot;
      revisionId?: string;
      targetState: DashboardTargetState;
      revisionState: DashboardTargetRevisionState;
    }>,
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

    for (const { entry, snapshot, revisionId, targetState, revisionState } of items) {
      const renderedDashboard = await this.renderDashboardForTarget(
        sourceRepository,
        entry,
        snapshot.dashboard,
        targetState,
        revisionState,
        instanceName,
        targetName,
      );
      const folderPath = normalizeFolderPath(targetState.folderPath ?? snapshot.folderPath);
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
    const targetRevision = await this.targetRevisionState(entry, instanceName, targetName);
    const overrideFile = generateOverrideFileFromDashboard(targetRevision.snapshot.dashboard);
    const variableCount = Object.keys(overrideFile.variableOverrides).length;
    if (variableCount === 0) {
      throw new Error("No supported dashboard variables found. Only custom, textbox, and constant are supported.");
    }

    const nextTargetState = {
      ...targetRevision.targetState,
      revisionStates: {
        ...targetRevision.targetState.revisionStates,
        [targetRevision.revision.id]: {
          ...targetRevision.revisionState,
          variableOverrides: overrideFile.variableOverrides,
        },
      },
    };
    const overridePath = await this.repository.saveTargetOverrideFile(instanceName, targetName, entry, nextTargetState);
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
    const targetRevision = await this.targetRevisionState(entry, instanceName, targetName);
    const effectiveDashboard = applyOverridesToDashboard(targetRevision.snapshot.dashboard, targetRevision.revisionState);
    const targets = await this.repository.listAllDeploymentTargets();
    const globallyManagedVariableNames = new Set<string>();
    for (const target of targets) {
      const targetRevisionState = await this.targetRevisionState(entry, target.instanceName, target.name).catch(() => undefined);
      if (!targetRevisionState) {
        continue;
      }
      for (const variableName of Object.keys(targetRevisionState.revisionState.variableOverrides ?? {})) {
        globallyManagedVariableNames.add(variableName);
      }
    }

    return extractSupportedVariables(effectiveDashboard, targetRevision.revisionState).map((descriptor) => {
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
    const selectedTargetRevision = await this.targetRevisionState(entry, instanceName, targetName);
    const supportedVariables = new Map(
      extractSupportedVariables(selectedTargetRevision.snapshot.dashboard).map((descriptor) => [descriptor.name, descriptor]),
    );
    const currentVariables: DashboardTargetRevisionState["variableOverrides"] = {};
    const enabledVariableNames = Object.keys(values)
      .filter((key) => key.startsWith("override_enabled__"))
      .map((key) => key.slice("override_enabled__".length));

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
    const nextRevisionState: DashboardTargetRevisionState = {
      ...selectedTargetRevision.revisionState,
      variableOverrides: currentVariables,
    };
    const nextTargetState: DashboardTargetState = {
      ...selectedTargetRevision.targetState,
      revisionStates: {
        ...selectedTargetRevision.targetState.revisionStates,
        [selectedTargetRevision.revision.id]: nextRevisionState,
      },
    };
    await this.repository.saveTargetOverrideFile(instanceName, targetName, entry, nextTargetState);

    return this.repository.targetOverridePath(instanceName, targetName, entry);
  }

  private async materializeManagedOverridesForTarget(instanceName: string, targetName: string): Promise<void> {
    const records = await this.repository.listDashboardRecords();

    for (const record of records) {
      const currentTargetState = await this.targetRevisionState(record.entry, instanceName, targetName).catch(() => undefined);
      if (!currentTargetState) {
        continue;
      }
      currentTargetState.targetState.dashboardUid ??= randomUUID();
      await this.repository.saveTargetOverrideFile(instanceName, targetName, record.entry, currentTargetState.targetState);
    }
  }

  async buildPlacementDetails(
    instanceName: string,
    targetName: string,
    entry: DashboardManifestEntry,
  ): Promise<PlacementDetails> {
    const folderMeta = await this.repository.readFolderMetadata(entry);
    const overrideFile = await this.ensureTargetState(entry, instanceName, targetName);
    const baseFolderPath = normalizeFolderPath(folderMeta?.path);
    const overrideFolderPath = normalizeFolderPath(overrideFile?.folderPath);
    const overrideDashboardUid = overrideFile?.dashboardUid?.trim() || undefined;
    return {
      ...(overrideFile.currentRevisionId ? { currentRevisionId: overrideFile.currentRevisionId } : {}),
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
    const existingOverride = await this.ensureTargetState(entry, instanceName, targetName);
    const normalizedFolderPath = normalizeFolderPath(folderPath);
    const nextOverride: DashboardTargetState = {
      ...(existingOverride.currentRevisionId ? { currentRevisionId: existingOverride.currentRevisionId } : {}),
      ...(existingOverride.dashboardUid ? { dashboardUid: existingOverride.dashboardUid } : {}),
      ...(normalizedFolderPath ? { folderPath: normalizedFolderPath } : {}),
      revisionStates: existingOverride.revisionStates,
    };
    await this.repository.saveTargetOverrideFile(instanceName, targetName, entry, nextOverride);
    return this.repository.dashboardOverridesFilePath(entry);
  }

  async saveDatasourceSelections(
    instanceName: string,
    targetName: string,
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

    const targetRevision = await this.targetRevisionState(record.entry, instanceName, targetName);
    const dashboardSourceNames = new Set(extractDashboardDatasourceRefs(targetRevision.snapshot.dashboard).map((ref) => ref.sourceUid));
    const instances = await this.repository.listInstances();
    const catalog = ensureDatasourceCatalogInstances(
      await this.repository.readDatasourceCatalog(),
      [...new Set([...instances.map((instance) => instance.name), instanceName])],
    );

    for (const sourceName of dashboardSourceNames) {
      catalog.datasources[sourceName] ??= { instances: {} };
    }

    const nextBindings = {
      ...targetRevision.revisionState.datasourceBindings,
    };

    for (const value of values) {
      const currentSourceName = value.currentSourceName.trim();
      const nextSourceName = value.nextSourceName.trim();
      if (!currentSourceName || !nextSourceName || !dashboardSourceNames.has(currentSourceName)) {
        continue;
      }
      catalog.datasources[nextSourceName] ??= { instances: {} };
      const normalizedTargetUid = value.targetUid?.trim();
      const normalizedTargetName = value.targetName?.trim();
      catalog.datasources[nextSourceName]!.instances[instanceName] =
        normalizedTargetUid || normalizedTargetName
          ? {
              ...(normalizedTargetUid ? { uid: normalizedTargetUid } : {}),
              ...(normalizedTargetName ? { name: normalizedTargetName } : {}),
            }
          : {};
      nextBindings[currentSourceName] = nextSourceName;
    }

    for (const sourceName of [...Object.keys(nextBindings)]) {
      if (!dashboardSourceNames.has(sourceName)) {
        delete nextBindings[sourceName];
      }
    }

    await this.repository.saveTargetOverrideFile(instanceName, targetName, record.entry, {
      ...targetRevision.targetState,
      revisionStates: {
        ...targetRevision.targetState.revisionStates,
        [targetRevision.revision.id]: {
          ...targetRevision.revisionState,
          datasourceBindings: nextBindings,
        },
      },
    });
    await this.repository.saveDatasourceCatalog(catalog);
  }

  async buildTargetDatasourceRows(
    instanceName: string,
    targetName: string,
    entry: DashboardManifestEntry,
  ): Promise<TargetDatasourceBindingRow[]> {
    const targetRevision = await this.targetRevisionState(entry, instanceName, targetName);
    const datasourceCatalog = await this.repository.readDatasourceCatalog();
    return buildDashboardDatasourceDescriptors(targetRevision.snapshot.dashboard)
      .map((descriptor) => {
        const globalDatasourceKey = targetRevision.revisionState.datasourceBindings[descriptor.sourceUid] ?? descriptor.sourceUid;
        const target = datasourceCatalog.datasources[globalDatasourceKey]?.instances[instanceName];
        return {
          datasourceKey: descriptor.sourceUid,
          sourceLabel: descriptor.label,
          sourceType: descriptor.type,
          usageCount: descriptor.usageCount,
          usageKinds: descriptor.usageKinds,
          globalDatasourceKey,
          targetUid: target?.uid,
          targetName: target?.name,
        };
      })
      .sort((left, right) => left.datasourceKey.localeCompare(right.datasourceKey));
  }

  async buildGlobalDatasourceUsageRows(instanceName: string): Promise<GlobalDatasourceUsageRow[]> {
    const datasourceCatalog = await this.repository.readDatasourceCatalog();
    const records = await this.repository.listDashboardRecords();
    const targets = await this.repository.listAllDeploymentTargets();
    const rowMap = new Map<string, GlobalDatasourceUsageRow>();

    for (const record of records) {
      for (const target of targets) {
        const targetRevision = await this.targetRevisionState(record.entry, target.instanceName, target.name).catch(() => undefined);
        if (!targetRevision) {
          continue;
        }
        for (const globalDatasourceKey of Object.values(targetRevision.revisionState.datasourceBindings)) {
          const row = rowMap.get(globalDatasourceKey) ?? {
            globalDatasourceKey,
            dashboards: [],
            instanceUid: datasourceCatalog.datasources[globalDatasourceKey]?.instances[instanceName]?.uid,
            instanceName: datasourceCatalog.datasources[globalDatasourceKey]?.instances[instanceName]?.name,
          };
          if (!row.dashboards.includes(record.selectorName)) {
            row.dashboards.push(record.selectorName);
          }
          rowMap.set(globalDatasourceKey, row);
        }
      }
    }

    for (const [globalDatasourceKey, catalogEntry] of Object.entries(datasourceCatalog.datasources)) {
      rowMap.set(globalDatasourceKey, rowMap.get(globalDatasourceKey) ?? {
        globalDatasourceKey,
        dashboards: [],
        instanceUid: catalogEntry.instances[instanceName]?.uid,
        instanceName: catalogEntry.instances[instanceName]?.name,
      });
    }

    return [...rowMap.values()]
      .map((row) => ({
        ...row,
        dashboards: [...row.dashboards].sort((left, right) => left.localeCompare(right)),
      }))
      .sort((left, right) => left.globalDatasourceKey.localeCompare(right.globalDatasourceKey));
  }

  async buildTargetDashboardSummaryRows(
    instanceName: string,
    targetName: string,
  ): Promise<TargetDashboardSummaryRow[]> {
    const records = await this.repository.listDashboardRecords();
    const datasourceCatalog = await this.repository.readDatasourceCatalog();
    return Promise.all(
      records.map(async (record) => {
        const targetRevision = await this.targetRevisionState(record.entry, instanceName, targetName).catch(() => undefined);
        const liveStatus = (await this.listLiveTargetVersionStatuses(record.entry)).find(
          (status) => status.instanceName === instanceName && status.targetName === targetName,
        );
        if (!targetRevision) {
          return {
            selectorName: record.selectorName,
            datasourceStatus: "missing",
            liveStatus: liveStatus?.state,
            liveMatchedRevisionId: liveStatus?.matchedRevisionId,
          } as TargetDashboardSummaryRow;
        }
        const missingMappings = findMissingDatasourceMappings(
          this.renameDatasourceBindings(targetRevision.snapshot.dashboard, targetRevision.revisionState.datasourceBindings),
          datasourceCatalog,
          instanceName,
        );
        return {
          selectorName: record.selectorName,
          currentRevisionId: targetRevision.targetState.currentRevisionId,
          effectiveDashboardUid: this.effectiveDashboardUidForTarget(record.entry, targetName, targetRevision.targetState),
          effectiveFolderPath: normalizeFolderPath(targetRevision.targetState.folderPath),
          datasourceStatus: missingMappings.length > 0 ? "missing" : "complete",
          liveStatus: liveStatus?.state,
          liveMatchedRevisionId: liveStatus?.matchedRevisionId,
        } as TargetDashboardSummaryRow;
      }),
    );
  }

  private async renderDashboardForTarget(
    sourceRepository: ProjectRepository,
    entry: DashboardManifestEntry,
    baseDashboard: Record<string, unknown>,
    targetState: DashboardTargetState,
    revisionState: DashboardTargetRevisionState,
    instanceName: string,
    targetName: string,
  ): Promise<Record<string, unknown>> {
    const datasourceCatalog = await sourceRepository.readDatasourceCatalog();
    const boundDashboard = this.renameDatasourceBindings(baseDashboard, revisionState.datasourceBindings);
    const dashboardWithVariableOverrides = applyOverridesToDashboard(boundDashboard, revisionState);
    dashboardWithVariableOverrides.uid = this.effectiveDashboardUidForTarget(entry, targetName, targetState);
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
