import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyDatasourceMappingsToDashboard,
  mergePulledDatasourceCatalog,
  normalizeDashboardDatasourceRefs,
  renameDatasourceSourceNames,
} from "../core/datasourceMappings";

test("applyDatasourceMappingsToDashboard rewrites canonical sourceName refs to target datasource uid and name", () => {
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
  } as Record<string, unknown>;

  const rendered = applyDatasourceMappingsToDashboard(
    dashboard,
    {
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
    },
    "prod",
  );

  assert.equal(
    (((rendered.panels as Array<Record<string, unknown>>)[0].datasource as { uid?: string } | undefined)?.uid),
    "target-prom",
  );
  assert.equal(
    (((rendered.panels as Array<Record<string, unknown>>)[0].targets as Array<Record<string, unknown>>)[0].datasource as {
      uid?: string;
    }).uid,
    "target-prom",
  );

  const datasourceVariable = ((rendered.templating as { list: Array<Record<string, unknown>> }).list)[0];
  assert.deepEqual(datasourceVariable.current, {
    text: "Prometheus Prod",
    value: "target-prom",
  });
  assert.deepEqual((datasourceVariable.options as Array<Record<string, unknown>>)[0], {
    text: "Prometheus Prod",
    value: "target-prom",
    selected: true,
  });

  const queryVariable = ((rendered.templating as { list: Array<Record<string, unknown>> }).list)[1];
  assert.equal((queryVariable.datasource as { uid?: string }).uid, "target-prom");
});

test("mergePulledDatasourceCatalog preserves matched sourceName, adds conflicting datasource, and normalizes dashboard refs", () => {
  const merged = mergePulledDatasourceCatalog(
    {
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
    },
    "prod",
    [
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
    ],
    ["prod", "stage"],
    new Map([
      ["prod", [{ uid: "source-uid", name: "integration", type: "prometheus" }]],
      ["stage", [{ uid: "stage-source-uid", name: "integration", type: "prometheus" }]],
    ]),
  );

  assert.deepEqual(merged.catalog, {
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
  assert.deepEqual(Object.fromEntries(merged.sourceNamesByUid), {
    "source-uid": "integration",
    "another-uid": "integration__another-uid",
  });

  const normalized = normalizeDashboardDatasourceRefs(
    {
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
    },
    merged.sourceNamesByUid,
  );

  assert.equal((((normalized.panels as Array<Record<string, unknown>>)[0].datasource as { uid?: string }).uid), "integration");
  assert.equal(
    ((((normalized.panels as Array<Record<string, unknown>>)[0].targets as Array<Record<string, unknown>>)[0].datasource as {
      uid?: string;
    }).uid),
    "integration__another-uid",
  );
  assert.deepEqual(((normalized.templating as { list: Array<Record<string, unknown>> }).list)[0].current, {
    text: "integration",
    value: "integration",
  });
});

test("renameDatasourceSourceNames rewrites canonical dashboard refs", () => {
  const renamed = renameDatasourceSourceNames(
    {
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
    },
    {
      integration: "mongo_main",
    },
  );

  assert.equal(((renamed.datasource as { uid?: string }).uid), "mongo_main");
  assert.deepEqual(((renamed.templating as { list: Array<Record<string, unknown>> }).list)[0].current, {
    text: "mongo_main",
    value: "mongo_main",
  });
});
