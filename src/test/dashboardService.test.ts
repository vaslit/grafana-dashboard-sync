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
  constructor(
    private readonly dashboardResponse: GrafanaDashboardResponse,
    private readonly folders: GrafanaFolder[],
    private readonly onUpsert: (payload: { dashboard: Record<string, unknown>; folderUid?: string; message: string }) => void,
    private readonly datasources: GrafanaDatasourceSummary[] = [],
    private readonly onGetDashboardByUid: (uid: string) => void = () => {},
  ) {}

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
