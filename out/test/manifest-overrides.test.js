"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const manifest_1 = require("../core/manifest");
const overrides_1 = require("../core/overrides");
(0, node_test_1.test)("selectorNameForEntry falls back to file name", () => {
    const selector = (0, manifest_1.selectorNameForEntry)({
        uid: "uid-1",
        path: "integration/status.json",
    });
    strict_1.default.equal(selector, "status");
});
(0, node_test_1.test)("validateManifest rejects duplicate selectors and paths", () => {
    const manifest = {
        dashboards: [
            {
                name: "sync-status",
                uid: "uid-1",
                path: "integration/status.json",
            },
            {
                name: "sync-status",
                uid: "uid-2",
                path: "integration/status-copy.json",
            },
            {
                name: "other",
                uid: "uid-3",
                path: "integration/status.json",
            },
        ],
    };
    const errors = (0, manifest_1.validateManifest)(manifest);
    strict_1.default.ok(errors.some((error) => error.includes("Duplicate dashboard selector")));
    strict_1.default.ok(errors.some((error) => error.includes("Duplicate dashboard path")));
});
(0, node_test_1.test)("generateOverrideFileFromDashboard extracts supported variable types", () => {
    const dashboard = {
        title: "Demo",
        templating: {
            list: [
                {
                    name: "site",
                    type: "custom",
                    current: {
                        text: "nsk",
                        value: "nsk",
                    },
                },
                {
                    name: "freeText",
                    type: "textbox",
                    current: {
                        text: "abc",
                        value: "abc",
                    },
                },
                {
                    name: "ignored",
                    type: "query",
                    current: {
                        text: "x",
                        value: "x",
                    },
                },
            ],
        },
    };
    const overrideFile = (0, overrides_1.generateOverrideFileFromDashboard)(dashboard);
    strict_1.default.deepEqual(overrideFile, {
        variableOverrides: {
            freeText: "abc",
            site: "nsk",
        },
        datasourceBindings: {},
    });
});
(0, node_test_1.test)("generateOverrideFileFromDashboard prefers constant query over stale current value", () => {
    const dashboard = {
        title: "Demo",
        templating: {
            list: [
                {
                    name: "siteConst",
                    type: "constant",
                    current: {
                        text: "LUZ",
                        value: "LUZ",
                    },
                    query: "LUZ1",
                },
            ],
        },
    };
    const overrideFile = (0, overrides_1.generateOverrideFileFromDashboard)(dashboard);
    strict_1.default.deepEqual(overrideFile, {
        variableOverrides: {
            siteConst: "LUZ1",
        },
        datasourceBindings: {},
    });
});
(0, node_test_1.test)("applyOverridesToDashboard rewrites current values for supported variables", () => {
    const dashboard = {
        title: "Demo",
        templating: {
            list: [
                {
                    name: "site",
                    type: "custom",
                    current: {
                        text: "default",
                        value: "default",
                    },
                    options: [
                        { text: "default", value: "default", selected: true },
                        { text: "nsk", value: "nsk", selected: false },
                    ],
                },
                {
                    name: "freeText",
                    type: "textbox",
                    current: {
                        text: "old",
                        value: "old",
                    },
                },
                {
                    name: "siteConst",
                    type: "constant",
                    current: {
                        text: "LUZ",
                        value: "LUZ",
                    },
                    query: "LUZ",
                },
                {
                    name: "ignored",
                    type: "query",
                    current: {
                        text: "a",
                        value: "a",
                    },
                },
            ],
        },
    };
    const rendered = (0, overrides_1.applyOverridesToDashboard)(dashboard, {
        variableOverrides: {
            site: "nsk",
            freeText: "new text",
            siteConst: "RND",
        },
        datasourceBindings: {},
    });
    const list = (rendered.templating.list);
    const site = list.find((item) => item.name === "site");
    const freeText = list.find((item) => item.name === "freeText");
    const siteConst = list.find((item) => item.name === "siteConst");
    const ignored = list.find((item) => item.name === "ignored");
    strict_1.default.deepEqual(site.current, { text: "nsk", value: "nsk" });
    strict_1.default.equal(site.query, undefined);
    strict_1.default.deepEqual(site.options, [
        { text: "default", value: "default", selected: false },
        { text: "nsk", value: "nsk", selected: true },
    ]);
    strict_1.default.deepEqual(freeText.current, { text: "new text", value: "new text" });
    strict_1.default.deepEqual(siteConst.current, { text: "RND", value: "RND" });
    strict_1.default.equal(siteConst.query, "RND");
    strict_1.default.deepEqual(ignored.current, { text: "a", value: "a" });
});
(0, node_test_1.test)("applyOverridesToDashboard rejects custom override values that are not in the variable options", () => {
    const dashboard = {
        title: "Demo",
        templating: {
            list: [
                {
                    name: "site",
                    type: "custom",
                    current: {
                        text: "RND",
                        value: "RND",
                    },
                    options: [
                        { text: "RND", value: "RND", selected: true },
                        { text: "DEV", value: "DEV", selected: false },
                    ],
                },
            ],
        },
    };
    strict_1.default.throws(() => (0, overrides_1.applyOverridesToDashboard)(dashboard, {
        variableOverrides: {
            site: "LUZ",
        },
        datasourceBindings: {},
    }), /is not available in custom variable "site"/);
});
//# sourceMappingURL=manifest-overrides.test.js.map