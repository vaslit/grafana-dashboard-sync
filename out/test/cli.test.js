"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const promises_1 = __importDefault(require("node:fs/promises"));
const node_http_1 = __importDefault(require("node:http"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const node_child_process_1 = require("node:child_process");
async function withTempWorkspace(run) {
    const rootPath = await promises_1.default.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), "grafana-dashboard-cli-"));
    try {
        await run(rootPath);
    }
    finally {
        await promises_1.default.rm(rootPath, { recursive: true, force: true });
    }
}
async function writeJson(filePath, value) {
    await promises_1.default.mkdir(node_path_1.default.dirname(filePath), { recursive: true });
    await promises_1.default.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
async function withMockGrafana(handlers, run) {
    const server = node_http_1.default.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks).toString("utf8");
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const result = handlers(url, body);
        response.statusCode = result.status ?? 200;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(result.body));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") {
        server.close();
        throw new Error("Mock Grafana server did not start correctly.");
    }
    try {
        await run(`http://127.0.0.1:${address.port}`);
    }
    finally {
        await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
}
function scriptEnv(rootPath, workspaceConfigPath) {
    return {
        ...process.env,
        WORKSPACE_CONFIG_FILE: workspaceConfigPath,
        DASHBOARDS_DIR: node_path_1.default.join(rootPath, "dashboards"),
        BACKUP_ROOT: node_path_1.default.join(rootPath, "backups"),
        TMP_DIR: node_path_1.default.join(rootPath, ".tmp"),
        INSTANCE_DIR: node_path_1.default.join(rootPath, "instances", "prod", "targets", "blue"),
        INSTANCE_NAME: "prod",
        TARGET_NAME: "blue",
        GRAFANA_TOKEN: "test-token",
        DONT_PROMPT_WSL_INSTALL: "1",
    };
}
async function runCommand(command, args, options) {
    return new Promise((resolve, reject) => {
        const child = (0, node_child_process_1.spawn)(command, args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            stdout += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
            stderr += String(chunk);
        });
        child.on("error", reject);
        child.on("close", (code) => {
            resolve({ code, stdout, stderr });
        });
    });
}
node_test_1.test.skip("deploy_dashboards.sh materializes dashboardUid for non-default target", async () => {
    await withTempWorkspace(async (rootPath) => {
        const workspaceConfigPath = node_path_1.default.join(rootPath, ".grafana-dashboard-workspace.json");
        const dashboardPath = node_path_1.default.join(rootPath, "dashboards", "integration", "status.json");
        const overridesPath = node_path_1.default.join(rootPath, "dashboards", "integration", ".overrides.json");
        await writeJson(workspaceConfigPath, {
            version: 2,
            layout: {
                dashboardsDir: "dashboards",
                instancesDir: "instances",
                backupsDir: "backups",
                maxBackups: 20,
            },
            dashboards: [
                {
                    name: "sync-status",
                    uid: "uid-base",
                    path: "integration/status.json",
                },
            ],
            datasources: {},
            instances: {
                prod: {
                    grafanaUrl: "http://placeholder",
                    grafanaNamespace: "default",
                    targets: {
                        default: {},
                        blue: {},
                    },
                },
            },
        });
        await writeJson(dashboardPath, {
            title: "Status",
            uid: "uid-base",
        });
        const folders = [];
        let upsertPayload;
        await withMockGrafana((url, body) => {
            if (url.pathname === "/api/folders" && body) {
                const payload = JSON.parse(body);
                const created = {
                    title: payload.title,
                    uid: `folder-${folders.length + 1}`,
                };
                folders.push(created);
                return { body: created };
            }
            if (url.pathname === "/api/folders") {
                return { body: folders };
            }
            if (url.pathname === "/api/dashboards/db") {
                upsertPayload = JSON.parse(body);
                return { body: { status: "success", url: "/d/blue" } };
            }
            return { status: 404, body: { message: `Unhandled ${url.pathname}` } };
        }, async (baseUrl) => {
            const config = JSON.parse(await promises_1.default.readFile(workspaceConfigPath, "utf8"));
            config.instances.prod = {
                grafanaUrl: baseUrl,
                grafanaNamespace: "default",
                targets: {
                    default: {},
                    blue: {},
                },
            };
            await writeJson(workspaceConfigPath, config);
            const result = await runCommand("bash", [node_path_1.default.resolve(process.cwd(), "../scripts/deploy_dashboards.sh")], {
                cwd: process.cwd(),
                env: scriptEnv(rootPath, workspaceConfigPath),
            });
            strict_1.default.equal(result.code, 0, result.stderr || result.stdout);
        });
        const overrides = JSON.parse(await promises_1.default.readFile(overridesPath, "utf8"));
        const dashboardUid = overrides.dashboards["uid-base"].targets["prod/blue"].dashboardUid;
        strict_1.default.match(dashboardUid, /^[0-9a-f-]{36}$/);
        strict_1.default.equal(upsertPayload?.dashboard?.uid ?? "", dashboardUid);
    });
});
node_test_1.test.skip("pull_dashboards.sh fetches target-specific uid and normalizes local uid", async () => {
    await withTempWorkspace(async (rootPath) => {
        const workspaceConfigPath = node_path_1.default.join(rootPath, ".grafana-dashboard-workspace.json");
        const dashboardPath = node_path_1.default.join(rootPath, "dashboards", "integration", "status.json");
        const overridesPath = node_path_1.default.join(rootPath, "dashboards", "integration", ".overrides.json");
        await writeJson(workspaceConfigPath, {
            version: 2,
            layout: {
                dashboardsDir: "dashboards",
                instancesDir: "instances",
                backupsDir: "backups",
                maxBackups: 20,
            },
            dashboards: [
                {
                    name: "sync-status",
                    uid: "uid-base",
                    path: "integration/status.json",
                },
            ],
            datasources: {},
            instances: {
                prod: {
                    grafanaUrl: "http://placeholder",
                    grafanaNamespace: "default",
                    targets: {
                        default: {},
                        blue: {},
                    },
                },
            },
        });
        await writeJson(dashboardPath, {
            title: "Old Status",
            uid: "uid-base",
        });
        await writeJson(overridesPath, {
            dashboards: {
                "uid-base": {
                    targets: {
                        "prod/blue": {
                            dashboardUid: "uid-blue",
                            variables: {},
                        },
                    },
                },
            },
        });
        const requestedUids = [];
        await withMockGrafana((url) => {
            if (url.pathname === "/api/folders") {
                return { body: [] };
            }
            if (url.pathname === "/api/datasources") {
                return { body: [] };
            }
            if (url.pathname === "/api/dashboards/uid/uid-blue") {
                requestedUids.push("uid-blue");
                return {
                    body: {
                        dashboard: {
                            title: "Status Blue",
                            uid: "uid-blue",
                        },
                        meta: {},
                    },
                };
            }
            return { status: 404, body: { message: `Unhandled ${url.pathname}` } };
        }, async (baseUrl) => {
            const config = JSON.parse(await promises_1.default.readFile(workspaceConfigPath, "utf8"));
            config.instances.prod = {
                grafanaUrl: baseUrl,
                grafanaNamespace: "default",
                targets: {
                    default: {},
                    blue: {},
                },
            };
            await writeJson(workspaceConfigPath, config);
            const result = await runCommand("bash", [node_path_1.default.resolve(process.cwd(), "../scripts/pull_dashboards.sh")], {
                cwd: process.cwd(),
                env: scriptEnv(rootPath, workspaceConfigPath),
            });
            strict_1.default.equal(result.code, 0, result.stderr || result.stdout);
        });
        strict_1.default.deepEqual(requestedUids, ["uid-blue"]);
        strict_1.default.equal(await promises_1.default.readFile(dashboardPath, "utf8"), "{\n  \"title\": \"Status Blue\",\n  \"uid\": \"uid-base\"\n}\n");
    });
});
//# sourceMappingURL=cli.test.js.map