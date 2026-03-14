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
async function initializeTargetState(repository, entry, instanceName, targetName, options) {
    const service = new dashboardService_1.DashboardService(repository, logger(), async () => new MockGrafanaClient({
        dashboard: {
            title: "unused",
            uid: entry.uid,
        },
        meta: {},
    }, [], () => { }));
    const revision = (await service.listDashboardRevisions(entry))[0].record;
    await repository.saveTargetOverrideFile(instanceName, targetName, entry, {
        ...(options?.dashboardUid ? { dashboardUid: options.dashboardUid } : {}),
        ...(options?.folderPath ? { folderPath: options.folderPath } : {}),
        currentRevisionId: revision.id,
        revisionStates: {
            [revision.id]: {
                variableOverrides: (options?.variableOverrides ?? {}),
                datasourceBindings: options?.datasourceBindings ?? {},
            },
        },
    });
    return revision.id;
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
        await initializeTargetState(repository, entry, "prod", "default", {
            folderPath: "Integration/Dev",
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
        strict_1.default.equal(await repository.readTextFileIfExists(repository.folderMetaPathForEntry(entry)), "{\n  \"path\": \"Source Integration\",\n  \"uid\": \"folder-2\"\n}\n");
    });
});
(0, node_test_1.test)("pullDashboards uses target-specific dashboardUid and normalizes local dashboard uid", async () => {
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
(0, node_test_1.test)("pullDashboards does not create a new revision when only managed constant override values change", async () => {
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
        const client = new MockGrafanaClient({
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
        }, [], () => { });
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => client);
        await service.pullDashboards([entry], "prod", "default");
        const index = await repository.readDashboardVersionIndex(entry);
        strict_1.default.equal(index?.revisions.length, 1);
        strict_1.default.equal(index?.checkedOutRevisionId, initialRevisionId);
        const targetState = await repository.readTargetOverrideFile("prod", "default", entry);
        strict_1.default.equal(targetState?.currentRevisionId, initialRevisionId);
        strict_1.default.equal(targetState?.revisionStates[initialRevisionId]?.variableOverrides.site, "LUZ1");
        const snapshot = await repository.readDashboardRevisionSnapshot(entry, initialRevisionId);
        const site = (snapshot?.dashboard.templating?.list ?? []).find((item) => item.name === "site");
        strict_1.default.equal(site?.query, "LUZ1");
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
(0, node_test_1.test)("dashboardBrowserUrl prefers Grafana meta.url and falls back to effective uid", async () => {
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
        const withMetaUrl = new dashboardService_1.DashboardService(repository, logger(), async () => new MockGrafanaClient({
            dashboard: {
                title: "Status",
                uid: "uid-blue",
            },
            meta: {
                url: "/d/uid-blue/status",
            },
        }, [], () => { }));
        strict_1.default.equal(await withMetaUrl.dashboardBrowserUrl(entry, "prod", "blue"), "http://prod/d/uid-blue/status");
        const withFallback = new dashboardService_1.DashboardService(repository, logger(), async () => {
            throw new Error("Grafana unavailable");
        });
        strict_1.default.equal(await withFallback.dashboardBrowserUrl(entry, "prod", "blue"), "http://prod/grafana/d/uid-blue");
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
(0, node_test_1.test)("deleteRevision removes an unused revision and its revision state", async () => {
    await withTempProject(async (repository, entry) => {
        await repository.createInstance("prod");
        await repository.writeJsonFile(repository.dashboardPath(entry), {
            title: "Status v1",
            uid: entry.uid,
        });
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => new MockGrafanaClient({
            dashboard: {
                title: "unused",
                uid: entry.uid,
            },
            meta: {},
        }, [], () => { }));
        const firstRevision = (await service.listDashboardRevisions(entry))[0].record;
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
        strict_1.default.equal(nextIndex?.revisions.some((revision) => revision.id === firstRevision.id), false);
        strict_1.default.equal(await repository.readDashboardRevisionSnapshot(entry, firstRevision.id), undefined);
        const targetState = await repository.readTargetOverrideFile("prod", "default", entry);
        strict_1.default.equal(targetState?.revisionStates[firstRevision.id], undefined);
    });
});
(0, node_test_1.test)("deleteRevision rejects the checked out revision and active target revision", async () => {
    await withTempProject(async (repository, entry) => {
        await repository.createInstance("prod");
        await repository.writeJsonFile(repository.dashboardPath(entry), {
            title: "Status v1",
            uid: entry.uid,
        });
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => new MockGrafanaClient({
            dashboard: {
                title: "unused",
                uid: entry.uid,
            },
            meta: {},
        }, [], () => { }));
        const firstRevision = (await service.listDashboardRevisions(entry))[0].record;
        await initializeTargetState(repository, entry, "prod", "default");
        await repository.writeJsonFile(repository.dashboardPath(entry), {
            title: "Status v2",
            uid: entry.uid,
        });
        const secondRevision = await service.createRevisionFromWorkingCopy(entry);
        await strict_1.default.rejects(service.deleteRevision(entry, secondRevision.id), /Cannot delete the checked out revision/);
        await strict_1.default.rejects(service.deleteRevision(entry, firstRevision.id), /Cannot delete revision .* because it is active on: prod\/default/);
    });
});
(0, node_test_1.test)("listLiveTargetVersionStatuses matches live dashboard to stored revision", async () => {
    await withTempProject(async (repository, entry) => {
        await repository.createInstance("prod");
        await repository.saveInstanceEnvValues("prod", {
            GRAFANA_URL: "http://prod",
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
                storedRevisionId: revision.id,
                effectiveDashboardUid: entry.uid,
                matchedRevisionId: revision.id,
                datasourceStatus: "complete",
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
        await initializeTargetState(repository, entry, "prod", "default", {
            variableOverrides: {
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
(0, node_test_1.test)("restoreBackup uses raw live dashboard snapshot without render", async () => {
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
        await repository.writeJsonFile(repository.folderMetaPathForEntry(entry), {
            path: "Integration",
            uid: "folder-1",
        });
        await initializeTargetState(repository, entry, "prod", "default", {
            variableOverrides: {
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
        await initializeTargetState(repository, entry, "prod", "default", {
            variableOverrides: {
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
        const summary = await service.restoreBackup(backup);
        strict_1.default.equal(summary.dashboardResults.length, 1);
        strict_1.default.equal(summary.targetCount, 1);
        const templating = upsertPayload?.dashboard.templating;
        strict_1.default.deepEqual(templating.list[0].current, {
            text: "old",
            value: "old",
        });
    });
});
(0, node_test_1.test)("restoreBackup can restore only a selected target slice", async () => {
    await withTempProject(async (repository, entry) => {
        await repository.createInstance("prod");
        await repository.createDeploymentTarget("prod", "blue");
        await repository.saveInstanceEnvValues("prod", {
            GRAFANA_URL: "http://prod",
        });
        const backup = await repository.createBackupSnapshot("instance", [
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
        ], "20260101_000001");
        const upserts = [];
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => new MockGrafanaClient({
            dashboard: {
                title: "unused",
                uid: entry.uid,
            },
            meta: {},
        }, [], (payload) => {
            upserts.push(payload);
        }));
        const summary = await service.restoreBackup(backup, {
            kind: "target",
            instanceName: "prod",
            targetName: "blue",
        });
        strict_1.default.equal(summary.instanceCount, 1);
        strict_1.default.equal(summary.targetCount, 1);
        strict_1.default.equal(summary.dashboardCount, 1);
        strict_1.default.equal(upserts.length, 1);
        strict_1.default.equal(upserts[0]?.dashboard.title, "Blue snapshot");
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
        await initializeTargetState(repository, entry, "prod", "blue", {
            folderPath: "LUZ/Integration/RND",
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
        await initializeTargetState(repository, entry, "prod", "blue", {
            dashboardUid: "shared-uid",
        });
        await initializeTargetState(repository, secondEntry, "prod", "blue", {
            dashboardUid: "shared-uid",
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
        await initializeTargetState(repository, entry, "prod", "blue", {
            dashboardUid: "uid-blue",
        });
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => new MockGrafanaClient({
            dashboard: {
                title: "unused",
                uid: entry.uid,
            },
            meta: {},
        }, [], () => { }));
        await service.savePlacement("prod", "blue", entry, "Integration/Dev");
        const savedOverride = await repository.readTargetOverrideFile("prod", "blue", entry);
        strict_1.default.equal(savedOverride?.dashboardUid, "uid-blue");
        strict_1.default.equal(savedOverride?.folderPath, "Integration/Dev");
        strict_1.default.deepEqual(savedOverride?.revisionStates[savedOverride.currentRevisionId], {
            variableOverrides: {},
            datasourceBindings: {},
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
(0, node_test_1.test)("saveDatasourceSelections stores target datasource bindings without rewriting dashboard files", async () => {
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
        await service.saveDatasourceSelections("prod", "default", (0, manifest_1.selectorNameForEntry)(entry), [
            {
                currentSourceName: "integration",
                nextSourceName: "mongo_main",
                targetUid: "prod-datasource",
                targetName: "Integration Prod",
            },
        ]);
        strict_1.default.deepEqual((await repository.loadWorkspaceConfig()).datasources.mongo_main, {
            instances: {
                prod: {
                    name: "Integration Prod",
                    uid: "prod-datasource",
                },
            },
        });
        const savedTargetState = await repository.readTargetOverrideFile("prod", "default", entry);
        strict_1.default.equal(savedTargetState?.revisionStates[savedTargetState.currentRevisionId]?.datasourceBindings.integration, "mongo_main");
        strict_1.default.equal(await repository.readTextFileIfExists(repository.dashboardPath(entry)), "{\n  \"datasource\": {\n    \"type\": \"prometheus\",\n    \"uid\": \"integration\"\n  },\n  \"title\": \"Status\",\n  \"uid\": \"uid-1\"\n}\n");
        strict_1.default.equal(await repository.readTextFileIfExists(repository.dashboardPath(secondEntry)), "{\n  \"datasource\": {\n    \"type\": \"prometheus\",\n    \"uid\": \"integration\"\n  },\n  \"title\": \"Other\",\n  \"uid\": \"uid-2\"\n}\n");
    });
});
(0, node_test_1.test)("saveDatasourceSelections preserves manually entered datasource name even when uid is unknown", async () => {
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
        const service = new dashboardService_1.DashboardService(repository, logger(), async () => new MockGrafanaClient({
            dashboard: {
                title: "unused",
                uid: entry.uid,
            },
            meta: {},
        }, [], () => { }));
        await service.saveDatasourceSelections("prod", "default", (0, manifest_1.selectorNameForEntry)(entry), [
            {
                currentSourceName: "integration",
                nextSourceName: "mongo_main",
                targetName: "Integration Prod",
            },
        ]);
        strict_1.default.deepEqual((await repository.loadWorkspaceConfig()).datasources.mongo_main, {
            instances: {
                prod: {
                    name: "Integration Prod",
                },
            },
        });
        const rows = await service.buildTargetDatasourceRows("prod", "default", entry);
        strict_1.default.equal(rows[0]?.globalDatasourceKey, "mongo_main");
        strict_1.default.equal(rows[0]?.targetName, "Integration Prod");
        strict_1.default.equal(rows[0]?.targetUid, undefined);
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
        const overrides = JSON.parse((await repository.readTextFileIfExists(repository.dashboardOverridesFilePath(entry))) ?? "{}");
        const defaultState = overrides.dashboards["uid-1"].targets["luz/default"];
        strict_1.default.deepEqual(defaultState.revisionStates[defaultState.currentRevisionId].variableOverrides, {
            site: "LUZ",
        });
    });
});
(0, node_test_1.test)("saveOverrideFromForm only updates the current revision state of the selected target", async () => {
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
        const overrides = JSON.parse((await repository.readTextFileIfExists(repository.dashboardOverridesFilePath(entry))) ?? "{}");
        const luzState = overrides.dashboards["uid-1"].targets["luz/default"];
        strict_1.default.deepEqual(luzState.revisionStates[luzState.currentRevisionId].variableOverrides, {
            site: "LUZ",
        });
        strict_1.default.equal(overrides.dashboards["uid-1"].targets["rnd/default"], undefined);
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
        const defaultState = overrides.dashboards["uid-1"].targets["luz/default"];
        strict_1.default.deepEqual(defaultState.revisionStates[defaultState.currentRevisionId].variableOverrides, {
            site: "LUZ",
        });
        const devState = overrides.dashboards["uid-1"].targets["luz/dev"];
        strict_1.default.equal(devState.folderPath, "Integration");
        strict_1.default.deepEqual(devState.revisionStates[devState.currentRevisionId].variableOverrides, {});
        strict_1.default.deepEqual(devState.revisionStates[devState.currentRevisionId].datasourceBindings, {});
        strict_1.default.match(devState.dashboardUid, /^[0-9a-f-]{36}$/);
    });
});
(0, node_test_1.test)("createDeploymentTarget initializes a fresh revision state for the new target", async () => {
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
        const defaultState = overrides.dashboards["uid-1"].targets["luz/default"];
        strict_1.default.deepEqual(defaultState.revisionStates[defaultState.currentRevisionId].variableOverrides, {
            site: "LUZ",
        });
        const devState = overrides.dashboards["uid-1"].targets["luz/dev"];
        strict_1.default.deepEqual(devState.revisionStates[devState.currentRevisionId].variableOverrides, {});
        strict_1.default.deepEqual(devState.revisionStates[devState.currentRevisionId].datasourceBindings, {});
        strict_1.default.match(devState.dashboardUid, /^[0-9a-f-]{36}$/);
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
        strict_1.default.deepEqual(savedOverride?.revisionStates[savedOverride.currentRevisionId], {
            variableOverrides: {},
            datasourceBindings: {},
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