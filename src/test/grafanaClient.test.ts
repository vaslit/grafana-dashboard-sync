import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { GrafanaClient } from "../core/grafanaClient";
import { EffectiveConnectionConfig } from "../core/types";

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to get test server address.");
  }
  return `http://127.0.0.1:${address.port}`;
}

test("GrafanaClient retries with fallback base URL when primary host is unavailable", async () => {
  const server = http.createServer((request, response) => {
    if (request.url === "/api/datasources") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("[]");
      return;
    }

    response.writeHead(404, { "Content-Type": "application/json" });
    response.end("{\"message\":\"not found\"}");
  });

  try {
    const fallbackBaseUrl = await listen(server);
    const connection: EffectiveConnectionConfig = {
      baseUrl: "http://127.0.0.1:1",
      baseUrls: ["http://127.0.0.1:1", fallbackBaseUrl],
      authKind: "bearer",
      token: "secret-token",
      sourceLabel: "test",
    };

    const client = new GrafanaClient(connection);
    const datasources = await client.listDatasources();

    assert.deepEqual(datasources, []);
    assert.equal(connection.baseUrl, fallbackBaseUrl);
    assert.deepEqual(connection.baseUrls, [fallbackBaseUrl, "http://127.0.0.1:1"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
