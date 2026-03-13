"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildManifestEntriesFromRemoteDashboards = buildManifestEntriesFromRemoteDashboards;
function slugify(value) {
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "_")
        .replace(/^_+|_+$/g, "");
    return normalized || "item";
}
function uniqueValue(base, existingValues) {
    if (!existingValues.has(base)) {
        existingValues.add(base);
        return base;
    }
    let suffix = 2;
    while (existingValues.has(`${base}_${suffix}`)) {
        suffix += 1;
    }
    const nextValue = `${base}_${suffix}`;
    existingValues.add(nextValue);
    return nextValue;
}
function buildManifestEntriesFromRemoteDashboards(dashboards, existingEntries) {
    const selectorValues = new Set(existingEntries.map((entry) => entry.name?.trim()).filter(Boolean));
    const pathValues = new Set(existingEntries.map((entry) => entry.path));
    const nextEntries = [];
    for (const dashboard of dashboards) {
        const folderSegment = dashboard.folderUid && dashboard.folderTitle
            ? `${slugify(dashboard.folderTitle)}__${dashboard.folderUid}`
            : "_root";
        const fileStem = `${slugify(dashboard.title)}__${dashboard.uid}`;
        const selectorBase = slugify(dashboard.title);
        const entry = {
            name: uniqueValue(selectorBase, selectorValues),
            uid: dashboard.uid,
            path: uniqueValue(`${folderSegment}/${fileStem}.json`, pathValues),
        };
        nextEntries.push(entry);
    }
    return nextEntries;
}
//# sourceMappingURL=dashboardCatalog.js.map