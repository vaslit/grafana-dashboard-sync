"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sortKeysDeep = sortKeysDeep;
exports.stableJsonStringify = stableJsonStringify;
function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function sortKeysDeep(value) {
    if (Array.isArray(value)) {
        return value.map((item) => sortKeysDeep(item));
    }
    if (isPlainObject(value)) {
        const sortedEntries = Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, childValue]) => [key, sortKeysDeep(childValue)]);
        return Object.fromEntries(sortedEntries);
    }
    return value;
}
function stableJsonStringify(value) {
    return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}
//# sourceMappingURL=json.js.map