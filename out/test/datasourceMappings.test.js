"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const datasourceMappings_1 = require("../core/datasourceMappings");
(0, node_test_1.test)("applyDatasourceMappingsToDashboard rewrites canonical sourceName refs to target datasource uid and name", () => {
    const dashboard = {
        uid: "dashboard-uid",
        panels: [
            {
                datasource: {
                    type: "prometheus",
                    uid: "integration",
                },
                targets: [
                    {
                        datasource: {
                            type: "prometheus",
                            uid: "integration",
                        },
                    },
                ],
            },
        ],
        templating: {
            list: [
                {
                    type: "datasource",
                    name: "ds",
                    current: {
                        text: "integration",
                        value: "integration",
                    },
                    options: [
                        {
                            text: "integration",
                            value: "integration",
                            selected: true,
                        },
                    ],
                },
                {
                    type: "query",
                    name: "region",
                    datasource: {
                        type: "prometheus",
                        uid: "integration",
                    },
                },
            ],
        },
    };
    const rendered = (0, datasourceMappings_1.applyDatasourceMappingsToDashboard)(dashboard, {
        datasources: {
            integration: {
                instances: {
                    prod: {
                        uid: "target-prom",
                        name: "Prometheus Prod",
                    },
                },
            },
        },
    }, "prod");
    strict_1.default.equal((rendered.panels[0].datasource?.uid), "target-prom");
    strict_1.default.equal(rendered.panels[0].targets[0].datasource.uid, "target-prom");
    const datasourceVariable = (rendered.templating.list)[0];
    strict_1.default.deepEqual(datasourceVariable.current, {
        text: "Prometheus Prod",
        value: "target-prom",
    });
    strict_1.default.deepEqual(datasourceVariable.options[0], {
        text: "Prometheus Prod",
        value: "target-prom",
        selected: true,
    });
    const queryVariable = (rendered.templating.list)[1];
    strict_1.default.equal(queryVariable.datasource.uid, "target-prom");
});
(0, node_test_1.test)("mergePulledDatasourceCatalog preserves matched sourceName, adds conflicting datasource, and normalizes dashboard refs", () => {
    const merged = (0, datasourceMappings_1.mergePulledDatasourceCatalog)({
        datasources: {
            integration: {
                instances: {
                    prod: {
                        uid: "source-uid",
                        name: "integration",
                    },
                    stage: {
                        uid: "stage-source-uid",
                        name: "integration",
                    },
                },
            },
        },
    }, "prod", [
        {
            key: "integration",
            label: "integration",
            sourceUid: "source-uid",
            sourceName: "integration",
            type: "prometheus",
            usageCount: 1,
            usageKinds: ["panel"],
        },
        {
            key: "integration",
            label: "integration",
            sourceUid: "another-uid",
            sourceName: "integration",
            type: "prometheus",
            usageCount: 1,
            usageKinds: ["query"],
        },
    ], ["prod", "stage"], new Map([
        ["prod", [{ uid: "source-uid", name: "integration", type: "prometheus" }]],
        ["stage", [{ uid: "stage-source-uid", name: "integration", type: "prometheus" }]],
    ]));
    strict_1.default.deepEqual(merged.catalog, {
        datasources: {
            integration: {
                instances: {
                    prod: {
                        uid: "source-uid",
                        name: "integration",
                    },
                    stage: {
                        uid: "stage-source-uid",
                        name: "integration",
                    },
                },
            },
            "integration__another-uid": {
                instances: {
                    prod: {
                        uid: "another-uid",
                        name: "integration",
                    },
                    stage: {
                        uid: "stage-source-uid",
                        name: "integration",
                    },
                },
            },
        },
    });
    strict_1.default.deepEqual(Object.fromEntries(merged.sourceNamesByUid), {
        "source-uid": "integration",
        "another-uid": "integration__another-uid",
    });
    const normalized = (0, datasourceMappings_1.normalizeDashboardDatasourceRefs)({
        panels: [
            {
                datasource: {
                    type: "prometheus",
                    uid: "source-uid",
                },
                targets: [
                    {
                        datasource: {
                            type: "prometheus",
                            uid: "another-uid",
                        },
                    },
                ],
            },
        ],
        templating: {
            list: [
                {
                    type: "datasource",
                    current: {
                        text: "integration",
                        value: "source-uid",
                    },
                    options: [
                        {
                            text: "integration",
                            value: "another-uid",
                        },
                    ],
                },
            ],
        },
    }, merged.sourceNamesByUid);
    strict_1.default.equal((normalized.panels[0].datasource.uid), "integration");
    strict_1.default.equal((normalized.panels[0].targets[0].datasource.uid), "integration__another-uid");
    strict_1.default.deepEqual((normalized.templating.list)[0].current, {
        text: "integration",
        value: "integration",
    });
});
(0, node_test_1.test)("renameDatasourceSourceNames rewrites canonical dashboard refs", () => {
    const renamed = (0, datasourceMappings_1.renameDatasourceSourceNames)({
        datasource: {
            type: "prometheus",
            uid: "integration",
        },
        templating: {
            list: [
                {
                    type: "datasource",
                    current: {
                        text: "integration",
                        value: "integration",
                    },
                },
            ],
        },
    }, {
        integration: "mongo_main",
    });
    strict_1.default.equal((renamed.datasource.uid), "mongo_main");
    strict_1.default.deepEqual((renamed.templating.list)[0].current, {
        text: "mongo_main",
        value: "mongo_main",
    });
});
//# sourceMappingURL=datasourceMappings.test.js.map