function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeysDeep(item)) as T;
  }

  if (isPlainObject(value)) {
    const sortedEntries = Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, childValue]) => [key, sortKeysDeep(childValue)]);

    return Object.fromEntries(sortedEntries) as T;
  }

  return value;
}

export function stableJsonStringify(value: unknown): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}
