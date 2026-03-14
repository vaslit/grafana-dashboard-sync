"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.supportedVariableTypes = supportedVariableTypes;
exports.extractSupportedVariables = extractSupportedVariables;
exports.normalizeOverrideValue = normalizeOverrideValue;
exports.normalizeCurrentForStorage = normalizeCurrentForStorage;
exports.generateOverrideFileFromDashboard = generateOverrideFileFromDashboard;
exports.applyOverridesToDashboard = applyOverridesToDashboard;
exports.serializeOverrideValue = serializeOverrideValue;
exports.parseOverrideInput = parseOverrideInput;
const SUPPORTED_VARIABLE_TYPES = new Set(["custom", "textbox", "constant"]);
function isObjectWithTextAndValue(value) {
    return value !== null && typeof value === "object" && "text" in value && "value" in value;
}
function dashboardTemplatingList(dashboard) {
    const templating = dashboard.templating;
    if (!templating || typeof templating !== "object" || !("list" in templating)) {
        return [];
    }
    const list = templating.list;
    if (!Array.isArray(list)) {
        return [];
    }
    return list.filter((item) => item !== null && typeof item === "object");
}
function normalizeCustomVariableOptions(item) {
    const options = [];
    const seen = new Set();
    if (Array.isArray(item.options)) {
        for (const option of item.options) {
            if (!option || typeof option !== "object" || Array.isArray(option)) {
                continue;
            }
            const optionRecord = option;
            const comparable = optionRecord.value ?? optionRecord.text;
            if (typeof comparable !== "string" &&
                typeof comparable !== "number" &&
                typeof comparable !== "boolean" &&
                comparable !== null) {
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
function supportedVariableTypes() {
    return [...SUPPORTED_VARIABLE_TYPES];
}
function extractSupportedVariables(dashboard, savedOverride) {
    const items = dashboardTemplatingList(dashboard);
    return items
        .filter((item) => {
        const name = item.name;
        const type = item.type;
        return typeof name === "string" && typeof type === "string" && SUPPORTED_VARIABLE_TYPES.has(type);
    })
        .map((item) => {
        const current = (item.current ?? {});
        const name = item.name;
        const constantQuery = item.type === "constant" && typeof item.query === "string" ? item.query : undefined;
        return {
            name,
            type: item.type,
            currentText: constantQuery ?? current.text ?? "",
            currentValue: constantQuery ?? current.value ?? "",
            savedOverride: savedOverride?.variableOverrides[name],
            ...(item.type === "custom" ? { overrideOptions: normalizeCustomVariableOptions(item) } : {}),
        };
    });
}
function normalizeOverrideValue(value) {
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
function normalizeCurrentForStorage(current) {
    const text = current.text;
    const value = current.value;
    if ((typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) &&
        (text === undefined || text === null || text === value || String(text) === String(value))) {
        return value;
    }
    return {
        text: text ?? "",
        value: value ?? "",
    };
}
function generateOverrideFileFromDashboard(dashboard) {
    const variableOverrides = Object.fromEntries(extractSupportedVariables(dashboard).map((descriptor) => [
        descriptor.name,
        normalizeCurrentForStorage({
            text: descriptor.currentText,
            value: descriptor.currentValue,
        }),
    ]));
    return {
        variableOverrides,
        datasourceBindings: {},
    };
}
function selectOptions(options, normalizedOverride) {
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
        const optionValue = "value" in option ? option.value : undefined;
        const optionText = "text" in option ? option.text : undefined;
        const comparable = optionValue ?? optionText;
        return {
            ...option,
            selected: selectedValues.some((value) => value === comparable),
        };
    });
}
function constantOverrideQuery(normalizedOverride) {
    const value = Array.isArray(normalizedOverride.value) ? normalizedOverride.value[0] : normalizedOverride.value;
    if (value === null || value === undefined) {
        return "";
    }
    return String(value);
}
function validateCustomOverrideValue(variable, normalizedOverride) {
    const allowedOptions = normalizeCustomVariableOptions(variable);
    if (allowedOptions.length === 0) {
        return;
    }
    const allowedValues = new Set(allowedOptions.map((option) => option.value));
    const values = Array.isArray(normalizedOverride.value) ? normalizedOverride.value : [normalizedOverride.value];
    const invalidValues = values
        .map((value) => serializeOverrideValue(value))
        .filter((value) => !allowedValues.has(value));
    if (invalidValues.length > 0) {
        throw new Error(`Override value ${invalidValues.map((value) => `"${value}"`).join(", ")} is not available in custom variable "${String(variable.name ?? "")}".`);
    }
}
function applyOverridesToDashboard(dashboard, overrideFile) {
    if (Object.keys(overrideFile?.variableOverrides ?? {}).length === 0) {
        return structuredClone(dashboard);
    }
    const nextDashboard = structuredClone(dashboard);
    const templating = (nextDashboard.templating ?? { list: [] });
    const list = Array.isArray(templating.list) ? templating.list : [];
    nextDashboard.templating = {
        ...(nextDashboard.templating ?? {}),
        list: list.map((item) => {
            if (!item || typeof item !== "object") {
                return item;
            }
            const variable = item;
            const name = variable.name;
            const type = variable.type;
            if (typeof name !== "string" || typeof type !== "string" || !SUPPORTED_VARIABLE_TYPES.has(type)) {
                return variable;
            }
            const overrideValue = overrideFile?.variableOverrides[name];
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
function serializeOverrideValue(value) {
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
function parseOverrideInput(rawValue) {
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
        const parsed = JSON.parse(trimmed);
        return parsed;
    }
    return trimmed;
}
//# sourceMappingURL=overrides.js.map