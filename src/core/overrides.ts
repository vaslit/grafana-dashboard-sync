import {
  DashboardOverrideFile,
  DashboardOverrideObject,
  DashboardOverrideValue,
  SupportedVariableDescriptor,
} from "./types";

const SUPPORTED_VARIABLE_TYPES = new Set(["custom", "textbox", "constant"]);

function isObjectWithTextAndValue(value: unknown): value is DashboardOverrideObject {
  return value !== null && typeof value === "object" && "text" in value && "value" in value;
}

function dashboardTemplatingList(dashboard: Record<string, unknown>): Array<Record<string, unknown>> {
  const templating = dashboard.templating;
  if (!templating || typeof templating !== "object" || !("list" in templating)) {
    return [];
  }

  const list = (templating as { list?: unknown }).list;
  if (!Array.isArray(list)) {
    return [];
  }

  return list.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object");
}

function normalizeCustomVariableOptions(item: Record<string, unknown>): Array<{ label: string; value: string }> {
  const options: Array<{ label: string; value: string }> = [];
  const seen = new Set<string>();

  if (Array.isArray(item.options)) {
    for (const option of item.options) {
      if (!option || typeof option !== "object" || Array.isArray(option)) {
        continue;
      }

      const optionRecord = option as { text?: unknown; value?: unknown };
      const comparable = optionRecord.value ?? optionRecord.text;
      if (
        typeof comparable !== "string" &&
        typeof comparable !== "number" &&
        typeof comparable !== "boolean" &&
        comparable !== null
      ) {
        continue;
      }

      const serializedValue = serializeOverrideValue(comparable);
      if (seen.has(serializedValue)) {
        continue;
      }

      seen.add(serializedValue);
      options.push({
        label: optionRecord.text === undefined || optionRecord.text === null ? String(comparable ?? "") : String(optionRecord.text),
        value: serializedValue,
      });
    }
  }

  if (options.length > 0) {
    return options;
  }

  if (typeof item.query === "string") {
    for (const rawValue of item.query.split(",")) {
      const value = rawValue.trim();
      if (!value || seen.has(value)) {
        continue;
      }

      seen.add(value);
      options.push({
        label: value,
        value,
      });
    }
  }

  return options;
}

export function supportedVariableTypes(): string[] {
  return [...SUPPORTED_VARIABLE_TYPES];
}

export function extractSupportedVariables(
  dashboard: Record<string, unknown>,
  savedOverride?: DashboardOverrideFile,
): SupportedVariableDescriptor[] {
  const items = dashboardTemplatingList(dashboard);

  return items
    .filter((item) => {
      const name = item.name;
      const type = item.type;
      return typeof name === "string" && typeof type === "string" && SUPPORTED_VARIABLE_TYPES.has(type);
    })
    .map((item) => {
      const current = (item.current ?? {}) as { text?: unknown; value?: unknown };
      const name = item.name as string;
      return {
        name,
        type: item.type as string,
        currentText: current.text ?? "",
        currentValue: current.value ?? "",
        savedOverride: savedOverride?.variables[name],
        ...(item.type === "custom" ? { overrideOptions: normalizeCustomVariableOptions(item) } : {}),
      };
    });
}

export function normalizeOverrideValue(value: DashboardOverrideValue): DashboardOverrideObject {
  if (isObjectWithTextAndValue(value)) {
    return {
      text: value.text,
      value: value.value,
    };
  }

  if (Array.isArray(value)) {
    return {
      text: value,
      value,
    };
  }

  return {
    text: value === null ? "" : String(value),
    value,
  };
}

export function normalizeCurrentForStorage(current: { text?: unknown; value?: unknown }): DashboardOverrideValue {
  const text = current.text;
  const value = current.value;

  if (
    (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) &&
    (text === undefined || text === null || text === value || String(text) === String(value))
  ) {
    return value as DashboardOverrideValue;
  }

  return {
    text: text ?? "",
    value: value ?? "",
  };
}

export function generateOverrideFileFromDashboard(
  dashboard: Record<string, unknown>,
): DashboardOverrideFile {
  const variables = Object.fromEntries(
    extractSupportedVariables(dashboard).map((descriptor) => [
      descriptor.name,
      normalizeCurrentForStorage({
        text: descriptor.currentText,
        value: descriptor.currentValue,
      }),
    ]),
  );

  return { variables };
}

function selectOptions(
  options: unknown,
  normalizedOverride: DashboardOverrideObject,
): unknown {
  if (!Array.isArray(options)) {
    return options;
  }

  const selectedValues = Array.isArray(normalizedOverride.value)
    ? normalizedOverride.value
    : [normalizedOverride.value];

  return options.map((option) => {
    if (!option || typeof option !== "object") {
      return option;
    }

    const optionValue = "value" in option ? (option as { value?: unknown }).value : undefined;
    const optionText = "text" in option ? (option as { text?: unknown }).text : undefined;
    const comparable = optionValue ?? optionText;

    return {
      ...option,
      selected: selectedValues.some((value) => value === comparable),
    };
  });
}

function constantOverrideQuery(normalizedOverride: DashboardOverrideObject): string {
  const value = Array.isArray(normalizedOverride.value) ? normalizedOverride.value[0] : normalizedOverride.value;
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

function validateCustomOverrideValue(
  variable: Record<string, unknown>,
  normalizedOverride: DashboardOverrideObject,
): void {
  const allowedOptions = normalizeCustomVariableOptions(variable);
  if (allowedOptions.length === 0) {
    return;
  }

  const allowedValues = new Set(allowedOptions.map((option) => option.value));
  const values = Array.isArray(normalizedOverride.value) ? normalizedOverride.value : [normalizedOverride.value];
  const invalidValues = values
    .map((value) => serializeOverrideValue(value as DashboardOverrideValue))
    .filter((value) => !allowedValues.has(value));

  if (invalidValues.length > 0) {
    throw new Error(
      `Override value ${invalidValues.map((value) => `"${value}"`).join(", ")} is not available in custom variable "${String(variable.name ?? "")}".`,
    );
  }
}

export function applyOverridesToDashboard(
  dashboard: Record<string, unknown>,
  overrideFile: DashboardOverrideFile | undefined,
): Record<string, unknown> {
  if (Object.keys(overrideFile?.variables ?? {}).length === 0) {
    return structuredClone(dashboard);
  }

  const nextDashboard = structuredClone(dashboard);
  const templating = (nextDashboard.templating ?? { list: [] }) as { list?: unknown[] };
  const list = Array.isArray(templating.list) ? templating.list : [];

  nextDashboard.templating = {
    ...((nextDashboard.templating as Record<string, unknown> | undefined) ?? {}),
    list: list.map((item) => {
      if (!item || typeof item !== "object") {
        return item;
      }

      const variable = item as Record<string, unknown>;
      const name = variable.name;
      const type = variable.type;
      if (typeof name !== "string" || typeof type !== "string" || !SUPPORTED_VARIABLE_TYPES.has(type)) {
        return variable;
      }

      const overrideValue = overrideFile?.variables[name];
      if (overrideValue === undefined) {
        return variable;
      }

      const normalizedOverride = normalizeOverrideValue(overrideValue);
      if (type === "custom") {
        validateCustomOverrideValue(variable, normalizedOverride);
      }
      return {
        ...variable,
        current: normalizedOverride,
        options: selectOptions(variable.options, normalizedOverride),
        ...(type === "constant" ? { query: constantOverrideQuery(normalizedOverride) } : {}),
      };
    }),
  };

  return nextDashboard;
}

export function serializeOverrideValue(value: DashboardOverrideValue | undefined): string {
  if (value === undefined) {
    return "";
  }

  if (value === null) {
    return "null";
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

export function parseOverrideInput(rawValue: string): DashboardOverrideValue | undefined {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed === "null") {
    return null;
  }

  if (trimmed === "true") {
    return true;
  }

  if (trimmed === "false") {
    return false;
  }

  if (!Number.isNaN(Number(trimmed)) && /^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as DashboardOverrideValue;
    return parsed;
  }

  return trimmed;
}
