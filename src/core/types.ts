export interface DashboardManifestEntry {
  name?: string;
  uid: string;
  path: string;
}

export interface DashboardManifest {
  dashboards: DashboardManifestEntry[];
}

export interface WorkspaceInstanceConfig {
  grafanaUrl?: string;
  grafanaUsername?: string;
  targets: Record<string, Record<string, never>>;
}

export interface WorkspaceDevTargetConfig {
  instanceName: string;
  targetName: string;
}

export interface WorkspaceProjectConfig {
  version: 4;
  layout: {
    dashboardsDir: string;
    instancesDir?: string;
    backupsDir: string;
    rendersDir: string;
    maxBackups: number;
  };
  devTarget?: WorkspaceDevTargetConfig;
  dashboards: DashboardManifestEntry[];
  datasources: DatasourceCatalogFile["datasources"];
  instances: Record<string, WorkspaceInstanceConfig>;
}

export interface FolderMetadata {
  uid?: string;
  path?: string;
}

export type DashboardOverrideScalar = string | number | boolean | null;

export interface DashboardOverrideObject {
  text: unknown;
  value: unknown;
}

export type DashboardOverrideValue = DashboardOverrideScalar | DashboardOverrideObject;

export interface DashboardTargetRevisionState {
  variableOverrides: Record<string, DashboardOverrideValue>;
  datasourceBindings: Record<string, string>;
}

export interface DashboardTargetState {
  currentRevisionId?: string;
  dashboardUid?: string;
  folderPath?: string;
  revisionStates: Record<string, DashboardTargetRevisionState>;
}

export type DashboardOverrideFile = DashboardTargetState;

export interface DashboardFolderOverridesFile {
  dashboards: Record<
    string,
    {
      targets: Record<string, DashboardTargetState>;
    }
  >;
}

export interface DashboardRevisionSnapshot {
  version: 1;
  dashboard: Record<string, unknown>;
  folderPath?: string;
}

export type DashboardRevisionSourceKind = "migration" | "pull" | "deploy" | "manual";

export interface DashboardRevisionSource {
  kind: DashboardRevisionSourceKind;
  instanceName?: string;
  targetName?: string;
  effectiveDashboardUid?: string;
}

export interface DashboardRevisionRecord {
  id: string;
  createdAt: string;
  contentHash: string;
  templateHash: string;
  snapshotPath: string;
  baseFolderPath?: string;
  source: DashboardRevisionSource;
}

export interface DashboardVersionIndex {
  checkedOutRevisionId?: string;
  revisions: DashboardRevisionRecord[];
}

export interface DatasourceCatalogInstanceTarget {
  uid?: string;
  name?: string;
}

export interface DatasourceCatalogEntry {
  instances: Record<string, DatasourceCatalogInstanceTarget>;
}

export interface DatasourceCatalogFile {
  datasources: Record<string, DatasourceCatalogEntry>;
}

export interface DashboardDatasourceRef {
  sourceUid: string;
  type?: string;
  usageCount: number;
  usageKinds: Array<"panel" | "query" | "variable">;
}

export interface DashboardDatasourceDescriptor extends DashboardDatasourceRef {
  key: string;
  label: string;
  sourceName?: string;
}

export interface DashboardRecord {
  entry: DashboardManifestEntry;
  selectorName: string;
  absolutePath: string;
  exists: boolean;
  title?: string;
  folderMetaPath?: string;
}

export interface InstanceRecord {
  name: string;
  dirPath: string;
  envPath: string;
  envExists: boolean;
  envExamplePath: string;
}

export interface DeploymentTargetRecord {
  instanceName: string;
  name: string;
  dirPath: string;
}

export interface EffectiveConnectionConfig {
  baseUrl: string;
  authKind: "bearer" | "basic";
  token?: string;
  username?: string;
  password?: string;
  sourceLabel: string;
}

export interface SupportedVariableDescriptor {
  name: string;
  type: string;
  currentText: unknown;
  currentValue: unknown;
  savedOverride?: DashboardOverrideValue;
  overrideOptions?: Array<{ label: string; value: string }>;
}

export interface PullFileResult {
  kind: "dashboard" | "folderMeta";
  relativePath: string;
  status: "updated" | "skipped";
  targetPath: string;
  backupPath?: string;
  previousPath?: string;
}

export interface PullDashboardResult {
  entry: DashboardManifestEntry;
  selectorName: string;
  fileResults: PullFileResult[];
}

export interface PullSummary {
  backupName?: string;
  backupRoot?: string;
  updatedCount: number;
  skippedCount: number;
  previousLocalBackupCount: number;
  dashboardResults: PullDashboardResult[];
}

export type BackupScope = "dashboard" | "target" | "instance" | "multi-instance";

export interface BackupDashboardRecord {
  selectorName: string;
  baseUid: string;
  effectiveDashboardUid: string;
  path: string;
  folderPath?: string;
  title: string;
  snapshotPath: string;
}

export interface BackupTargetRecord {
  instanceName: string;
  targetName: string;
  dashboardCount: number;
  dashboards: BackupDashboardRecord[];
}

export interface BackupInstanceRecord {
  instanceName: string;
  targetCount: number;
  dashboardCount: number;
  targets: BackupTargetRecord[];
}

export interface BackupManifest {
  version: 2;
  kind: "grouped-backup";
  backupName: string;
  generatedAt: string;
  scope: BackupScope;
  instanceCount: number;
  targetCount: number;
  dashboardCount: number;
  instances: BackupInstanceRecord[];
  retentionLimit: number;
}

export interface BackupRecord {
  name: string;
  rootPath: string;
  manifestPath: string;
  generatedAt: string;
  scope: BackupScope;
  instanceCount: number;
  targetCount: number;
  dashboardCount: number;
  instances: BackupInstanceRecord[];
}

export type BackupRestoreSelection =
  | { kind: "backup" }
  | { kind: "instance"; instanceName: string }
  | { kind: "target"; instanceName: string; targetName: string }
  | { kind: "dashboard"; instanceName: string; targetName: string; selectorName: string };

export interface RestoreSummary {
  instanceCount: number;
  targetCount: number;
  dashboardCount: number;
  dashboardResults: DeployDashboardResult[];
}

export type RenderScope = "dashboard" | "target";

export interface RenderManifestDashboardRecord {
  selectorName: string;
  baseUid: string;
  effectiveDashboardUid: string;
  path: string;
  folderPath?: string;
  title: string;
  renderPath: string;
  revisionId?: string;
}

export interface RenderManifest {
  version: 1;
  instanceName: string;
  targetName: string;
  generatedAt: string;
  scope: RenderScope;
  dashboards: RenderManifestDashboardRecord[];
}

export interface DeployDashboardResult {
  entry: DashboardManifestEntry;
  selectorName: string;
  dashboardTitle: string;
  folderUid?: string;
  url?: string;
  targetBaseUrl: string;
  deploymentTargetName?: string;
}

export interface DeploySummary {
  instanceName?: string;
  deploymentTargetName?: string;
  dashboardResults: DeployDashboardResult[];
}

export interface OverrideGenerationResult {
  overridePath: string;
  variableCount: number;
}

export interface LogSink {
  info(message: string): void;
  error(message: string): void;
}

export interface GrafanaDashboardResponse {
  dashboard: Record<string, unknown>;
  meta: {
    folderUid?: string;
    folderTitle?: string;
    url?: string;
  };
}

export interface GrafanaFolder {
  uid: string;
  title: string;
  parentUid?: string;
}

export interface GrafanaDashboardSummary {
  uid: string;
  title: string;
  folderUid?: string;
  folderTitle?: string;
  url?: string;
}

export interface GrafanaDatasourceSummary {
  uid: string;
  name: string;
  type?: string;
  isDefault?: boolean;
}

export interface GrafanaUpsertResponse {
  uid?: string;
  url?: string;
  status?: string;
}

export interface GrafanaApi {
  getDashboardByUid(uid: string): Promise<GrafanaDashboardResponse>;
  listDashboards(): Promise<GrafanaDashboardSummary[]>;
  listDatasources(): Promise<GrafanaDatasourceSummary[]>;
  listFolders(parentUid?: string): Promise<GrafanaFolder[]>;
  createFolder(input: { title: string; uid?: string; parentUid?: string }): Promise<GrafanaFolder>;
  upsertDashboard(input: {
    dashboard: Record<string, unknown>;
    folderUid?: string;
    message: string;
  }): Promise<GrafanaUpsertResponse>;
}

export interface DashboardDetailsModel {
  entry: DashboardManifestEntry;
  selectorName: string;
  exists: boolean;
  title?: string;
}

export interface DashboardRevisionListItem {
  record: DashboardRevisionRecord;
  isCheckedOut: boolean;
}

export interface LiveTargetVersionStatus {
  instanceName: string;
  targetName: string;
  storedRevisionId?: string;
  effectiveDashboardUid?: string;
  effectiveFolderPath?: string;
  matchedRevisionId?: string;
  datasourceStatus?: "complete" | "missing";
  state: "matched" | "diverged" | "unversioned" | "error";
  detail?: string;
}

export interface InstanceDetailsModel {
  instance: InstanceRecord;
  envValues: Record<string, string>;
  mergedConnection?: EffectiveConnectionConfig;
  hasConnection: boolean;
  tokenConfigured: boolean;
  tokenSourceLabel?: string;
  passwordConfigured: boolean;
  passwordSourceLabel?: string;
}

export interface DeploymentTargetDetailsModel {
  target: DeploymentTargetRecord;
}

export interface OverrideEditorVariableModel {
  name: string;
  type: string;
  currentText: string;
  currentValue: string;
  savedOverride: string;
  hasSavedOverride: boolean;
  overrideOptions?: Array<{ label: string; value: string }>;
}

export interface TargetDatasourceBindingRow {
  datasourceKey: string;
  sourceLabel: string;
  sourceType?: string;
  usageCount?: number;
  usageKinds?: Array<"panel" | "query" | "variable">;
  globalDatasourceKey: string;
  targetUid?: string;
  targetName?: string;
}

export interface GlobalDatasourceUsageRow {
  globalDatasourceKey: string;
  sourceType?: string;
  dashboards: string[];
  instanceUid?: string;
  instanceName?: string;
}

export interface TargetDashboardSummaryRow {
  selectorName: string;
  currentRevisionId?: string;
  effectiveDashboardUid?: string;
  effectiveFolderPath?: string;
  datasourceStatus: "complete" | "missing";
  liveStatus?: LiveTargetVersionStatus["state"];
  liveMatchedRevisionId?: string;
}
