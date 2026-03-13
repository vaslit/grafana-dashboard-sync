"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureDatasourceCatalogInstances = ensureDatasourceCatalogInstances;
exports.mergePulledDatasourceCatalog = mergePulledDatasourceCatalog;
exports.autoMatchDatasourceCatalogInstance = autoMatchDatasourceCatalogInstance;
exports.normalizeDashboardDatasourceRefs = normalizeDashboardDatasourceRefs;
exports.normalizeDashboardDatasourceRefsFromCatalog = normalizeDashboardDatasourceRefsFromCatalog;
exports.renameDatasourceSourceNames = renameDatasourceSourceNames;
exports.applyDatasourceMappingsToDashboard = applyDatasourceMappingsToDashboard;
exports.findMissingDatasourceMappings = findMissingDatasourceMappings;
exports.buildDatasourceRowsFromDashboard = buildDatasourceRowsFromDashboard;
const datasourceRefs_1 = require("./datasourceRefs");
function cloneCatalog(catalogFile) {
    return structuredClone(catalogFile ?? {
        datasources: {},
    });
}
function uniqueSourceName(baseName, sourceUid, usedKeys) {
    const preferred = baseName.trim() || sourceUid;
    if (!usedKeys.has(preferred)) {
        usedKeys.add(preferred);
        return preferred;
    }
    const fallback = `${preferred}__${sourceUid}`;
    if (!usedKeys.has(fallback)) {
        usedKeys.add(fallback);
        return fallback;
    }
    let suffix = 2;
    while (usedKeys.has(`${fallback}_${suffix}`)) {
        suffix += 1;
    }
    const uniqueKey = `${fallback}_${suffix}`;
    usedKeys.add(uniqueKey);
    return uniqueKey;
}
function datasourceByName(datasources) {
    return new Map(datasources.map((datasource) => [datasource.name, datasource]));
}
function findSourceNameByInstanceUid(catalogFile, instanceName, sourceUid) {
    return Object.entries(catalogFile.datasources).find(([, entry]) => entry.instances[instanceName]?.uid?.trim() === sourceUid)?.[0];
}
function ensureCatalogEntryInstances(entry, instanceNames) {
    for (const instanceName of instanceNames) {
        entry.instances[instanceName] ??= {};
    }
    return entry;
}
function ensureDatasourceCatalogInstances(catalogFile, instanceNames) {
    const nextCatalog = cloneCatalog(catalogFile);
    for (const entry of Object.values(nextCatalog.datasources)) {
        ensureCatalogEntryInstances(entry, instanceNames);
    }
    return nextCatalog;
}
function mergePulledDatasourceCatalog(catalogFile, instanceName, descriptors, instanceNames, datasourcesByInstance) {
    const nextCatalog = ensureDatasourceCatalogInstances(catalogFile, instanceNames);
    const usedSourceNames = new Set(Object.keys(nextCatalog.datasources));
    const sourceNamesByUid = new Map();
    for (const descriptor of descriptors) {
        let sourceName = findSourceNameByInstanceUid(nextCatalog, instanceName, descriptor.sourceUid);
        const remoteName = descriptor.sourceName?.trim() || descriptor.label.trim() || descriptor.sourceUid;
        if (!sourceName) {
            sourceName = uniqueSourceName(remoteName, descriptor.sourceUid, usedSourceNames);
            nextCatalog.datasources[sourceName] = {
                instances: {},
            };
        }
        const entry = ensureCatalogEntryInstances(nextCatalog.datasources[sourceName], instanceNames);
        const currentTarget = (entry.instances[instanceName] ??= {});
        currentTarget.uid = descriptor.sourceUid;
        if (remoteName) {
            currentTarget.name = remoteName;
        }
        for (const candidateInstanceName of instanceNames) {
            const candidateTarget = (entry.instances[candidateInstanceName] ??= {});
            if (candidateInstanceName === instanceName || candidateTarget.uid?.trim()) {
                continue;
            }
            const matchedDatasource = remoteName
                ? datasourceByName(datasourcesByInstance.get(candidateInstanceName) ?? []).get(remoteName)
                : undefined;
            if (!matchedDatasource) {
                continue;
            }
            candidateTarget.uid = matchedDatasource.uid;
            candidateTarget.name = matchedDatasource.name;
        }
        sourceNamesByUid.set(descriptor.sourceUid, sourceName);
    }
    return {
        catalog: nextCatalog,
        sourceNamesByUid,
    };
}
function autoMatchDatasourceCatalogInstance(catalogFile, instanceName, targetDatasources) {
    const nextCatalog = cloneCatalog(catalogFile);
    const targetsByName = datasourceByName(targetDatasources);
    for (const [sourceName, entry] of Object.entries(nextCatalog.datasources)) {
        const currentTarget = (entry.instances[instanceName] ??= {});
        if (currentTarget.uid?.trim()) {
            continue;
        }
        const matchedDatasource = targetsByName.get(sourceName);
        if (!matchedDatasource) {
            continue;
        }
        currentTarget.uid = matchedDatasource.uid;
        currentTarget.name = matchedDatasource.name;
    }
    return nextCatalog;
}
function buildTargetMap(catalogFile, instanceName) {
    const mappings = {};
    for (const [sourceName, entry] of Object.entries(catalogFile?.datasources ?? {})) {
        const target = entry.instances[instanceName];
        if (!target?.uid?.trim()) {
            continue;
        }
        mappings[sourceName] = {
            uid: target.uid.trim(),
            ...(target.name?.trim() ? { name: target.name.trim() } : {}),
        };
    }
    return mappings;
}
function rewriteIdentifierValue(value, replacements) {
    if (typeof value === "string") {
        return replacements[value] ?? value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => rewriteIdentifierValue(item, replacements));
    }
    return value;
}
function rewriteDatasourceRefWithIdentifiers(value, replacements) {
    if (typeof value === "string") {
        return replacements[value] ?? value;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return value;
    }
    const ref = value;
    if (typeof ref.uid !== "string") {
        return value;
    }
    return {
        ...ref,
        uid: replacements[ref.uid] ?? ref.uid,
    };
}
function rewriteDatasourceVariableWithIdentifiers(variable, replacements) {
    if (variable.type !== "datasource") {
        return variable;
    }
    const current = variable.current;
    const nextCurrent = current && typeof current === "object" && !Array.isArray(current)
        ? (() => {
            const currentRecord = current;
            const originalValue = currentRecord.value;
            const nextValue = rewriteIdentifierValue(originalValue, replacements);
            const nextText = Array.isArray(originalValue)
                ? originalValue.map((item, index) => {
                    if (typeof item === "string" && replacements[item]) {
                        return replacements[item];
                    }
                    return Array.isArray(currentRecord.text) ? currentRecord.text[index] : item;
                })
                : typeof originalValue === "string" && replacements[originalValue]
                    ? replacements[originalValue]
                    : currentRecord.text;
            return {
                ...currentRecord,
                value: nextValue,
                text: nextText,
            };
        })()
        : current;
    const nextOptions = Array.isArray(variable.options)
        ? variable.options.map((option) => {
            if (!option || typeof option !== "object" || Array.isArray(option)) {
                return option;
            }
            const optionRecord = option;
            const originalValue = optionRecord.value;
            const nextValue = rewriteIdentifierValue(originalValue, replacements);
            const nextText = typeof originalValue === "string" && replacements[originalValue]
                ? replacements[originalValue]
                : optionRecord.text;
            return {
                ...optionRecord,
                value: nextValue,
                text: nextText,
            };
        })
        : variable.options;
    return {
        ...variable,
        current: nextCurrent,
        options: nextOptions,
    };
}
function rewriteDatasourceRefWithTargets(value, mappings) {
    if (typeof value === "string") {
        return mappings[value]?.uid ?? value;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return value;
    }
    const ref = value;
    if (typeof ref.uid !== "string") {
        return value;
    }
    const mapped = mappings[ref.uid];
    if (!mapped) {
        return value;
    }
    return {
        ...ref,
        uid: mapped.uid,
    };
}
function rewriteTargetValue(value, mappings, field) {
    if (typeof value === "string") {
        const mapped = mappings[value];
        if (!mapped) {
            return value;
        }
        return field === "uid" ? mapped.uid : mapped.name ?? value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => rewriteTargetValue(item, mappings, field));
    }
    return value;
}
function rewriteDatasourceVariableWithTargets(variable, mappings) {
    if (variable.type !== "datasource") {
        return variable;
    }
    const current = variable.current;
    const nextCurrent = current && typeof current === "object" && !Array.isArray(current)
        ? (() => {
            const currentRecord = current;
            const originalValue = currentRecord.value;
            const nextValue = rewriteTargetValue(originalValue, mappings, "uid");
            const nextText = Array.isArray(originalValue)
                ? originalValue.map((item, index) => {
                    if (typeof item === "string" && mappings[item]?.name) {
                        return mappings[item].name;
                    }
                    return Array.isArray(currentRecord.text) ? currentRecord.text[index] : item;
                })
                : typeof originalValue === "string" && mappings[originalValue]?.name
                    ? mappings[originalValue].name
                    : currentRecord.text;
            return {
                ...currentRecord,
                value: nextValue,
                text: nextText,
            };
        })()
        : current;
    const nextOptions = Array.isArray(variable.options)
        ? variable.options.map((option) => {
            if (!option || typeof option !== "object" || Array.isArray(option)) {
                return option;
            }
            const optionRecord = option;
            const originalValue = optionRecord.value;
            const nextValue = rewriteTargetValue(originalValue, mappings, "uid");
            const nextText = typeof originalValue === "string" && mappings[originalValue]?.name
                ? mappings[originalValue].name
                : optionRecord.text;
            return {
                ...optionRecord,
                value: nextValue,
                text: nextText,
            };
        })
        : variable.options;
    return {
        ...variable,
        current: nextCurrent,
        options: nextOptions,
    };
}
function rewriteNode(node, rewriteDatasourceRef, rewriteDatasourceVariable) {
    if (Array.isArray(node)) {
        return node.map((item) => rewriteNode(item, rewriteDatasourceRef, rewriteDatasourceVariable));
    }
    if (!node || typeof node !== "object") {
        return node;
    }
    const record = node;
    const nextRecord = {};
    for (const [key, value] of Object.entries(record)) {
        if (key === "datasource") {
            nextRecord[key] = rewriteDatasourceRef(value);
        }
        else {
            nextRecord[key] = rewriteNode(value, rewriteDatasourceRef, rewriteDatasourceVariable);
        }
    }
    return rewriteDatasourceVariable(nextRecord);
}
function normalizeDashboardDatasourceRefs(dashboard, sourceNamesByUid) {
    const replacements = Object.fromEntries(sourceNamesByUid.entries());
    if (Object.keys(replacements).length === 0) {
        return structuredClone(dashboard);
    }
    return rewriteNode(structuredClone(dashboard), (value) => rewriteDatasourceRefWithIdentifiers(value, replacements), (variable) => rewriteDatasourceVariableWithIdentifiers(variable, replacements));
}
function normalizeDashboardDatasourceRefsFromCatalog(dashboard, catalogFile, instanceName) {
    const sourceNamesByUid = new Map();
    for (const [sourceName, entry] of Object.entries(catalogFile?.datasources ?? {})) {
        const targetUid = entry.instances[instanceName]?.uid?.trim();
        if (!targetUid) {
            continue;
        }
        sourceNamesByUid.set(targetUid, sourceName);
    }
    return normalizeDashboardDatasourceRefs(dashboard, sourceNamesByUid);
}
function renameDatasourceSourceNames(dashboard, renames) {
    if (Object.keys(renames).length === 0) {
        return structuredClone(dashboard);
    }
    return rewriteNode(structuredClone(dashboard), (value) => rewriteDatasourceRefWithIdentifiers(value, renames), (variable) => rewriteDatasourceVariableWithIdentifiers(variable, renames));
}
function applyDatasourceMappingsToDashboard(dashboard, catalogFile, instanceName) {
    const mappings = buildTargetMap(catalogFile, instanceName);
    if (Object.keys(mappings).length === 0) {
        return structuredClone(dashboard);
    }
    return rewriteNode(structuredClone(dashboard), (value) => rewriteDatasourceRefWithTargets(value, mappings), (variable) => rewriteDatasourceVariableWithTargets(variable, mappings));
}
function findMissingDatasourceMappings(dashboard, catalogFile, instanceName) {
    const refs = (0, datasourceRefs_1.extractDashboardDatasourceRefs)(dashboard);
    return refs
        .filter((ref) => !catalogFile?.datasources[ref.sourceUid]?.instances[instanceName]?.uid?.trim())
        .map((ref) => ref.sourceUid);
}
function buildDatasourceRowsFromDashboard(dashboard, catalogFile, instanceName) {
    const descriptors = (0, datasourceRefs_1.buildDashboardDatasourceDescriptors)(dashboard);
    return descriptors.map((descriptor) => ({
        sourceName: descriptor.sourceUid,
        sourceType: descriptor.type,
        usageCount: descriptor.usageCount,
        usageKinds: descriptor.usageKinds,
        target: catalogFile?.datasources[descriptor.sourceUid]?.instances[instanceName],
    }));
}
//# sourceMappingURL=datasourceMappings.js.map