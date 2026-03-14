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
const projectBootstrap_1 = require("../core/projectBootstrap");
const projectLocator_1 = require("../core/projectLocator");
async function withTempWorkspace(run) {
    const workspaceRoot = await promises_1.default.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), "grafana-dashboard-bootstrap-"));
    try {
        await run(workspaceRoot);
    }
    finally {
        await promises_1.default.rm(workspaceRoot, { recursive: true, force: true });
    }
}
(0, node_test_1.test)("initializeProjectDirectory creates marker file, layout and first instance", async () => {
    await withTempWorkspace(async (workspaceRoot) => {
        const repository = await (0, projectBootstrap_1.initializeProjectDirectory)(workspaceRoot, "ops/grafana", "example");
        const projectRoot = node_path_1.default.join(workspaceRoot, "ops", "grafana");
        const config = await repository.loadWorkspaceConfig();
        strict_1.default.equal(repository.projectRootPath, projectRoot);
        strict_1.default.equal(await repository.readTextFileIfExists(node_path_1.default.join(projectRoot, projectLocator_1.PROJECT_CONFIG_FILE)) !== undefined, true);
        strict_1.default.deepEqual(config.layout, {
            dashboardsDir: "dashboards",
            backupsDir: "backups",
            rendersDir: "renders",
            maxBackups: 20,
        });
        await strict_1.default.rejects(promises_1.default.stat(node_path_1.default.join(projectRoot, "instances")));
        strict_1.default.deepEqual(config.dashboards, []);
        strict_1.default.deepEqual(config.datasources, {});
        strict_1.default.deepEqual(config.devTarget, {
            instanceName: "example",
            targetName: "default",
        });
        strict_1.default.deepEqual(config.instances, {
            example: {
                grafanaUrl: "http://localhost:3000",
                targets: {
                    default: {},
                },
            },
        });
    });
});
//# sourceMappingURL=projectBootstrap.test.js.map