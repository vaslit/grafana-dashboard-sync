import fs from "node:fs/promises";
import path from "node:path";

export const PROJECT_CONFIG_FILE = ".grafana-dashboard-workspace.json";

const DEFAULT_LAYOUT = {
  dashboardsDir: "dashboards",
  backupsDir: "backups",
  rendersDir: "renders",
} as const;

const IGNORED_DIR_NAMES = new Set([
  ".git",
  ".idea",
  ".vscode",
  "backups",
  "dist",
  "node_modules",
  "out",
]);

const MAX_SCAN_DEPTH = 5;
const DEFAULT_MAX_BACKUPS = 20;

interface ProjectConfigFile {
  version: 4;
  layout?: {
    dashboardsDir?: string;
    backupsDir?: string;
    rendersDir?: string;
    maxBackups?: number;
  };
}

export interface ProjectLayout {
  workspaceRootPath: string;
  projectRootPath: string;
  configPath?: string;
  selectionNote?: string;
  workspaceConfigPath: string;
  dashboardsDir: string;
  backupsDir: string;
  rendersDir: string;
  maxBackups: number;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sortByDepthAndPath(paths: string[]): string[] {
  return [...paths].sort((left, right) => {
    const depthDelta = left.split(path.sep).length - right.split(path.sep).length;
    return depthDelta !== 0 ? depthDelta : left.localeCompare(right);
  });
}

function resolveRelativePath(projectRootPath: string, configured: string | undefined, fallback: string, label: string): string {
  const relativePath = configured?.trim() || fallback;
  const normalizedPath = relativePath.replace(/\\/g, "/");
  if (
    !normalizedPath ||
    normalizedPath === "." ||
    path.isAbsolute(relativePath) ||
    normalizedPath.startsWith("/") ||
    normalizedPath.startsWith("../") ||
    normalizedPath.includes("/../")
  ) {
    throw new Error(`${label} in ${PROJECT_CONFIG_FILE} must be a relative path inside the project folder.`);
  }
  return path.join(projectRootPath, relativePath);
}

function buildProjectLayout(
  workspaceRootPath: string,
  projectRootPath: string,
  options?: {
    configPath?: string;
    config?: ProjectConfigFile;
    selectionNote?: string;
  },
): ProjectLayout {
  const config = options?.config;
  const layoutConfig = config?.layout;
  return {
    workspaceRootPath,
    projectRootPath,
    configPath: options?.configPath,
    selectionNote: options?.selectionNote,
    workspaceConfigPath: options?.configPath ?? path.join(projectRootPath, PROJECT_CONFIG_FILE),
    dashboardsDir: resolveRelativePath(
      projectRootPath,
      layoutConfig?.dashboardsDir,
      DEFAULT_LAYOUT.dashboardsDir,
      "dashboardsDir",
    ),
    backupsDir: resolveRelativePath(
      projectRootPath,
      layoutConfig?.backupsDir,
      DEFAULT_LAYOUT.backupsDir,
      "backupsDir",
    ),
    rendersDir: resolveRelativePath(
      projectRootPath,
      layoutConfig?.rendersDir,
      DEFAULT_LAYOUT.rendersDir,
      "rendersDir",
    ),
    maxBackups:
      typeof layoutConfig?.maxBackups === "number" &&
      Number.isInteger(layoutConfig.maxBackups) &&
      layoutConfig.maxBackups > 0
        ? layoutConfig.maxBackups
        : DEFAULT_MAX_BACKUPS,
  };
}

async function loadProjectConfig(configPath: string): Promise<ProjectConfigFile> {
  const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${PROJECT_CONFIG_FILE} must contain a JSON object.`);
  }

  const config = parsed as Record<string, unknown>;
  if (config.layout !== undefined) {
    if (!config.layout || typeof config.layout !== "object" || Array.isArray(config.layout)) {
      throw new Error(`layout in ${PROJECT_CONFIG_FILE} must be an object when provided.`);
    }
    const layout = config.layout as Record<string, unknown>;
    const layoutStringFields = ["dashboardsDir", "backupsDir", "rendersDir"] as const;
    for (const field of layoutStringFields) {
      const value = layout[field];
      if (value !== undefined && typeof value !== "string") {
        throw new Error(`${field} in ${PROJECT_CONFIG_FILE}.layout must be a string when provided.`);
      }
    }
    if (
      layout.maxBackups !== undefined &&
      (typeof layout.maxBackups !== "number" || !Number.isInteger(layout.maxBackups) || layout.maxBackups <= 0)
    ) {
      throw new Error(`maxBackups in ${PROJECT_CONFIG_FILE}.layout must be a positive integer when provided.`);
    }
  }

  if (config.version !== 4) {
    throw new Error(`Unsupported ${PROJECT_CONFIG_FILE} version: ${String(config.version)}.`);
  }

  return config as unknown as ProjectConfigFile;
}

async function scanForCandidates(
  dirPath: string,
  depth: number,
  configPaths: string[],
): Promise<void> {
  const configPath = path.join(dirPath, PROJECT_CONFIG_FILE);
  if (await exists(configPath)) {
    configPaths.push(configPath);
  }

  if (depth >= MAX_SCAN_DEPTH) {
    return;
  }

  const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (IGNORED_DIR_NAMES.has(entry.name)) {
      continue;
    }
    await scanForCandidates(path.join(dirPath, entry.name), depth + 1, configPaths);
  }
}

export function defaultProjectLayout(projectRootPath: string, workspaceRootPath = projectRootPath): ProjectLayout {
  return buildProjectLayout(workspaceRootPath, projectRootPath);
}

export async function discoverProjectLayout(workspaceRootPath: string): Promise<ProjectLayout | undefined> {
  const configPaths: string[] = [];
  await scanForCandidates(workspaceRootPath, 0, configPaths);

  const sortedConfigs = sortByDepthAndPath(configPaths);
  if (sortedConfigs.length > 0) {
    const configPath = sortedConfigs[0];
    const config = await loadProjectConfig(configPath);
    return buildProjectLayout(workspaceRootPath, path.dirname(configPath), {
      config,
      configPath,
      selectionNote:
        sortedConfigs.length > 1
          ? `Multiple ${PROJECT_CONFIG_FILE} files found. Using ${path.relative(workspaceRootPath, configPath)}.`
          : undefined,
    });
  }

  return undefined;
}
