"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const dashboardCatalog_1 = require("../core/dashboardCatalog");
(0, node_test_1.test)("buildManifestEntriesFromRemoteDashboards creates stable selector and path defaults", () => {
    const entries = (0, dashboardCatalog_1.buildManifestEntriesFromRemoteDashboards)([
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
    ], []);
    strict_1.default.deepEqual(entries, [
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
//# sourceMappingURL=dashboardCatalog.test.js.map