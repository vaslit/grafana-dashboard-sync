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
  grafanaNamespace?: string;
  targets: Record<
    string,
    {
      defaults?: Record<string, DashboardOverrideValue>;
    }
  >;
}

export interface WorkspaceProjectConfig {
  version: 2;
  layout: {
    dashboardsDir: string;
    instancesDir?: string;
    backupsDir: string;
    rendersDir: string;
    maxBackups: number;
  };
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

export interface DashboardOverrideFile {
  dashboardUid?: string;
  folderPath?: string;
  variables: Record<string, DashboardOverrideValue>;
}

export interface DashboardFolderOverridesFile {
  dashboards: Record<
    string,
    {
      targets: Record<string, DashboardOverrideFile>;
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
  defaultsPath: string;
  defaultsExists: boolean;
}

export interface DeploymentTargetRecord {
  instanceName: string;
  name: string;
  dirPath: string;
  defaultsPath: string;
  defaultsExists: boolean;
}

export interface EffectiveConnectionConfig {
  baseUrl: string;
  token: string;
  namespace: string;
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

export type TargetBackupScope = "dashboard" | "target";

export interface TargetBackupDashboardRecord {
  selectorName: string;
  baseUid: string;
  effectiveDashboardUid: string;
  path: string;
  folderPath?: string;
  title: string;
  snapshotPath: string;
}

export interface BackupManifest {
  version: 1;
  kind: "target-backup";
  backupName: string;
  generatedAt: string;
  scope: TargetBackupScope;
  instanceName: string;
  targetName: string;
  dashboardCount: number;
  dashboards: TargetBackupDashboardRecord[];
  retentionLimit: number;
}

export interface BackupRecord {
  name: string;
  rootPath: string;
  manifestPath: string;
  generatedAt: string;
  scope: TargetBackupScope;
  instanceName: string;
  targetName: string;
  dashboardCount: number;
  dashboards: TargetBackupDashboardRecord[];
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
  effectiveDashboardUid?: string;
  matchedRevisionId?: string;
  state: "matched" | "unversioned" | "error";
  detail?: string;
}

export interface InstanceDetailsModel {
  instance: InstanceRecord;
  envValues: Record<string, string>;
  mergedConnection?: EffectiveConnectionConfig;
  hasConnection: boolean;
  tokenConfigured: boolean;
  tokenSourceLabel?: string;
}

export interface DeploymentTargetDetailsModel {
  target: DeploymentTargetRecord;
  defaultsValues: Record<string, DashboardOverrideValue>;
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
