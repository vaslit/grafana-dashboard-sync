import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

async function withTempWorkspace(run: (rootPath: string) => Promise<void>): Promise<void> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "grafana-dashboard-cli-"));
  try {
    await run(rootPath);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function withMockGrafana(
  handlers: (url: URL, body: string) => { status?: number; body: unknown },
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(async (request, response) => {
    const chunks: Uint8Array[] = [];
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

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Mock Grafana server did not start correctly.");
  }

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function scriptEnv(rootPath: string, workspaceConfigPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    WORKSPACE_CONFIG_FILE: workspaceConfigPath,
    DASHBOARDS_DIR: path.join(rootPath, "dashboards"),
    BACKUP_ROOT: path.join(rootPath, "backups"),
    TMP_DIR: path.join(rootPath, ".tmp"),
    INSTANCE_DIR: path.join(rootPath, "instances", "prod", "targets", "blue"),
    INSTANCE_NAME: "prod",
    TARGET_NAME: "blue",
    GRAFANA_TOKEN: "test-token",
    DONT_PROMPT_WSL_INSTALL: "1",
  };
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
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

test.skip("deploy_dashboards.sh materializes dashboardUid for non-default target", async () => {
  await withTempWorkspace(async (rootPath) => {
    const workspaceConfigPath = path.join(rootPath, ".grafana-dashboard-workspace.json");
    const dashboardPath = path.join(rootPath, "dashboards", "integration", "status.json");
    const overridesPath = path.join(rootPath, "dashboards", "integration", ".overrides.json");

    await writeJson(workspaceConfigPath, {
      version: 5,
      layout: {
        dashboardsDir: "dashboards",
        backupsDir: "backups",
        rendersDir: "renders",
        alertsDir: "alerts",
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

    const folders: Array<{ title: string; uid: string }> = [];
    let upsertPayload: Record<string, unknown> | undefined;
    await withMockGrafana(
      (url, body) => {
        if (url.pathname === "/api/folders" && body) {
          const payload = JSON.parse(body) as { title: string };
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
          upsertPayload = JSON.parse(body) as Record<string, unknown>;
          return { body: { status: "success", url: "/d/blue" } };
        }
        return { status: 404, body: { message: `Unhandled ${url.pathname}` } };
      },
      async (baseUrl) => {
        const config = JSON.parse(await fs.readFile(workspaceConfigPath, "utf8")) as Record<string, unknown>;
        (config.instances as Record<string, unknown>).prod = {
          grafanaUrl: baseUrl,
          targets: {
            default: {},
            blue: {},
          },
        };
        await writeJson(workspaceConfigPath, config);

        const result = await runCommand(
          "bash",
          [path.resolve(process.cwd(), "../scripts/deploy_dashboards.sh")],
          {
            cwd: process.cwd(),
            env: scriptEnv(rootPath, workspaceConfigPath),
          },
        );

        assert.equal(result.code, 0, result.stderr || result.stdout);
      },
    );

    const overrides = JSON.parse(await fs.readFile(overridesPath, "utf8")) as {
      dashboards: Record<string, { targets: Record<string, { dashboardUid: string }> }>;
    };
    const dashboardUid = overrides.dashboards["uid-base"].targets["prod/blue"].dashboardUid;
    assert.match(dashboardUid, /^[0-9a-f-]{36}$/);
    assert.equal(
      ((upsertPayload?.dashboard as Record<string, unknown> | undefined)?.uid as string | undefined) ?? "",
      dashboardUid,
    );
  });
});

test.skip("pull_dashboards.sh fetches target-specific uid and normalizes local uid", async () => {
  await withTempWorkspace(async (rootPath) => {
    const workspaceConfigPath = path.join(rootPath, ".grafana-dashboard-workspace.json");
    const dashboardPath = path.join(rootPath, "dashboards", "integration", "status.json");
    const overridesPath = path.join(rootPath, "dashboards", "integration", ".overrides.json");

    await writeJson(workspaceConfigPath, {
      version: 5,
      layout: {
        dashboardsDir: "dashboards",
        backupsDir: "backups",
        rendersDir: "renders",
        alertsDir: "alerts",
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

    const requestedUids: string[] = [];
    await withMockGrafana(
      (url) => {
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
      },
      async (baseUrl) => {
        const config = JSON.parse(await fs.readFile(workspaceConfigPath, "utf8")) as Record<string, unknown>;
        (config.instances as Record<string, unknown>).prod = {
          grafanaUrl: baseUrl,
          targets: {
            default: {},
            blue: {},
          },
        };
        await writeJson(workspaceConfigPath, config);

        const result = await runCommand(
          "bash",
          [path.resolve(process.cwd(), "../scripts/pull_dashboards.sh")],
          {
            cwd: process.cwd(),
            env: scriptEnv(rootPath, workspaceConfigPath),
          },
        );

        assert.equal(result.code, 0, result.stderr || result.stdout);
      },
    );

    assert.deepEqual(requestedUids, ["uid-blue"]);
    assert.equal(
      await fs.readFile(dashboardPath, "utf8"),
      "{\n  \"title\": \"Status Blue\",\n  \"uid\": \"uid-base\"\n}\n",
    );
  });
});
