import { buildDashboardDatasourceDescriptors, extractDashboardDatasourceRefs } from "./datasourceRefs";
import {
  DashboardDatasourceDescriptor,
  DatasourceCatalogEntry,
  DatasourceCatalogFile,
  DatasourceCatalogInstanceTarget,
  GrafanaDatasourceSummary,
} from "./types";

type DatasourceTargetMap = Record<string, Required<Pick<DatasourceCatalogInstanceTarget, "uid">> & DatasourceCatalogInstanceTarget>;

function cloneCatalog(catalogFile?: DatasourceCatalogFile): DatasourceCatalogFile {
  return structuredClone(
    catalogFile ?? {
      datasources: {},
    },
  );
}

function uniqueSourceName(baseName: string, sourceUid: string, usedKeys: Set<string>): string {
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

function datasourceByName(datasources: GrafanaDatasourceSummary[]): Map<string, GrafanaDatasourceSummary> {
  return new Map(datasources.map((datasource) => [datasource.name, datasource]));
}

function findSourceNameByInstanceUid(
  catalogFile: DatasourceCatalogFile,
  instanceName: string,
  sourceUid: string,
): string | undefined {
  return Object.entries(catalogFile.datasources).find(
    ([, entry]) => entry.instances[instanceName]?.uid?.trim() === sourceUid,
  )?.[0];
}

function ensureCatalogEntryInstances(
  entry: DatasourceCatalogEntry,
  instanceNames: string[],
): DatasourceCatalogEntry {
  for (const instanceName of instanceNames) {
    entry.instances[instanceName] ??= {};
  }
  return entry;
}

export function ensureDatasourceCatalogInstances(
  catalogFile: DatasourceCatalogFile | undefined,
  instanceNames: string[],
): DatasourceCatalogFile {
  const nextCatalog = cloneCatalog(catalogFile);
  for (const entry of Object.values(nextCatalog.datasources)) {
    ensureCatalogEntryInstances(entry, instanceNames);
  }
  return nextCatalog;
}

export function mergePulledDatasourceCatalog(
  catalogFile: DatasourceCatalogFile | undefined,
  instanceName: string,
  descriptors: DashboardDatasourceDescriptor[],
  instanceNames: string[],
  datasourcesByInstance: ReadonlyMap<string, GrafanaDatasourceSummary[]>,
): { catalog: DatasourceCatalogFile; sourceNamesByUid: Map<string, string> } {
  const nextCatalog = ensureDatasourceCatalogInstances(catalogFile, instanceNames);
  const usedSourceNames = new Set(Object.keys(nextCatalog.datasources));
  const sourceNamesByUid = new Map<string, string>();

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

export function autoMatchDatasourceCatalogInstance(
  catalogFile: DatasourceCatalogFile | undefined,
  instanceName: string,
  targetDatasources: GrafanaDatasourceSummary[],
): DatasourceCatalogFile {
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

function buildTargetMap(catalogFile: DatasourceCatalogFile | undefined, instanceName: string): DatasourceTargetMap {
  const mappings: DatasourceTargetMap = {};

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

function rewriteIdentifierValue(value: unknown, replacements: Record<string, string>): unknown {
  if (typeof value === "string") {
    return replacements[value] ?? value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => rewriteIdentifierValue(item, replacements));
  }

  return value;
}

function rewriteDatasourceRefWithIdentifiers(value: unknown, replacements: Record<string, string>): unknown {
  if (typeof value === "string") {
    return replacements[value] ?? value;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const ref = value as Record<string, unknown>;
  if (typeof ref.uid !== "string") {
    return value;
  }

  return {
    ...ref,
    uid: replacements[ref.uid] ?? ref.uid,
  };
}

function rewriteDatasourceVariableWithIdentifiers(
  variable: Record<string, unknown>,
  replacements: Record<string, string>,
): Record<string, unknown> {
  if (variable.type !== "datasource") {
    return variable;
  }

  const current = variable.current;
  const nextCurrent =
    current && typeof current === "object" && !Array.isArray(current)
      ? (() => {
          const currentRecord = current as Record<string, unknown>;
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

        const optionRecord = option as Record<string, unknown>;
        const originalValue = optionRecord.value;
        const nextValue = rewriteIdentifierValue(originalValue, replacements);
        const nextText =
          typeof originalValue === "string" && replacements[originalValue]
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

function rewriteDatasourceRefWithTargets(value: unknown, mappings: DatasourceTargetMap): unknown {
  if (typeof value === "string") {
    return mappings[value]?.uid ?? value;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const ref = value as Record<string, unknown>;
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

function rewriteTargetValue(value: unknown, mappings: DatasourceTargetMap, field: "uid" | "name"): unknown {
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

function rewriteDatasourceVariableWithTargets(
  variable: Record<string, unknown>,
  mappings: DatasourceTargetMap,
): Record<string, unknown> {
  if (variable.type !== "datasource") {
    return variable;
  }

  const current = variable.current;
  const nextCurrent =
    current && typeof current === "object" && !Array.isArray(current)
      ? (() => {
          const currentRecord = current as Record<string, unknown>;
          const originalValue = currentRecord.value;
          const nextValue = rewriteTargetValue(originalValue, mappings, "uid");
          const nextText = Array.isArray(originalValue)
            ? originalValue.map((item, index) => {
                if (typeof item === "string" && mappings[item]?.name) {
                  return mappings[item]!.name!;
                }
                return Array.isArray(currentRecord.text) ? currentRecord.text[index] : item;
              })
            : typeof originalValue === "string" && mappings[originalValue]?.name
              ? mappings[originalValue]!.name
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

        const optionRecord = option as Record<string, unknown>;
        const originalValue = optionRecord.value;
        const nextValue = rewriteTargetValue(originalValue, mappings, "uid");
        const nextText =
          typeof originalValue === "string" && mappings[originalValue]?.name
            ? mappings[originalValue]!.name
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

function rewriteNode(
  node: unknown,
  rewriteDatasourceRef: (value: unknown) => unknown,
  rewriteDatasourceVariable: (variable: Record<string, unknown>) => Record<string, unknown>,
): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => rewriteNode(item, rewriteDatasourceRef, rewriteDatasourceVariable));
  }

  if (!node || typeof node !== "object") {
    return node;
  }

  const record = node as Record<string, unknown>;
  const nextRecord: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "datasource") {
      nextRecord[key] = rewriteDatasourceRef(value);
    } else {
      nextRecord[key] = rewriteNode(value, rewriteDatasourceRef, rewriteDatasourceVariable);
    }
  }

  return rewriteDatasourceVariable(nextRecord);
}

export function normalizeDashboardDatasourceRefs(
  dashboard: Record<string, unknown>,
  sourceNamesByUid: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const replacements = Object.fromEntries(sourceNamesByUid.entries());
  if (Object.keys(replacements).length === 0) {
    return structuredClone(dashboard);
  }

  return rewriteNode(
    structuredClone(dashboard),
    (value) => rewriteDatasourceRefWithIdentifiers(value, replacements),
    (variable) => rewriteDatasourceVariableWithIdentifiers(variable, replacements),
  ) as Record<string, unknown>;
}

export function normalizeDashboardDatasourceRefsFromCatalog(
  dashboard: Record<string, unknown>,
  catalogFile: DatasourceCatalogFile | undefined,
  instanceName: string,
): Record<string, unknown> {
  const sourceNamesByUid = new Map<string, string>();
  for (const [sourceName, entry] of Object.entries(catalogFile?.datasources ?? {})) {
    const targetUid = entry.instances[instanceName]?.uid?.trim();
    if (!targetUid) {
      continue;
    }
    sourceNamesByUid.set(targetUid, sourceName);
  }

  return normalizeDashboardDatasourceRefs(dashboard, sourceNamesByUid);
}

export function renameDatasourceSourceNames(
  dashboard: Record<string, unknown>,
  renames: Record<string, string>,
): Record<string, unknown> {
  if (Object.keys(renames).length === 0) {
    return structuredClone(dashboard);
  }

  return rewriteNode(
    structuredClone(dashboard),
    (value) => rewriteDatasourceRefWithIdentifiers(value, renames),
    (variable) => rewriteDatasourceVariableWithIdentifiers(variable, renames),
  ) as Record<string, unknown>;
}

export function applyDatasourceMappingsToDashboard(
  dashboard: Record<string, unknown>,
  catalogFile: DatasourceCatalogFile | undefined,
  instanceName: string,
): Record<string, unknown> {
  const mappings = buildTargetMap(catalogFile, instanceName);
  if (Object.keys(mappings).length === 0) {
    return structuredClone(dashboard);
  }

  return rewriteNode(
    structuredClone(dashboard),
    (value) => rewriteDatasourceRefWithTargets(value, mappings),
    (variable) => rewriteDatasourceVariableWithTargets(variable, mappings),
  ) as Record<string, unknown>;
}

export function findMissingDatasourceMappings(
  dashboard: Record<string, unknown>,
  catalogFile: DatasourceCatalogFile | undefined,
  instanceName: string,
): string[] {
  const refs = extractDashboardDatasourceRefs(dashboard);

  return refs
    .filter((ref) => !catalogFile?.datasources[ref.sourceUid]?.instances[instanceName]?.uid?.trim())
    .map((ref) => ref.sourceUid);
}

export function buildDatasourceRowsFromDashboard(
  dashboard: Record<string, unknown>,
  catalogFile: DatasourceCatalogFile | undefined,
  instanceName: string,
) {
  const descriptors = buildDashboardDatasourceDescriptors(dashboard);
  return descriptors.map((descriptor) => ({
    sourceName: descriptor.sourceUid,
    sourceType: descriptor.type,
    usageCount: descriptor.usageCount,
    usageKinds: descriptor.usageKinds,
    target: catalogFile?.datasources[descriptor.sourceUid]?.instances[instanceName],
  }));
}
