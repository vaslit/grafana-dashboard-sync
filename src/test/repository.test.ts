import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ProjectRepository } from "../core/repository";

async function withTempProject(run: (rootPath: string, repository: ProjectRepository) => Promise<void>): Promise<void> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "grafana-dashboard-workspace-"));
  const repository = new ProjectRepository(rootPath);
  await repository.ensureProjectLayout();
  try {
    await run(rootPath, repository);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
}

test("loadConnectionConfig uses workspace config instance settings", async () => {
  await withTempProject(async (_rootPath, repository) => {
    const repositoryWithSecret = new ProjectRepository(repository.projectRootPath, {
      resolveToken: async (instanceName?: string) => (instanceName === "prod" ? "root-token" : undefined),
    });
    await repositoryWithSecret.ensureProjectLayout();
    await repository.createInstance("prod");
    await repository.saveInstanceEnvValues("prod", {
      GRAFANA_URL: "http://prod",
      GRAFANA_NAMESPACE: "team-a",
    });

    const connection = await repositoryWithSecret.loadConnectionConfig("prod");
    assert.equal(connection.baseUrl, "http://prod");
    assert.equal(connection.token, "root-token");
    assert.equal(connection.namespace, "team-a");
    assert.equal(connection.sourceLabel, ".grafana-dashboard-workspace.json -> instances.prod");
  });
});

test("loadConnectionConfig uses token resolver for instance secret", async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "grafana-dashboard-secret-"));
  const repository = new ProjectRepository(rootPath, {
    resolveToken: async (instanceName?: string) => (instanceName === "prod" ? "secret-token" : undefined),
  });

  try {
    await repository.ensureProjectLayout();
    await repository.createInstance("prod");
    await repository.saveInstanceEnvValues("prod", {
      GRAFANA_URL: "http://prod",
    });

    const connection = await repository.loadConnectionConfig("prod");
    assert.equal(connection.baseUrl, "http://prod");
    assert.equal(connection.token, "secret-token");
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test("repository resolves dashboard, override and folder metadata paths", async () => {
  await withTempProject(async (_rootPath, repository) => {
    const entry = {
      name: "sync-status",
      uid: "uid-1",
      path: "integration/status.json",
    };

    assert.equal(repository.dashboardPath(entry), path.join(repository.dashboardsDir, "integration", "status.json"));
    assert.equal(
      repository.overridePath("prod", entry),
      `${path.join(repository.dashboardsDir, "integration", ".overrides.json")}#prod/default`,
    );
    assert.equal(
      repository.folderMetaPathForEntry(entry),
      path.join(repository.dashboardsDir, "integration", ".folder.json"),
    );
  });
});

test("migrateDeploymentTargets moves legacy flat overrides into targets/default", async () => {
  await withTempProject(async (_rootPath, repository) => {
    const entry = {
      name: "sync-status",
      uid: "uid-1",
      path: "integration/status.json",
    };

    await repository.saveManifest({ dashboards: [entry] });
    await repository.createInstance("prod");
    await repository.writeJsonFile(path.join(repository.instancesDir, "prod", entry.path), {
      variables: {
        site: "rnd",
      },
    });

    const changed = await repository.migrateDeploymentTargets();

    assert.equal(changed, true);
    assert.deepEqual((await repository.loadWorkspaceConfig()).instances.prod.targets.default, {});
    assert.equal(
      await repository.readTextFileIfExists(repository.dashboardOverridesFilePath(entry)),
      "{\n  \"dashboards\": {\n    \"uid-1\": {\n      \"targets\": {\n        \"prod/default\": {\n          \"variables\": {\n            \"site\": \"rnd\"\n          }\n        }\n      }\n    }\n  }\n}\n",
    );
  });
});

test("saveTargetOverrideFile rejects dashboardUid on default target", async () => {
  await withTempProject(async (_rootPath, repository) => {
    const entry = {
      name: "sync-status",
      uid: "uid-1",
      path: "integration/status.json",
    };

    await repository.saveManifest({ dashboards: [entry] });
    await repository.createInstance("prod");

    await assert.rejects(
      repository.saveTargetOverrideFile("prod", "default", entry, {
        dashboardUid: "not-allowed",
        variables: {},
      }),
      /Invalid dashboard overrides file/,
    );
  });
});

test("updateManifestEntry migrates override key when base dashboard uid changes", async () => {
  await withTempProject(async (_rootPath, repository) => {
    const entry = {
      name: "sync-status",
      uid: "uid-1",
      path: "integration/status.json",
    };

    await repository.saveManifest({ dashboards: [entry] });
    await repository.createInstance("prod");
    await repository.createDeploymentTarget("prod", "blue");
    await repository.saveTargetOverrideFile("prod", "blue", entry, {
      dashboardUid: "uid-blue",
      variables: {
        site: "rnd",
      },
    });

    await repository.updateManifestEntry("sync-status", {
      ...entry,
      uid: "uid-2",
    });

    assert.equal(
      await repository.readTextFileIfExists(repository.dashboardOverridesFilePath({ ...entry, uid: "uid-2" })),
      "{\n  \"dashboards\": {\n    \"uid-2\": {\n      \"targets\": {\n        \"prod/blue\": {\n          \"dashboardUid\": \"uid-blue\",\n          \"variables\": {\n            \"site\": \"rnd\"\n          }\n        }\n      }\n    }\n  }\n}\n",
    );
  });
});

test("listInstances does not create instances directory during read-only access", async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "grafana-dashboard-readonly-"));
  const repository = new ProjectRepository(rootPath);

  try {
    const instances = await repository.listInstances();
    assert.deepEqual(instances, []);
    await assert.rejects(fs.stat(repository.instancesDir));
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test("saveInstanceEnvValues strips GRAFANA_TOKEN from stored file", async () => {
  await withTempProject(async (_rootPath, repository) => {
    await repository.createInstance("prod");
    await repository.saveInstanceEnvValues("prod", {
      GRAFANA_URL: "http://prod",
      GRAFANA_NAMESPACE: "team-a",
      GRAFANA_TOKEN: "should-not-be-written",
    });

    assert.deepEqual((await repository.loadWorkspaceConfig()).instances.prod, {
      grafanaUrl: "http://prod",
      grafanaNamespace: "team-a",
      targets: {
        default: {},
      },
    });
  });
});

test("removeInstance deletes instance directory", async () => {
  await withTempProject(async (_rootPath, repository) => {
    await repository.createInstance("prod");
    await repository.saveInstanceEnvValues("prod", {
      GRAFANA_URL: "http://prod",
    });

    await repository.removeInstance("prod");

    assert.equal((await repository.loadWorkspaceConfig()).instances.prod, undefined);
    assert.equal(await repository.instanceByName("prod"), undefined);
  });
});

test("removeDashboardFromProject deletes local dashboard and overrides when requested", async () => {
  await withTempProject(async (_rootPath, repository) => {
    const entry = {
      name: "sync-status",
      uid: "uid-1",
      path: "integration/status.json",
    };

    await repository.saveManifest({ dashboards: [entry] });
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
    });
    await repository.writeJsonFile(repository.folderMetaPathForEntry(entry)!, {
      path: "Integration",
      uid: "folder-1",
    });
    await repository.createInstance("prod");
    await repository.saveOverrideFile("prod", entry, {
      variables: {
        site: "nsk",
      },
    });
    await repository.saveDatasourceCatalog({
      datasources: {
        integration: {
          instances: {
            prod: {
              uid: "target-ds",
              name: "target-ds",
            },
          },
        },
      },
    });

    const result = await repository.removeDashboardFromProject("sync-status", { deleteFiles: true });
    const manifest = await repository.loadManifest();

    assert.equal(result.removedPaths.length, 3);
    assert.deepEqual(manifest.dashboards, []);
    assert.equal(await repository.readTextFileIfExists(repository.dashboardPath(entry)), undefined);
    assert.equal(await repository.readTextFileIfExists(repository.folderMetaPathForEntry(entry)!), undefined);
    assert.equal(await repository.readTextFileIfExists(repository.dashboardOverridesFilePath(entry)), undefined);
    assert.deepEqual((await repository.loadWorkspaceConfig()).datasources, {
      integration: {
        instances: {
          prod: {
            uid: "target-ds",
            name: "target-ds",
          },
        },
      },
    });
  });
});

test("createBackupSnapshot stores grouped backup and lists it", async () => {
  await withTempProject(async (_rootPath, repository) => {
    const entry = {
      name: "sync-status",
      uid: "uid-1",
      path: "integration/status.json",
    };

    await repository.saveManifest({ dashboards: [entry] });
    await repository.writeJsonFile(repository.dashboardPath(entry), {
      title: "Status",
      uid: entry.uid,
    });
    await repository.createInstance("prod");
    await repository.saveInstanceEnvValues("prod", {
      GRAFANA_URL: "http://prod",
      GRAFANA_NAMESPACE: "team-a",
    });
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
    await repository.saveOverrideFile("prod", entry, {
      variables: {
        site: "nsk",
      },
    });

    const backup = await repository.createBackupSnapshot(
      "dashboard",
      [
        {
          instanceName: "prod",
          targetName: "default",
          dashboards: [
            {
              selectorName: "sync-status",
              baseUid: "uid-1",
              effectiveDashboardUid: "uid-1",
              path: "integration/status.json",
              folderPath: "Integration",
              title: "Status",
              snapshotPath: "",
              dashboard: {
                title: "Status",
                uid: "uid-1",
              },
            },
          ],
        },
      ],
      "20260101_000000",
    );
    const backups = await repository.listBackups();

    assert.equal(backups.length, 1);
    assert.equal(backups[0].name, "20260101_000000");
    assert.equal(backups[0].scope, "dashboard");
    assert.equal(backups[0].instanceCount, 1);
    assert.equal(backups[0].targetCount, 1);
    assert.equal(backups[0].dashboardCount, 1);
    assert.ok(await repository.readTextFileIfExists(path.join(backup.rootPath, "backup_manifest.json")));
    assert.ok(
      await repository.readTextFileIfExists(
        path.join(backup.rootPath, "instances", "prod", "targets", "default", "dashboards", "integration", "status.json"),
      ),
    );
    assert.equal(backups[0].instances[0]?.targets[0]?.dashboards[0]?.selectorName, "sync-status");
  });
});
