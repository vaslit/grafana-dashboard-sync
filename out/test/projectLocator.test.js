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
const projectLocator_1 = require("../core/projectLocator");
async function withTempWorkspace(run) {
    const workspaceRoot = await promises_1.default.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), "grafana-dashboard-workspace-"));
    try {
        await run(workspaceRoot);
    }
    finally {
        await promises_1.default.rm(workspaceRoot, { recursive: true, force: true });
    }
}
(0, node_test_1.test)("discoverProjectLayout finds nested marker file", async () => {
    await withTempWorkspace(async (workspaceRoot) => {
        const projectRoot = node_path_1.default.join(workspaceRoot, "ops", "grafana");
        await promises_1.default.mkdir(projectRoot, { recursive: true });
        await promises_1.default.writeFile(node_path_1.default.join(projectRoot, projectLocator_1.PROJECT_CONFIG_FILE), JSON.stringify({ version: 1 }), "utf8");
        const layout = await (0, projectLocator_1.discoverProjectLayout)(workspaceRoot);
        strict_1.default.ok(layout);
        strict_1.default.equal(layout.projectRootPath, projectRoot);
        strict_1.default.equal(layout.configPath, node_path_1.default.join(projectRoot, projectLocator_1.PROJECT_CONFIG_FILE));
        strict_1.default.equal(layout.dashboardsDir, node_path_1.default.join(projectRoot, "dashboards"));
        strict_1.default.equal(layout.instancesDir, node_path_1.default.join(projectRoot, "instances"));
    });
});
(0, node_test_1.test)("discoverProjectLayout applies configured relative paths", async () => {
    await withTempWorkspace(async (workspaceRoot) => {
        const projectRoot = node_path_1.default.join(workspaceRoot, "grafana");
        await promises_1.default.mkdir(projectRoot, { recursive: true });
        await promises_1.default.writeFile(node_path_1.default.join(projectRoot, projectLocator_1.PROJECT_CONFIG_FILE), JSON.stringify({
            version: 1,
            manifest: "config/manifest.json",
            dashboardsDir: "data/dashboards",
            instancesDir: "data/instances",
            backupsDir: "data/backups",
            rootEnv: "config/.env",
            maxBackups: 7,
        }), "utf8");
        const layout = await (0, projectLocator_1.discoverProjectLayout)(workspaceRoot);
        strict_1.default.ok(layout);
        strict_1.default.equal(layout.manifestPath, node_path_1.default.join(projectRoot, "config", "manifest.json"));
        strict_1.default.equal(layout.dashboardsDir, node_path_1.default.join(projectRoot, "data", "dashboards"));
        strict_1.default.equal(layout.instancesDir, node_path_1.default.join(projectRoot, "data", "instances"));
        strict_1.default.equal(layout.backupsDir, node_path_1.default.join(projectRoot, "data", "backups"));
        strict_1.default.equal(layout.rootEnvPath, node_path_1.default.join(projectRoot, "config", ".env"));
        strict_1.default.equal(layout.maxBackups, 7);
    });
});
//# sourceMappingURL=projectLocator.test.js.map