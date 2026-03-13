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
    await repository.saveTargetOverrideFile("prod", "default", entry, {
      folderPath: "Integration/Dev",
      variables: {},
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
      "{\n  \"path\": \"Integration\",\n  \"uid\": \"folder-2\"\n}\n",
    );
  });
});

test("pullDashboards uses target-specific dashboardUid and normalizes local dashboard uid", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.createDeploymentTarget("prod", "blue");
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
    });
    await repository.saveTargetOverrideFile("prod", "blue", entry, {
      dashboardUid: "uid-blue",
      variables: {},
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

test("pullDashboards rejects mismatched dashboard uid for default target", async () => {
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

    await assert.rejects(
      service.pullDashboards([entry], "prod", "default"),
      /Pulled dashboard UID mismatch/,
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
      GRAFANA_NAMESPACE: "default",
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

test("listLiveTargetVersionStatuses matches live dashboard to stored revision", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.saveInstanceEnvValues("prod", {
      GRAFANA_URL: "http://prod",
      GRAFANA_NAMESPACE: "default",
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
        effectiveDashboardUid: entry.uid,
        matchedRevisionId: revision.id,
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
      GRAFANA_NAMESPACE: "default",
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
    await repository.saveOverrideFile("prod", entry, {
      variables: {
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

test("renderDashboards creates persisted render artifacts", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.saveInstanceEnvValues("prod", {
      GRAFANA_URL: "http://prod",
      GRAFANA_NAMESPACE: "default",
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

test("restoreTargetBackup uses raw live dashboard snapshot without render", async () => {
  await withTempProject(async (repository, entry) => {
    await repository.createInstance("prod");
    await repository.saveInstanceEnvValues("prod", {
      GRAFANA_URL: "http://prod",
      GRAFANA_NAMESPACE: "default",
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
    await repository.saveOverrideFile("prod", entry, {
      variables: {
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
    await repository.saveOverrideFile("prod", entry, {
      variables: {
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
    const summary = await service.restoreTargetBackup(backup);

    assert.equal(summary.dashboardResults.length, 1);
    const templating = upsertPayload?.dashboard.templating as { list: Array<Record<string, unknown>> };
    assert.deepEqual(templating.list[0].current, {
      text: "old",
      value: "old",
    });
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
    await repository.saveTargetOverrideFile("prod", "blue", entry, {
      folderPath: "LUZ/Integration/RND",
      variables: {},
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
    await repository.saveTargetOverrideFile("prod", "blue", entry, {
      dashboardUid: "shared-uid",
      variables: {},
    });
    await repository.saveTargetOverrideFile("prod", "blue", secondEntry, {
      dashboardUid: "shared-uid",
      variables: {},
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
    await repository.saveTargetOverrideFile("prod", "blue", entry, {
      dashboardUid: "uid-blue",
      variables: {},
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

    assert.deepEqual(await repository.readTargetOverrideFile("prod", "blue", entry), {
      dashboardUid: "uid-blue",
      folderPath: "Integration/Dev",
      variables: {},
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

test("saveDatasourceSelections renames sourceName globally and updates selected instance target mapping", async () => {
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

    await service.saveDatasourceSelections("prod", selectorNameForEntry(entry), [
      {
        currentSourceName: "integration",
        nextSourceName: "mongo_main",
        targetUid: "prod-datasource",
        targetName: "Integration Prod",
      },
    ]);

    assert.deepEqual((await repository.loadWorkspaceConfig()).datasources, {
      mongo_main: {
        instances: {
          prod: {
            name: "Integration Prod",
            uid: "prod-datasource",
          },
        },
      },
    });
    assert.equal(
      await repository.readTextFileIfExists(repository.dashboardPath(entry)),
      "{\n  \"datasource\": {\n    \"type\": \"prometheus\",\n    \"uid\": \"mongo_main\"\n  },\n  \"title\": \"Status\",\n  \"uid\": \"uid-1\"\n}\n",
    );
    assert.equal(
      await repository.readTextFileIfExists(repository.dashboardPath(secondEntry)),
      "{\n  \"datasource\": {\n    \"type\": \"prometheus\",\n    \"uid\": \"mongo_main\"\n  },\n  \"title\": \"Other\",\n  \"uid\": \"uid-2\"\n}\n",
    );
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

    assert.equal(
      await repository.readTextFileIfExists(repository.dashboardOverridesFilePath(entry)),
      "{\n  \"dashboards\": {\n    \"uid-1\": {\n      \"targets\": {\n        \"luz/default\": {\n          \"variables\": {\n            \"site\": \"LUZ\"\n          }\n        }\n      }\n    }\n  }\n}\n",
    );
  });
});

test("saveOverrideFromForm seeds managed override variables for all instances", async () => {
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

    assert.equal(
      await repository.readTextFileIfExists(repository.dashboardOverridesFilePath(entry)),
      "{\n  \"dashboards\": {\n    \"uid-1\": {\n      \"targets\": {\n        \"luz/default\": {\n          \"variables\": {\n            \"site\": \"LUZ\"\n          }\n        },\n        \"rnd/default\": {\n          \"variables\": {\n            \"site\": \"RND\"\n          }\n        }\n      }\n    }\n  }\n}\n",
    );
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
    assert.deepEqual(overrides.dashboards["uid-1"].targets["luz/default"], {
      variables: {
        site: "LUZ",
      },
    });
    assert.equal(overrides.dashboards["uid-1"].targets["luz/dev"].folderPath, "Integration");
    assert.deepEqual(overrides.dashboards["uid-1"].targets["luz/dev"].variables, {
      site: "LUZ",
    });
    assert.match(overrides.dashboards["uid-1"].targets["luz/dev"].dashboardUid, /^[0-9a-f-]{36}$/);
  });
});

test("createDeploymentTarget materializes already managed override variables for the new target", async () => {
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
    assert.deepEqual(overrides.dashboards["uid-1"].targets["luz/default"], {
      variables: {
        site: "LUZ",
      },
    });
    assert.deepEqual(overrides.dashboards["uid-1"].targets["luz/dev"].variables, {
      site: "LUZ",
    });
    assert.match(overrides.dashboards["uid-1"].targets["luz/dev"].dashboardUid, /^[0-9a-f-]{36}$/);
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
    assert.deepEqual(savedOverride, {
      dashboardUid: savedOverride?.dashboardUid,
      variables: {},
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
