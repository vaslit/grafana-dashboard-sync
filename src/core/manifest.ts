import path from "node:path";

import { DashboardManifest, DashboardManifestEntry } from "./types";

export function selectorNameForEntry(entry: DashboardManifestEntry): string {
  if (entry.name && entry.name.trim()) {
    return entry.name.trim();
  }

  const baseName = path.basename(entry.path, path.extname(entry.path));
  return baseName || entry.uid;
}

export function validateManifest(manifest: DashboardManifest): string[] {
  const errors: string[] = [];

  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.dashboards)) {
    return ["Manifest must be an object with a dashboards array."];
  }

  const seenSelectors = new Set<string>();
  const seenUids = new Set<string>();
  const seenPaths = new Set<string>();

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

export function findManifestEntryBySelector(
  manifest: DashboardManifest,
  selectorName: string,
): DashboardManifestEntry | undefined {
  return manifest.dashboards.find((entry) => selectorNameForEntry(entry) === selectorName);
}
