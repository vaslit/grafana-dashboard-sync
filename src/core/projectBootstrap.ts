import path from "node:path";

import { ProjectRepository } from "./repository";
import { defaultProjectLayout } from "./projectLocator";
import { WorkspaceProjectConfig } from "./types";

function validateRelativeProjectPath(projectPath: string): string {
  const normalized = projectPath.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!normalized) {
    throw new Error("Project folder must not be empty.");
  }
  if (
    normalized === "." ||
    path.isAbsolute(normalized) ||
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error("Project folder must be a relative path inside the current workspace.");
  }
  return normalized;
}

export function projectRootPathForWorkspace(workspaceRootPath: string, relativeProjectPath: string): string {
  return path.join(workspaceRootPath, validateRelativeProjectPath(relativeProjectPath));
}

export async function initializeProjectDirectory(
  workspaceRootPath: string,
  relativeProjectPath: string,
  initialInstanceName: string,
): Promise<ProjectRepository> {
  const projectRootPath = projectRootPathForWorkspace(workspaceRootPath, relativeProjectPath);
  const repository = new ProjectRepository(defaultProjectLayout(projectRootPath, workspaceRootPath));
  await repository.ensureProjectLayout();
  const config: WorkspaceProjectConfig = {
    version: 2,
    layout: {
      dashboardsDir: "dashboards",
      instancesDir: "instances",
      backupsDir: "backups",
      rendersDir: "renders",
      maxBackups: repository.maxBackups,
    },
    dashboards: [],
    datasources: {},
    instances: {
      [initialInstanceName.trim()]: {
        grafanaUrl: "http://localhost:3000",
        grafanaNamespace: "default",
        targets: {
          default: {},
        },
      },
    },
  };
  await repository.saveWorkspaceConfig(config);
  await repository.createInstance(initialInstanceName);

  return repository;
}
