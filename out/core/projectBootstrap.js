"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.projectRootPathForWorkspace = projectRootPathForWorkspace;
exports.initializeProjectDirectory = initializeProjectDirectory;
const node_path_1 = __importDefault(require("node:path"));
const repository_1 = require("./repository");
const projectLocator_1 = require("./projectLocator");
function validateRelativeProjectPath(projectPath) {
    const normalized = projectPath.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
    if (!normalized) {
        throw new Error("Project folder must not be empty.");
    }
    if (normalized === "." ||
        node_path_1.default.isAbsolute(normalized) ||
        normalized.startsWith("/") ||
        normalized.startsWith("../") ||
        normalized.includes("/../")) {
        throw new Error("Project folder must be a relative path inside the current workspace.");
    }
    return normalized;
}
function projectRootPathForWorkspace(workspaceRootPath, relativeProjectPath) {
    return node_path_1.default.join(workspaceRootPath, validateRelativeProjectPath(relativeProjectPath));
}
async function initializeProjectDirectory(workspaceRootPath, relativeProjectPath, initialInstanceName) {
    const projectRootPath = projectRootPathForWorkspace(workspaceRootPath, relativeProjectPath);
    const repository = new repository_1.ProjectRepository((0, projectLocator_1.defaultProjectLayout)(projectRootPath, workspaceRootPath));
    await repository.ensureProjectLayout();
    const config = {
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
//# sourceMappingURL=projectBootstrap.js.map