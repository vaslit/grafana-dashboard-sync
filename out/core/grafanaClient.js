"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GrafanaClient = void 0;
const node_http_1 = __importDefault(require("node:http"));
const node_https_1 = __importDefault(require("node:https"));
const node_url_1 = require("node:url");
class GrafanaClient {
    connection;
    constructor(connection) {
        this.connection = connection;
    }
    async getDashboardByUid(uid) {
        return this.requestJson("GET", `/api/dashboards/uid/${encodeURIComponent(uid)}`);
    }
    async listDashboards() {
        const dashboards = [];
        let page = 1;
        while (true) {
            const batch = await this.requestJson("GET", `/api/search?type=dash-db&limit=5000&page=${page}`);
            dashboards.push(...batch
                .filter((item) => item.type === "dash-db" && typeof item.uid === "string" && typeof item.title === "string")
                .map((item) => ({
                uid: item.uid,
                title: item.title,
                folderUid: item.folderUid,
                folderTitle: item.folderTitle,
                url: item.url,
            })));
            if (batch.length < 5000) {
                break;
            }
            page += 1;
        }
        return dashboards;
    }
    async listFolders(parentUid) {
        const folders = [];
        let page = 1;
        while (true) {
            const query = new URLSearchParams({
                limit: "1000",
                page: String(page),
            });
            if (parentUid) {
                query.set("parentUid", parentUid);
            }
            const batch = await this.requestJson("GET", `/api/folders?${query.toString()}`);
            folders.push(...batch.map((folder) => ({
                uid: folder.uid,
                title: folder.title,
                parentUid: folder.parentUid,
            })));
            if (batch.length < 1000) {
                break;
            }
            page += 1;
        }
        return folders;
    }
    async listDatasources() {
        const datasources = await this.requestJson("GET", "/api/datasources");
        return datasources
            .filter((item) => typeof item.uid === "string" && typeof item.name === "string")
            .map((item) => ({
            uid: item.uid,
            name: item.name,
            type: item.type,
            isDefault: item.isDefault,
        }));
    }
    async createFolder(input) {
        return this.requestJson("POST", "/api/folders", input);
    }
    async upsertDashboard(input) {
        return this.requestJson("POST", "/api/dashboards/db", {
            dashboard: input.dashboard,
            folderUid: input.folderUid,
            overwrite: true,
            message: input.message,
        });
    }
    async requestJson(method, requestPath, body) {
        const url = new node_url_1.URL(requestPath, `${this.connection.baseUrl}/`);
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const client = url.protocol === "https:" ? node_https_1.default : node_http_1.default;
        const headers = {
            Accept: "application/json",
            Authorization: `Bearer ${this.connection.token}`,
        };
        if (payload !== undefined) {
            headers["Content-Type"] = "application/json";
            headers["Content-Length"] = Buffer.byteLength(payload);
        }
        return new Promise((resolve, reject) => {
            const request = client.request(url, {
                method,
                headers,
            }, (response) => {
                const chunks = [];
                response.on("data", (chunk) => {
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                });
                response.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    const statusCode = response.statusCode ?? 0;
                    if (statusCode < 200 || statusCode >= 300) {
                        reject(new Error(`Grafana API ${method} ${url.pathname} failed with ${statusCode}: ${text || response.statusMessage}`));
                        return;
                    }
                    if (!text) {
                        resolve({});
                        return;
                    }
                    try {
                        resolve(JSON.parse(text));
                    }
                    catch (error) {
                        reject(new Error(`Failed to parse Grafana response from ${url.pathname}: ${String(error)}`));
                    }
                });
            });
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
exports.GrafanaClient = GrafanaClient;
//# sourceMappingURL=grafanaClient.js.map