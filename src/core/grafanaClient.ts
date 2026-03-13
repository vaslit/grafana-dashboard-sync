import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

import {
  EffectiveConnectionConfig,
  GrafanaApi,
  GrafanaDashboardResponse,
  GrafanaDashboardSummary,
  GrafanaDatasourceSummary,
  GrafanaFolder,
  GrafanaUpsertResponse,
} from "./types";

export class GrafanaClient implements GrafanaApi {
  constructor(private readonly connection: EffectiveConnectionConfig) {}

  async getDashboardByUid(uid: string): Promise<GrafanaDashboardResponse> {
    return this.requestJson<GrafanaDashboardResponse>("GET", `/api/dashboards/uid/${encodeURIComponent(uid)}`);
  }

  async listDashboards(): Promise<GrafanaDashboardSummary[]> {
    const dashboards: GrafanaDashboardSummary[] = [];
    let page = 1;

    while (true) {
      const batch = await this.requestJson<
        Array<{
          uid?: string;
          title?: string;
          folderUid?: string;
          folderTitle?: string;
          url?: string;
          type?: string;
        }>
      >("GET", `/api/search?type=dash-db&limit=5000&page=${page}`);

      dashboards.push(
        ...batch
          .filter((item) => item.type === "dash-db" && typeof item.uid === "string" && typeof item.title === "string")
          .map((item) => ({
            uid: item.uid!,
            title: item.title!,
            folderUid: item.folderUid,
            folderTitle: item.folderTitle,
            url: item.url,
          })),
      );

      if (batch.length < 5000) {
        break;
      }
      page += 1;
    }

    return dashboards;
  }

  async listFolders(parentUid?: string): Promise<GrafanaFolder[]> {
    const folders: GrafanaFolder[] = [];
    let page = 1;

    while (true) {
      const query = new URLSearchParams({
        limit: "1000",
        page: String(page),
      });
      if (parentUid) {
        query.set("parentUid", parentUid);
      }

      const batch = await this.requestJson<Array<{ uid: string; title: string; parentUid?: string }>>(
        "GET",
        `/api/folders?${query.toString()}`,
      );
      folders.push(
        ...batch.map((folder) => ({
          uid: folder.uid,
          title: folder.title,
          parentUid: folder.parentUid,
        })),
      );
      if (batch.length < 1000) {
        break;
      }
      page += 1;
    }

    return folders;
  }

  async listDatasources(): Promise<GrafanaDatasourceSummary[]> {
    const datasources = await this.requestJson<
      Array<{
        uid?: string;
        name?: string;
        type?: string;
        isDefault?: boolean;
      }>
    >("GET", "/api/datasources");

    return datasources
      .filter((item) => typeof item.uid === "string" && typeof item.name === "string")
      .map((item) => ({
        uid: item.uid!,
        name: item.name!,
        type: item.type,
        isDefault: item.isDefault,
      }));
  }

  async createFolder(input: { title: string; uid?: string; parentUid?: string }): Promise<GrafanaFolder> {
    return this.requestJson<GrafanaFolder>("POST", "/api/folders", input);
  }

  async upsertDashboard(input: {
    dashboard: Record<string, unknown>;
    folderUid?: string;
    message: string;
  }): Promise<GrafanaUpsertResponse> {
    return this.requestJson<GrafanaUpsertResponse>("POST", "/api/dashboards/db", {
      dashboard: input.dashboard,
      folderUid: input.folderUid,
      overwrite: true,
      message: input.message,
    });
  }

  private async requestJson<T>(method: "GET" | "POST", requestPath: string, body?: unknown): Promise<T> {
    const url = new URL(requestPath, `${this.connection.baseUrl}/`);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const client = url.protocol === "https:" ? https : http;

    const headers: Record<string, string | number> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.connection.token}`,
    };

    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }

    return new Promise<T>((resolve, reject) => {
      const request = client.request(
        url,
        {
          method,
          headers,
        },
        (response) => {
          const chunks: Buffer[] = [];

          response.on("data", (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });

          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const statusCode = response.statusCode ?? 0;

            if (statusCode < 200 || statusCode >= 300) {
              reject(
                new Error(
                  `Grafana API ${method} ${url.pathname} failed with ${statusCode}: ${text || response.statusMessage}`,
                ),
              );
              return;
            }

            if (!text) {
              resolve({} as T);
              return;
            }

            try {
              resolve(JSON.parse(text) as T);
            } catch (error) {
              reject(new Error(`Failed to parse Grafana response from ${url.pathname}: ${String(error)}`));
            }
          });
        },
      );

      request.on("error", (error) => {
        reject(error);
      });

      if (payload !== undefined) {
        request.write(payload);
      }

      request.end();
    });
  }
}
