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
    });

    const connection = await repositoryWithSecret.loadConnectionConfig("prod");
    assert.equal(connection.baseUrl, "http://prod");
    assert.equal(connection.authKind, "bearer");
    assert.equal(connection.token, "root-token");
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
    assert.equal(connection.authKind, "bearer");
    assert.equal(connection.token, "secret-token");
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test("loadConnectionConfig falls back to basic auth when username and password are configured", async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "grafana-dashboard-basic-auth-"));
  const repository = new ProjectRepository(rootPath, {
    resolvePassword: async (instanceName?: string) => (instanceName === "prod" ? "secret-password" : undefined),
  });

  try {
    await repository.ensureProjectLayout();
    await repository.createInstance("prod");
    await repository.saveInstanceEnvValues("prod", {
      GRAFANA_URL: "http://prod",
      GRAFANA_USERNAME: "grafana-user",
    });

    const connection = await repository.loadConnectionConfig("prod");
    assert.equal(connection.baseUrl, "http://prod");
    assert.equal(connection.authKind, "basic");
    assert.equal(connection.username, "grafana-user");
    assert.equal(connection.password, "secret-password");
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

test("migrateDeploymentTargets is disabled for version 4 projects", async () => {
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

    assert.equal(changed, false);
    assert.equal(await repository.readTextFileIfExists(repository.dashboardOverridesFilePath(entry)), undefined);
  });
});

test("saveTargetOverrideFile allows dashboardUid on target named default", async () => {
  await withTempProject(async (_rootPath, repository) => {
    const entry = {
      name: "sync-status",
      uid: "uid-1",
      path: "integration/status.json",
    };

    await repository.saveManifest({ dashboards: [entry] });
    await repository.createInstance("prod");

    await repository.saveTargetOverrideFile("prod", "default", entry, {
      dashboardUid: "allowed-now",
      revisionStates: {},
    });

    const saved = await repository.readTargetOverrideFile("prod", "default", entry);
    assert.equal(saved?.dashboardUid, "allowed-now");
  });
});

test("removeDeploymentTarget rejects removing the last remaining target", async () => {
  await withTempProject(async (_rootPath, repository) => {
    await repository.createInstance("prod");
    await assert.rejects(
      repository.removeDeploymentTarget("prod", "default"),
      /Cannot remove the last remaining deployment target/,
    );
  });
});

test("renameDeploymentTarget updates workspace config and override keys", async () => {
  await withTempProject(async (_rootPath, repository) => {
    const entry = {
      name: "sync-status",
      uid: "uid-1",
      path: "integration/status.json",
    };

    await repository.saveManifest({ dashboards: [entry] });
    await repository.createInstance("prod");
    await repository.saveTargetOverrideFile("prod", "default", entry, {
      dashboardUid: "uid-dev",
      revisionStates: {
        rev1: {
          variableOverrides: {
            site: "rnd",
          },
          datasourceBindings: {},
        },
      },
    });

    const renamed = await repository.renameDeploymentTarget("prod", "default", "dev");

    assert.equal(renamed.name, "dev");
    const config = await repository.loadWorkspaceConfig();
    assert.equal(config.instances.prod?.targets.default, undefined);
    assert.deepEqual(config.instances.prod?.targets.dev, {});
    const saved = await repository.readTextFileIfExists(repository.dashboardOverridesFilePath(entry));
    assert.match(saved ?? "", /"prod\/dev"/);
    assert.doesNotMatch(saved ?? "", /"prod\/default"/);
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
      revisionStates: {
        rev1: {
          variableOverrides: {
            site: "rnd",
          },
          datasourceBindings: {},
        },
      },
    });

    await repository.updateManifestEntry("sync-status", {
      ...entry,
      uid: "uid-2",
    });

    assert.equal(
      await repository.readTextFileIfExists(repository.dashboardOverridesFilePath({ ...entry, uid: "uid-2" })),
      "{\n  \"dashboards\": {\n    \"uid-2\": {\n      \"targets\": {\n        \"prod/blue\": {\n          \"dashboardUid\": \"uid-blue\",\n          \"revisionStates\": {\n            \"rev1\": {\n              \"datasourceBindings\": {},\n              \"variableOverrides\": {\n                \"site\": \"rnd\"\n              }\n            }\n          }\n        }\n      }\n    }\n  }\n}\n",
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
      GRAFANA_USERNAME: "grafana-user",
      GRAFANA_TOKEN: "should-not-be-written",
      GRAFANA_PASSWORD: "should-not-be-written",
    });

    assert.deepEqual((await repository.loadWorkspaceConfig()).instances.prod, {
      grafanaUrl: "http://prod",
      grafanaUsername: "grafana-user",
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
      revisionStates: {},
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

test("removeAlertFromProject deletes alert files and prunes only unused contact points", async () => {
  await withTempProject(async (_rootPath, repository) => {
    await repository.createInstance("prod");
    await repository.createDeploymentTarget("prod", "blue");

    const manifest = {
      version: 1 as const,
      instanceName: "prod",
      targetName: "blue",
      generatedAt: "2026-03-19T00:00:00.000Z",
      rules: {
        "alert-a": {
          uid: "alert-a",
          title: "Alert A",
          path: "rules/alert-a.json",
          contactPointKeys: ["uid__cp-shared", "uid__cp-unused"],
          contactPointStatus: "linked" as const,
        },
        "alert-b": {
          uid: "alert-b",
          title: "Alert B",
          path: "rules/alert-b.json",
          contactPointKeys: ["uid__cp-shared"],
          contactPointStatus: "linked" as const,
        },
      },
      contactPoints: {
        "uid__cp-shared": {
          key: "uid__cp-shared",
          path: "contact-points/uid__cp-shared.json",
          name: "shared",
          uid: "cp-shared",
          type: "email",
        },
        "uid__cp-unused": {
          key: "uid__cp-unused",
          path: "contact-points/uid__cp-unused.json",
          name: "unused",
          uid: "cp-unused",
          type: "email",
        },
      },
    };

    await repository.saveAlertsManifest("prod", "blue", manifest);
    await repository.writeJsonFile(repository.alertRuleFilePath("prod", "blue", "alert-a"), {
      uid: "alert-a",
      title: "Alert A",
    });
    await repository.writeJsonFile(repository.alertRuleFilePath("prod", "blue", "alert-b"), {
      uid: "alert-b",
      title: "Alert B",
    });
    await repository.writeJsonFile(repository.alertContactPointFilePath("prod", "blue", "uid__cp-shared"), {
      uid: "cp-shared",
      name: "shared",
      type: "email",
    });
    await repository.writeJsonFile(repository.alertContactPointFilePath("prod", "blue", "uid__cp-unused"), {
      uid: "cp-unused",
      name: "unused",
      type: "email",
    });

    const result = await repository.removeAlertFromProject("prod", "blue", "alert-a");
    const nextManifest = await repository.loadAlertsManifest("prod", "blue");

    assert.equal(nextManifest.rules["alert-a"], undefined);
    assert.ok(nextManifest.rules["alert-b"]);
    assert.ok(nextManifest.contactPoints["uid__cp-shared"]);
    assert.equal(nextManifest.contactPoints["uid__cp-unused"], undefined);
    assert.deepEqual(result.removedContactPointKeys, ["uid__cp-unused"]);
    assert.equal(await repository.readTextFileIfExists(repository.alertRuleFilePath("prod", "blue", "alert-a")), undefined);
    assert.equal(
      await repository.readTextFileIfExists(repository.alertContactPointFilePath("prod", "blue", "uid__cp-unused")),
      undefined,
    );
    assert.ok(await repository.readTextFileIfExists(repository.alertContactPointFilePath("prod", "blue", "uid__cp-shared")));
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
      revisionStates: {},
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
