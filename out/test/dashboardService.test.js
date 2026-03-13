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
const dashboardService_1 = require("../core/dashboardService");
const manifest_1 = require("../core/manifest");
const repository_1 = require("../core/repository");
class MockGrafanaClient {
    dashboardResponse;
    folders;
    onUpsert;
    datasources;
    onGetDashboardByUid;
    constructor(dashboardResponse, folders, onUpsert, datasources = [], onGetDashboardByUid = () => { }) {
        this.dashboardResponse = dashboardResponse;
        this.folders = folders;
        this.onUpsert = onUpsert;
        this.datasources = datasources;
        this.onGetDashboardByUid = onGetDashboardByUid;
    }
    async getDashboardByUid(uid) {
        this.onGetDashboardByUid(uid);
        return this.dashboardResponse;
    }
    async listDashboards() {
        return [];
    }
    async listDatasources() {
        return [...this.datasources];
    }
    async listFolders(parentUid) {
        return [...this.folders].filter((folder) => (parentUid ? folder.parentUid === parentUid : !folder.parentUid));
    }
    async createFolder(input) {
        const created = {
            title: input.title,
            uid: input.uid ?? "generated-folder",
            parentUid: input.parentUid,
        };
        this.folders.push(created);
        return created;
    }
    async upsertDashboard(input) {
        this.onUpsert(input);
        return {
            url: "/d/test",
            status: "success",
        };
    }
}
async function withTempProject(run) {
    const rootPath = await promises_1.default.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), "grafana-dashboard-service-"));
    const repository = new repository_1.ProjectRepository(rootPath, {
        resolveToken: async () => "test-token",
    });
    await repository.ensureProjectLayout();
    const entry = {
        name: "sync-status",
        uid: "uid-1",
        path: "integration/status.json",
    };
    await repository.saveManifest({ dashboards: [entry] });
    try {
        await run(repository, entry);
    }
    finally {
        await promises_1.default.rm(rootPath, { recursive: true, force: true });
    }
}
function logger() {
    return {
        info() { },
        error() { },
    };
}
(0, node_test_1.test)("pullDashboards updates changed files and skips unchanged ones", async () => {
    await withTempProject(async (repository, entry) => {
        await repository.createInstance("prod");
        await repository.createInstance("stage");
        await repository.writeJsonFile(repository.dashboardPath(entry), {
            title: "Old",
            uid: entry.uid,
        });
        await repository.writeJsonFile(repository.folderMetaPathForEntry(entry), {
            path: "Integration",
            uid: "folder-1",
        });
        const dashboardResponse = {
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
        const client = new MockGrafanaClient(dashboardResponse, [{ title: "Integration", uid: "folder-1" }], () => { }, [{ uid: "source-datasource", name: "integration", type: "prometheus" }]);
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => client);
        const first = await service.pullDashboards([entry], "prod");
        strict_1.default.equal(first.updatedCount, 1);
        strict_1.default.equal(first.skippedCount, 1);
        strict_1.default.equal(first.previousLocalBackupCount, 0);
        strict_1.default.equal(JSON.stringify((await repository.loadWorkspaceConfig()).datasources, null, 2), JSON.stringify({
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
        }, null, 2));
        strict_1.default.equal(await repository.readTextFileIfExists(repository.dashboardPath(entry)), "{\n  \"datasource\": {\n    \"type\": \"prometheus\",\n    \"uid\": \"integration\"\n  },\n  \"title\": \"New\",\n  \"uid\": \"uid-1\"\n}\n");
        strict_1.default.equal(await repository.readTextFileIfExists(repository.folderMetaPathForEntry(entry)), "{\n  \"path\": \"Integration\",\n  \"uid\": \"folder-1\"\n}\n");
        const second = await service.pullDashboards([entry], "prod");
        strict_1.default.equal(second.updatedCount, 0);
        strict_1.default.equal(second.skippedCount, 2);
    });
});
(0, node_test_1.test)("pullDashboards creates a new dashboard file when the manifest entry has no local JSON yet", async () => {
    await withTempProject(async (repository, entry) => {
        await repository.createInstance("prod");
        const client = new MockGrafanaClient({
            dashboard: {
                title: "Fresh dashboard",
                uid: entry.uid,
            },
            meta: {},
        }, [], () => { });
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => client);
        const summary = await service.pullDashboards([entry], "prod");
        strict_1.default.equal(summary.updatedCount, 1);
        strict_1.default.equal(summary.skippedCount, 0);
        strict_1.default.equal(await repository.readTextFileIfExists(repository.dashboardPath(entry)), "{\n  \"title\": \"Fresh dashboard\",\n  \"uid\": \"uid-1\"\n}\n");
        strict_1.default.equal((await repository.readDashboardVersionIndex(entry))?.revisions.length, 1);
    });
});
(0, node_test_1.test)("pullDashboards preserves base folder path when dashboard has explicit folderPath overrides", async () => {
    await withTempProject(async (repository, entry) => {
        await repository.createInstance("prod");
        await repository.writeJsonFile(repository.dashboardPath(entry), {
            title: "Status",
            uid: entry.uid,
        });
        await repository.writeJsonFile(repository.folderMetaPathForEntry(entry), {
            uid: "folder-1",
            path: "Integration",
        });
        await repository.saveTargetOverrideFile("prod", "default", entry, {
            folderPath: "Integration/Dev",
            variables: {},
        });
        const dashboardResponse = {
            dashboard: {
                title: "Status",
                uid: entry.uid,
            },
            meta: {
                folderUid: "folder-2",
                folderTitle: "Source Integration",
            },
        };
        const client = new MockGrafanaClient(dashboardResponse, [{ title: "Source Integration", uid: "folder-2" }], () => { });
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => client);
        await service.pullDashboards([entry], "prod");
        strict_1.default.equal(await repository.readTextFileIfExists(repository.folderMetaPathForEntry(entry)), "{\n  \"path\": \"Integration\",\n  \"uid\": \"folder-2\"\n}\n");
    });
});
(0, node_test_1.test)("pullDashboards uses target-specific dashboardUid and normalizes local dashboard uid", async () => {
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
        const client = new MockGrafanaClient({
            dashboard: {
                title: "Status Blue",
                uid: "uid-blue",
            },
            meta: {},
        }, [], () => { }, [], (uid) => {
            requestedUid = uid;
        });
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => client);
        await service.pullDashboards([entry], "prod", "blue");
        strict_1.default.equal(requestedUid, "uid-blue");
        strict_1.default.equal(await repository.readTextFileIfExists(repository.dashboardPath(entry)), "{\n  \"title\": \"Status Blue\",\n  \"uid\": \"uid-1\"\n}\n");
        strict_1.default.equal((await repository.readTargetOverrideFile("prod", "blue", entry))?.dashboardUid, "uid-blue");
    });
});
(0, node_test_1.test)("pullDashboards rejects mismatched dashboard uid for default target", async () => {
    await withTempProject(async (repository, entry) => {
        await repository.createInstance("prod");
        await repository.writeJsonFile(repository.dashboardPath(entry), {
            title: "Status",
            uid: entry.uid,
        });
        const client = new MockGrafanaClient({
            dashboard: {
                title: "Status",
                uid: "unexpected-uid",
            },
            meta: {},
        }, [], () => { });
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => client);
        await strict_1.default.rejects(service.pullDashboards([entry], "prod", "default"), /Pulled dashboard UID mismatch/);
    });
});
(0, node_test_1.test)("listDashboardRevisions initializes version history from working copy", async () => {
    await withTempProject(async (repository, entry) => {
        await repository.writeJsonFile(repository.dashboardPath(entry), {
            title: "Status v1",
            uid: entry.uid,
        });
        await repository.writeJsonFile(repository.folderMetaPathForEntry(entry), {
            path: "Integration",
            uid: "folder-1",
        });
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => new MockGrafanaClient({
            dashboard: {
                title: "unused",
                uid: entry.uid,
            },
            meta: {},
        }, [], () => { }));
        const revisions = await service.listDashboardRevisions(entry);
        strict_1.default.equal(revisions.length, 1);
        strict_1.default.equal(revisions[0]?.isCheckedOut, true);
        strict_1.default.equal((await repository.readDashboardVersionIndex(entry))?.checkedOutRevisionId, revisions[0]?.record.id);
        strict_1.default.ok(await repository.readDashboardRevisionSnapshot(entry, revisions[0].record.id));
    });
});
(0, node_test_1.test)("deployRevision deploys selected revision", async () => {
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
        await repository.writeJsonFile(repository.folderMetaPathForEntry(entry), {
            path: "Integration",
            uid: "folder-1",
        });
        let upsertPayload;
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => new MockGrafanaClient({
            dashboard: {
                title: "unused",
                uid: entry.uid,
            },
            meta: {},
        }, [], (payload) => {
            upsertPayload = payload;
        }));
        const initialRevision = (await service.listDashboardRevisions(entry))[0].record;
        await repository.writeJsonFile(repository.dashboardPath(entry), {
            title: "Status v2",
            uid: entry.uid,
        });
        const currentRevision = await service.createRevisionFromWorkingCopy(entry);
        await service.deployRevision(entry, initialRevision.id, "prod", "default");
        await service.checkoutRevision(entry, initialRevision.id);
        strict_1.default.equal(upsertPayload?.dashboard.title ?? "", "Status v1");
        strict_1.default.equal((await repository.readDashboardJson(entry)).title, "Status v1");
        strict_1.default.notEqual(initialRevision.id, currentRevision.id);
        strict_1.default.equal((await service.currentCheckedOutRevision(entry))?.id, initialRevision.id);
    });
});
(0, node_test_1.test)("listLiveTargetVersionStatuses matches live dashboard to stored revision", async () => {
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
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => new MockGrafanaClient({
            dashboard: {
                title: "Status v1",
                uid: entry.uid,
            },
            meta: {},
        }, [], () => { }));
        const revision = (await service.listDashboardRevisions(entry))[0].record;
        const statuses = await service.listLiveTargetVersionStatuses(entry);
        strict_1.default.deepEqual(statuses, [
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
(0, node_test_1.test)("deployDashboards applies overrides and creates missing folder", async () => {
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
        await repository.writeJsonFile(repository.folderMetaPathForEntry(entry), {
            path: "Integration",
            uid: "folder-1",
        });
        await repository.saveOverrideFile("prod", entry, {
            variables: {
                site: "nsk",
            },
        });
        let upsertPayload;
        const client = new MockGrafanaClient({
            dashboard: {
                title: "unused",
                uid: entry.uid,
            },
            meta: {},
        }, [], (payload) => {
            upsertPayload = payload;
        });
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => client);
        const summary = await service.deployDashboards([entry], "prod");
        strict_1.default.equal(summary.dashboardResults.length, 1);
        strict_1.default.equal(summary.dashboardResults[0].targetBaseUrl, "http://prod");
        strict_1.default.equal(summary.dashboardResults[0].folderUid, "folder-1");
        strict_1.default.ok(upsertPayload);
        strict_1.default.equal(upsertPayload?.folderUid, "folder-1");
        const templating = upsertPayload?.dashboard.templating;
        strict_1.default.deepEqual(templating.list[0].current, {
            text: "nsk",
            value: "nsk",
        });
        strict_1.default.equal(upsertPayload?.dashboard.datasource?.uid, "prod-datasource");
        strict_1.default.equal(templating.list[1].datasource?.uid, "prod-datasource");
        strict_1.default.ok(await repository.readTextFileIfExists(repository.renderDashboardPath("prod", "default", entry)));
        strict_1.default.ok(await repository.readTextFileIfExists(repository.renderManifestPath("prod", "default")));
    });
});
(0, node_test_1.test)("renderDashboards creates persisted render artifacts", async () => {
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
        await repository.writeJsonFile(repository.folderMetaPathForEntry(entry), {
            path: "Integration",
            uid: "folder-1",
        });
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => new MockGrafanaClient({
            dashboard: {
                title: "unused",
                uid: entry.uid,
            },
            meta: {},
        }, [], () => { }));
        const manifest = await service.renderDashboards([entry], "prod", "default", "dashboard");
        strict_1.default.equal(manifest.instanceName, "prod");
        strict_1.default.equal(manifest.targetName, "default");
        strict_1.default.equal(manifest.scope, "dashboard");
        strict_1.default.equal(manifest.dashboards.length, 1);
        strict_1.default.ok(await repository.readTextFileIfExists(repository.renderDashboardPath("prod", "default", entry)));
        strict_1.default.ok(await repository.readTextFileIfExists(repository.renderManifestPath("prod", "default")));
        strict_1.default.equal(await repository.readTextFileIfExists(repository.renderDashboardPath("prod", "default", entry)), "{\n  \"datasource\": {\n    \"type\": \"prometheus\",\n    \"uid\": \"prod-datasource\"\n  },\n  \"title\": \"Status\",\n  \"uid\": \"uid-1\"\n}\n");
    });
});
(0, node_test_1.test)("deployDashboards generates and persists dashboardUid for non-default target", async () => {
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
        let upsertPayload;
        const client = new MockGrafanaClient({
            dashboard: {
                title: "unused",
                uid: entry.uid,
            },
            meta: {},
        }, [], (payload) => {
            upsertPayload = payload;
        });
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => client);
        await service.deployDashboards([entry], "prod", "blue");
        const savedOverride = await repository.readTargetOverrideFile("prod", "blue", entry);
        strict_1.default.ok(savedOverride?.dashboardUid);
        strict_1.default.equal(upsertPayload?.dashboard.uid, savedOverride?.dashboardUid);
        strict_1.default.notEqual(upsertPayload?.dashboard.uid, entry.uid);
    });
});
(0, node_test_1.test)("restoreTargetBackup uses raw live dashboard snapshot without render", async () => {
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
        await repository.writeJsonFile(repository.folderMetaPathForEntry(entry), {
            path: "Integration",
            uid: "folder-1",
        });
        await repository.saveOverrideFile("prod", entry, {
            variables: {
                site: "nsk-old",
            },
        });
        const backupCaptureService = new dashboardService_1.DashboardService(repository, logger(), async () => new MockGrafanaClient({
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
        }, [{ title: "Integration", uid: "folder-1" }], () => { }));
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
        let upsertPayload;
        const client = new MockGrafanaClient({
            dashboard: {
                title: "unused",
                uid: entry.uid,
            },
            meta: {},
        }, [{ title: "Integration", uid: "folder-1" }], (payload) => {
            upsertPayload = payload;
        });
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => client);
        const summary = await service.restoreTargetBackup(backup);
        strict_1.default.equal(summary.dashboardResults.length, 1);
        const templating = upsertPayload?.dashboard.templating;
        strict_1.default.deepEqual(templating.list[0].current, {
            text: "old",
            value: "old",
        });
    });
});
(0, node_test_1.test)("deployDashboards resolves canonical datasource names through the global catalog", async () => {
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
        let upsertPayload;
        const client = new MockGrafanaClient({
            dashboard: {
                title: "unused",
                uid: entry.uid,
            },
            meta: {},
        }, [], (payload) => {
            upsertPayload = payload;
        });
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => client);
        await service.deployDashboards([entry], "prod");
        strict_1.default.equal(upsertPayload?.dashboard.datasource?.uid, "target-datasource");
    });
});
(0, node_test_1.test)("deployDashboards fails when datasource mapping is missing", async () => {
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
        const client = new MockGrafanaClient({
            dashboard: {
                title: "unused",
                uid: entry.uid,
            },
            meta: {},
        }, [], () => { });
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => client);
        await strict_1.default.rejects(service.deployDashboards([entry], "prod"), /Datasource mappings are missing/);
    });
});
(0, node_test_1.test)("deployDashboards uses deployment target folderPath override to create nested folders", async () => {
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
        const createdFolders = [];
        let upsertPayload;
        const client = new MockGrafanaClient({
            dashboard: {
                title: "unused",
                uid: entry.uid,
            },
            meta: {},
        }, [], (payload) => {
            upsertPayload = payload;
        });
        const originalCreateFolder = client.createFolder.bind(client);
        client.createFolder = async (input) => {
            createdFolders.push(input);
            return originalCreateFolder({
                ...input,
                uid: input.uid ?? `${input.title.toLowerCase()}-uid`,
            });
        };
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => client);
        const summary = await service.deployDashboards([entry], "prod", "blue");
        strict_1.default.equal(summary.deploymentTargetName, "blue");
        strict_1.default.equal(createdFolders.length, 3);
        strict_1.default.deepEqual(createdFolders, [
            { title: "LUZ" },
            { title: "Integration", parentUid: "luz-uid" },
            { title: "RND", parentUid: "integration-uid" },
        ]);
        strict_1.default.equal(upsertPayload?.folderUid, "rnd-uid");
    });
});
(0, node_test_1.test)("deployDashboards rejects duplicate effective dashboard uids for one instance", async () => {
    await withTempProject(async (repository, entry) => {
        const secondEntry = {
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
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => new MockGrafanaClient({
            dashboard: {
                title: "unused",
                uid: entry.uid,
            },
            meta: {},
        }, [], () => { }));
        await strict_1.default.rejects(service.deployDashboards([entry, secondEntry], "prod", "blue"), /Duplicate effective dashboard UID "shared-uid"/);
    });
});
(0, node_test_1.test)("savePlacement preserves target-specific dashboardUid", async () => {
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
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => new MockGrafanaClient({
            dashboard: {
                title: "unused",
                uid: entry.uid,
            },
            meta: {},
        }, [], () => { }));
        await service.savePlacement("prod", "blue", entry, "Integration/Dev");
        strict_1.default.deepEqual(await repository.readTargetOverrideFile("prod", "blue", entry), {
            dashboardUid: "uid-blue",
            folderPath: "Integration/Dev",
            variables: {},
        });
    });
});
(0, node_test_1.test)("folder browsing helpers list children, resolve chains, and create folders in parent", async () => {
    await withTempProject(async (repository, entry) => {
        await repository.createInstance("prod");
        await repository.saveInstanceEnvValues("prod", {
            GRAFANA_URL: "http://prod",
        });
        const client = new MockGrafanaClient({
            dashboard: {
                title: "unused",
                uid: entry.uid,
            },
            meta: {},
        }, [
            { title: "LUZ", uid: "luz-uid" },
            { title: "Integration", uid: "integration-uid", parentUid: "luz-uid" },
        ], () => { });
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => client);
        strict_1.default.deepEqual(await service.listFolderChildren("prod"), [{ title: "LUZ", uid: "luz-uid" }]);
        strict_1.default.deepEqual(await service.resolveFolderPathChain("prod", "LUZ/Integration"), [
            { title: "LUZ", uid: "luz-uid" },
            { title: "Integration", uid: "integration-uid", parentUid: "luz-uid" },
        ]);
        const created = await service.createFolderInParent("prod", "integration-uid", "Dev");
        strict_1.default.deepEqual(created, { title: "Dev", uid: "generated-folder", parentUid: "integration-uid" });
        strict_1.default.deepEqual(await service.listFolderChildren("prod", "integration-uid"), [
            { title: "Dev", uid: "generated-folder", parentUid: "integration-uid" },
        ]);
    });
});
(0, node_test_1.test)("saveDatasourceSelections renames sourceName globally and updates selected instance target mapping", async () => {
    await withTempProject(async (repository, entry) => {
        const secondEntry = {
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
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => new MockGrafanaClient({
            dashboard: {
                title: "unused",
                uid: entry.uid,
            },
            meta: {},
        }, [], () => { }));
        await service.saveDatasourceSelections("prod", (0, manifest_1.selectorNameForEntry)(entry), [
            {
                currentSourceName: "integration",
                nextSourceName: "mongo_main",
                targetUid: "prod-datasource",
                targetName: "Integration Prod",
            },
        ]);
        strict_1.default.deepEqual((await repository.loadWorkspaceConfig()).datasources, {
            mongo_main: {
                instances: {
                    prod: {
                        name: "Integration Prod",
                        uid: "prod-datasource",
                    },
                },
            },
        });
        strict_1.default.equal(await repository.readTextFileIfExists(repository.dashboardPath(entry)), "{\n  \"datasource\": {\n    \"type\": \"prometheus\",\n    \"uid\": \"mongo_main\"\n  },\n  \"title\": \"Status\",\n  \"uid\": \"uid-1\"\n}\n");
        strict_1.default.equal(await repository.readTextFileIfExists(repository.dashboardPath(secondEntry)), "{\n  \"datasource\": {\n    \"type\": \"prometheus\",\n    \"uid\": \"mongo_main\"\n  },\n  \"title\": \"Other\",\n  \"uid\": \"uid-2\"\n}\n");
    });
});
(0, node_test_1.test)("saveOverrideFromForm persists only checked override variables", async () => {
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
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => new MockGrafanaClient({
            dashboard: {
                title: "unused",
                uid: entry.uid,
            },
            meta: {},
        }, [], () => { }));
        await service.saveOverrideFromForm("luz", "default", entry, {
            "override_enabled__site": "on",
            "override_value__site": "LUZ",
            "override_value__env": "stage",
        });
        strict_1.default.equal(await repository.readTextFileIfExists(repository.dashboardOverridesFilePath(entry)), "{\n  \"dashboards\": {\n    \"uid-1\": {\n      \"targets\": {\n        \"luz/default\": {\n          \"variables\": {\n            \"site\": \"LUZ\"\n          }\n        }\n      }\n    }\n  }\n}\n");
    });
});
(0, node_test_1.test)("saveOverrideFromForm seeds managed override variables for all instances", async () => {
    await withTempProject(async (repository, entry) => {
        await repository.createInstance("luz");
        await repository.createInstance("rnd");
        await repository.writeJsonFile(repository.folderMetaPathForEntry(entry), {
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
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => new MockGrafanaClient({
            dashboard: {
                title: "unused",
                uid: entry.uid,
            },
            meta: {},
        }, [], () => { }));
        await service.saveOverrideFromForm("luz", "default", entry, {
            "override_enabled__site": "on",
            "override_value__site": "LUZ",
        });
        strict_1.default.equal(await repository.readTextFileIfExists(repository.dashboardOverridesFilePath(entry)), "{\n  \"dashboards\": {\n    \"uid-1\": {\n      \"targets\": {\n        \"luz/default\": {\n          \"variables\": {\n            \"site\": \"LUZ\"\n          }\n        },\n        \"rnd/default\": {\n          \"variables\": {\n            \"site\": \"RND\"\n          }\n        }\n      }\n    }\n  }\n}\n");
    });
});
(0, node_test_1.test)("createDeploymentTarget materializes folderPath together with managed variables", async () => {
    await withTempProject(async (repository, entry) => {
        await repository.createInstance("luz");
        await repository.writeJsonFile(repository.folderMetaPathForEntry(entry), {
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
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => new MockGrafanaClient({
            dashboard: {
                title: "unused",
                uid: entry.uid,
            },
            meta: {},
        }, [], () => { }));
        await service.saveOverrideFromForm("luz", "default", entry, {
            "override_enabled__site": "on",
            "override_value__site": "LUZ",
        });
        await service.createDeploymentTarget("luz", "dev");
        const overrides = JSON.parse((await repository.readTextFileIfExists(repository.dashboardOverridesFilePath(entry))) ?? "{}");
        strict_1.default.deepEqual(overrides.dashboards["uid-1"].targets["luz/default"], {
            variables: {
                site: "LUZ",
            },
        });
        strict_1.default.equal(overrides.dashboards["uid-1"].targets["luz/dev"].folderPath, "Integration");
        strict_1.default.deepEqual(overrides.dashboards["uid-1"].targets["luz/dev"].variables, {
            site: "LUZ",
        });
        strict_1.default.match(overrides.dashboards["uid-1"].targets["luz/dev"].dashboardUid, /^[0-9a-f-]{36}$/);
    });
});
(0, node_test_1.test)("createDeploymentTarget materializes already managed override variables for the new target", async () => {
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
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => new MockGrafanaClient({
            dashboard: {
                title: "unused",
                uid: entry.uid,
            },
            meta: {},
        }, [], () => { }));
        await service.saveOverrideFromForm("luz", "default", entry, {
            "override_enabled__site": "on",
            "override_value__site": "LUZ",
        });
        await service.createDeploymentTarget("luz", "dev");
        const overrides = JSON.parse((await repository.readTextFileIfExists(repository.dashboardOverridesFilePath(entry))) ?? "{}");
        strict_1.default.deepEqual(overrides.dashboards["uid-1"].targets["luz/default"], {
            variables: {
                site: "LUZ",
            },
        });
        strict_1.default.deepEqual(overrides.dashboards["uid-1"].targets["luz/dev"].variables, {
            site: "LUZ",
        });
        strict_1.default.match(overrides.dashboards["uid-1"].targets["luz/dev"].dashboardUid, /^[0-9a-f-]{36}$/);
    });
});
(0, node_test_1.test)("createDeploymentTarget seeds dashboardUid even when dashboard has no managed variables", async () => {
    await withTempProject(async (repository, entry) => {
        await repository.createInstance("luz");
        await repository.writeJsonFile(repository.dashboardPath(entry), {
            title: "Status",
            uid: entry.uid,
        });
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => new MockGrafanaClient({
            dashboard: {
                title: "unused",
                uid: entry.uid,
            },
            meta: {},
        }, [], () => { }));
        await service.createDeploymentTarget("luz", "dev");
        const savedOverride = await repository.readTargetOverrideFile("luz", "dev", entry);
        strict_1.default.deepEqual(savedOverride, {
            dashboardUid: savedOverride?.dashboardUid,
            variables: {},
        });
        strict_1.default.match(savedOverride?.dashboardUid ?? "", /^[0-9a-f-]{36}$/);
    });
});
(0, node_test_1.test)("saveOverrideFromForm rejects invalid custom override values", async () => {
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
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => new MockGrafanaClient({
            dashboard: {
                title: "unused",
                uid: entry.uid,
            },
            meta: {},
        }, [], () => { }));
        await strict_1.default.rejects(service.saveOverrideFromForm("luz", "default", entry, {
            "override_enabled__site": "on",
            "override_value__site": "LUZ",
        }), /is not available in custom variable "site"/);
    });
});
//# sourceMappingURL=dashboardService.test.js.map