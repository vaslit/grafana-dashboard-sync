"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.selectorNameForEntry = selectorNameForEntry;
exports.validateManifest = validateManifest;
exports.findManifestEntryBySelector = findManifestEntryBySelector;
const node_path_1 = __importDefault(require("node:path"));
function selectorNameForEntry(entry) {
    if (entry.name && entry.name.trim()) {
        return entry.name.trim();
    }
    const baseName = node_path_1.default.basename(entry.path, node_path_1.default.extname(entry.path));
    return baseName || entry.uid;
}
function validateManifest(manifest) {
    const errors = [];
    if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.dashboards)) {
        return ["Manifest must be an object with a dashboards array."];
    }
    const seenSelectors = new Set();
    const seenUids = new Set();
    const seenPaths = new Set();
    for (const [index, entry] of manifest.dashboards.entries()) {
        if (!entry || typeof entry !== "object") {
            errors.push(`dashboards[${index}] must be an object.`);
            continue;
        }
        if (typeof entry.uid !== "string" || !entry.uid.trim()) {
            errors.push(`dashboards[${index}].uid must be a non-empty string.`);
        }
        if (typeof entry.path !== "string" || !entry.path.trim()) {
            errors.push(`dashboards[${index}].path must be a non-empty string.`);
        }
        if (entry.name !== undefined && (typeof entry.name !== "string" || !entry.name.trim())) {
            errors.push(`dashboards[${index}].name must be omitted or be a non-empty string.`);
        }
        if (typeof entry.path === "string") {
            const normalizedPath = entry.path.replace(/\\/g, "/");
            if (normalizedPath.startsWith("/") || normalizedPath.includes("../") || normalizedPath.includes("/..")) {
                errors.push(`dashboards[${index}].path must stay inside dashboards/.`);
            }
        }
        const selector = selectorNameForEntry(entry);
        if (seenSelectors.has(selector)) {
            errors.push(`Duplicate dashboard selector: ${selector}`);
        }
        if (typeof entry.uid === "string" && seenUids.has(entry.uid)) {
            errors.push(`Duplicate dashboard uid: ${entry.uid}`);
        }
        if (typeof entry.path === "string" && seenPaths.has(entry.path)) {
            errors.push(`Duplicate dashboard path: ${entry.path}`);
        }
        seenSelectors.add(selector);
        if (typeof entry.uid === "string") {
            seenUids.add(entry.uid);
        }
        if (typeof entry.path === "string") {
            seenPaths.add(entry.path);
        }
    }
    return errors;
}
function findManifestEntryBySelector(manifest, selectorName) {
    return manifest.dashboards.find((entry) => selectorNameForEntry(entry) === selectorName);
}
//# sourceMappingURL=manifest.js.map