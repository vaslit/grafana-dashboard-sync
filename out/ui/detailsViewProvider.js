"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DetailsViewProvider = void 0;
const vscode = __importStar(require("vscode"));
const datasourceRefs_1 = require("../core/datasourceRefs");
const projectLocator_1 = require("../core/projectLocator");
function escapeHtml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}
function nonce() {
    return Math.random().toString(36).slice(2);
}
function optionLabel(option) {
    return option.isDefault ? `${option.name} (${option.uid}) [default]` : `${option.name} (${option.uid})`;
}
function usageLabel(row) {
    const labels = (row.usageKinds ?? []).map((usageKind) => {
        switch (usageKind) {
            case "panel":
                return "panel";
            case "query":
                return "query";
            case "variable":
                return "variable";
        }
    });
    return labels.length > 0 ? labels.join(" + ") : String(row.usageCount ?? 0);
}
function revisionLabel(revision) {
    const timestamp = revision.record.createdAt.replace("T", " ").replace(/\.\d+Z$/, "Z");
    return revision.isCheckedOut
        ? `${revision.record.id} [current]`
        : `${revision.record.id} (${timestamp}, ${revision.record.source.kind})`;
}
function liveStatusLabel(status) {
    switch (status.state) {
        case "matched":
            return status.matchedRevisionId ?? "matched";
        case "unversioned":
            return "unversioned";
        case "error":
            return "error";
    }
}
class DetailsViewProvider {
    getRepository;
    getService;
    selectionState;
    actions;
    getMissingProjectMessage;
    view;
    constructor(getRepository, getService, selectionState, actions, getMissingProjectMessage) {
        this.getRepository = getRepository;
        this.getService = getService;
        this.selectionState = selectionState;
        this.actions = actions;
        this.getMissingProjectMessage = getMissingProjectMessage;
    }
    async resolveWebviewView(webviewView) {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
        };
        webviewView.webview.html = this.renderLoadingState();
        webviewView.webview.onDidReceiveMessage(async (message) => {
            try {
                await this.handleMessage(message);
            }
            catch (error) {
                void vscode.window.showErrorMessage(String(error));
            }
        });
        void this.refresh();
    }
    async refresh() {
        if (!this.view) {
            return;
        }
        try {
            this.view.webview.html = await this.render();
        }
        catch (error) {
            this.view.webview.html = `<html><body><pre>${escapeHtml(String(error))}</pre></body></html>`;
        }
    }
    async render() {
        const repository = this.getRepository();
        if (!repository) {
            return this.renderMissingProject();
        }
        const service = this.getService();
        if (!service) {
            return this.renderMissingProject();
        }
        const detailsMode = this.selectionState.selectedDetailsMode ??
            (this.selectionState.selectedDashboardSelectorName ? "dashboard" : this.selectionState.selectedInstanceName ? "instance" : undefined);
        const manifestExists = await repository.manifestExists();
        const dashboardInstanceName = detailsMode === "dashboard" ? this.selectionState.activeInstanceName : this.selectionState.selectedInstanceName;
        const dashboardTargetName = detailsMode === "dashboard" ? this.selectionState.activeTargetName : this.selectionState.selectedTargetName;
        const dashboard = detailsMode === "dashboard" && this.selectionState.selectedDashboardSelectorName
            ? await repository.loadDashboardDetails(this.selectionState.selectedDashboardSelectorName)
            : undefined;
        const instance = dashboardInstanceName
            ? await repository.loadInstanceDetails(dashboardInstanceName)
            : undefined;
        const target = detailsMode === "dashboard" && instance && dashboardTargetName
            ? await repository.loadDeploymentTargetDetails(instance.instance.name, dashboardTargetName)
            : undefined;
        let datasourceOptions = [];
        let datasourceLoadError;
        if (instance) {
            try {
                datasourceOptions = await service.listRemoteDatasources(instance.instance.name);
            }
            catch (error) {
                datasourceLoadError = String(error);
            }
        }
        const instanceDatasourceRows = detailsMode === "instance" && instance
            ? await this.buildInstanceDatasourceRows(instance.instance.name)
            : [];
        const datasourceRows = dashboard && instance
            ? await this.buildDatasourceRows(instance.instance.name, dashboard.entry, datasourceOptions)
            : [];
        const overrideVariables = dashboard && instance && target
            ? await service.buildOverrideEditorVariables(instance.instance.name, target.target.name, dashboard.entry).catch(() => [])
            : [];
        const revisions = dashboard
            ? await service.listDashboardRevisions(dashboard.entry).catch(() => [])
            : [];
        const liveTargetVersions = dashboard
            ? await service.listLiveTargetVersionStatuses(dashboard.entry).catch(() => [])
            : [];
        const placement = dashboard && instance && target
            ? await service.buildPlacementDetails(instance.instance.name, target.target.name, dashboard.entry).catch(() => undefined)
            : undefined;
        const scriptNonce = nonce();
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}';"
  />
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      padding: 12px;
    }
    section {
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 12px;
    }
    h2 {
      margin: 0 0 8px;
      font-size: 13px;
    }
    .hint {
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
    }
    label {
      display: block;
      margin-bottom: 8px;
      font-size: 12px;
    }
    input, textarea, select {
      width: 100%;
      box-sizing: border-box;
      margin-top: 4px;
      padding: 6px 8px;
      border: 1px solid var(--vscode-input-border, transparent);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
    }
    input[type="checkbox"] {
      width: auto;
      margin-top: 0;
      padding: 0;
    }
    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 8px;
    }
    button {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      padding: 6px 10px;
      cursor: pointer;
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 8px;
    }
    .small {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    details.details-section > summary {
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      user-select: none;
    }
    details.details-section > .section-body {
      margin-top: 8px;
    }
  </style>
</head>
<body>
  ${this.renderManifestSection(manifestExists)}
  ${detailsMode === "dashboard" ? this.renderDashboardSection(dashboard) : ""}
  ${detailsMode === "dashboard" ? this.renderRevisionSection(dashboard, revisions, instance, target) : ""}
  ${detailsMode === "dashboard" ? this.renderLiveTargetVersionsSection(dashboard, liveTargetVersions) : ""}
  ${detailsMode === "instance" ? this.renderInstanceSection(instance, target) : ""}
  ${this.renderDatasourceSection(dashboard, instance, target, datasourceRows, datasourceOptions, datasourceLoadError, detailsMode, instanceDatasourceRows)}
  ${detailsMode === "dashboard" ? this.renderPlacementSection(dashboard, instance, target, placement) : ""}
  ${detailsMode === "dashboard" ? this.renderOverrideSection(dashboard, instance, target, overrideVariables) : ""}
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();

    function valuesFromForm(form) {
      const data = new FormData(form);
      return Object.fromEntries(data.entries());
    }

    function initCollapsibleSections() {
      const currentState = vscode.getState() || {};
      const sectionState = currentState.sectionState || {};
      document.querySelectorAll("body > section[data-collapsible-section]").forEach((section) => {
        const sectionId = section.dataset.collapsibleSection;
        const heading = section.querySelector("h2");
        if (!sectionId || !heading) {
          return;
        }

        const details = document.createElement("details");
        details.className = "details-section";
        details.open = sectionState[sectionId] !== undefined ? Boolean(sectionState[sectionId]) : true;

        const summary = document.createElement("summary");
        summary.textContent = heading.textContent || sectionId;
        details.appendChild(summary);

        const body = document.createElement("div");
        body.className = "section-body";

        while (section.firstChild) {
          const node = section.firstChild;
          section.removeChild(node);
          if (node !== heading) {
            body.appendChild(node);
          }
        }

        details.appendChild(body);
        section.appendChild(details);

        details.addEventListener("toggle", () => {
          const nextState = vscode.getState() || {};
          vscode.setState({
            ...nextState,
            sectionState: {
              ...(nextState.sectionState || {}),
              [sectionId]: details.open,
            },
          });
        });
      });
    }

    initCollapsibleSections();

    document.querySelectorAll("[data-command]").forEach((button) => {
      button.addEventListener("click", () => {
        const rawPayload = button.dataset.payload || "";
        let payload = rawPayload;
        if (rawPayload.startsWith("{")) {
          try {
            payload = JSON.parse(rawPayload);
          } catch {
            payload = rawPayload;
          }
        }
        vscode.postMessage({ type: button.dataset.command, payload });
      });
    });

    const dashboardForm = document.getElementById("dashboard-form");
    if (dashboardForm) {
      dashboardForm.addEventListener("submit", (event) => {
        event.preventDefault();
        vscode.postMessage({ type: "saveManifest", payload: valuesFromForm(dashboardForm) });
      });
    }

    const instanceForm = document.getElementById("instance-form");
    if (instanceForm) {
      instanceForm.addEventListener("submit", (event) => {
        event.preventDefault();
        vscode.postMessage({ type: "saveInstanceEnv", payload: valuesFromForm(instanceForm) });
      });
    }

    const dashboardDatasourceForm = document.getElementById("dashboard-datasource-form");
    if (dashboardDatasourceForm) {
      dashboardDatasourceForm.addEventListener("submit", (event) => {
        event.preventDefault();
        vscode.postMessage({ type: "saveDashboardDatasourceMappings", payload: valuesFromForm(dashboardDatasourceForm) });
      });
    }

    const overrideForm = document.getElementById("override-form");
    if (overrideForm) {
      overrideForm.addEventListener("submit", (event) => {
        event.preventDefault();
        vscode.postMessage({ type: "saveOverride", payload: valuesFromForm(overrideForm) });
      });
    }

    const placementForm = document.getElementById("placement-form");
    if (placementForm) {
      placementForm.addEventListener("submit", (event) => {
        event.preventDefault();
        vscode.postMessage({ type: "savePlacement", payload: valuesFromForm(placementForm) });
      });
    }

    const revisionForm = document.getElementById("revision-form");
    if (revisionForm) {
      revisionForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const payload = valuesFromForm(revisionForm);
        const submitter = event.submitter;
        const action = submitter && "dataset" in submitter ? submitter.dataset.revisionAction : undefined;
        if (action === "checkoutRevision") {
          vscode.postMessage({ type: "checkoutRevision", payload });
        } else if (action === "deployRevision") {
          vscode.postMessage({ type: "deployRevision", payload });
        }
      });
    }

    const createInstanceForm = document.getElementById("create-instance-form");
    if (createInstanceForm) {
      createInstanceForm.addEventListener("submit", (event) => {
        event.preventDefault();
        vscode.postMessage({ type: "createInstance", payload: valuesFromForm(createInstanceForm) });
      });
    }

    document.querySelectorAll("select[data-name-target]").forEach((select) => {
      const syncName = () => {
        const selectedOption = select.options[select.selectedIndex];
        const hidden = document.getElementById(select.dataset.nameTarget);
        if (hidden) {
          hidden.value = selectedOption ? (selectedOption.dataset.datasourceName || "") : "";
        }
      };
      select.addEventListener("change", syncName);
      syncName();
    });

    document.querySelectorAll("input[data-override-toggle]").forEach((checkbox) => {
      const syncEnabled = () => {
        const target = document.getElementById(checkbox.dataset.overrideToggle);
        if (target) {
          target.disabled = !checkbox.checked;
        }
      };
      checkbox.addEventListener("change", syncEnabled);
      syncEnabled();
    });

    document.querySelectorAll("input[data-placement-toggle]").forEach((checkbox) => {
      const syncEnabled = () => {
        const target = document.getElementById(checkbox.dataset.placementToggle);
        if (target) {
          target.disabled = !checkbox.checked;
        }
      };
      checkbox.addEventListener("change", syncEnabled);
      syncEnabled();
    });

    document.querySelectorAll("select[data-placement-target]").forEach((select) => {
      select.addEventListener("change", () => {
        const target = document.getElementById(select.dataset.placementTarget);
        if (target && select.value) {
          target.value = select.value;
        }
      });
    });
  </script>
</body>
</html>`;
    }
    renderMissingProject() {
        const scriptNonce = nonce();
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}';"
  />
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      padding: 12px;
    }
    section {
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 6px;
      padding: 12px;
    }
    h2 {
      margin: 0 0 8px;
      font-size: 13px;
    }
    .hint {
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
    }
    button {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      padding: 6px 10px;
      cursor: pointer;
    }
    code {
      font-family: var(--vscode-editor-font-family);
    }
  </style>
</head>
<body>
  <section>
    <h2>Project</h2>
    <div class="hint">${escapeHtml(this.getMissingProjectMessage())}</div>
    <div class="hint">Initialize a project to create <code>${escapeHtml(projectLocator_1.PROJECT_CONFIG_FILE)}</code>, <code>dashboards/</code>, <code>backups/</code>, <code>renders/</code>, and the first instance.</div>
    <button data-command="initializeProject">Initialize Project</button>
  </section>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll("[data-command]").forEach((button) => {
      button.addEventListener("click", () => {
        vscode.postMessage({ type: button.dataset.command });
      });
    });
  </script>
</body>
</html>`;
    }
    renderLoadingState() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      padding: 12px;
    }
    section {
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 6px;
      padding: 12px;
    }
    h2 {
      margin: 0 0 8px;
      font-size: 13px;
    }
    .hint {
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <section>
    <h2>Details</h2>
    <div class="hint">Loading…</div>
  </section>
</body>
</html>`;
    }
    renderManifestSection(manifestExists) {
        if (manifestExists) {
            return "";
        }
        return `<section data-collapsible-section="manifest">
      <h2>Manifest</h2>
      <div class="hint">This workspace config has no managed dashboards yet.</div>
      <div class="actions">
        <button data-command="createManifestFromExample">Import From Example</button>
      </div>
    </section>`;
    }
    renderDashboardSection(dashboard) {
        if (!dashboard) {
            return `<section data-collapsible-section="dashboard">
        <h2>Dashboard</h2>
        <div class="hint">Select a dashboard from the tree or add one from Grafana.</div>
        <div class="actions">
          <button data-command="addDashboard">Add Dashboard</button>
        </div>
      </section>`;
        }
        return `<section data-collapsible-section="dashboard">
      <h2>Dashboard</h2>
      <div class="hint">${dashboard.exists ? "Editing managed dashboard entry." : "Managed dashboard entry exists but local dashboard file is missing."}</div>
      <form id="dashboard-form" class="grid">
        <label>
          Selector name
          <input type="text" name="name" value="${escapeHtml(dashboard.entry.name ?? "")}" />
        </label>
        <label>
          UID
          <input type="text" name="uid" value="${escapeHtml(dashboard.entry.uid)}" required />
        </label>
        <label>
          Path
          <input type="text" name="path" value="${escapeHtml(dashboard.entry.path)}" required />
        </label>
        <div class="small">Current title: ${escapeHtml(dashboard.title ?? "(unknown)")}</div>
        <div class="actions">
          <button type="submit">Save Manifest Entry</button>
          <button type="button" class="secondary" data-command="openDashboardJson">Open JSON</button>
        </div>
      </form>
    </section>`;
    }
    renderRevisionSection(dashboard, revisions, instance, target) {
        if (!dashboard) {
            return "";
        }
        const current = revisions.find((revision) => revision.isCheckedOut);
        const revisionOptions = revisions.length === 0
            ? `<option value="">No revisions yet</option>`
            : revisions
                .map((revision) => {
                const selected = revision.isCheckedOut ? ' selected="selected"' : "";
                return `<option value="${escapeHtml(revision.record.id)}"${selected}>${escapeHtml(revisionLabel(revision))}</option>`;
            })
                .join("");
        const targetHint = instance && target
            ? `${instance.instance.name}/${target.target.name}`
            : "Select a deployment target to deploy a revision.";
        return `<section data-collapsible-section="revisions">
      <h2>Revisions</h2>
      <div class="hint">History for <strong>${escapeHtml(dashboard.selectorName)}</strong>.</div>
      <div class="small">Current checked out revision: ${escapeHtml(current?.record.id ?? "(initializing)")}</div>
      <div class="small">Active target: ${escapeHtml(targetHint)}</div>
      <form id="revision-form" class="grid">
        <label>
          Revision
          <select name="revisionId">
            ${revisionOptions}
          </select>
        </label>
        <div class="actions">
          <button type="submit" data-revision-action="checkoutRevision">Checkout Selected Revision</button>
        </div>
      </form>
    </section>`;
    }
    renderLiveTargetVersionsSection(dashboard, statuses) {
        if (!dashboard) {
            return "";
        }
        if (statuses.length === 0) {
            return `<section data-collapsible-section="live-target-versions">
        <h2>Live Target Versions</h2>
        <div class="hint">No deployment targets available.</div>
      </section>`;
        }
        const rows = statuses
            .map((status) => {
            const payload = escapeHtml(JSON.stringify({
                instanceName: status.instanceName,
                targetName: status.targetName,
            }));
            return `<div class="grid" style="padding: 8px; border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px;">
          <div><strong>${escapeHtml(`${status.instanceName}/${status.targetName}`)}</strong></div>
          <div class="small">Live status: ${escapeHtml(liveStatusLabel(status))}</div>
          <div class="small">Dashboard UID: ${escapeHtml(status.effectiveDashboardUid ?? "(unknown)")}</div>
          ${status.detail ? `<div class="small">Detail: ${escapeHtml(status.detail)}</div>` : ""}
          <div class="actions">
            <button type="button" class="secondary" data-command="useLiveTarget" data-payload="${payload}">Use Target</button>
            <button type="button" class="secondary" data-command="pullLiveTarget" data-payload="${payload}">Pull From Target</button>
          </div>
        </div>`;
        })
            .join("");
        return `<section data-collapsible-section="live-target-versions">
      <h2>Live Target Versions</h2>
      <div class="hint">Current live revision status for each deployment target.</div>
      <div class="grid">
        ${rows}
      </div>
    </section>`;
    }
    renderInstanceSection(instance, target) {
        if (!instance) {
            return `<section data-collapsible-section="instance">
        <h2>Instance</h2>
        <div class="hint">Select an instance or create one.</div>
        <form id="create-instance-form" class="grid">
          <label>
            New instance name
            <input type="text" name="instanceName" value="" />
          </label>
          <div class="actions">
            <button type="submit">Create Instance</button>
          </div>
        </form>
      </section>`;
        }
        const envValues = instance.envValues;
        return `<section data-collapsible-section="instance">
      <h2>Instance</h2>
      <div class="hint">Selected instance: <strong>${escapeHtml(instance.instance.name)}</strong></div>
      <div class="small">Active deployment target: ${escapeHtml(target?.target.name ?? "(none)")}</div>
      <form id="instance-form" class="grid">
        <label>
          GRAFANA_URL
          <input type="text" name="GRAFANA_URL" value="${escapeHtml(envValues.GRAFANA_URL ?? "")}" />
        </label>
        <label>
          GRAFANA_NAMESPACE
          <input type="text" name="GRAFANA_NAMESPACE" value="${escapeHtml(envValues.GRAFANA_NAMESPACE ?? "")}" />
        </label>
        <div class="small">Token: ${escapeHtml(instance.tokenConfigured ? `configured via ${instance.tokenSourceLabel ?? "Secret Storage"}` : "missing")}</div>
        <div class="small">Connection source: ${escapeHtml(instance.mergedConnection?.sourceLabel ?? "No valid connection yet")}</div>
        <div class="actions">
          <button type="submit">Save Instance Config</button>
        </div>
      </form>
    </section>`;
    }
    async buildDatasourceRows(instanceName, entry, datasourceOptions = []) {
        const repository = this.getRepository();
        if (!repository || !entry) {
            return [];
        }
        const descriptors = await repository
            .readDashboardJson(entry)
            .then((dashboard) => (0, datasourceRefs_1.buildDashboardDatasourceDescriptors)(dashboard))
            .catch(() => []);
        const datasourceCatalog = await repository.readDatasourceCatalog();
        const rowMap = new Map();
        const ensureRow = (sourceName, sourceLabel) => {
            const existing = rowMap.get(sourceName);
            if (existing) {
                return existing;
            }
            const row = {
                currentSourceName: sourceName,
                sourceLabel,
            };
            rowMap.set(sourceName, row);
            return row;
        };
        for (const descriptor of descriptors) {
            const row = ensureRow(descriptor.sourceUid, descriptor.label);
            row.sourceType = descriptor.type;
            row.usageCount = descriptor.usageCount;
            row.usageKinds = descriptor.usageKinds;
            const target = datasourceCatalog.datasources[descriptor.sourceUid]?.instances[instanceName];
            row.targetUid = target?.uid;
            row.targetName = target?.name;
        }
        return [...rowMap.values()].sort((left, right) => left.sourceLabel.localeCompare(right.sourceLabel));
    }
    async buildInstanceDatasourceRows(instanceName) {
        const repository = this.getRepository();
        if (!repository) {
            return [];
        }
        const records = await repository.listDashboardRecords();
        const datasourceCatalog = await repository.readDatasourceCatalog();
        const rowMap = new Map();
        for (const record of records) {
            if (!record.exists) {
                continue;
            }
            const dashboard = await repository.readDashboardJson(record.entry).catch(() => undefined);
            if (!dashboard) {
                continue;
            }
            const descriptors = (0, datasourceRefs_1.buildDashboardDatasourceDescriptors)(dashboard);
            for (const descriptor of descriptors) {
                const sourceName = descriptor.sourceUid;
                const target = datasourceCatalog.datasources[sourceName]?.instances[instanceName];
                const existing = rowMap.get(sourceName);
                if (existing) {
                    existing.usageCount += descriptor.usageCount;
                    existing.sourceType ??= descriptor.type;
                    for (const usageKind of descriptor.usageKinds) {
                        if (!existing.usageKinds.includes(usageKind)) {
                            existing.usageKinds.push(usageKind);
                        }
                    }
                    if (!existing.dashboards.includes(record.selectorName)) {
                        existing.dashboards.push(record.selectorName);
                    }
                    existing.targetUid ??= target?.uid;
                    existing.targetName ??= target?.name;
                    continue;
                }
                rowMap.set(sourceName, {
                    sourceName,
                    sourceType: descriptor.type,
                    usageCount: descriptor.usageCount,
                    usageKinds: [...descriptor.usageKinds],
                    dashboards: [record.selectorName],
                    targetUid: target?.uid,
                    targetName: target?.name,
                });
            }
        }
        return [...rowMap.values()]
            .map((row) => ({
            ...row,
            dashboards: [...row.dashboards].sort((left, right) => left.localeCompare(right)),
            usageKinds: [...row.usageKinds].sort(),
        }))
            .sort((left, right) => left.sourceName.localeCompare(right.sourceName));
    }
    renderDatasourceRows(rows, prefix, datasourceOptions) {
        return rows
            .map((row, index) => {
            const targetUid = row.targetUid;
            const targetName = row.targetName;
            const hiddenNameId = `${prefix}-target-name-${index}`;
            const normalizedTargetName = targetName ??
                datasourceOptions.find((option) => option.uid === targetUid)?.name ??
                "";
            const selectOptions = [
                `<option value="">Select datasource</option>`,
                ...datasourceOptions.map((option) => {
                    const selected = option.uid === targetUid ? ' selected="selected"' : "";
                    return `<option value="${escapeHtml(option.uid)}" data-datasource-name="${escapeHtml(option.name)}"${selected}>${escapeHtml(optionLabel(option))}</option>`;
                }),
                ...(targetUid && !datasourceOptions.some((option) => option.uid === targetUid)
                    ? [
                        `<option value="${escapeHtml(targetUid)}" data-datasource-name="${escapeHtml(normalizedTargetName)}" selected="selected">${escapeHtml(normalizedTargetName ? `${normalizedTargetName} (${targetUid})` : targetUid)}</option>`,
                    ]
                    : []),
            ].join("");
            return `<div class="grid" style="padding: 8px; border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px;">
          <label>
            Source Datasource
            <input type="text" name="${prefix}_source_name__${index}" value="${escapeHtml(row.sourceLabel)}" />
          </label>
          <input type="hidden" name="${prefix}_current_source_name__${index}" value="${escapeHtml(row.currentSourceName)}" />
          <div class="small">Type: ${escapeHtml(row.sourceType ?? "-")}, used in: ${escapeHtml(usageLabel(row))}</div>
          <label>
            Target Datasource
            <select name="${prefix}_target_uid__${index}" data-name-target="${hiddenNameId}">
              ${selectOptions}
            </select>
          </label>
          <input type="hidden" id="${hiddenNameId}" name="${prefix}_target_name__${index}" value="${escapeHtml(normalizedTargetName)}" />
        </div>`;
        })
            .join("");
    }
    renderDatasourceSection(dashboard, instance, target, rows, datasourceOptions, datasourceLoadError, detailsMode, instanceRows = []) {
        if (!instance) {
            return "";
        }
        if (detailsMode === "instance") {
            const loadError = datasourceLoadError !== undefined
                ? `<div class="hint">Could not load datasources from Grafana for <strong>${escapeHtml(instance.instance.name)}</strong>: ${escapeHtml(datasourceLoadError)}</div>`
                : "";
            const rowsMarkup = instanceRows.length === 0
                ? `<div class="hint">No tracked dashboard datasources are currently used for this instance.</div>`
                : instanceRows
                    .map((row) => {
                    const mappedTarget = row.targetUid
                        ? `${row.targetName ?? "(unknown)"} (${row.targetUid})`
                        : "(not mapped)";
                    return `<div class="grid" style="padding: 8px; border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px;">
                  <div><strong>${escapeHtml(row.sourceName)}</strong></div>
                  <div class="small">Type: ${escapeHtml(row.sourceType ?? "-")}, used in: ${escapeHtml(row.usageKinds.join(" + "))}</div>
                  <div class="small">Mapped target datasource: ${escapeHtml(mappedTarget)}</div>
                  <div class="small">Dashboards: ${escapeHtml(row.dashboards.join(", "))}</div>
                </div>`;
                })
                    .join("");
            return `<section data-collapsible-section="datasources">
        <h2>Datasources</h2>
        <div class="hint">Datasources used by managed dashboards for <strong>${escapeHtml(instance.instance.name)}</strong>.</div>
        <div class="small">Tracked datasource entries: ${escapeHtml(String(instanceRows.length))}</div>
        ${loadError}
        <div class="grid" style="margin-top: 8px;">
          ${rowsMarkup}
        </div>
      </section>`;
        }
        if (!dashboard || !target) {
            return "";
        }
        const dashboardRows = this.renderDatasourceRows(rows, "dashboard", datasourceOptions);
        const emptyState = rows.length === 0
            ? `<div class="hint">No external datasources found in this dashboard. Builtin Grafana annotations are handled automatically.</div>`
            : "";
        const loadError = datasourceLoadError !== undefined
            ? `<div class="hint">Could not load datasources from Grafana for <strong>${escapeHtml(instance.instance.name)}</strong>: ${escapeHtml(datasourceLoadError)}</div>`
            : "";
        return `<section data-collapsible-section="datasources">
      <h2>Datasources</h2>
      <div class="hint">Configure datasources for <strong>${escapeHtml(instance.instance.name)}/${escapeHtml(target.target.name)}</strong> and dashboard <strong>${escapeHtml(dashboard.selectorName)}</strong>.</div>
      <div class="small">Dashboard: ${escapeHtml(dashboard.selectorName)}</div>
      <div class="small">Available datasources from Grafana: ${escapeHtml(String(datasourceOptions.length))}</div>
      ${loadError}
      <form id="dashboard-datasource-form" class="grid" style="margin-top: 8px;">
        ${emptyState}
        ${dashboardRows}
        <div class="actions">
          <button type="submit">Save Datasources</button>
          <button type="button" class="secondary" data-command="openDatasourceCatalog">Open Catalog</button>
        </div>
      </form>
    </section>`;
    }
    renderPlacementSection(dashboard, instance, target, placement) {
        if (!dashboard || !instance || !target) {
            return "";
        }
        const inputId = "placement-folder-path";
        const checked = placement?.overrideFolderPath ? ' checked="checked"' : "";
        const value = placement?.overrideFolderPath ?? placement?.baseFolderPath ?? "";
        return `<section data-collapsible-section="placement">
      <h2>Placement</h2>
      <div class="hint">Configure server folder placement for <strong>${escapeHtml(instance.instance.name)}/${escapeHtml(target.target.name)}</strong>.</div>
      <div class="small">Base dashboard UID: ${escapeHtml(placement?.baseDashboardUid ?? dashboard.entry.uid)}</div>
      <div class="small">Target dashboard UID: ${escapeHtml(placement?.overrideDashboardUid ?? (target.target.name === "default" ? "(not used for default)" : "(will be generated on deploy/pull)"))}</div>
      <div class="small">Effective dashboard UID: ${escapeHtml(placement?.effectiveDashboardUid ?? (target.target.name === "default" ? dashboard.entry.uid : "(pending generation)"))}</div>
      <div class="small">Base folder path: ${escapeHtml(placement?.baseFolderPath ?? "(root)")}</div>
      <form id="placement-form" class="grid">
        <div style="display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center;">
          <input
            id="${inputId}"
            type="text"
            name="folderPath"
            readonly="readonly"
            value="${escapeHtml(value)}"
          />
          <input
            type="checkbox"
            name="folderPathEnabled"
            data-placement-toggle="${inputId}"
            title="Enable folder path override"
            aria-label="Enable folder path override"${checked}
          />
        </div>
        <div class="actions">
          <button type="button" class="secondary" data-command="pickPlacementFolder">Choose Folder...</button>
          <button type="submit">Save Placement</button>
        </div>
      </form>
    </section>`;
    }
    renderOverrideSection(dashboard, instance, target, variables) {
        if (!dashboard || !instance || !target) {
            return "";
        }
        if (variables.length === 0) {
            return `<section data-collapsible-section="overrides">
        <h2>Overrides</h2>
        <div class="hint">No supported dashboard variables found. Supported types: custom, textbox, constant.</div>
        <div class="actions">
          <button data-command="generateOverride">Generate Override From Dashboard</button>
        </div>
      </section>`;
        }
        const variableMarkup = variables
            .map((variable, index) => {
            const inputId = `override-value-${index}`;
            const checked = variable.hasSavedOverride ? ' checked="checked"' : "";
            const value = variable.hasSavedOverride ? variable.savedOverride : variable.currentValue;
            const editor = variable.type === "custom" && (variable.overrideOptions?.length ?? 0) > 0
                ? `<select
              id="${inputId}"
              name="override_value__${escapeHtml(variable.name)}"
            >
              ${variable.overrideOptions
                    .map((option) => {
                    const selected = option.value === value ? ' selected="selected"' : "";
                    return `<option value="${escapeHtml(option.value)}"${selected}>${escapeHtml(option.label)}</option>`;
                })
                    .join("")}
            </select>`
                : `<input
              id="${inputId}"
              type="text"
              name="override_value__${escapeHtml(variable.name)}"
              value="${escapeHtml(value)}"
            />`;
            return `<div class="grid" style="padding: 8px; border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px;">
          <div>${escapeHtml(variable.name)} <span class="small">(${escapeHtml(variable.type)})</span></div>
          <div style="display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center;">
            ${editor}
            <input
              type="checkbox"
              name="override_enabled__${escapeHtml(variable.name)}"
              data-override-toggle="${inputId}"
              title="Enable override for ${escapeHtml(variable.name)}"
              aria-label="Enable override for ${escapeHtml(variable.name)}"${checked}
            />
          </div>
          <div class="small">Current dashboard value: ${escapeHtml(variable.currentValue)}</div>
        </div>`;
        })
            .join("");
        return `<section data-collapsible-section="overrides">
      <h2>Overrides</h2>
      <div class="hint">
        File: <code>${escapeHtml(`${dashboard.entry.path.replace(/\\/g, "/").replace(/\/[^/]+$/, "")}/.overrides.json`)}</code>
      </div>
      <form id="override-form" class="grid">
        ${variableMarkup}
        <div class="actions">
          <button type="submit">Save Override File</button>
          <button type="button" class="secondary" data-command="openOverrideFile">Open Override File</button>
          <button type="button" class="secondary" data-command="generateOverride">Generate Override From Dashboard</button>
        </div>
      </form>
    </section>`;
    }
    async handleMessage(message) {
        const dashboardSelector = this.selectionState.selectedDashboardSelectorName;
        const instanceName = this.selectionState.selectedInstanceName;
        const targetName = this.selectionState.selectedTargetName;
        switch (message.type) {
            case "initializeProject":
                await this.actions.initializeProject();
                return;
            case "createManifestFromExample":
                await this.actions.createManifestFromExample();
                return;
            case "addDashboard":
                await this.actions.addDashboard();
                return;
            case "createInstance":
                await this.actions.createInstance(message.payload?.instanceName ?? "");
                return;
            case "createDeploymentTarget":
                if (!instanceName) {
                    throw new Error("No instance selected.");
                }
                await this.actions.createDeploymentTarget(instanceName, "");
                return;
            case "saveManifest":
                if (!dashboardSelector) {
                    throw new Error("No dashboard selected.");
                }
                await this.actions.saveManifest(dashboardSelector, {
                    name: message.payload?.name || undefined,
                    uid: message.payload?.uid ?? "",
                    path: message.payload?.path ?? "",
                });
                return;
            case "saveInstanceEnv":
                if (!instanceName) {
                    throw new Error("No instance selected.");
                }
                await this.actions.saveInstanceEnv(instanceName, message.payload);
                return;
            case "saveDashboardDatasourceMappings":
                if (!instanceName || !targetName || !dashboardSelector) {
                    throw new Error("Select a dashboard and deployment target to save datasource mappings.");
                }
                await this.actions.saveDashboardDatasourceMappings(instanceName, dashboardSelector, message.payload);
                return;
            case "removeInstance":
                await this.actions.removeInstance();
                return;
            case "removeDeploymentTarget":
                await this.actions.removeDeploymentTarget();
                return;
            case "setInstanceToken":
                await this.actions.setInstanceToken();
                return;
            case "clearInstanceToken":
                await this.actions.clearInstanceToken();
                return;
            case "saveOverride":
                if (!dashboardSelector || !instanceName || !targetName) {
                    throw new Error("Select a dashboard and deployment target to save overrides.");
                }
                await this.actions.saveOverride(instanceName, targetName, dashboardSelector, message.payload);
                return;
            case "createRevision":
                if (!dashboardSelector) {
                    throw new Error("No dashboard selected.");
                }
                await this.actions.createRevision(dashboardSelector);
                return;
            case "checkoutRevision":
                if (!dashboardSelector) {
                    throw new Error("No dashboard selected.");
                }
                await this.actions.checkoutRevision(dashboardSelector, message.payload?.revisionId ?? "");
                return;
            case "deployRevision":
                if (!dashboardSelector || !instanceName || !targetName) {
                    throw new Error("Select a dashboard and deployment target to deploy a revision.");
                }
                await this.actions.deployRevision(dashboardSelector, message.payload?.revisionId ?? "", instanceName, targetName);
                return;
            case "deployLatestRevision":
                if (!dashboardSelector || !instanceName || !targetName) {
                    throw new Error("Select a dashboard and deployment target to deploy the latest revision.");
                }
                await this.actions.deployLatestRevision(dashboardSelector, instanceName, targetName);
                return;
            case "useLiveTarget": {
                const payload = message.payload;
                if (!payload?.instanceName || !payload?.targetName) {
                    throw new Error("Live target payload is invalid.");
                }
                await this.actions.setActiveTarget(payload.instanceName, payload.targetName);
                return;
            }
            case "pullLiveTarget": {
                if (!dashboardSelector) {
                    throw new Error("No dashboard selected.");
                }
                const payload = message.payload;
                if (!payload?.instanceName || !payload?.targetName) {
                    throw new Error("Live target payload is invalid.");
                }
                await this.actions.pullTarget(dashboardSelector, payload.instanceName, payload.targetName);
                return;
            }
            case "savePlacement":
                if (!dashboardSelector || !instanceName || !targetName) {
                    throw new Error("Select a dashboard and deployment target to save placement.");
                }
                await this.actions.savePlacement(instanceName, targetName, dashboardSelector, message.payload);
                return;
            case "pickPlacementFolder":
                if (!dashboardSelector || !instanceName || !targetName) {
                    throw new Error("Select a dashboard and deployment target to choose placement.");
                }
                await this.actions.pickPlacementFolder(instanceName, targetName, dashboardSelector);
                return;
            case "pullSelected":
                await this.actions.pullSelected();
                return;
            case "deploySelected":
                await this.actions.deploySelected();
                return;
            case "renderSelected":
                await this.actions.renderSelected();
                return;
            case "renderTarget":
                await this.actions.renderTarget();
                return;
            case "openRenderFolder":
                await this.actions.openRenderFolder();
                return;
            case "openDashboardJson":
                await this.actions.openDashboardJson();
                return;
            case "openDatasourceCatalog":
                await this.actions.openDatasourceCatalog();
                return;
            case "openOverrideFile":
                await this.actions.openOverrideFile();
                return;
            case "generateOverride":
                await this.actions.generateOverride();
                return;
            case "removeDashboard":
                await this.actions.removeDashboard();
                return;
            default:
                return;
        }
    }
}
exports.DetailsViewProvider = DetailsViewProvider;
//# sourceMappingURL=detailsViewProvider.js.map