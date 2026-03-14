import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { initializeProjectDirectory } from "../core/projectBootstrap";
import { PROJECT_CONFIG_FILE } from "../core/projectLocator";

async function withTempWorkspace(run: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "grafana-dashboard-bootstrap-"));
  try {
    await run(workspaceRoot);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
}

test("initializeProjectDirectory creates marker file, layout and first instance", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const repository = await initializeProjectDirectory(workspaceRoot, "ops/grafana", "example");
    const projectRoot = path.join(workspaceRoot, "ops", "grafana");
    const config = await repository.loadWorkspaceConfig();

    assert.equal(repository.projectRootPath, projectRoot);
    assert.equal(await repository.readTextFileIfExists(path.join(projectRoot, PROJECT_CONFIG_FILE)) !== undefined, true);
    assert.deepEqual(config.layout, {
      dashboardsDir: "dashboards",
      backupsDir: "backups",
      rendersDir: "renders",
      maxBackups: 20,
    });
    await assert.rejects(fs.stat(path.join(projectRoot, "instances")));
    assert.deepEqual(config.dashboards, []);
    assert.deepEqual(config.datasources, {});
    assert.deepEqual(config.devTarget, {
      instanceName: "example",
      targetName: "default",
    });
    assert.deepEqual(config.instances, {
      example: {
        grafanaUrl: "http://localhost:3000",
        targets: {
          default: {},
        },
      },
    });
  });
});
