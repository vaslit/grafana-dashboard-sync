import { test } from "node:test";
import assert from "node:assert/strict";

import { extractDashboardDatasourceRefs } from "../core/datasourceRefs";

test("extractDashboardDatasourceRefs filters builtin grafana refs and deduplicates usage kinds", () => {
  const refs = extractDashboardDatasourceRefs({
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
  } as Record<string, unknown>);

  assert.deepEqual(refs, [
    {
      sourceUid: "shared-uid",
      type: "prometheus",
      usageCount: 2,
      usageKinds: ["panel", "query"],
    },
  ]);
});
