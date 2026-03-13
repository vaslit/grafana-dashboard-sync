import { test } from "node:test";
import assert from "node:assert/strict";

import { selectorNameForEntry, validateManifest } from "../core/manifest";
import { applyOverridesToDashboard, generateOverrideFileFromDashboard } from "../core/overrides";
import { DashboardManifest } from "../core/types";

test("selectorNameForEntry falls back to file name", () => {
  const selector = selectorNameForEntry({
    uid: "uid-1",
    path: "integration/status.json",
  });

  assert.equal(selector, "status");
});

test("validateManifest rejects duplicate selectors and paths", () => {
  const manifest: DashboardManifest = {
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

  const errors = validateManifest(manifest);
  assert.ok(errors.some((error) => error.includes("Duplicate dashboard selector")));
  assert.ok(errors.some((error) => error.includes("Duplicate dashboard path")));
});

test("generateOverrideFileFromDashboard extracts supported variable types", () => {
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
  } as Record<string, unknown>;

  const overrideFile = generateOverrideFileFromDashboard(dashboard);
  assert.deepEqual(overrideFile, {
    variables: {
      freeText: "abc",
      site: "nsk",
    },
  });
});

test("applyOverridesToDashboard rewrites current values for supported variables", () => {
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
  } as Record<string, unknown>;

  const rendered = applyOverridesToDashboard(
    dashboard,
    {
      variables: {
        site: "nsk",
      },
    },
    {
      variables: {
        freeText: "new text",
        siteConst: "RND",
      },
    },
  );

  const list = ((rendered.templating as { list: Array<Record<string, unknown>> }).list);
  const site = list.find((item) => item.name === "site") as Record<string, unknown>;
  const freeText = list.find((item) => item.name === "freeText") as Record<string, unknown>;
  const siteConst = list.find((item) => item.name === "siteConst") as Record<string, unknown>;
  const ignored = list.find((item) => item.name === "ignored") as Record<string, unknown>;

  assert.deepEqual(site.current, { text: "nsk", value: "nsk" });
  assert.equal(site.query, undefined);
  assert.deepEqual(site.options, [
    { text: "default", value: "default", selected: false },
    { text: "nsk", value: "nsk", selected: true },
  ]);
  assert.deepEqual(freeText.current, { text: "new text", value: "new text" });
  assert.deepEqual(siteConst.current, { text: "RND", value: "RND" });
  assert.equal(siteConst.query, "RND");
  assert.deepEqual(ignored.current, { text: "a", value: "a" });
});

test("applyOverridesToDashboard rejects custom override values that are not in the variable options", () => {
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
  } as Record<string, unknown>;

  assert.throws(
    () =>
      applyOverridesToDashboard(dashboard, undefined, {
        variables: {
          site: "LUZ",
        },
      }),
    /is not available in custom variable "site"/,
  );
});
