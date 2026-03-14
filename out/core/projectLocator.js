"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROJECT_CONFIG_FILE = void 0;
exports.defaultProjectLayout = defaultProjectLayout;
exports.discoverProjectLayout = discoverProjectLayout;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
exports.PROJECT_CONFIG_FILE = ".grafana-dashboard-workspace.json";
const DEFAULT_LAYOUT = {
    manifest: "dashboard-manifest.json",
    manifestExample: "dashboard-manifest.example.json",
    dashboardsDir: "dashboards",
    instancesDir: "instances",
    backupsDir: "backups",
    rendersDir: "renders",
    rootEnv: ".env",
};
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
async function exists(filePath) {
    try {
        await promises_1.default.access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
function sortByDepthAndPath(paths) {
    return [...paths].sort((left, right) => {
        const depthDelta = left.split(node_path_1.default.sep).length - right.split(node_path_1.default.sep).length;
        return depthDelta !== 0 ? depthDelta : left.localeCompare(right);
    });
}
function resolveRelativePath(projectRootPath, configured, fallback, label) {
    const relativePath = configured?.trim() || fallback;
    const normalizedPath = relativePath.replace(/\\/g, "/");
    if (!normalizedPath ||
        normalizedPath === "." ||
        node_path_1.default.isAbsolute(relativePath) ||
        normalizedPath.startsWith("/") ||
        normalizedPath.startsWith("../") ||
        normalizedPath.includes("/../")) {
        throw new Error(`${label} in ${exports.PROJECT_CONFIG_FILE} must be a relative path inside the project folder.`);
    }
    return node_path_1.default.join(projectRootPath, relativePath);
}
function buildProjectLayout(workspaceRootPath, projectRootPath, options) {
    const config = options?.config;
    const layoutConfig = config?.layout;
    return {
        workspaceRootPath,
        projectRootPath,
        configPath: options?.configPath,
        selectionNote: options?.selectionNote,
        workspaceConfigPath: options?.configPath ?? node_path_1.default.join(projectRootPath, exports.PROJECT_CONFIG_FILE),
        manifestPath: resolveRelativePath(projectRootPath, config?.manifest, DEFAULT_LAYOUT.manifest, "manifest"),
        manifestExamplePath: resolveRelativePath(projectRootPath, config?.manifestExample, DEFAULT_LAYOUT.manifestExample, "manifestExample"),
        legacyDatasourceCatalogPath: node_path_1.default.join(projectRootPath, "datasources.json"),
        dashboardsDir: resolveRelativePath(projectRootPath, layoutConfig?.dashboardsDir ?? config?.dashboardsDir, DEFAULT_LAYOUT.dashboardsDir, "dashboardsDir"),
        instancesDir: resolveRelativePath(projectRootPath, layoutConfig?.instancesDir ?? config?.instancesDir, DEFAULT_LAYOUT.instancesDir, "instancesDir"),
        backupsDir: resolveRelativePath(projectRootPath, layoutConfig?.backupsDir ?? config?.backupsDir, DEFAULT_LAYOUT.backupsDir, "backupsDir"),
        rendersDir: resolveRelativePath(projectRootPath, layoutConfig?.rendersDir ?? config?.rendersDir, DEFAULT_LAYOUT.rendersDir, "rendersDir"),
        rootEnvPath: resolveRelativePath(projectRootPath, config?.rootEnv, DEFAULT_LAYOUT.rootEnv, "rootEnv"),
        maxBackups: typeof (layoutConfig?.maxBackups ?? config?.maxBackups) === "number" &&
            Number.isInteger(layoutConfig?.maxBackups ?? config?.maxBackups) &&
            (layoutConfig?.maxBackups ?? config?.maxBackups) > 0
            ? (layoutConfig?.maxBackups ?? config?.maxBackups)
            : DEFAULT_MAX_BACKUPS,
    };
}
async function loadProjectConfig(configPath) {
    const parsed = JSON.parse(await promises_1.default.readFile(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${exports.PROJECT_CONFIG_FILE} must contain a JSON object.`);
    }
    const config = parsed;
    const stringFields = [
        "manifest",
        "manifestExample",
        "dashboardsDir",
        "instancesDir",
        "backupsDir",
        "rendersDir",
        "rootEnv",
    ];
    if (config.layout !== undefined) {
        if (!config.layout || typeof config.layout !== "object" || Array.isArray(config.layout)) {
            throw new Error(`layout in ${exports.PROJECT_CONFIG_FILE} must be an object when provided.`);
        }
        const layout = config.layout;
        const layoutStringFields = ["dashboardsDir", "instancesDir", "backupsDir", "rendersDir"];
        for (const field of layoutStringFields) {
            const value = layout[field];
            if (value !== undefined && typeof value !== "string") {
                throw new Error(`${field} in ${exports.PROJECT_CONFIG_FILE}.layout must be a string when provided.`);
            }
        }
        if (layout.maxBackups !== undefined &&
            (typeof layout.maxBackups !== "number" || !Number.isInteger(layout.maxBackups) || layout.maxBackups <= 0)) {
            throw new Error(`maxBackups in ${exports.PROJECT_CONFIG_FILE}.layout must be a positive integer when provided.`);
        }
    }
    for (const field of stringFields) {
        const value = config[field];
        if (value !== undefined && typeof value !== "string") {
            throw new Error(`${field} in ${exports.PROJECT_CONFIG_FILE} must be a string when provided.`);
        }
    }
    if (config.maxBackups !== undefined &&
        (typeof config.maxBackups !== "number" || !Number.isInteger(config.maxBackups) || config.maxBackups <= 0)) {
        throw new Error(`maxBackups in ${exports.PROJECT_CONFIG_FILE} must be a positive integer when provided.`);
    }
    if (config.version !== undefined && config.version !== 1 && config.version !== 2 && config.version !== 3 && config.version !== 4) {
        throw new Error(`Unsupported ${exports.PROJECT_CONFIG_FILE} version: ${String(config.version)}.`);
    }
    return config;
}
async function scanForCandidates(dirPath, depth, configPaths) {
    const configPath = node_path_1.default.join(dirPath, exports.PROJECT_CONFIG_FILE);
    if (await exists(configPath)) {
        configPaths.push(configPath);
    }
    if (depth >= MAX_SCAN_DEPTH) {
        return;
    }
    const entries = await promises_1.default.readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        if (IGNORED_DIR_NAMES.has(entry.name)) {
            continue;
        }
        await scanForCandidates(node_path_1.default.join(dirPath, entry.name), depth + 1, configPaths);
    }
}
function defaultProjectLayout(projectRootPath, workspaceRootPath = projectRootPath) {
    return buildProjectLayout(workspaceRootPath, projectRootPath);
}
async function discoverProjectLayout(workspaceRootPath) {
    const configPaths = [];
    await scanForCandidates(workspaceRootPath, 0, configPaths);
    const sortedConfigs = sortByDepthAndPath(configPaths);
    if (sortedConfigs.length > 0) {
        const configPath = sortedConfigs[0];
        const config = await loadProjectConfig(configPath);
        return buildProjectLayout(workspaceRootPath, node_path_1.default.dirname(configPath), {
            config,
            configPath,
            selectionNote: sortedConfigs.length > 1
                ? `Multiple ${exports.PROJECT_CONFIG_FILE} files found. Using ${node_path_1.default.relative(workspaceRootPath, configPath)}.`
                : undefined,
        });
    }
    return undefined;
}
//# sourceMappingURL=projectLocator.js.map