import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PROJECT_CONFIG_FILE, discoverProjectLayout } from "../core/projectLocator";

async function withTempWorkspace(run: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "grafana-dashboard-workspace-"));
  try {
    await run(workspaceRoot);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
}

test("discoverProjectLayout finds nested marker file", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const projectRoot = path.join(workspaceRoot, "ops", "grafana");
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.writeFile(path.join(projectRoot, PROJECT_CONFIG_FILE), JSON.stringify({ version: 1 }), "utf8");

    const layout = await discoverProjectLayout(workspaceRoot);
    assert.ok(layout);
    assert.equal(layout.projectRootPath, projectRoot);
    assert.equal(layout.configPath, path.join(projectRoot, PROJECT_CONFIG_FILE));
    assert.equal(layout.dashboardsDir, path.join(projectRoot, "dashboards"));
    assert.equal(layout.instancesDir, path.join(projectRoot, "instances"));
  });
});

test("discoverProjectLayout applies configured relative paths", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const projectRoot = path.join(workspaceRoot, "grafana");
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, PROJECT_CONFIG_FILE),
      JSON.stringify({
        version: 1,
        manifest: "config/manifest.json",
        dashboardsDir: "data/dashboards",
        instancesDir: "data/instances",
        backupsDir: "data/backups",
        rootEnv: "config/.env",
        maxBackups: 7,
      }),
      "utf8",
    );

    const layout = await discoverProjectLayout(workspaceRoot);
    assert.ok(layout);
    assert.equal(layout.manifestPath, path.join(projectRoot, "config", "manifest.json"));
    assert.equal(layout.dashboardsDir, path.join(projectRoot, "data", "dashboards"));
    assert.equal(layout.instancesDir, path.join(projectRoot, "data", "instances"));
    assert.equal(layout.backupsDir, path.join(projectRoot, "data", "backups"));
    assert.equal(layout.rootEnvPath, path.join(projectRoot, "config", ".env"));
    assert.equal(layout.maxBackups, 7);
  });
});
