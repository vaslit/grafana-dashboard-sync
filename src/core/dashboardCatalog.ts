import { DashboardManifestEntry, GrafanaDashboardSummary } from "./types";

function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "item";
}

function uniqueValue(base: string, existingValues: Set<string>): string {
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

export function buildManifestEntriesFromRemoteDashboards(
  dashboards: GrafanaDashboardSummary[],
  existingEntries: DashboardManifestEntry[],
): DashboardManifestEntry[] {
  const selectorValues = new Set(existingEntries.map((entry) => entry.name?.trim()).filter(Boolean) as string[]);
  const pathValues = new Set(existingEntries.map((entry) => entry.path));
  const nextEntries: DashboardManifestEntry[] = [];

  for (const dashboard of dashboards) {
    const folderSegment =
      dashboard.folderUid && dashboard.folderTitle
        ? `${slugify(dashboard.folderTitle)}__${dashboard.folderUid}`
        : "_root";
    const fileStem = `${slugify(dashboard.title)}__${dashboard.uid}`;
    const selectorBase = slugify(dashboard.title);

    const entry: DashboardManifestEntry = {
      name: uniqueValue(selectorBase, selectorValues),
      uid: dashboard.uid,
      path: uniqueValue(`${folderSegment}/${fileStem}.json`, pathValues),
    };

    nextEntries.push(entry);
  }

  return nextEntries;
}
