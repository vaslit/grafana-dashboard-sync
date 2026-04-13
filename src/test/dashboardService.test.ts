import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DashboardService } from "../core/dashboardService";
import { selectorNameForEntry } from "../core/manifest";
import { ProjectRepository } from "../core/repository";
import {
  DashboardManifestEntry,
  GrafanaApi,
  GrafanaDashboardResponse,
  GrafanaDashboardSummary,
  GrafanaDatasourceSummary,
  GrafanaFolder,
  GrafanaUpsertResponse,
  LogSink,
} from "../core/types";

class MockGrafanaClient implements GrafanaApi {
  private readonly alertRules: Array<Record<string, unknown>>;
  private readonly alertContactPoints: Array<Record<string, unknown>>;
  private readonly operationLog?: string[];

  constructor(
    private readonly dashboardResponse: GrafanaDashboardResponse,
    private readonly folders: GrafanaFolder[],
    private readonly onUpsert: (payload: { dashboard: Record<string, unknown>; folderUid?: string; message: string }) => void,
    private readonly datasources: GrafanaDatasourceSummary[] = [],
    private readonly onGetDashboardByUid: (uid: string) => void = () => {},
    private readonly alertExport?: {
      rules?: Array<Record<string, unknown>>;
      contactPoints?: Array<Record<string, unknown>>;
      failAlertRules?: boolean;
      failContactPoints?: boolean;
      operationLog?: string[];
    },
  ) {
    this.alertRules = [...(alertExport?.rules ?? [])];
    this.alertContactPoints = [...(alertExport?.contactPoints ?? [])];
    this.operationLog = alertExport?.operationLog;
  }

  async getDashboardByUid(uid: string): Promise<GrafanaDashboardResponse> {
    this.onGetDashboardByUid(uid);
    return this.dashboardResponse;
  }

  async listDashboards(): Promise<GrafanaDashboardSummary[]> {
    return [];
  }

  async listDatasources(): Promise<GrafanaDatasourceSummary[]> {
    return [...this.datasources];
  }

  async listFolders(parentUid?: string): Promise<GrafanaFolder[]> {
    return [...this.folders].filter((folder) => (parentUid ? folder.parentUid === parentUid : !folder.parentUid));
  }

  async listAlertRules(): Promise<Array<Record<string, unknown>>> {
    if (this.alertExport?.failAlertRules) {
      throw new Error("alert rules export failed");
    }
    return this.alertRules.map((rule) => structuredClone(rule));
  }

  async getAlertRule(uid: string): Promise<Record<string, unknown>> {
    this.operationLog?.push(`getAlertRule:${uid}`);
    const rule = this.alertRules.find((candidate) => (candidate.uid as string | undefined) === uid);
    if (!rule) {
      throw new Error(`Grafana API GET /api/v1/provisioning/alert-rules/${uid} failed with 404: not found`);
    }
    return structuredClone(rule);
  }

  async getAlertRuleGroup(folderUid: string, group: string): Promise<Record<string, unknown>> {
    this.operationLog?.push(`getAlertRuleGroup:${folderUid}/${group}`);
    const rules = this.alertRules.filter(
      (candidate) =>
        ((candidate.folderUID as string | undefined) ?? (candidate.folderUid as string | undefined)) === folderUid &&
        (candidate.ruleGroup as string | undefined) === group,
    );
    if (rules.length === 0) {
      throw new Error(
        `Grafana API GET /api/v1/provisioning/folder/${folderUid}/rule-groups/${group} failed with 404: not found`,
      );
    }
    return {
      folderUID: folderUid,
      interval: "1m",
      name: group,
      rules: rules.map((rule) => structuredClone(rule)),
    };
  }

  async createAlertRule(rule: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.operationLog?.push(`createAlertRule:${(rule.uid as string | undefined) ?? ""}`);
    const uid = (rule.uid as string | undefined) ?? "";
    this.alertRules.push(structuredClone(rule));
    return {
      uid,
      ...structuredClone(rule),
    };
  }

  async updateAlertRule(uid: string, rule: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.operationLog?.push(`updateAlertRule:${uid}`);
    const index = this.alertRules.findIndex((candidate) => (candidate.uid as string | undefined) === uid);
    if (index === -1) {
      throw new Error(`Grafana API PUT /api/v1/provisioning/alert-rules/${uid} failed with 404: not found`);
    }
    this.alertRules[index] = structuredClone(rule);
    return structuredClone(rule);
  }

  async updateAlertRuleGroup(folderUid: string, group: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.operationLog?.push(`updateAlertRuleGroup:${folderUid}/${group}`);
    const rules = Array.isArray(body.rules) ? body.rules.map((rule) => structuredClone(rule as Record<string, unknown>)) : [];
    this.alertRules.splice(
      0,
      this.alertRules.length,
      ...this.alertRules.filter(
        (candidate) =>
          ((candidate.folderUID as string | undefined) ?? (candidate.folderUid as string | undefined)) !== folderUid ||
          (candidate.ruleGroup as string | undefined) !== group,
      ),
      ...rules,
    );
    return structuredClone(body);
  }

  async listContactPoints(): Promise<Array<Record<string, unknown>>> {
    this.operationLog?.push("listContactPoints");
    if (this.alertExport?.failContactPoints) {
      throw new Error("contact points export failed");
    }
    return this.alertContactPoints.map((contactPoint) => structuredClone(contactPoint));
  }

  async createContactPoint(contactPoint: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.operationLog?.push(`createContactPoint:${(contactPoint.uid as string | undefined) ?? ""}`);
    this.alertContactPoints.push(structuredClone(contactPoint));
    return structuredClone(contactPoint);
  }

  async updateContactPoint(uid: string, contactPoint: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.operationLog?.push(`updateContactPoint:${uid}`);
    const index = this.alertContactPoints.findIndex((candidate) => (candidate.uid as string | undefined) === uid);
    if (index === -1) {
      throw new Error(`Grafana API PUT /api/v1/provisioning/contact-points/${uid} failed with 404: not found`);
    }
    this.alertContactPoints[index] = structuredClone(contactPoint);
    return structuredClone(contactPoint);
  }

  async createFolder(input: { title: string; uid?: string; parentUid?: string }): Promise<GrafanaFolder> {
    const created = {
      title: input.title,
      uid: input.uid ?? "generated-folder",
      parentUid: input.parentUid,
    };
    this.folders.push(created);
    return created;
  }

  async upsertDashboard(input: {
    dashboard: Record<string, unknown>;
    folderUid?: string;
    message: string;
  }): Promise<GrafanaUpsertResponse> {
    this.onUpsert(input);
    return {
      url: "/d/test",
      status: "success",
    };
  }
}

async function withTempProject(
  run: (repository: ProjectRepository, entry: DashboardManifestEntry) => Promise<void>,
): Promise<void> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "grafana-dashboard-service-"));
  const repository = new ProjectRepository(rootPath, {
    resolveToken: async () => "test-token",
  });
  await repository.ensureProjectLayout();

  const entry: DashboardManifestEntry = {
    name: "sync-status",
    uid: "uid-1",
    path: "integration/status.json",
  };

  await repository.saveManifest({ dashboards: [entry] });

  try {
    await run(repository, entry);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
}

function logger(): LogSink {
  return {
    info() {},
    error() {},
  };
}

async function initializeTargetState(
  repository: ProjectRepository,
  entry: DashboardManifestEntry,
  instanceName: string,
  targetName: string,
  options?: {
    dashboardUid?: string;
    folderPath?: string;
    variableOverrides?: Record<string, unknown>;
    datasourceBindings?: Record<string, string>;
  },
): Promise<string> {
  const service = new DashboardService(
    repository,
    logger(),
    async () =>
      new MockGrafanaClient(
        {
          dashboard: {
            title: "unused",
            uid: entry.uid,
          },
          meta: {},
        },
        [],
        () => {},
      ),
  );

  const revision = (await service.listDashboardRevisions(entry))[0]!.record;
  await repository.saveTargetOverrideFile(instanceName, targetName, entry, {
    ...(options?.dashboardUid ? { dashboardUid: options.dashboardUid } : {}),
    ...(options?.folderPath ? { folderPath: options.folderPath } : {}),
    currentRevisionId: revision.id,
    revisionStates: {
      [revision.id]: {
        variableOverrides: (options?.variableOverrides ?? {}) as Record<string, string | number | boolean | null | { text: unknown; value: unknown }>,
        datasourceBindings: options?.datasourceBindings ?? {},
      },
    },
  });
  return revision.id;
}

test("pullDashboards updates changed files and skips unchanged ones", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.createInstance("stage");
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Old",
      uid: entry.uid,
    });
    await repository.writeJsonFile(repository.folderMetaPathForEntry(entry)!, {
      path: "Integration",
      uid: "folder-1",
    });

    const dashboardResponse: GrafanaDashboardResponse = {
      dashboard: {
        title: "New",
        uid: entry.uid,
        datasource: {
          type: "prometheus",
          uid: "source-datasource",
        },
      },
      meta: {
        folderUid: "folder-1",
        folderTitle: "Integration",
      },
    };

    const client = new MockGrafanaClient(
      dashboardResponse,
      [{ title: "Integration", uid: "folder-1" }],
      () => {},
      [{ uid: "source-datasource", name: "integration", type: "prometheus" }],
    );
    const service = new DashboardService(repository, logger(), async () => client);

    const first = await service.pullDashboards([entry], "prod");
    assert.equal(first.updatedCount, 1);
    assert.equal(first.skippedCount, 1);
    assert.equal(first.previousLocalBackupCount, 0);
    assert.equal(
      JSON.stringify((await repository.loadWorkspaceConfig()).datasources, null, 2),
      JSON.stringify(
        {
          integration: {
            instances: {
              prod: {
                name: "integration",
                uid: "source-datasource",
              },
              stage: {
                name: "integration",
                uid: "source-datasource",
              },
            },
          },
        },
        null,
        2,
      ),
    );
    assert.equal(
      await repository.readTextFileIfExists(repository.dashboardPath(entry)),
      "{\n  \"datasource\": {\n    \"type\": \"prometheus\",\n    \"uid\": \"integration\"\n  },\n  \"title\": \"New\",\n  \"uid\": \"uid-1\"\n}\n",
    );
    assert.equal(
      await repository.readTextFileIfExists(repository.folderMetaPathForEntry(entry)!),
      "{\n  \"path\": \"Integration\",\n  \"uid\": \"folder-1\"\n}\n",
    );

    const second = await service.pullDashboards([entry], "prod");
    assert.equal(second.updatedCount, 0);
    assert.equal(second.skippedCount, 2);
  });
});

test("pullDashboards creates a new dashboard file when the manifest entry has no local JSON yet", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");

    const client = new MockGrafanaClient(
      {
        dashboard: {
          title: "Fresh dashboard",
          uid: entry.uid,
        },
        meta: {},
      },
      [],
      () => {},
    );
    const service = new DashboardService(repository, logger(), async () => client);

    const summary = await service.pullDashboards([entry], "prod");

    assert.equal(summary.updatedCount, 1);
    assert.equal(summary.skippedCount, 0);
    assert.equal(
      await repository.readTextFileIfExists(repository.dashboardPath(entry)),
      "{\n  \"title\": \"Fresh dashboard\",\n  \"uid\": \"uid-1\"\n}\n",
    );
    assert.equal((await repository.readDashboardVersionIndex(entry))?.revisions.length, 1);
  });
});

test("buildOverrideEditorVariables keeps revisions isolated for dashboards in the same folder", async () => {
  await withTempProject(async (repository, entry) => {
    const secondEntry: DashboardManifestEntry = {
      name: "other-status",
      uid: "uid-2",
      path: "integration/other.json",
    };
    await repository.saveManifest({ dashboards: [entry, secondEntry] });
    await repository.createInstance("prod");
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
      templating: {
        list: [
          {
            name: "site",
            type: "constant",
            current: {
              text: "LUZ",
              value: "LUZ",
            },
            query: "LUZ",
          },
        ],
      },
    });
    await repository.writeJsonFile(repository.dashboardPath(secondEntry), {
      title: "Other",
      uid: secondEntry.uid,
      templating: {
        list: [
          {
            name: "pallet",
            type: "constant",
            current: {
              text: "16036050",
              value: "16036050",
            },
            query: "16036050",
          },
        ],
      },
    });

    const service = new DashboardService(
      repository,
      logger(),
      async () =>
        new MockGrafanaClient(
          {
            dashboard: {
              title: "unused",
              uid: entry.uid,
            },
            meta: {},
          },
          [],
          () => {},
        ),
    );

    const firstRevision = (await service.listDashboardRevisions(entry))[0]!.record;
    const secondRevision = (await service.listDashboardRevisions(secondEntry))[0]!.record;
    await repository.saveTargetOverrideFile("prod", "default", secondEntry, {
      currentRevisionId: firstRevision.id,
      revisionStates: {
        [firstRevision.id]: {
          variableOverrides: {},
          datasourceBindings: {},
        },
      },
    });

    const variables = await service.buildOverrideEditorVariables("prod", "default", secondEntry);
    assert.deepEqual(
      variables.map((variable) => variable.name),
      ["pallet"],
    );

    const savedTargetState = await repository.readTargetOverrideFile("prod", "default", secondEntry);
    assert.equal(savedTargetState?.currentRevisionId, secondRevision.id);
    assert.deepEqual(Object.keys(savedTargetState?.revisionStates ?? {}), [secondRevision.id]);
  });
});

test("pullDashboards preserves base folder path when dashboard has explicit folderPath overrides", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
    });
    await repository.writeJsonFile(repository.folderMetaPathForEntry(entry)!, {
      uid: "folder-1",
      path: "Integration",
    });
    await initializeTargetState(repository, entry, "prod", "default", {
      folderPath: "Integration/Dev",
    });

    const dashboardResponse: GrafanaDashboardResponse = {
      dashboard: {
        title: "Status",
        uid: entry.uid,
      },
      meta: {
        folderUid: "folder-2",
        folderTitle: "Source Integration",
      },
    };

    const client = new MockGrafanaClient(
      dashboardResponse,
      [{ title: "Source Integration", uid: "folder-2" }],
      () => {},
    );
    const service = new DashboardService(repository, logger(), async () => client);

    await service.pullDashboards([entry], "prod");

    assert.equal(
      await repository.readTextFileIfExists(repository.folderMetaPathForEntry(entry)!),
      "{\n  \"path\": \"Source Integration\",\n  \"uid\": \"folder-2\"\n}\n",
    );
  });
});

test("pullDashboards uses target-specific dashboardUid and normalizes local dashboard uid", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.createDeploymentTarget("prod", "blue");
    await repository.setDevTarget("prod", "blue");
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
    });
    await initializeTargetState(repository, entry, "prod", "blue", {
      dashboardUid: "uid-blue",
    });

    let requestedUid = "";
    const client = new MockGrafanaClient(
      {
        dashboard: {
          title: "Status Blue",
          uid: "uid-blue",
        },
        meta: {},
      },
      [],
      () => {},
      [],
      (uid) => {
        requestedUid = uid;
      },
    );
    const service = new DashboardService(repository, logger(), async () => client);

    await service.pullDashboards([entry], "prod", "blue");

    assert.equal(requestedUid, "uid-blue");
    assert.equal(
      await repository.readTextFileIfExists(repository.dashboardPath(entry)),
      "{\n  \"title\": \"Status Blue\",\n  \"uid\": \"uid-1\"\n}\n",
    );
    assert.equal((await repository.readTargetOverrideFile("prod", "blue", entry))?.dashboardUid, "uid-blue");
  });
});

test("pullDashboards does not create a new revision when only managed constant override values change", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
      templating: {
        list: [
          {
            name: "site",
            type: "constant",
            current: {
              text: "LUZ",
              value: "LUZ",
            },
            query: "LUZ",
          },
        ],
      },
    });
    const initialRevisionId = await initializeTargetState(repository, entry, "prod", "default", {
      variableOverrides: {
        site: "LUZ",
      },
    });

    const client = new MockGrafanaClient(
      {
        dashboard: {
          title: "Status",
          uid: entry.uid,
          templating: {
            list: [
              {
                name: "site",
                type: "constant",
                current: {
                  text: "LUZ1",
                  value: "LUZ1",
                },
                query: "LUZ1",
              },
            ],
          },
        },
        meta: {},
      },
      [],
      () => {},
    );
    const service = new DashboardService(repository, logger(), async () => client);

    await service.pullDashboards([entry], "prod", "default");

    const index = await repository.readDashboardVersionIndex(entry);
    assert.equal(index?.revisions.length, 1);
    assert.equal(index?.checkedOutRevisionId, initialRevisionId);

    const targetState = await repository.readTargetOverrideFile("prod", "default", entry);
    assert.equal(targetState?.currentRevisionId, initialRevisionId);
    assert.equal(targetState?.revisionStates[initialRevisionId]?.variableOverrides.site, "LUZ1");

    const snapshot = await repository.readDashboardRevisionSnapshot(entry, initialRevisionId);
    const site = ((snapshot?.dashboard.templating as { list?: Array<Record<string, unknown>> } | undefined)?.list ?? []).find(
      (item) => item.name === "site",
    );
    assert.equal(site?.query, "LUZ1");
  });
});

test("pullDashboards normalizes stale custom variable state from query values", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
    });

    const client = new MockGrafanaClient(
      {
        dashboard: {
          title: "Status",
          uid: entry.uid,
          templating: {
            list: [
              {
                current: {
                  text: "АПУ-1",
                  value: "АПУ-1",
                },
                hide: 2,
                name: "APU_investigation",
                options: [
                  {
                    selected: false,
                    text: "Все",
                    value: "Все",
                  },
                  {
                    selected: true,
                    text: "АПУ-1",
                    value: "АПУ-1",
                  },
                  {
                    selected: false,
                    text: "АПУ-2",
                    value: "АПУ-2",
                  },
                  {
                    selected: false,
                    text: "АПУ-3",
                    value: "АПУ-3",
                  },
                ],
                query: " Все, Dolina-1, Dolina-2, Lorenz Pan-3",
                type: "custom",
              },
            ],
          },
        },
        meta: {},
      },
      [],
      () => {},
    );
    const service = new DashboardService(repository, logger(), async () => client);

    await service.pullDashboards([entry], "prod", "default");

    const dashboard = await repository.readJsonFile<Record<string, unknown>>(repository.dashboardPath(entry));
    const variable = ((dashboard.templating as { list: Array<Record<string, unknown>> }).list)[0]!;

    assert.deepEqual(variable.current, {
      text: "Все",
      value: "Все",
    });
    assert.deepEqual(variable.options, [
      {
        selected: true,
        text: "Все",
        value: "Все",
      },
      {
        selected: false,
        text: "Dolina-1",
        value: "Dolina-1",
      },
      {
        selected: false,
        text: "Dolina-2",
        value: "Dolina-2",
      },
      {
        selected: false,
        text: "Lorenz Pan-3",
        value: "Lorenz Pan-3",
      },
    ]);
  });
});

test("pullDashboards accepts mismatched remote dashboard uid and normalizes the local snapshot uid", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
    });

    const client = new MockGrafanaClient(
      {
        dashboard: {
          title: "Status",
          uid: "unexpected-uid",
        },
        meta: {},
      },
      [],
      () => {},
    );
    const service = new DashboardService(repository, logger(), async () => client);

    await service.pullDashboards([entry], "prod", "default");

    const dashboard = await repository.readJsonFile<Record<string, unknown>>(repository.dashboardPath(entry));
    assert.equal(dashboard.uid, entry.uid);
  });
});

test("exportAlerts writes selected alert and linked contact point files, then skips unchanged content", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.createDeploymentTarget("prod", "blue");
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
    });

    const service = new DashboardService(
      repository,
      logger(),
      async () =>
        new MockGrafanaClient(
          {
            dashboard: {
              title: "unused",
              uid: entry.uid,
            },
            meta: {},
          },
          [],
          () => {},
          [],
          () => {},
          {
            rules: [
              {
                uid: "alert-cpu-high",
                title: "CPU High",
                id: 10,
                updated: "2026-03-01T00:00:00Z",
                notification_settings: {
                  receiver: "oncall",
                },
              },
            ],
            contactPoints: [
              {
                uid: "cp-oncall",
                name: "oncall",
                type: "email",
                settings: {
                  addresses: "ops@example.com",
                },
              },
            ],
          },
        ),
    );

    const first = await service.exportSelectedAlerts("prod", "blue", ["alert-cpu-high"]);
    assert.equal(first.instanceName, "prod");
    assert.equal(first.targetName, "blue");
    assert.equal(first.selectedCount, 1);
    assert.equal(first.updatedCount, 3);
    assert.equal(first.skippedCount, 0);
    assert.equal(first.outputDir, repository.alertsRootPath("prod", "blue"));
    const manifest = await repository.readAlertsManifest("prod", "blue");
    assert.ok(manifest);
    assert.ok(manifest?.rules["alert-cpu-high"]);
    const savedRule = await repository.readAlertRuleJson("prod", "blue", "alert-cpu-high");
    assert.equal((savedRule?.uid as string | undefined) ?? "", "alert-cpu-high");
    assert.equal((savedRule?.id as number | undefined) ?? 0, 0);
    assert.equal(savedRule?.id, undefined);
    assert.equal(
      await repository.readTextFileIfExists(repository.alertContactPointFilePath("prod", "blue", "uid__cp-oncall")),
      "{\n  \"name\": \"oncall\",\n  \"settings\": {\n    \"addresses\": \"ops@example.com\"\n  },\n  \"type\": \"email\",\n  \"uid\": \"cp-oncall\"\n}\n",
    );

    const second = await service.exportSelectedAlerts("prod", "blue", ["alert-cpu-high"]);
    assert.equal(second.updatedCount, 0);
    assert.equal(second.skippedCount, 3);
    assert.deepEqual(
      second.fileResults.map((result) => result.status),
      ["skipped", "skipped", "skipped"],
    );
  });
});

test("exportAlerts does not write partial files when one export endpoint fails", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.createDeploymentTarget("prod", "blue");
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
    });

    const service = new DashboardService(
      repository,
      logger(),
      async () =>
        new MockGrafanaClient(
          {
            dashboard: {
              title: "unused",
              uid: entry.uid,
            },
            meta: {},
          },
          [],
          () => {},
          [],
          () => {},
          {
            failContactPoints: true,
          },
        ),
    );

    await assert.rejects(service.exportSelectedAlerts("prod", "blue", ["missing-alert"]), /contact points export failed/);
    assert.equal(await repository.readTextFileIfExists(repository.alertsManifestPath("prod", "blue")), undefined);
    assert.equal(await repository.readTextFileIfExists(repository.alertRuleFilePath("prod", "blue", "missing-alert")), undefined);
  });
});

test("exportAlerts pulls only tracked alerts and ignores untracked remote rules", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.createDeploymentTarget("prod", "blue");
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
    });
    await repository.saveAlertsManifest("prod", "blue", {
      version: 1,
      instanceName: "prod",
      targetName: "blue",
      generatedAt: "2026-03-19T00:00:00.000Z",
      rules: {
        "alert-cpu-high": {
          uid: "alert-cpu-high",
          title: "CPU High",
          path: "rules/alert-cpu-high.json",
          contactPointKeys: [],
          contactPointStatus: "policy-managed",
        },
      },
      contactPoints: {},
    });

    const service = new DashboardService(
      repository,
      logger(),
      async () =>
        new MockGrafanaClient(
          {
            dashboard: {
              title: "unused",
              uid: entry.uid,
            },
            meta: {},
          },
          [],
          () => {},
          [],
          () => {},
          {
            rules: [
              {
                uid: "alert-cpu-high",
                title: "CPU High",
                notification_settings: {
                  receiver: "oncall",
                },
              },
              {
                uid: "alert-memory-high",
                title: "Memory High",
                notification_settings: {
                  receiver: "oncall",
                },
              },
            ],
            contactPoints: [
              {
                uid: "cp-oncall",
                name: "oncall",
                type: "email",
                settings: {
                  addresses: "ops@example.com",
                },
              },
            ],
          },
        ),
    );

    const summary = await service.exportAlerts("prod", "blue");

    assert.equal(summary.alertCount, 1);
    assert.equal(summary.failedCount, 0);
    const manifest = await repository.readAlertsManifest("prod", "blue");
    assert.ok(manifest?.rules["alert-cpu-high"]);
    assert.equal(manifest?.rules["alert-memory-high"], undefined);
  });
});

test("saveAlertSettings updates isPaused and rewrites all non-expression datasource refs", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.createDeploymentTarget("prod", "blue");
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
    });
    await repository.saveAlertsManifest("prod", "blue", {
      version: 1,
      instanceName: "prod",
      targetName: "blue",
      generatedAt: "2026-03-19T00:00:00.000Z",
      rules: {
        "alert-a": {
          uid: "alert-a",
          title: "Alert A",
          path: "rules/alert-a.json",
          contactPointKeys: [],
          contactPointStatus: "policy-managed",
        },
      },
      contactPoints: {},
    });
    await repository.writeJsonFile(repository.alertRuleFilePath("prod", "blue", "alert-a"), {
      uid: "alert-a",
      title: "Alert A",
      isPaused: false,
      data: [
        {
          refId: "A",
          datasourceUid: "mongo-a",
          model: {
            datasource: {
              uid: "mongo-a",
              name: "Mongo A",
              type: "mongodb",
            },
          },
        },
        {
          refId: "B",
          datasourceUid: "mongo-b",
          model: {
            datasource: {
              uid: "mongo-b",
              name: "Mongo B",
              type: "mongodb",
            },
          },
        },
        {
          refId: "C",
          datasourceUid: "__expr__",
          model: {
            datasource: {
              uid: "__expr__",
              type: "__expr__",
            },
          },
        },
      ],
    });

    const service = new DashboardService(
      repository,
      logger(),
      async () =>
        new MockGrafanaClient(
          {
            dashboard: {
              title: "unused",
              uid: entry.uid,
            },
            meta: {},
          },
          [],
          () => {},
        ),
    );

    await service.saveAlertSettings("prod", "blue", "alert-a", {
      isPaused: true,
      datasourceUid: "mongo-target",
      datasourceName: "Mongo Target",
    });

    const savedRule = await repository.readAlertRuleJson("prod", "blue", "alert-a");
    const data = Array.isArray(savedRule?.data) ? savedRule.data : [];
    assert.equal(savedRule?.isPaused, true);
    assert.equal((data[0] as Record<string, unknown>).datasourceUid, "mongo-target");
    assert.equal((data[1] as Record<string, unknown>).datasourceUid, "mongo-target");
    assert.equal((data[2] as Record<string, unknown>).datasourceUid, "__expr__");
    assert.equal(
      (((data[0] as Record<string, unknown>).model as Record<string, unknown>).datasource as Record<string, unknown>).name,
      "Mongo Target",
    );
  });
});

test("copyAlertToTarget creates a new alert uid, new contact point ids, and clears sync timestamps", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.createDeploymentTarget("prod", "blue");
    await repository.createInstance("qa");
    await repository.createDeploymentTarget("qa", "green");
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
    });
    await repository.saveAlertsManifest("prod", "blue", {
      version: 1,
      instanceName: "prod",
      targetName: "blue",
      generatedAt: "2026-03-19T00:00:00.000Z",
      rules: {
        "alert-source": {
          uid: "alert-source",
          title: "Alert Source",
          path: "rules/alert-source.json",
          contactPointKeys: ["uid__cp-source"],
          contactPointStatus: "linked",
          lastExportedAt: "2026-03-19T01:00:00.000Z",
          lastAppliedAt: "2026-03-19T02:00:00.000Z",
        },
      },
      contactPoints: {
        "uid__cp-source": {
          key: "uid__cp-source",
          path: "contact-points/uid__cp-source.json",
          name: "Integration contact point",
          uid: "cp-source",
          type: "teams",
        },
      },
    });
    await repository.writeJsonFile(repository.alertRuleFilePath("prod", "blue", "alert-source"), {
      uid: "alert-source",
      title: "Alert Source",
      notification_settings: {
        receiver: "Integration contact point",
      },
      data: [
        {
          refId: "A",
          datasourceUid: "mongo-source",
          model: {
            datasource: {
              uid: "mongo-source",
              name: "Mongo Source",
              type: "mongodb",
            },
          },
        },
      ],
    });
    await repository.writeJsonFile(repository.alertContactPointFilePath("prod", "blue", "uid__cp-source"), {
      uid: "cp-source",
      name: "Integration contact point",
      type: "teams",
      settings: {
        url: "https://example.com",
      },
    });

    const service = new DashboardService(
      repository,
      logger(),
      async () =>
        new MockGrafanaClient(
          {
            dashboard: {
              title: "unused",
              uid: entry.uid,
            },
            meta: {},
          },
          [],
          () => {},
        ),
    );

    const summary = await service.copyAlertToTarget(
      "prod",
      "blue",
      "alert-source",
      "qa",
      "green",
      {
        uid: "mongo-target",
        name: "Mongo Target",
      },
    );

    const destinationManifest = await repository.loadAlertsManifest("qa", "green");
    const copiedEntry = destinationManifest.rules[summary.destinationUid];
    const copiedRule = await repository.readAlertRuleJson("qa", "green", summary.destinationUid);
    assert.notEqual(summary.destinationUid, "alert-source");
    assert.ok(copiedEntry);
    assert.equal(copiedEntry?.lastExportedAt, undefined);
    assert.equal(copiedEntry?.lastAppliedAt, undefined);
    assert.equal(copiedRule?.uid, summary.destinationUid);
    assert.equal(
      ((Array.isArray(copiedRule?.data) ? copiedRule.data[0] : undefined) as Record<string, unknown>).datasourceUid,
      "mongo-target",
    );
    assert.equal(copiedEntry?.contactPointKeys.length, 1);
    assert.notEqual(copiedEntry?.contactPointKeys[0], "uid__cp-source");
    const copiedContactPoint = await repository.readAlertContactPointJson("qa", "green", copiedEntry!.contactPointKeys[0]!);
    assert.ok(copiedContactPoint);
    assert.notEqual(copiedContactPoint?.uid, "cp-source");
  });
});

test("uploadAlert upserts contact points before creating the alert rule", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.createDeploymentTarget("prod", "blue");
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
    });
    await repository.saveAlertsManifest("prod", "blue", {
      version: 1,
      instanceName: "prod",
      targetName: "blue",
      generatedAt: "2026-03-19T00:00:00.000Z",
      rules: {
        "alert-a": {
          uid: "alert-a",
          title: "Alert A",
          path: "rules/alert-a.json",
          contactPointKeys: ["uid__cp-a"],
          contactPointStatus: "linked",
        },
      },
      contactPoints: {
        "uid__cp-a": {
          key: "uid__cp-a",
          path: "contact-points/uid__cp-a.json",
          name: "Integration contact point",
          uid: "cp-a",
          type: "teams",
        },
      },
    });
    await repository.writeJsonFile(repository.alertRuleFilePath("prod", "blue", "alert-a"), {
      uid: "alert-a",
      title: "Alert A",
      folderUID: "folder-1",
      ruleGroup: "integration",
      isPaused: true,
      notification_settings: {
        receiver: "Integration contact point",
      },
      data: [],
    });
    await repository.writeJsonFile(repository.alertContactPointFilePath("prod", "blue", "uid__cp-a"), {
      uid: "cp-a",
      name: "Integration contact point",
      type: "teams",
      settings: {
        url: "https://example.com",
      },
    });

    const operationLog: string[] = [];
    const service = new DashboardService(
      repository,
      logger(),
      async () =>
        new MockGrafanaClient(
          {
            dashboard: {
              title: "unused",
              uid: entry.uid,
            },
            meta: {},
          },
          [],
          () => {},
          [],
          () => {},
          {
            rules: [],
            contactPoints: [],
            operationLog,
          },
        ),
    );

    await service.uploadAlert("prod", "blue", "alert-a");

    assert.ok(operationLog.indexOf("createContactPoint:cp-a") >= 0);
    assert.ok(operationLog.indexOf("createAlertRule:alert-a") >= 0);
    assert.ok(operationLog.indexOf("updateAlertRuleGroup:folder-1/integration") >= 0);
    assert.ok(operationLog.indexOf("createContactPoint:cp-a") < operationLog.indexOf("createAlertRule:alert-a"));
    assert.ok(operationLog.indexOf("createAlertRule:alert-a") < operationLog.indexOf("updateAlertRuleGroup:folder-1/integration"));
  });
});

test("deployTrackedAlertsForTargets continues when one alert fails", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.createDeploymentTarget("prod", "blue");
    await repository.createDeploymentTarget("prod", "green");
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
    });
    await repository.saveAlertsManifest("prod", "blue", {
      version: 1,
      instanceName: "prod",
      targetName: "blue",
      generatedAt: "2026-03-19T00:00:00.000Z",
      rules: {
        "alert-a": {
          uid: "alert-a",
          title: "Alert A",
          path: "rules/alert-a.json",
          contactPointKeys: [],
          contactPointStatus: "policy-managed",
        },
      },
      contactPoints: {},
    });
    await repository.saveAlertsManifest("prod", "green", {
      version: 1,
      instanceName: "prod",
      targetName: "green",
      generatedAt: "2026-03-19T00:00:00.000Z",
      rules: {
        "alert-b": {
          uid: "alert-b",
          title: "Alert B",
          path: "rules/alert-b.json",
          contactPointKeys: [],
          contactPointStatus: "policy-managed",
        },
      },
      contactPoints: {},
    });
    await repository.writeJsonFile(repository.alertRuleFilePath("prod", "blue", "alert-a"), {
      uid: "alert-a",
      title: "Alert A",
      folderUID: "folder-1",
      ruleGroup: "integration",
      data: [],
    });

    const operationLog: string[] = [];
    const service = new DashboardService(
      repository,
      logger(),
      async () =>
        new MockGrafanaClient(
          {
            dashboard: {
              title: "unused",
              uid: entry.uid,
            },
            meta: {},
          },
          [],
          () => {},
          [],
          () => {},
          {
            rules: [],
            contactPoints: [],
            operationLog,
          },
        ),
    );

    const summary = await service.deployTrackedAlertsForTargets([
      {
        instanceName: "prod",
        name: "blue",
        dirPath: "ignored",
      },
      {
        instanceName: "prod",
        name: "green",
        dirPath: "ignored",
      },
    ]);

    assert.equal(summary.targetCount, 2);
    assert.equal(summary.alertCount, 2);
    assert.equal(summary.updatedCount, 1);
    assert.equal(summary.failedCount, 1);
    assert.ok(operationLog.indexOf("createAlertRule:alert-a") >= 0);
    assert.ok(summary.targetResults.some((result) => result.targetName === "green" && result.failedCount === 1));
  });
});

test("dashboardBrowserUrl prefers Grafana meta.url and falls back to effective uid", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.saveInstanceEnvValues("prod", {
      GRAFANA_URL: "http://prod/grafana",
    });
    await repository.createDeploymentTarget("prod", "blue");
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
    });
    await initializeTargetState(repository, entry, "prod", "blue", {
      dashboardUid: "uid-blue",
    });

    const withMetaUrl = new DashboardService(
      repository,
      logger(),
      async () =>
        new MockGrafanaClient(
          {
            dashboard: {
              title: "Status",
              uid: "uid-blue",
            },
            meta: {
              url: "/d/uid-blue/status",
            },
          },
          [],
          () => {},
        ),
    );

    assert.equal(
      await withMetaUrl.dashboardBrowserUrl(entry, "prod", "blue"),
      "http://prod/d/uid-blue/status",
    );

    const withFallback = new DashboardService(
      repository,
      logger(),
      async () => {
        throw new Error("Grafana unavailable");
      },
    );

    assert.equal(
      await withFallback.dashboardBrowserUrl(entry, "prod", "blue"),
      "http://prod/grafana/d/uid-blue",
    );
  });
});

test("listDashboardRevisions initializes version history from working copy", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status v1",
      uid: entry.uid,
    });
    await repository.writeJsonFile(repository.folderMetaPathForEntry(entry)!, {
      path: "Integration",
      uid: "folder-1",
    });

    const service = new DashboardService(
      repository,
      logger(),
      async () =>
        new MockGrafanaClient(
          {
            dashboard: {
              title: "unused",
              uid: entry.uid,
            },
            meta: {},
          },
          [],
          () => {},
        ),
    );

    const revisions = await service.listDashboardRevisions(entry);

    assert.equal(revisions.length, 1);
    assert.equal(revisions[0]?.isCheckedOut, true);
    assert.equal((await repository.readDashboardVersionIndex(entry))?.checkedOutRevisionId, revisions[0]?.record.id);
    assert.ok(await repository.readDashboardRevisionSnapshot(entry, revisions[0]!.record.id));
  });
});

test("deployRevision deploys selected revision", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.saveInstanceEnvValues("prod", {
      GRAFANA_URL: "http://prod",
    });
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status v1",
      uid: entry.uid,
    });
    await repository.writeJsonFile(repository.folderMetaPathForEntry(entry)!, {
      path: "Integration",
      uid: "folder-1",
    });

    let upsertPayload: { dashboard: Record<string, unknown>; folderUid?: string; message: string } | undefined;
    const service = new DashboardService(
      repository,
      logger(),
      async () =>
        new MockGrafanaClient(
          {
            dashboard: {
              title: "unused",
              uid: entry.uid,
            },
            meta: {},
          },
          [],
          (payload) => {
            upsertPayload = payload;
          },
        ),
    );

    const initialRevision = (await service.listDashboardRevisions(entry))[0]!.record;
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status v2",
      uid: entry.uid,
    });
    const currentRevision = await service.createRevisionFromWorkingCopy(entry);

    await service.deployRevision(entry, initialRevision.id, "prod", "default");
    await service.checkoutRevision(entry, initialRevision.id);

    assert.equal((upsertPayload?.dashboard.title as string | undefined) ?? "", "Status v1");
    assert.equal((await repository.readDashboardJson(entry)).title, "Status v1");
    assert.notEqual(initialRevision.id, currentRevision.id);
    assert.equal((await service.currentCheckedOutRevision(entry))?.id, initialRevision.id);
  });
});

test("deleteRevision removes an unused revision and its revision state", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status v1",
      uid: entry.uid,
    });

    const service = new DashboardService(
      repository,
      logger(),
      async () =>
        new MockGrafanaClient(
          {
            dashboard: {
              title: "unused",
              uid: entry.uid,
            },
            meta: {},
          },
          [],
          () => {},
        ),
    );

    const firstRevision = (await service.listDashboardRevisions(entry))[0]!.record;
    await initializeTargetState(repository, entry, "prod", "default");
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status v2",
      uid: entry.uid,
    });
    const secondRevision = await service.createRevisionFromWorkingCopy(entry);
    await service.checkoutRevision(entry, secondRevision.id);
    await service.setTargetRevision(entry, secondRevision.id, "prod", "default");

    await service.deleteRevision(entry, firstRevision.id);

    const nextIndex = await repository.readDashboardVersionIndex(entry);
    assert.equal(nextIndex?.revisions.some((revision) => revision.id === firstRevision.id), false);
    assert.equal(await repository.readDashboardRevisionSnapshot(entry, firstRevision.id), undefined);
    const targetState = await repository.readTargetOverrideFile("prod", "default", entry);
    assert.equal(targetState?.revisionStates[firstRevision.id], undefined);
  });
});

test("deleteRevision rejects the checked out revision and active target revision", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status v1",
      uid: entry.uid,
    });

    const service = new DashboardService(
      repository,
      logger(),
      async () =>
        new MockGrafanaClient(
          {
            dashboard: {
              title: "unused",
              uid: entry.uid,
            },
            meta: {},
          },
          [],
          () => {},
        ),
    );

    const firstRevision = (await service.listDashboardRevisions(entry))[0]!.record;
    await initializeTargetState(repository, entry, "prod", "default");
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status v2",
      uid: entry.uid,
    });
    const secondRevision = await service.createRevisionFromWorkingCopy(entry);

    await assert.rejects(
      service.deleteRevision(entry, secondRevision.id),
      /Cannot delete the checked out revision/,
    );
    await assert.rejects(
      service.deleteRevision(entry, firstRevision.id),
      /Cannot delete revision .* because it is active on: prod\/default/,
    );
  });
});

test("listLiveTargetVersionStatuses matches live dashboard to stored revision", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.saveInstanceEnvValues("prod", {
      GRAFANA_URL: "http://prod",
    });
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status v1",
      uid: entry.uid,
    });

    const service = new DashboardService(
      repository,
      logger(),
      async () =>
        new MockGrafanaClient(
          {
            dashboard: {
              title: "Status v1",
              uid: entry.uid,
            },
            meta: {},
          },
          [],
          () => {},
        ),
    );

    const revision = (await service.listDashboardRevisions(entry))[0]!.record;
    const statuses = await service.listLiveTargetVersionStatuses(entry);

    assert.deepEqual(statuses, [
      {
        instanceName: "prod",
        targetName: "default",
        storedRevisionId: revision.id,
        effectiveDashboardUid: entry.uid,
        matchedRevisionId: revision.id,
        datasourceStatus: "complete",
        state: "matched",
      },
    ]);
  });
});

test("deployDashboards applies overrides and creates missing folder", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.saveInstanceEnvValues("prod", {
      GRAFANA_URL: "http://prod",
    });
    await repository.saveDatasourceCatalog({
      datasources: {
        integration: {
          instances: {
            prod: {
              uid: "prod-datasource",
              name: "prod-datasource",
            },
          },
        },
      },
    });

    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
      datasource: {
        type: "prometheus",
        uid: "integration",
      },
      templating: {
        list: [
          {
            name: "site",
            type: "custom",
            current: {
              text: "default",
              value: "default",
            },
          },
          {
            name: "queryVar",
            type: "query",
            datasource: {
              type: "prometheus",
              uid: "integration",
            },
          },
        ],
      },
    });
    await repository.writeJsonFile(repository.folderMetaPathForEntry(entry)!, {
      path: "Integration",
      uid: "folder-1",
    });
    await initializeTargetState(repository, entry, "prod", "default", {
      variableOverrides: {
        site: "nsk",
      },
    });

    let upsertPayload: { dashboard: Record<string, unknown>; folderUid?: string; message: string } | undefined;
    const client = new MockGrafanaClient(
      {
        dashboard: {
          title: "unused",
          uid: entry.uid,
        },
        meta: {},
      },
      [],
      (payload) => {
        upsertPayload = payload;
      },
    );

    const service = new DashboardService(repository, logger(), async () => client);
    const summary = await service.deployDashboards([entry], "prod");

    assert.equal(summary.dashboardResults.length, 1);
    assert.equal(summary.dashboardResults[0].targetBaseUrl, "http://prod");
    assert.equal(summary.dashboardResults[0].folderUid, "folder-1");
    assert.ok(upsertPayload);
    assert.equal(upsertPayload?.folderUid, "folder-1");
    const templating = upsertPayload?.dashboard.templating as { list: Array<Record<string, unknown>> };
    assert.deepEqual(templating.list[0].current, {
      text: "nsk",
      value: "nsk",
    });
    assert.equal((upsertPayload?.dashboard.datasource as { uid?: string })?.uid, "prod-datasource");
    assert.equal((templating.list[1].datasource as { uid?: string })?.uid, "prod-datasource");
    assert.ok(await repository.readTextFileIfExists(repository.renderDashboardPath("prod", "default", entry)));
    assert.ok(await repository.readTextFileIfExists(repository.renderManifestPath("prod", "default")));
  });
});

test("deployDashboards continues when pre-deploy backup returns 404 for missing target dashboard", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.saveInstanceEnvValues("prod", {
      GRAFANA_URL: "http://prod",
    });
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
    });
    await initializeTargetState(repository, entry, "prod", "default", {
      dashboardUid: "missing-target-uid",
    });

    let upsertPayload: { dashboard: Record<string, unknown>; folderUid?: string; message: string } | undefined;
    const client = new MockGrafanaClient(
      {
        dashboard: {
          title: "unused",
          uid: entry.uid,
        },
        meta: {},
      },
      [],
      (payload) => {
        upsertPayload = payload;
      },
      [],
      () => {
        throw new Error('Grafana API GET /api/dashboards/uid/missing-target-uid failed with 404: {"message":"Dashboard not found","title":"Not found"}');
      },
    );

    const service = new DashboardService(repository, logger(), async () => client);
    const summary = await service.deployDashboards([entry], "prod");

    assert.equal(summary.dashboardResults.length, 1);
    assert.equal((upsertPayload?.dashboard.uid as string | undefined) ?? "", "missing-target-uid");
  });
});

test("renderDashboards creates persisted render artifacts", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.saveInstanceEnvValues("prod", {
      GRAFANA_URL: "http://prod",
    });
    await repository.saveDatasourceCatalog({
      datasources: {
        integration: {
          instances: {
            prod: {
              uid: "prod-datasource",
              name: "prod-datasource",
            },
          },
        },
      },
    });
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
      datasource: {
        type: "prometheus",
        uid: "integration",
      },
    });
    await repository.writeJsonFile(repository.folderMetaPathForEntry(entry)!, {
      path: "Integration",
      uid: "folder-1",
    });

    const service = new DashboardService(
      repository,
      logger(),
      async () =>
        new MockGrafanaClient(
          {
            dashboard: {
              title: "unused",
              uid: entry.uid,
            },
            meta: {},
          },
          [],
          () => {},
        ),
    );

    const manifest = await service.renderDashboards([entry], "prod", "default", "dashboard");

    assert.equal(manifest.instanceName, "prod");
    assert.equal(manifest.targetName, "default");
    assert.equal(manifest.scope, "dashboard");
    assert.equal(manifest.dashboards.length, 1);
    assert.ok(await repository.readTextFileIfExists(repository.renderDashboardPath("prod", "default", entry)));
    assert.ok(await repository.readTextFileIfExists(repository.renderManifestPath("prod", "default")));
    assert.equal(
      await repository.readTextFileIfExists(repository.renderDashboardPath("prod", "default", entry)),
      "{\n  \"datasource\": {\n    \"type\": \"prometheus\",\n    \"uid\": \"prod-datasource\"\n  },\n  \"title\": \"Status\",\n  \"uid\": \"uid-1\"\n}\n",
    );
  });
});

test("deployDashboards generates and persists dashboardUid for non-default target", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.createDeploymentTarget("prod", "blue");
    await repository.saveInstanceEnvValues("prod", {
      GRAFANA_URL: "http://prod",
    });
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
    });

    let upsertPayload: { dashboard: Record<string, unknown>; folderUid?: string; message: string } | undefined;
    const client = new MockGrafanaClient(
      {
        dashboard: {
          title: "unused",
          uid: entry.uid,
        },
        meta: {},
      },
      [],
      (payload) => {
        upsertPayload = payload;
      },
    );

    const service = new DashboardService(repository, logger(), async () => client);
    await service.deployDashboards([entry], "prod", "blue");

    const savedOverride = await repository.readTargetOverrideFile("prod", "blue", entry);
    assert.ok(savedOverride?.dashboardUid);
    assert.equal(upsertPayload?.dashboard.uid, savedOverride?.dashboardUid);
    assert.notEqual(upsertPayload?.dashboard.uid, entry.uid);
  });
});

test("restoreBackup uses raw live dashboard snapshot without render", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.saveInstanceEnvValues("prod", {
      GRAFANA_URL: "http://prod",
    });

    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
      templating: {
        list: [
          {
            name: "site",
            type: "custom",
            current: {
              text: "old",
              value: "old",
            },
          },
        ],
      },
    });
    await repository.writeJsonFile(repository.folderMetaPathForEntry(entry)!, {
      path: "Integration",
      uid: "folder-1",
    });
    await initializeTargetState(repository, entry, "prod", "default", {
      variableOverrides: {
        site: "nsk-old",
      },
    });

    const backupCaptureService = new DashboardService(
      repository,
      logger(),
      async () =>
        new MockGrafanaClient(
          {
            dashboard: {
              title: "Status",
              uid: entry.uid,
              templating: {
                list: [
                  {
                    name: "site",
                    type: "custom",
                    current: {
                      text: "old",
                      value: "old",
                    },
                  },
                ],
              },
            },
            meta: {
              folderUid: "folder-1",
              folderTitle: "Integration",
            },
          },
          [{ title: "Integration", uid: "folder-1" }],
          () => {},
        ),
    );
    const backup = await backupCaptureService.createTargetBackup([entry], "prod", "default", "dashboard");

    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
      templating: {
        list: [
          {
            name: "site",
            type: "custom",
            current: {
              text: "new",
              value: "new",
            },
          },
        ],
      },
    });
    await initializeTargetState(repository, entry, "prod", "default", {
      variableOverrides: {
        site: "nsk-new",
      },
    });

    let upsertPayload: { dashboard: Record<string, unknown>; folderUid?: string; message: string } | undefined;
    const client = new MockGrafanaClient(
      {
        dashboard: {
          title: "unused",
          uid: entry.uid,
        },
        meta: {},
      },
      [{ title: "Integration", uid: "folder-1" }],
      (payload) => {
        upsertPayload = payload;
      },
    );

    const service = new DashboardService(repository, logger(), async () => client);
    const summary = await service.restoreBackup(backup);

    assert.equal(summary.dashboardResults.length, 1);
    assert.equal(summary.targetCount, 1);
    const templating = upsertPayload?.dashboard.templating as { list: Array<Record<string, unknown>> };
    assert.deepEqual(templating.list[0].current, {
      text: "old",
      value: "old",
    });
  });
});

test("restoreBackup can restore only a selected target slice", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.createDeploymentTarget("prod", "blue");
    await repository.saveInstanceEnvValues("prod", {
      GRAFANA_URL: "http://prod",
    });

    const backup = await repository.createBackupSnapshot(
      "instance",
      [
        {
          instanceName: "prod",
          targetName: "default",
          dashboards: [
            {
              selectorName: "sync-status",
              baseUid: entry.uid,
              effectiveDashboardUid: entry.uid,
              path: entry.path,
              title: "Default snapshot",
              snapshotPath: "",
              dashboard: {
                title: "Default snapshot",
                uid: entry.uid,
              },
            },
          ],
        },
        {
          instanceName: "prod",
          targetName: "blue",
          dashboards: [
            {
              selectorName: "sync-status",
              baseUid: entry.uid,
              effectiveDashboardUid: "uid-blue",
              path: entry.path,
              title: "Blue snapshot",
              snapshotPath: "",
              dashboard: {
                title: "Blue snapshot",
                uid: "uid-blue",
              },
            },
          ],
        },
      ],
      "20260101_000001",
    );

    const upserts: Array<{ dashboard: Record<string, unknown>; folderUid?: string; message: string }> = [];
    const service = new DashboardService(
      repository,
      logger(),
      async () =>
        new MockGrafanaClient(
          {
            dashboard: {
              title: "unused",
              uid: entry.uid,
            },
            meta: {},
          },
          [],
          (payload) => {
            upserts.push(payload);
          },
        ),
    );

    const summary = await service.restoreBackup(backup, {
      kind: "target",
      instanceName: "prod",
      targetName: "blue",
    });

    assert.equal(summary.instanceCount, 1);
    assert.equal(summary.targetCount, 1);
    assert.equal(summary.dashboardCount, 1);
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0]?.dashboard.title, "Blue snapshot");
  });
});

test("deployDashboards resolves canonical datasource names through the global catalog", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.saveInstanceEnvValues("prod", {
      GRAFANA_URL: "http://prod",
    });
    await repository.saveDatasourceCatalog({
      datasources: {
        integration: {
          instances: {
            prod: {
              uid: "target-datasource",
              name: "target-datasource",
            },
          },
        },
      },
    });

    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
      datasource: {
        type: "prometheus",
        uid: "integration",
      },
    });

    let upsertPayload: { dashboard: Record<string, unknown>; folderUid?: string; message: string } | undefined;
    const client = new MockGrafanaClient(
      {
        dashboard: {
          title: "unused",
          uid: entry.uid,
        },
        meta: {},
      },
      [],
      (payload) => {
        upsertPayload = payload;
      },
    );

    const service = new DashboardService(repository, logger(), async () => client);
    await service.deployDashboards([entry], "prod");

    assert.equal((upsertPayload?.dashboard.datasource as { uid?: string })?.uid, "target-datasource");
  });
});

test("deployDashboards fails when datasource mapping is missing", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.saveInstanceEnvValues("prod", {
      GRAFANA_URL: "http://prod",
    });
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
      datasource: {
        type: "prometheus",
        uid: "integration",
      },
    });

    const client = new MockGrafanaClient(
      {
        dashboard: {
          title: "unused",
          uid: entry.uid,
        },
        meta: {},
      },
      [],
      () => {},
    );

    const service = new DashboardService(repository, logger(), async () => client);
    await assert.rejects(service.deployDashboards([entry], "prod"), /Datasource mappings are missing/);
  });
});

test("deployDashboards uses deployment target folderPath override to create nested folders", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.createDeploymentTarget("prod", "blue");
    await repository.saveInstanceEnvValues("prod", {
      GRAFANA_URL: "http://prod",
    });
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
    });
    await initializeTargetState(repository, entry, "prod", "blue", {
      folderPath: "LUZ/Integration/RND",
    });

    const createdFolders: Array<{ title: string; uid?: string; parentUid?: string }> = [];
    let upsertPayload: { dashboard: Record<string, unknown>; folderUid?: string; message: string } | undefined;
    const client = new MockGrafanaClient(
      {
        dashboard: {
          title: "unused",
          uid: entry.uid,
        },
        meta: {},
      },
      [],
      (payload) => {
        upsertPayload = payload;
      },
    );
    const originalCreateFolder = client.createFolder.bind(client);
    client.createFolder = async (input) => {
      createdFolders.push(input);
      return originalCreateFolder({
        ...input,
        uid: input.uid ?? `${input.title.toLowerCase()}-uid`,
      });
    };

    const service = new DashboardService(repository, logger(), async () => client);
    const summary = await service.deployDashboards([entry], "prod", "blue");

    assert.equal(summary.deploymentTargetName, "blue");
    assert.equal(createdFolders.length, 3);
    assert.deepEqual(createdFolders, [
      { title: "LUZ" },
      { title: "Integration", parentUid: "luz-uid" },
      { title: "RND", parentUid: "integration-uid" },
    ]);
    assert.equal(upsertPayload?.folderUid, "rnd-uid");
  });
});

test("deployDashboards rejects duplicate effective dashboard uids for one instance", async () => {
  await withTempProject(async (repository, entry) => {
    const secondEntry: DashboardManifestEntry = {
      name: "other-status",
      uid: "uid-2",
      path: "integration/other.json",
    };
    await repository.saveManifest({ dashboards: [entry, secondEntry] });
    await repository.createInstance("prod");
    await repository.createDeploymentTarget("prod", "blue");
    await repository.saveInstanceEnvValues("prod", {
      GRAFANA_URL: "http://prod",
    });
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
    });
    await repository.writeJsonFile(repository.dashboardPath(secondEntry), {
      title: "Other",
      uid: secondEntry.uid,
    });
    await initializeTargetState(repository, entry, "prod", "blue", {
      dashboardUid: "shared-uid",
    });
    await initializeTargetState(repository, secondEntry, "prod", "blue", {
      dashboardUid: "shared-uid",
    });

    const service = new DashboardService(
      repository,
      logger(),
      async () =>
        new MockGrafanaClient(
          {
            dashboard: {
              title: "unused",
              uid: entry.uid,
            },
            meta: {},
          },
          [],
          () => {},
        ),
    );

    await assert.rejects(
      service.deployDashboards([entry, secondEntry], "prod", "blue"),
      /Duplicate effective dashboard UID "shared-uid"/,
    );
  });
});

test("savePlacement preserves target-specific dashboardUid", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.createDeploymentTarget("prod", "blue");
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
    });
    await initializeTargetState(repository, entry, "prod", "blue", {
      dashboardUid: "uid-blue",
    });

    const service = new DashboardService(
      repository,
      logger(),
      async () =>
        new MockGrafanaClient(
          {
            dashboard: {
              title: "unused",
              uid: entry.uid,
            },
            meta: {},
          },
          [],
          () => {},
        ),
    );

    await service.savePlacement("prod", "blue", entry, "Integration/Dev");

    const savedOverride = await repository.readTargetOverrideFile("prod", "blue", entry);
    assert.equal(savedOverride?.dashboardUid, "uid-blue");
    assert.equal(savedOverride?.folderPath, "Integration/Dev");
    assert.deepEqual(savedOverride?.revisionStates[savedOverride.currentRevisionId!], {
      variableOverrides: {},
      datasourceBindings: {},
    });
  });
});

test("folder browsing helpers list children, resolve chains, and create folders in parent", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.saveInstanceEnvValues("prod", {
      GRAFANA_URL: "http://prod",
    });

    const client = new MockGrafanaClient(
      {
        dashboard: {
          title: "unused",
          uid: entry.uid,
        },
        meta: {},
      },
      [
        { title: "LUZ", uid: "luz-uid" },
        { title: "Integration", uid: "integration-uid", parentUid: "luz-uid" },
      ],
      () => {},
    );

    const service = new DashboardService(repository, logger(), async () => client);

    assert.deepEqual(await service.listFolderChildren("prod"), [{ title: "LUZ", uid: "luz-uid" }]);
    assert.deepEqual(await service.resolveFolderPathChain("prod", "LUZ/Integration"), [
      { title: "LUZ", uid: "luz-uid" },
      { title: "Integration", uid: "integration-uid", parentUid: "luz-uid" },
    ]);

    const created = await service.createFolderInParent("prod", "integration-uid", "Dev");
    assert.deepEqual(created, { title: "Dev", uid: "generated-folder", parentUid: "integration-uid" });
    assert.deepEqual(await service.listFolderChildren("prod", "integration-uid"), [
      { title: "Dev", uid: "generated-folder", parentUid: "integration-uid" },
    ]);
  });
});

test("saveDatasourceSelections stores target datasource bindings without rewriting dashboard files", async () => {
  await withTempProject(async (repository, entry) => {
    const secondEntry: DashboardManifestEntry = {
      name: "other-status",
      uid: "uid-2",
      path: "integration/other.json",
    };
    await repository.saveManifest({ dashboards: [entry, secondEntry] });
    await repository.createInstance("prod");
    await repository.saveDatasourceCatalog({
      datasources: {
        integration: {
          instances: {
            prod: {
              uid: "prod-datasource",
              name: "Integration Prod",
            },
          },
        },
      },
    });
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
      datasource: {
        type: "prometheus",
        uid: "integration",
      },
    });
    await repository.writeJsonFile(repository.dashboardPath(secondEntry), {
      title: "Other",
      uid: secondEntry.uid,
      datasource: {
        type: "prometheus",
        uid: "integration",
      },
    });

    const service = new DashboardService(
      repository,
      logger(),
      async () =>
        new MockGrafanaClient(
          {
            dashboard: {
              title: "unused",
              uid: entry.uid,
            },
            meta: {},
          },
          [],
          () => {},
        ),
    );

    await service.saveDatasourceSelections("prod", "default", selectorNameForEntry(entry), [
      {
        currentSourceName: "integration",
        nextSourceName: "mongo_main",
        targetUid: "prod-datasource",
        targetName: "Integration Prod",
      },
    ]);

    assert.deepEqual((await repository.loadWorkspaceConfig()).datasources.mongo_main, {
      instances: {
        prod: {
          name: "Integration Prod",
          uid: "prod-datasource",
        },
      },
    });
    const savedTargetState = await repository.readTargetOverrideFile("prod", "default", entry);
    assert.equal(savedTargetState?.revisionStates[savedTargetState.currentRevisionId!]?.datasourceBindings.integration, "mongo_main");
    assert.equal(
      await repository.readTextFileIfExists(repository.dashboardPath(entry)),
      "{\n  \"datasource\": {\n    \"type\": \"prometheus\",\n    \"uid\": \"integration\"\n  },\n  \"title\": \"Status\",\n  \"uid\": \"uid-1\"\n}\n",
    );
    assert.equal(
      await repository.readTextFileIfExists(repository.dashboardPath(secondEntry)),
      "{\n  \"datasource\": {\n    \"type\": \"prometheus\",\n    \"uid\": \"integration\"\n  },\n  \"title\": \"Other\",\n  \"uid\": \"uid-2\"\n}\n",
    );
  });
});

test("saveDatasourceSelections preserves manually entered datasource name even when uid is unknown", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
      datasource: {
        type: "prometheus",
        uid: "integration",
      },
    });

    const service = new DashboardService(
      repository,
      logger(),
      async () =>
        new MockGrafanaClient(
          {
            dashboard: {
              title: "unused",
              uid: entry.uid,
            },
            meta: {},
          },
          [],
          () => {},
        ),
    );

    await service.saveDatasourceSelections("prod", "default", selectorNameForEntry(entry), [
      {
        currentSourceName: "integration",
        nextSourceName: "mongo_main",
        targetName: "Integration Prod",
      },
    ]);

    assert.deepEqual((await repository.loadWorkspaceConfig()).datasources.mongo_main, {
      instances: {
        prod: {
          name: "Integration Prod",
        },
      },
    });
    const rows = await service.buildTargetDatasourceRows("prod", "default", entry);
    assert.equal(rows[0]?.globalDatasourceKey, "mongo_main");
    assert.equal(rows[0]?.targetName, "Integration Prod");
    assert.equal(rows[0]?.targetUid, undefined);
  });
});

test("saveOverrideFromForm persists only checked override variables", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("luz");
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
      templating: {
        list: [
          {
            name: "site",
            type: "custom",
            current: {
              text: "RND",
              value: "RND",
            },
          },
          {
            name: "env",
            type: "textbox",
            current: {
              text: "prod",
              value: "prod",
            },
          },
        ],
      },
    });

    const service = new DashboardService(
      repository,
      logger(),
      async () =>
        new MockGrafanaClient(
          {
            dashboard: {
              title: "unused",
              uid: entry.uid,
            },
            meta: {},
          },
          [],
          () => {},
        ),
    );

    await service.saveOverrideFromForm("luz", "default", entry, {
      "override_enabled__site": "on",
      "override_value__site": "LUZ",
      "override_value__env": "stage",
    });

    const overrides = JSON.parse((await repository.readTextFileIfExists(repository.dashboardOverridesFilePath(entry))) ?? "{}");
    const defaultState = overrides.dashboards["uid-1"].targets["luz/default"];
    assert.deepEqual(defaultState.revisionStates[defaultState.currentRevisionId].variableOverrides, {
      site: "LUZ",
    });
  });
});

test("saveOverrideFromForm only updates the current revision state of the selected target", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("luz");
    await repository.createInstance("rnd");
    await repository.writeJsonFile(repository.folderMetaPathForEntry(entry)!, {
      uid: "folder-1",
      path: "Integration",
    });
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
      templating: {
        list: [
          {
            name: "site",
            type: "textbox",
            current: {
              text: "RND",
              value: "RND",
            },
          },
        ],
      },
    });

    const service = new DashboardService(
      repository,
      logger(),
      async () =>
        new MockGrafanaClient(
          {
            dashboard: {
              title: "unused",
              uid: entry.uid,
            },
            meta: {},
          },
          [],
          () => {},
        ),
    );

    await service.saveOverrideFromForm("luz", "default", entry, {
      "override_enabled__site": "on",
      "override_value__site": "LUZ",
    });

    const overrides = JSON.parse((await repository.readTextFileIfExists(repository.dashboardOverridesFilePath(entry))) ?? "{}");
    const luzState = overrides.dashboards["uid-1"].targets["luz/default"];
    assert.deepEqual(luzState.revisionStates[luzState.currentRevisionId].variableOverrides, {
      site: "LUZ",
    });
    assert.equal(overrides.dashboards["uid-1"].targets["rnd/default"], undefined);
  });
});

test("createDeploymentTarget materializes folderPath together with managed variables", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("luz");
    await repository.writeJsonFile(repository.folderMetaPathForEntry(entry)!, {
      uid: "folder-1",
      path: "Integration",
    });
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
      templating: {
        list: [
          {
            name: "site",
            type: "textbox",
            current: {
              text: "LUZ",
              value: "LUZ",
            },
          },
        ],
      },
    });

    const service = new DashboardService(
      repository,
      logger(),
      async () =>
        new MockGrafanaClient(
          {
            dashboard: {
              title: "unused",
              uid: entry.uid,
            },
            meta: {},
          },
          [],
          () => {},
        ),
    );

    await service.saveOverrideFromForm("luz", "default", entry, {
      "override_enabled__site": "on",
      "override_value__site": "LUZ",
    });

    await service.createDeploymentTarget("luz", "dev");

    const overrides = JSON.parse((await repository.readTextFileIfExists(repository.dashboardOverridesFilePath(entry))) ?? "{}");
    const defaultState = overrides.dashboards["uid-1"].targets["luz/default"];
    assert.deepEqual(defaultState.revisionStates[defaultState.currentRevisionId].variableOverrides, {
      site: "LUZ",
    });
    const devState = overrides.dashboards["uid-1"].targets["luz/dev"];
    assert.equal(devState.folderPath, "Integration");
    assert.deepEqual(devState.revisionStates[devState.currentRevisionId].variableOverrides, {});
    assert.deepEqual(devState.revisionStates[devState.currentRevisionId].datasourceBindings, {});
    assert.match(devState.dashboardUid, /^[0-9a-f-]{36}$/);
  });
});

test("createDeploymentTarget initializes a fresh revision state for the new target", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("luz");
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
      templating: {
        list: [
          {
            name: "site",
            type: "textbox",
            current: {
              text: "LUZ",
              value: "LUZ",
            },
          },
        ],
      },
    });

    const service = new DashboardService(
      repository,
      logger(),
      async () =>
        new MockGrafanaClient(
          {
            dashboard: {
              title: "unused",
              uid: entry.uid,
            },
            meta: {},
          },
          [],
          () => {},
        ),
    );

    await service.saveOverrideFromForm("luz", "default", entry, {
      "override_enabled__site": "on",
      "override_value__site": "LUZ",
    });

    await service.createDeploymentTarget("luz", "dev");

    const overrides = JSON.parse((await repository.readTextFileIfExists(repository.dashboardOverridesFilePath(entry))) ?? "{}");
    const defaultState = overrides.dashboards["uid-1"].targets["luz/default"];
    assert.deepEqual(defaultState.revisionStates[defaultState.currentRevisionId].variableOverrides, {
      site: "LUZ",
    });
    const devState = overrides.dashboards["uid-1"].targets["luz/dev"];
    assert.deepEqual(devState.revisionStates[devState.currentRevisionId].variableOverrides, {});
    assert.deepEqual(devState.revisionStates[devState.currentRevisionId].datasourceBindings, {});
    assert.match(devState.dashboardUid, /^[0-9a-f-]{36}$/);
  });
});

test("createDeploymentTarget seeds dashboardUid even when dashboard has no managed variables", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("luz");
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
    });

    const service = new DashboardService(
      repository,
      logger(),
      async () =>
        new MockGrafanaClient(
          {
            dashboard: {
              title: "unused",
              uid: entry.uid,
            },
            meta: {},
          },
          [],
          () => {},
        ),
    );

    await service.createDeploymentTarget("luz", "dev");

    const savedOverride = await repository.readTargetOverrideFile("luz", "dev", entry);
    assert.deepEqual(savedOverride?.revisionStates[savedOverride.currentRevisionId!], {
      variableOverrides: {},
      datasourceBindings: {},
    });
    assert.match(savedOverride?.dashboardUid ?? "", /^[0-9a-f-]{36}$/);
  });
});

test("saveOverrideFromForm rejects invalid custom override values", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("luz");
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
      templating: {
        list: [
          {
            name: "site",
            type: "custom",
            current: {
              text: "RND",
              value: "RND",
            },
            options: [
              { text: "RND", value: "RND", selected: true },
              { text: "DEV", value: "DEV", selected: false },
            ],
          },
        ],
      },
    });

    const service = new DashboardService(
      repository,
      logger(),
      async () =>
        new MockGrafanaClient(
          {
            dashboard: {
              title: "unused",
              uid: entry.uid,
            },
            meta: {},
          },
          [],
          () => {},
        ),
    );

    await assert.rejects(
      service.saveOverrideFromForm("luz", "default", entry, {
        "override_enabled__site": "on",
        "override_value__site": "LUZ",
      }),
      /is not available in custom variable "site"/,
    );
  });
});
