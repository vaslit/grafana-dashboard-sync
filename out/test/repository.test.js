"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const promises_1 = __importDefault(require("node:fs/promises"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const repository_1 = require("../core/repository");
async function withTempProject(run) {
    const rootPath = await promises_1.default.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), "grafana-dashboard-workspace-"));
    const repository = new repository_1.ProjectRepository(rootPath);
    await repository.ensureProjectLayout();
    try {
        await run(rootPath, repository);
    }
    finally {
        await promises_1.default.rm(rootPath, { recursive: true, force: true });
    }
}
(0, node_test_1.test)("loadConnectionConfig uses workspace config instance settings", async () => {
    await withTempProject(async (_rootPath, repository) => {
        const repositoryWithSecret = new repository_1.ProjectRepository(repository.projectRootPath, {
            resolveToken: async (instanceName) => (instanceName === "prod" ? "root-token" : undefined),
        });
        await repositoryWithSecret.ensureProjectLayout();
        await repository.createInstance("prod");
        await repository.saveInstanceEnvValues("prod", {
            GRAFANA_URL: "http://prod",
            GRAFANA_NAMESPACE: "team-a",
        });
        const connection = await repositoryWithSecret.loadConnectionConfig("prod");
        strict_1.default.equal(connection.baseUrl, "http://prod");
        strict_1.default.equal(connection.token, "root-token");
        strict_1.default.equal(connection.namespace, "team-a");
        strict_1.default.equal(connection.sourceLabel, ".grafana-dashboard-workspace.json -> instances.prod");
    });
});
(0, node_test_1.test)("loadConnectionConfig uses token resolver for instance secret", async () => {
    const rootPath = await promises_1.default.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), "grafana-dashboard-secret-"));
    const repository = new repository_1.ProjectRepository(rootPath, {
        resolveToken: async (instanceName) => (instanceName === "prod" ? "secret-token" : undefined),
    });
    try {
        await repository.ensureProjectLayout();
        await repository.createInstance("prod");
        await repository.saveInstanceEnvValues("prod", {
            GRAFANA_URL: "http://prod",
        });
        const connection = await repository.loadConnectionConfig("prod");
        strict_1.default.equal(connection.baseUrl, "http://prod");
        strict_1.default.equal(connection.token, "secret-token");
    }
    finally {
        await promises_1.default.rm(rootPath, { recursive: true, force: true });
    }
});
(0, node_test_1.test)("repository resolves dashboard, override and folder metadata paths", async () => {
    await withTempProject(async (_rootPath, repository) => {
        const entry = {
            name: "sync-status",
            uid: "uid-1",
            path: "integration/status.json",
        };
        strict_1.default.equal(repository.dashboardPath(entry), node_path_1.default.join(repository.dashboardsDir, "integration", "status.json"));
        strict_1.default.equal(repository.overridePath("prod", entry), `${node_path_1.default.join(repository.dashboardsDir, "integration", ".overrides.json")}#prod/default`);
        strict_1.default.equal(repository.folderMetaPathForEntry(entry), node_path_1.default.join(repository.dashboardsDir, "integration", ".folder.json"));
    });
});
(0, node_test_1.test)("migrateDeploymentTargets moves legacy flat overrides into targets/default", async () => {
    await withTempProject(async (_rootPath, repository) => {
        const entry = {
            name: "sync-status",
            uid: "uid-1",
            path: "integration/status.json",
        };
        await repository.saveManifest({ dashboards: [entry] });
        await repository.createInstance("prod");
        await repository.writeJsonFile(node_path_1.default.join(repository.instancesDir, "prod", entry.path), {
            variables: {
                site: "rnd",
            },
        });
        const changed = await repository.migrateDeploymentTargets();
        strict_1.default.equal(changed, true);
        strict_1.default.deepEqual((await repository.loadWorkspaceConfig()).instances.prod.targets.default, {});
        strict_1.default.equal(await repository.readTextFileIfExists(repository.dashboardOverridesFilePath(entry)), "{\n  \"dashboards\": {\n    \"uid-1\": {\n      \"targets\": {\n        \"prod/default\": {\n          \"variables\": {\n            \"site\": \"rnd\"\n          }\n        }\n      }\n    }\n  }\n}\n");
    });
});
(0, node_test_1.test)("saveTargetOverrideFile rejects dashboardUid on default target", async () => {
    await withTempProject(async (_rootPath, repository) => {
        const entry = {
            name: "sync-status",
            uid: "uid-1",
            path: "integration/status.json",
        };
        await repository.saveManifest({ dashboards: [entry] });
        await repository.createInstance("prod");
        await strict_1.default.rejects(repository.saveTargetOverrideFile("prod", "default", entry, {
            dashboardUid: "not-allowed",
            variables: {},
        }), /Invalid dashboard overrides file/);
    });
});
(0, node_test_1.test)("updateManifestEntry migrates override key when base dashboard uid changes", async () => {
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
        strict_1.default.equal(await repository.readTextFileIfExists(repository.dashboardOverridesFilePath({ ...entry, uid: "uid-2" })), "{\n  \"dashboards\": {\n    \"uid-2\": {\n      \"targets\": {\n        \"prod/blue\": {\n          \"dashboardUid\": \"uid-blue\",\n          \"variables\": {\n            \"site\": \"rnd\"\n          }\n        }\n      }\n    }\n  }\n}\n");
    });
});
(0, node_test_1.test)("listInstances does not create instances directory during read-only access", async () => {
    const rootPath = await promises_1.default.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), "grafana-dashboard-readonly-"));
    const repository = new repository_1.ProjectRepository(rootPath);
    try {
        const instances = await repository.listInstances();
        strict_1.default.deepEqual(instances, []);
        await strict_1.default.rejects(promises_1.default.stat(repository.instancesDir));
    }
    finally {
        await promises_1.default.rm(rootPath, { recursive: true, force: true });
    }
});
(0, node_test_1.test)("saveInstanceEnvValues strips GRAFANA_TOKEN from stored file", async () => {
    await withTempProject(async (_rootPath, repository) => {
        await repository.createInstance("prod");
        await repository.saveInstanceEnvValues("prod", {
            GRAFANA_URL: "http://prod",
            GRAFANA_NAMESPACE: "team-a",
            GRAFANA_TOKEN: "should-not-be-written",
        });
        strict_1.default.deepEqual((await repository.loadWorkspaceConfig()).instances.prod, {
            grafanaUrl: "http://prod",
            grafanaNamespace: "team-a",
            targets: {
                default: {},
            },
        });
    });
});
(0, node_test_1.test)("removeInstance deletes instance directory", async () => {
    await withTempProject(async (_rootPath, repository) => {
        await repository.createInstance("prod");
        await repository.saveInstanceEnvValues("prod", {
            GRAFANA_URL: "http://prod",
        });
        await repository.removeInstance("prod");
        strict_1.default.equal((await repository.loadWorkspaceConfig()).instances.prod, undefined);
        strict_1.default.equal(await repository.instanceByName("prod"), undefined);
    });
});
(0, node_test_1.test)("removeDashboardFromProject deletes local dashboard and overrides when requested", async () => {
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
        await repository.writeJsonFile(repository.folderMetaPathForEntry(entry), {
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
        strict_1.default.equal(result.removedPaths.length, 3);
        strict_1.default.deepEqual(manifest.dashboards, []);
        strict_1.default.equal(await repository.readTextFileIfExists(repository.dashboardPath(entry)), undefined);
        strict_1.default.equal(await repository.readTextFileIfExists(repository.folderMetaPathForEntry(entry)), undefined);
        strict_1.default.equal(await repository.readTextFileIfExists(repository.dashboardOverridesFilePath(entry)), undefined);
        strict_1.default.deepEqual((await repository.loadWorkspaceConfig()).datasources, {
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
(0, node_test_1.test)("createTargetBackupSnapshot stores raw target backup and lists it", async () => {
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
        const backup = await repository.createTargetBackupSnapshot("prod", "default", "dashboard", [
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
        ], "20260101_000000");
        const backups = await repository.listBackups();
        strict_1.default.equal(backups.length, 1);
        strict_1.default.equal(backups[0].name, "20260101_000000");
        strict_1.default.equal(backups[0].instanceName, "prod");
        strict_1.default.equal(backups[0].targetName, "default");
        strict_1.default.equal(backups[0].scope, "dashboard");
        strict_1.default.equal(backups[0].dashboardCount, 1);
        strict_1.default.ok(await repository.readTextFileIfExists(node_path_1.default.join(backup.rootPath, "backup_manifest.json")));
        strict_1.default.ok(await repository.readTextFileIfExists(node_path_1.default.join(backup.rootPath, "dashboards", "integration", "status.json")));
    });
});
//# sourceMappingURL=repository.test.js.map