export function parseEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    if (key) {
      result[key] = value;
    }
  }

  return result;
}

export function stringifyEnv(values: Record<string, string | undefined>): string {
  const preferredOrder = ["GRAFANA_URL", "GRAFANA_URL_FALLBACKS"];
  const emitted = new Set<string>();
  const lines: string[] = [];

  for (const key of preferredOrder) {
    const value = values[key];
    if (value !== undefined && value !== "") {
      lines.push(`${key}=${value}`);
      emitted.add(key);
    }
  }

  for (const key of Object.keys(values).sort((left, right) => left.localeCompare(right))) {
    if (emitted.has(key)) {
      continue;
    }

    const value = values[key];
    if (value !== undefined && value !== "") {
      lines.push(`${key}=${value}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function mergeEnv(
  baseValues: Record<string, string>,
  overlayValues: Record<string, string>,
): Record<string, string> {
  return {
    ...baseValues,
    ...overlayValues,
  };
}
