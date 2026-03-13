import { DashboardDatasourceDescriptor, DashboardDatasourceRef, GrafanaDatasourceSummary } from "./types";

function isBuiltinGrafanaDatasource(uid: string, type: string | undefined): boolean {
  return uid === "-- Grafana --" || (uid === "grafana" && (type === "grafana" || type === "datasource"));
}

function registerRef(
  refs: Map<string, DashboardDatasourceRef>,
  uid: string,
  type: string | undefined,
  usageKind: "panel" | "query" | "variable",
): void {
  if (!uid.trim() || isBuiltinGrafanaDatasource(uid, type)) {
    return;
  }

  const existing = refs.get(uid);
  if (existing) {
    existing.usageCount += 1;
    if (!existing.usageKinds.includes(usageKind)) {
      existing.usageKinds.push(usageKind);
    }
    if (!existing.type && type) {
      existing.type = type;
    }
    return;
  }

  refs.set(uid, {
    sourceUid: uid,
    type,
    usageCount: 1,
    usageKinds: [usageKind],
  });
}

function walk(node: unknown, refs: Map<string, DashboardDatasourceRef>): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      walk(item, refs);
    }
    return;
  }

  if (!node || typeof node !== "object") {
    return;
  }

  const record = node as Record<string, unknown>;

  if (record.type === "datasource") {
    const current = record.current;
    if (current && typeof current === "object" && !Array.isArray(current)) {
      const currentValue = (current as Record<string, unknown>).value;
      if (typeof currentValue === "string") {
        registerRef(refs, currentValue, undefined, "variable");
      } else if (Array.isArray(currentValue)) {
        for (const value of currentValue) {
          if (typeof value === "string") {
            registerRef(refs, value, undefined, "variable");
          }
        }
      }
    }

    if (Array.isArray(record.options)) {
      for (const option of record.options) {
        if (!option || typeof option !== "object" || Array.isArray(option)) {
          continue;
        }
        const value = (option as Record<string, unknown>).value;
        if (typeof value === "string") {
          registerRef(refs, value, undefined, "variable");
        }
      }
    }
  }

  const datasource = record.datasource;
  if (typeof datasource === "string") {
    registerRef(refs, datasource, undefined, typeof record.refId === "string" ? "query" : "panel");
  } else if (datasource && typeof datasource === "object" && !Array.isArray(datasource)) {
    const datasourceRecord = datasource as Record<string, unknown>;
    if (typeof datasourceRecord.uid === "string") {
      registerRef(
        refs,
        datasourceRecord.uid,
        typeof datasourceRecord.type === "string" ? datasourceRecord.type : undefined,
        typeof record.refId === "string" ? "query" : "panel",
      );
    }
  }

  for (const value of Object.values(record)) {
    walk(value, refs);
  }
}

export function extractDashboardDatasourceRefs(dashboard: Record<string, unknown>): DashboardDatasourceRef[] {
  const refs = new Map<string, DashboardDatasourceRef>();
  walk(dashboard, refs);
  return [...refs.values()].sort((left, right) => left.sourceUid.localeCompare(right.sourceUid));
}

function uniqueDatasourceKey(baseLabel: string, sourceUid: string, usedKeys: Set<string>): string {
  const preferred = baseLabel.trim() || sourceUid;
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

export function buildDashboardDatasourceDescriptors(
  dashboard: Record<string, unknown>,
  datasources?: GrafanaDatasourceSummary[],
): DashboardDatasourceDescriptor[] {
  const refs = extractDashboardDatasourceRefs(dashboard);
  const datasourceNames = new Map((datasources ?? []).map((datasource) => [datasource.uid, datasource.name]));
  const usedKeys = new Set<string>();

  return refs.map((ref) => {
    const sourceName = datasourceNames.get(ref.sourceUid);
    const label = sourceName ?? ref.sourceUid;
    return {
      ...ref,
      key: uniqueDatasourceKey(label, ref.sourceUid, usedKeys),
      label,
      sourceName,
    };
  });
}
