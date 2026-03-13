import { test } from "node:test";
import assert from "node:assert/strict";

import { buildManifestEntriesFromRemoteDashboards } from "../core/dashboardCatalog";

test("buildManifestEntriesFromRemoteDashboards creates stable selector and path defaults", () => {
  const entries = buildManifestEntriesFromRemoteDashboards(
    [
      {
        uid: "uid-1",
        title: "Sync Status",
        folderUid: "folder-1",
        folderTitle: "Integration",
      },
      {
        uid: "uid-2",
        title: "Sync Status",
      },
    ],
    [],
  );

  assert.deepEqual(entries, [
    {
      name: "sync_status",
      uid: "uid-1",
      path: "integration__folder-1/sync_status__uid-1.json",
    },
    {
      name: "sync_status_2",
      uid: "uid-2",
      path: "_root/sync_status__uid-2.json",
    },
  ]);
});
