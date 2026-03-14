"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseEnv = parseEnv;
exports.stringifyEnv = stringifyEnv;
exports.mergeEnv = mergeEnv;
function parseEnv(content) {
    const result = {};
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
        if (value.length >= 2 &&
            ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
            value = value.slice(1, -1);
        }
        if (key) {
            result[key] = value;
        }
    }
    return result;
}
function stringifyEnv(values) {
    const preferredOrder = ["GRAFANA_URL"];
    const emitted = new Set();
    const lines = [];
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
function mergeEnv(baseValues, overlayValues) {
    return {
        ...baseValues,
        ...overlayValues,
    };
}
//# sourceMappingURL=env.js.map