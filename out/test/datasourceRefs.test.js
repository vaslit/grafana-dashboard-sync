"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const datasourceRefs_1 = require("../core/datasourceRefs");
(0, node_test_1.test)("extractDashboardDatasourceRefs filters builtin grafana refs and deduplicates usage kinds", () => {
    const refs = (0, datasourceRefs_1.extractDashboardDatasourceRefs)({
        annotations: {
            list: [
                {
                    datasource: {
                        type: "grafana",
                        uid: "-- Grafana --",
                    },
                },
            ],
        },
        panels: [
            {
                datasource: {
                    type: "prometheus",
                    uid: "shared-uid",
                },
                targets: [
                    {
                        refId: "A",
                        datasource: {
                            type: "prometheus",
                            uid: "shared-uid",
                        },
                    },
                ],
            },
        ],
    });
    strict_1.default.deepEqual(refs, [
        {
            sourceUid: "shared-uid",
            type: "prometheus",
            usageCount: 2,
            usageKinds: ["panel", "query"],
        },
    ]);
});
//# sourceMappingURL=datasourceRefs.test.js.map