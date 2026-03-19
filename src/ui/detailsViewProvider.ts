import * as vscode from "vscode";

import { DashboardService } from "../core/dashboardService";
import { PROJECT_CONFIG_FILE } from "../core/projectLocator";
import { ProjectRepository } from "../core/repository";
import {
  AlertDetailsModel,
  DashboardDetailsModel,
  DeploymentTargetDetailsModel,
  GlobalDatasourceUsageRow,
  GrafanaDatasourceSummary,
  GrafanaFolder,
  InstanceDetailsModel,
  LiveTargetVersionStatus,
  OverrideEditorVariableModel,
  TargetAlertSummaryRow,
  TargetDashboardSummaryRow,
  TargetDatasourceBindingRow,
} from "../core/types";
import { SelectionState } from "./selectionState";

interface DetailsActionHandlers {
  initializeProject(): Promise<void>;
  createManifestFromExample(): Promise<void>;
  addDashboard(): Promise<void>;
  createInstance(name: string): Promise<void>;
  createDeploymentTarget(instanceName: string, targetName: string): Promise<void>;
  removeDeploymentTarget(): Promise<void>;
  removeInstance(): Promise<void>;
  saveManifest(currentSelector: string, values: { name?: string; uid: string; path: string }): Promise<void>;
  saveInstanceEnv(instanceName: string, values: Record<string, string>): Promise<void>;
  saveDashboardDatasourceMappings(
    instanceName: string,
    targetName: string,
    selectorName: string,
    values: Record<string, string>,
  ): Promise<void>;
  savePlacement(instanceName: string, targetName: string, selectorName: string, values: Record<string, string>): Promise<void>;
  setInstanceToken(): Promise<void>;
  clearInstanceToken(): Promise<void>;
  setInstancePassword(): Promise<void>;
  clearInstancePassword(): Promise<void>;
  saveOverride(instanceName: string, targetName: string, selectorName: string, values: Record<string, string>): Promise<void>;
  createRevision(selectorName: string): Promise<void>;
  deployLatestRevision(selectorName: string, instanceName: string, targetName: string): Promise<void>;
  pullSelected(): Promise<void>;
  deploySelected(): Promise<void>;
  renderSelected(): Promise<void>;
  renderTarget(): Promise<void>;
  renderInstance(): Promise<void>;
  renderAllInstances(): Promise<void>;
  exportAlerts(): Promise<void>;
  copySelectedAlertToTarget(): Promise<void>;
  uploadSelectedAlert(): Promise<void>;
  refreshSelectedAlertStatus(): Promise<void>;
  saveAlertSettings(instanceName: string, targetName: string, uid: string, values: Record<string, string>): Promise<void>;
  removeAlertFromProject(): Promise<void>;
  openRenderFolder(): Promise<void>;
  openDashboardJson(): Promise<void>;
  openDatasourceCatalog(): Promise<void>;
  openOverrideFile(): Promise<void>;
  generateOverride(): Promise<void>;
  removeDashboard(): Promise<void>;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function nonce(): string {
  return Math.random().toString(36).slice(2);
}

interface DatasourceMappingRow {
  currentSourceName: string;
  sourceLabel: string;
  sourceType?: string;
  usageCount?: number;
  usageKinds?: Array<"panel" | "query" | "variable">;
  globalDatasourceKey: string;
  targetUid?: string;
  targetName?: string;
}

interface InstanceDatasourceSummaryRow {
  globalDatasourceKey: string;
  sourceType?: string;
  dashboards: string[];
  instanceUid?: string;
  instanceName?: string;
}

interface PlacementBrowserState {
  key: string;
  inputPath: string;
  isOpen: boolean;
  currentChain: GrafanaFolder[];
  children: GrafanaFolder[];
  knownPaths?: string[];
  browserError?: string;
  knownPathsError?: string;
}

interface PlacementViewModel {
  inputPath: string;
  isOpen: boolean;
  currentPath?: string;
  children: GrafanaFolder[];
  browserError?: string;
  missingPathWarning?: string;
}

function optionLabel(option: GrafanaDatasourceSummary): string {
  return option.isDefault ? `${option.name} (${option.uid}) [default]` : `${option.name} (${option.uid})`;
}

function usageLabel(row: DatasourceMappingRow): string {
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

function normalizeFolderPathValue(value: string | undefined): string | undefined {
  const normalized = (value ?? "")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
  return normalized || undefined;
}

function folderPathFromChain(chain: GrafanaFolder[]): string | undefined {
  if (chain.length === 0) {
    return undefined;
  }
  return chain.map((folder) => folder.title).join("/");
}

export class DetailsViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private placementBrowserState?: PlacementBrowserState;

  constructor(
    private readonly getRepository: () => ProjectRepository | undefined,
    private readonly getService: () => DashboardService | undefined,
    private readonly selectionState: SelectionState,
    private readonly actions: DetailsActionHandlers,
    private readonly getMissingProjectMessage: () => string,
  ) {}

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };
    webviewView.webview.html = this.renderLoadingState();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      try {
        await this.handleMessage(message);
      } catch (error) {
        void vscode.window.showErrorMessage(String(error));
      }
    });

    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.view) {
      return;
    }

    try {
      this.view.webview.html = await this.render();
    } catch (error) {
      this.view.webview.html = `<html><body><pre>${escapeHtml(String(error))}</pre></body></html>`;
    }
  }

  private async render(): Promise<string> {
    const repository = this.getRepository();
    if (!repository) {
      return this.renderMissingProject();
    }

    const service = this.getService();
    if (!service) {
      return this.renderMissingProject();
    }

    const detailsMode =
      this.selectionState.selectedDetailsMode ??
      (this.selectionState.selectedDashboardSelectorName
        ? "dashboard"
        : this.selectionState.selectedAlertUid
          ? "alert"
          : this.selectionState.selectedInstanceName
            ? "instance"
            : undefined);

    const manifestExists = await repository.manifestExists();
    const dashboardInstanceName =
      detailsMode === "dashboard" || detailsMode === "alert"
        ? this.selectionState.selectedInstanceName ?? this.selectionState.activeInstanceName
        : this.selectionState.selectedInstanceName;
    const dashboardTargetName =
      detailsMode === "dashboard" || detailsMode === "alert"
        ? this.selectionState.selectedTargetName ?? this.selectionState.activeTargetName
        : this.selectionState.selectedTargetName;
    const dashboard = detailsMode === "dashboard" && this.selectionState.selectedDashboardSelectorName
      ? await repository.loadDashboardDetails(this.selectionState.selectedDashboardSelectorName)
      : undefined;
    const alert =
      detailsMode === "alert" && this.selectionState.selectedAlertUid && dashboardInstanceName && dashboardTargetName
        ? await service.loadAlertDetails(dashboardInstanceName, dashboardTargetName, this.selectionState.selectedAlertUid).catch(() => undefined)
        : undefined;
    const instance = dashboardInstanceName
      ? await repository.loadInstanceDetails(dashboardInstanceName)
      : undefined;
    const target = instance && dashboardTargetName
      ? await repository.loadDeploymentTargetDetails(instance.instance.name, dashboardTargetName)
      : undefined;
    let datasourceOptions: GrafanaDatasourceSummary[] = [];
    let datasourceLoadError: string | undefined;
    if (instance) {
      try {
        datasourceOptions = await service.listRemoteDatasources(instance.instance.name);
      } catch (error) {
        datasourceLoadError = String(error);
      }
    }
    const instanceDatasourceRows =
      detailsMode === "instance" && instance
        ? await this.buildInstanceDatasourceRows(instance.instance.name)
        : [];
    const targetDashboardRows =
      detailsMode === "instance" && instance && this.selectionState.selectedTargetName
        ? await service.buildTargetDashboardSummaryRows(instance.instance.name, this.selectionState.selectedTargetName).catch(() => [])
        : [];
    const targetAlertRows =
      detailsMode === "instance" && instance && this.selectionState.selectedTargetName
        ? await service.buildTargetAlertSummaryRows(instance.instance.name, this.selectionState.selectedTargetName).catch(() => [])
        : [];
    const datasourceRows =
      dashboard && instance && dashboardTargetName
        ? await this.buildDatasourceRows(instance.instance.name, dashboardTargetName, dashboard.entry, datasourceOptions)
        : [];
    const overrideVariables =
      dashboard && instance && target
        ? await service.buildOverrideEditorVariables(instance.instance.name, target.target.name, dashboard.entry).catch(() => [])
        : [];
    const liveTargetVersions =
      dashboard
        ? await service.listLiveTargetVersionStatuses(dashboard.entry).catch(() => [])
        : [];
    const placement =
      dashboard && instance && target
        ? await service.buildPlacementDetails(instance.instance.name, target.target.name, dashboard.entry).catch(() => undefined)
        : undefined;
    const placementView =
      dashboard && instance && target
        ? await this.resolvePlacementViewModel(dashboard, instance, target, placement)
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
  ${detailsMode === "alert" ? this.renderAlertSection(alert, instance, target, datasourceOptions, datasourceLoadError) : ""}
  ${detailsMode === "dashboard" ? this.renderLiveTargetVersionsSection(dashboard, liveTargetVersions) : ""}
  ${detailsMode === "instance" ? this.renderInstanceSection(instance, target) : ""}
  ${this.renderDatasourceSection(dashboard, instance, target, datasourceRows, datasourceOptions, datasourceLoadError, detailsMode, instanceDatasourceRows)}
  ${detailsMode === "instance" ? this.renderTargetDashboardSection(instance, this.selectionState.selectedTargetName, targetDashboardRows) : ""}
  ${detailsMode === "instance" ? this.renderTargetAlertSection(instance, this.selectionState.selectedTargetName, targetAlertRows) : ""}
  ${detailsMode === "dashboard" ? this.renderPlacementSection(dashboard, instance, target, placement, placementView) : ""}
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

    const alertForm = document.getElementById("alert-form");
    if (alertForm) {
      alertForm.addEventListener("submit", (event) => {
        event.preventDefault();
        vscode.postMessage({ type: "saveAlertSettings", payload: valuesFromForm(alertForm) });
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

    const placementInput = document.getElementById("placement-folder-path");
    if (placementInput) {
      placementInput.addEventListener("change", () => {
        vscode.postMessage({
          type: "placementInputChanged",
          payload: {
            folderPath: placementInput.value,
          },
        });
      });
    }

    const createInstanceForm = document.getElementById("create-instance-form");
    if (createInstanceForm) {
      createInstanceForm.addEventListener("submit", (event) => {
        event.preventDefault();
        vscode.postMessage({ type: "createInstance", payload: valuesFromForm(createInstanceForm) });
      });
    }

    document.querySelectorAll("select[data-target-uid-input]").forEach((select) => {
      const syncDatasourceInputs = () => {
        const selectedOption = select.options[select.selectedIndex];
        const uidInput = document.getElementById(select.dataset.targetUidInput);
        if (uidInput) {
          uidInput.value = selectedOption ? selectedOption.value : "";
        }
        const nameInput = document.getElementById(select.dataset.targetNameInput);
        if (nameInput) {
          nameInput.value = selectedOption ? (selectedOption.dataset.datasourceName || "") : "";
        }
      };
      select.addEventListener("change", syncDatasourceInputs);
      syncDatasourceInputs();
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
        document.querySelectorAll('[data-placement-control="' + checkbox.dataset.placementToggle + '"]').forEach((control) => {
          control.disabled = !checkbox.checked;
        });
      };
      checkbox.addEventListener("change", syncEnabled);
      syncEnabled();
    });
  </script>
</body>
</html>`;
  }

  private renderMissingProject(): string {
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
    <div class="hint">Initialize a project to create <code>${escapeHtml(PROJECT_CONFIG_FILE)}</code>, <code>dashboards/</code>, <code>backups/</code>, <code>renders/</code>, and the first instance.</div>
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

  private renderLoadingState(): string {
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

  private renderManifestSection(manifestExists: boolean): string {
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

  private renderDashboardSection(dashboard?: DashboardDetailsModel): string {
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

  private renderAlertSection(
    alert: AlertDetailsModel | undefined,
    instance?: InstanceDetailsModel,
    target?: DeploymentTargetDetailsModel,
    datasourceOptions: GrafanaDatasourceSummary[] = [],
    datasourceLoadError?: string,
  ): string {
    if (!alert || !instance || !target) {
      return `<section data-collapsible-section="alert">
        <h2>Alert</h2>
        <div class="hint">Select an alert from Instances -> Target -> Alerts.</div>
      </section>`;
    }

    const contactPoints =
      alert.contactPoints.length === 0
        ? `<div class="hint">No linked contact points.</div>`
        : alert.contactPoints
            .map(
              (contactPoint) =>
                `<div class="grid" style="padding: 8px; border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px;">
                  <div><strong>${escapeHtml(contactPoint.name)}</strong></div>
                  <div class="small">Key: ${escapeHtml(contactPoint.key)}</div>
                  <div class="small">UID: ${escapeHtml(contactPoint.uid ?? "(none)")}</div>
                  <div class="small">Type: ${escapeHtml(contactPoint.type ?? "(unknown)")}</div>
                  <div class="small">Local file: ${escapeHtml(contactPoint.exists ? "present" : "missing")}</div>
                </div>`,
            )
            .join("");

    const targetUid = alert.datasourceSelection?.targetUid;
    const targetName =
      alert.datasourceSelection?.targetName ??
      datasourceOptions.find((option) => option.uid === targetUid)?.name ??
      "";
    const targetUidInputId = "alert-target-uid";
    const targetNameInputId = "alert-target-name";
    const helperSelectId = "alert-target-helper";
    const datasourceSelectOptions = [
      `<option value="">Select datasource to autofill</option>`,
      ...datasourceOptions.map((option) => {
        const selected = option.uid === targetUid ? ' selected="selected"' : "";
        return `<option value="${escapeHtml(option.uid)}" data-datasource-name="${escapeHtml(option.name)}"${selected}>${escapeHtml(optionLabel(option))}</option>`;
      }),
      ...(targetUid && !datasourceOptions.some((option) => option.uid === targetUid)
        ? [
            `<option value="${escapeHtml(targetUid)}" data-datasource-name="${escapeHtml(targetName)}" selected="selected">${escapeHtml(
              targetName ? `${targetName} (${targetUid})` : targetUid,
            )}</option>`,
          ]
        : []),
    ].join("");
    const datasourceEditor = alert.datasourceSelection
      ? `<label>
            Resolved Instance Datasource
            <select
              id="${helperSelectId}"
              data-target-uid-input="${targetUidInputId}"
              data-target-name-input="${targetNameInputId}"
            >
              ${datasourceSelectOptions}
            </select>
          </label>
          <div class="small">Alert refs: ${escapeHtml(alert.datasourceSelection.refIds.join(", "))}</div>
          <div class="small">Current external datasource UIDs: ${escapeHtml(alert.datasourceSelection.sourceUids.join(", "))}</div>
          <div class="small">Saving rewrites all non-expression datasource refs to one datasource.</div>
          <label>
            Target Datasource Name
            <input
              id="${targetNameInputId}"
              type="text"
              name="alert_target_name"
              value="${escapeHtml(targetName)}"
              placeholder="Prometheus Prod"
            />
          </label>
          <label>
            Target Datasource UID
            <input
              id="${targetUidInputId}"
              type="text"
              name="alert_target_uid"
              value="${escapeHtml(targetUid ?? "")}"
              placeholder="prometheus-prod-uid"
            />
          </label>`
      : `<div class="hint">No external datasources found in this alert.</div>`;
    const loadError =
      datasourceLoadError !== undefined
        ? `<div class="hint">Could not load datasources from Grafana for <strong>${escapeHtml(instance.instance.name)}</strong>: ${escapeHtml(datasourceLoadError)}</div>`
        : "";

    return `<section data-collapsible-section="alert">
      <h2>Alert</h2>
      <div class="hint">Selected alert for <strong>${escapeHtml(instance.instance.name)}/${escapeHtml(target.target.name)}</strong>.</div>
      <div class="small">UID: ${escapeHtml(alert.rule.uid)}</div>
      <div class="small">Title: ${escapeHtml(alert.rule.title)}</div>
      <div class="small">Contact point status: ${escapeHtml(alert.rule.contactPointStatus)}</div>
      <div class="small">Sync status: ${escapeHtml(alert.syncStatus)}${alert.syncDetail ? ` (${escapeHtml(alert.syncDetail)})` : ""}</div>
      <div class="small">Paused locally: ${escapeHtml(alert.isPaused ? "yes" : "no")}</div>
      <div class="grid" style="margin-top: 8px;">
        ${contactPoints}
      </div>
      ${loadError}
      <form id="alert-form" class="grid" style="margin-top: 8px;">
        ${datasourceEditor}
        <label>
          <input type="checkbox" name="isPaused" ${alert.isPaused ? 'checked="checked"' : ""} />
          Pause alert locally
        </label>
        <div class="actions">
          <button type="submit">Save Alert</button>
        </div>
      </form>
      <div class="actions">
        <button data-command="exportAlerts">Pull Alerts</button>
        <button type="button" class="secondary" data-command="copySelectedAlertToTarget">Copy Alert To Target</button>
        <button type="button" class="secondary" data-command="uploadSelectedAlert">Deploy Alert</button>
        <button type="button" class="secondary" data-command="refreshSelectedAlertStatus">Refresh Alert Status</button>
        <button type="button" class="secondary" data-command="removeAlertFromProject">Remove Alert From Project</button>
      </div>
    </section>`;
  }

  private renderLiveTargetVersionsSection(
    dashboard: DashboardDetailsModel | undefined,
    statuses: LiveTargetVersionStatus[],
  ): string {
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
        return `<div class="grid" style="padding: 8px; border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px;">
          <div><strong>${escapeHtml(`${status.instanceName}/${status.targetName}`)}</strong></div>
          ${status.detail ? `<div class="small">Detail: ${escapeHtml(status.detail)}</div>` : ""}
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

  private renderInstanceSection(
    instance?: InstanceDetailsModel,
    target?: DeploymentTargetDetailsModel,
  ): string {
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
          GRAFANA_USERNAME
          <input type="text" name="GRAFANA_USERNAME" value="${escapeHtml(envValues.GRAFANA_USERNAME ?? "")}" />
        </label>
        <div class="small">Token auth: ${escapeHtml(instance.tokenConfigured ? `configured via ${instance.tokenSourceLabel ?? "Secret Storage"}` : "missing")}</div>
        <div class="small">Password auth: ${escapeHtml(instance.passwordConfigured ? `configured via ${instance.passwordSourceLabel ?? "Secret Storage"}` : "missing")}</div>
        <div class="small">Active auth mode: ${escapeHtml(instance.mergedConnection?.authKind ?? "(none)")}</div>
        <div class="small">Connection source: ${escapeHtml(instance.mergedConnection?.sourceLabel ?? "No valid connection yet")}</div>
        <div class="actions">
          <button type="submit">Save Instance Config</button>
          <button type="button" class="secondary" data-command="setInstanceToken">Set Token</button>
          <button type="button" class="secondary" data-command="clearInstanceToken">Clear Token</button>
          <button type="button" class="secondary" data-command="setInstancePassword">Set Password</button>
          <button type="button" class="secondary" data-command="clearInstancePassword">Clear Password</button>
        </div>
      </form>
    </section>`;
  }

  private async buildDatasourceRows(
    instanceName: string,
    targetName: string,
    entry?: { path: string; uid: string; name?: string },
    datasourceOptions: GrafanaDatasourceSummary[] = [],
  ): Promise<DatasourceMappingRow[]> {
    const repository = this.getRepository();
    const service = this.getService();
    if (!repository || !service || !entry) {
      return [];
    }
    const rows = await service.buildTargetDatasourceRows(instanceName, targetName, entry).catch(() => [] as TargetDatasourceBindingRow[]);
    return rows.map((row) => ({
      currentSourceName: row.datasourceKey,
      sourceLabel: row.sourceLabel,
      sourceType: row.sourceType,
      usageCount: row.usageCount,
      usageKinds: row.usageKinds,
      globalDatasourceKey: row.globalDatasourceKey,
      targetUid: row.targetUid,
      targetName: row.targetName,
    }));
  }

  private async buildInstanceDatasourceRows(instanceName: string): Promise<InstanceDatasourceSummaryRow[]> {
    const service = this.getService();
    if (!service) {
      return [];
    }
    const rows = await service.buildGlobalDatasourceUsageRows(instanceName).catch(() => [] as GlobalDatasourceUsageRow[]);
    return rows.map((row) => ({
      globalDatasourceKey: row.globalDatasourceKey,
      sourceType: row.sourceType,
      dashboards: row.dashboards,
      instanceUid: row.instanceUid,
      instanceName: row.instanceName,
    }));
  }

  private renderDatasourceRows(
    rows: DatasourceMappingRow[],
    prefix: "dashboard",
    datasourceOptions: GrafanaDatasourceSummary[],
  ): string {
    return rows
      .map((row, index) => {
        const targetUid = row.targetUid;
        const targetName = row.targetName;
        const helperSelectId = `${prefix}-target-helper-${index}`;
        const targetUidInputId = `${prefix}-target-uid-${index}`;
        const targetNameInputId = `${prefix}-target-name-${index}`;
        const normalizedTargetName =
          targetName ??
          datasourceOptions.find((option) => option.uid === targetUid)?.name ??
          "";
        const selectOptions = [
          `<option value="">Select datasource to autofill</option>`,
          ...datasourceOptions.map((option) => {
            const selected = option.uid === targetUid ? ' selected="selected"' : "";
            return `<option value="${escapeHtml(option.uid)}" data-datasource-name="${escapeHtml(option.name)}"${selected}>${escapeHtml(optionLabel(option))}</option>`;
          }),
          ...(targetUid && !datasourceOptions.some((option) => option.uid === targetUid)
            ? [
                `<option value="${escapeHtml(targetUid)}" data-datasource-name="${escapeHtml(normalizedTargetName)}" selected="selected">${escapeHtml(
                  normalizedTargetName ? `${normalizedTargetName} (${targetUid})` : targetUid,
                )}</option>`,
              ]
            : []),
        ].join("");

        return `<div class="grid" style="padding: 8px; border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px;">
          <label>
            Global Datasource Key
            <input type="text" name="${prefix}_source_name__${index}" value="${escapeHtml(row.globalDatasourceKey)}" />
          </label>
          <input type="hidden" name="${prefix}_current_source_name__${index}" value="${escapeHtml(row.currentSourceName)}" />
          <div class="small">Dashboard datasource: ${escapeHtml(row.sourceLabel)} (${escapeHtml(row.currentSourceName)})</div>
          <div class="small">Type: ${escapeHtml(row.sourceType ?? "-")}, used in: ${escapeHtml(usageLabel(row))}</div>
          <label>
            Resolved Instance Datasource
            <select
              id="${helperSelectId}"
              data-target-uid-input="${targetUidInputId}"
              data-target-name-input="${targetNameInputId}"
            >
              ${selectOptions}
            </select>
          </label>
          <div class="small">Use the picker when Grafana is reachable, or enter datasource values manually below.</div>
          <label>
            Target Datasource Name
            <input
              id="${targetNameInputId}"
              type="text"
              name="${prefix}_target_name__${index}"
              value="${escapeHtml(normalizedTargetName)}"
              placeholder="Prometheus Prod"
            />
          </label>
          <label>
            Target Datasource UID
            <input
              id="${targetUidInputId}"
              type="text"
              name="${prefix}_target_uid__${index}"
              value="${escapeHtml(targetUid ?? "")}"
              placeholder="prometheus-prod-uid"
            />
          </label>
        </div>`;
      })
      .join("");
  }

  private renderDatasourceSection(
    dashboard: DashboardDetailsModel | undefined,
    instance: InstanceDetailsModel | undefined,
    target: DeploymentTargetDetailsModel | undefined,
    rows: DatasourceMappingRow[],
    datasourceOptions: GrafanaDatasourceSummary[],
    datasourceLoadError?: string,
    detailsMode?: "dashboard" | "instance" | "alert",
    instanceRows: InstanceDatasourceSummaryRow[] = [],
  ): string {
    if (!instance) {
      return "";
    }

    if (detailsMode === "instance") {
      const loadError =
        datasourceLoadError !== undefined
          ? `<div class="hint">Could not load datasources from Grafana for <strong>${escapeHtml(instance.instance.name)}</strong>: ${escapeHtml(datasourceLoadError)}</div>`
          : "";
      const rowsMarkup =
        instanceRows.length === 0
          ? `<div class="hint">Global datasource catalog is empty for this instance.</div>`
          : instanceRows
              .map((row) => {
                const mappedTarget = row.instanceUid
                  ? `${row.instanceName ?? "(unknown)"} (${row.instanceUid})`
                  : "(not mapped)";
                return `<div class="grid" style="padding: 8px; border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px;">
                  <div><strong>${escapeHtml(row.globalDatasourceKey)}</strong></div>
                  <div class="small">Resolved instance datasource: ${escapeHtml(mappedTarget)}</div>
                  <div class="small">Dashboards: ${escapeHtml(row.dashboards.join(", "))}</div>
                </div>`;
              })
              .join("");

      return `<section data-collapsible-section="datasources">
        <h2>Global Datasources</h2>
        <div class="hint">Global datasource catalog for <strong>${escapeHtml(instance.instance.name)}</strong>.</div>
        <div class="small">Tracked global datasource entries: ${escapeHtml(String(instanceRows.length))}</div>
        ${loadError}
        <div class="grid" style="margin-top: 8px;">
          ${rowsMarkup}
        </div>
        <div class="actions">
          <button type="button" class="secondary" data-command="openDatasourceCatalog">Open Catalog</button>
        </div>
      </section>`;
    }

    if (!dashboard || !target) {
      return "";
    }

    const dashboardRows = this.renderDatasourceRows(rows, "dashboard", datasourceOptions);
    const emptyState =
      rows.length === 0
        ? `<div class="hint">No external datasources found in this dashboard. Builtin Grafana annotations are handled automatically.</div>`
        : "";
    const loadError =
      datasourceLoadError !== undefined
        ? `<div class="hint">Could not load datasources from Grafana for <strong>${escapeHtml(instance.instance.name)}</strong>: ${escapeHtml(datasourceLoadError)}</div>`
        : "";

    return `<section data-collapsible-section="datasources">
      <h2>Datasources</h2>
      <div class="hint">Configure datasource bindings for <strong>${escapeHtml(instance.instance.name)}/${escapeHtml(target.target.name)}</strong> and dashboard <strong>${escapeHtml(dashboard.selectorName)}</strong>.</div>
      <div class="small">Dashboard: ${escapeHtml(dashboard.selectorName)}</div>
      <div class="small">Available datasources from Grafana: ${escapeHtml(String(datasourceOptions.length))}</div>
      <div class="small">If the target is not reachable, enter datasource name and UID manually.</div>
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

  private renderTargetDashboardSection(
    instance: InstanceDetailsModel | undefined,
    targetName: string | undefined,
    rows: TargetDashboardSummaryRow[],
  ): string {
    if (!instance || !targetName) {
      return "";
    }

    const content =
      rows.length === 0
        ? `<div class="hint">No dashboards available for this target.</div>`
        : rows
            .map((row) => {
              const liveText =
                row.liveStatus !== undefined
                  ? `${row.liveStatus}${row.liveMatchedRevisionId ? ` (${row.liveMatchedRevisionId})` : ""}`
                  : "not checked";
              return `<div class="grid" style="padding: 8px; border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px;">
                <div><strong>${escapeHtml(row.selectorName)}</strong></div>
                <div class="small">Stored revision: ${escapeHtml(row.currentRevisionId ?? "(unset)")}</div>
                <div class="small">UID / path: ${escapeHtml(row.effectiveDashboardUid ?? "(pending)")} / ${escapeHtml(row.effectiveFolderPath ?? "(root)")}</div>
                <div class="small">Datasources: ${escapeHtml(row.datasourceStatus)}</div>
                <div class="small">Live status: ${escapeHtml(liveText)}</div>
              </div>`;
            })
            .join("");

    return `<section data-collapsible-section="target-dashboards">
      <h2>Target Dashboards</h2>
      <div class="hint">Managed dashboards for <strong>${escapeHtml(instance.instance.name)}/${escapeHtml(targetName)}</strong>.</div>
      <div class="grid" style="margin-top: 8px;">
        ${content}
      </div>
    </section>`;
  }

  private renderTargetAlertSection(
    instance: InstanceDetailsModel | undefined,
    targetName: string | undefined,
    rows: TargetAlertSummaryRow[],
  ): string {
    if (!instance || !targetName) {
      return "";
    }

    const content =
      rows.length === 0
        ? `<div class="hint">No alerts pulled for this target.</div>`
        : rows
            .map((row) => {
              return `<div class="grid" style="padding: 8px; border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px;">
                <div><strong>${escapeHtml(row.title)}</strong></div>
                <div class="small">UID: ${escapeHtml(row.uid)}</div>
                <div class="small">Contact points: ${escapeHtml(row.contactPointStatus)}</div>
                <div class="small">Sync: ${escapeHtml(row.syncStatus)}${row.syncDetail ? ` (${escapeHtml(row.syncDetail)})` : ""}</div>
              </div>`;
            })
            .join("");

    return `<section data-collapsible-section="target-alerts">
      <h2>Target Alerts</h2>
      <div class="hint">Pulled alerts for <strong>${escapeHtml(instance.instance.name)}/${escapeHtml(targetName)}</strong>.</div>
      <div class="grid" style="margin-top: 8px;">
        ${content}
      </div>
    </section>`;
  }

  private placementContextKey(instanceName: string, targetName: string, selectorName: string): string {
    return `${instanceName}/${targetName}/${selectorName}`;
  }

  private async resolvePlacementViewModel(
    dashboard: DashboardDetailsModel | undefined,
    instance: InstanceDetailsModel | undefined,
    target: DeploymentTargetDetailsModel | undefined,
    placement:
      | {
          baseFolderPath?: string;
          overrideFolderPath?: string;
          baseDashboardUid?: string;
          overrideDashboardUid?: string;
          effectiveDashboardUid?: string;
        }
      | undefined,
  ): Promise<PlacementViewModel | undefined> {
    if (!dashboard || !instance || !target) {
      this.placementBrowserState = undefined;
      return undefined;
    }

    const key = this.placementContextKey(instance.instance.name, target.target.name, dashboard.selectorName);
    const defaultInputPath = placement?.overrideFolderPath ?? placement?.baseFolderPath ?? "";
    if (!this.placementBrowserState || this.placementBrowserState.key !== key) {
      this.placementBrowserState = {
        key,
        inputPath: defaultInputPath,
        isOpen: false,
        currentChain: [],
        children: [],
      };
    }

    const state = this.placementBrowserState;
    const service = this.getService();
    if (!service) {
      return {
        inputPath: state.inputPath,
        isOpen: state.isOpen,
        currentPath: folderPathFromChain(state.currentChain),
        children: state.children,
        browserError: "Grafana service is not available.",
      };
    }

    if (state.knownPaths === undefined && state.knownPathsError === undefined) {
      try {
        state.knownPaths = await service.listRemoteFolderPaths(instance.instance.name);
      } catch (error) {
        state.knownPathsError = String(error);
      }
    }

    const normalizedInputPath = normalizeFolderPathValue(state.inputPath);
    const missingPathWarning =
      normalizedInputPath && state.knownPaths && !state.knownPaths.includes(normalizedInputPath)
        ? `Folder path "${normalizedInputPath}" does not currently exist in ${instance.instance.name}/${target.target.name}.`
        : undefined;

    return {
      inputPath: state.inputPath,
      isOpen: state.isOpen,
      currentPath: folderPathFromChain(state.currentChain),
      children: state.children,
      browserError: state.browserError ?? state.knownPathsError,
      missingPathWarning,
    };
  }

  private async openPlacementBrowser(instanceName: string): Promise<void> {
    const state = this.placementBrowserState;
    const service = this.getService();
    if (!state || !service) {
      return;
    }

    state.isOpen = true;
    state.currentChain = [];
    try {
      state.children = await service.listFolderChildren(instanceName);
      state.browserError = undefined;
      if (state.knownPaths === undefined) {
        state.knownPathsError = undefined;
      }
    } catch (error) {
      state.children = [];
      state.browserError = String(error);
    }
  }

  private async navigatePlacementBrowser(instanceName: string, chain: GrafanaFolder[]): Promise<void> {
    const state = this.placementBrowserState;
    const service = this.getService();
    if (!state || !service) {
      return;
    }

    state.currentChain = chain;
    try {
      state.children = await service.listFolderChildren(instanceName, chain.at(-1)?.uid);
      state.browserError = undefined;
      if (state.knownPaths === undefined) {
        state.knownPathsError = undefined;
      }
    } catch (error) {
      state.children = [];
      state.browserError = String(error);
    }
  }

  private renderPlacementSection(
    dashboard: DashboardDetailsModel | undefined,
    instance: InstanceDetailsModel | undefined,
    target: DeploymentTargetDetailsModel | undefined,
    placement?: {
      baseFolderPath?: string;
      overrideFolderPath?: string;
      baseDashboardUid?: string;
        overrideDashboardUid?: string;
        effectiveDashboardUid?: string;
      },
    placementView?: PlacementViewModel,
  ): string {
    if (!dashboard || !instance || !target) {
      return "";
    }

    const inputId = "placement-folder-path";
    const browseButtonId = "placement-browse-button";
    const checked = placementView?.inputPath && placementView.inputPath !== (placement?.baseFolderPath ?? "") ? ' checked="checked"' : placement?.overrideFolderPath ? ' checked="checked"' : "";
    const value = placementView?.inputPath ?? placement?.overrideFolderPath ?? placement?.baseFolderPath ?? "";
    const browserRows = placementView?.isOpen
      ? [
          placementView.currentPath
            ? `<button type="button" class="secondary" data-command="placementNavigateUp">..</button>`
            : "",
          ...(placementView.children.length > 0
            ? placementView.children.map(
                (folder) =>
                  `<button type="button" class="secondary" data-command="placementEnterFolder" data-payload="${escapeHtml(
                    JSON.stringify({ uid: folder.uid, title: folder.title }),
                  )}">${escapeHtml(folder.title)}</button>`,
              )
            : [`<div class="hint">No child folders at this level.</div>`]),
        ]
          .filter(Boolean)
          .join("")
      : "";
    const browserError = placementView?.browserError
      ? `<div class="small" style="color: var(--vscode-errorForeground);">${escapeHtml(placementView.browserError)}</div>`
      : "";
    const missingWarning = placementView?.missingPathWarning
      ? `<div class="small" style="color: var(--vscode-editorWarning-foreground);">${escapeHtml(placementView.missingPathWarning)}</div>`
      : "";
    const browser =
      placementView?.isOpen
        ? `<div style="border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; padding: 8px; display: grid; gap: 8px;">
            <div class="small">Current browser path: ${escapeHtml(placementView.currentPath ?? "(root)")}</div>
            ${browserError}
            <div class="grid">${browserRows}</div>
            <div class="actions">
              <button type="button" data-command="placementConfirm">OK</button>
              <button type="button" class="secondary" data-command="placementCancel">Cancel</button>
            </div>
          </div>`
        : "";

    return `<section data-collapsible-section="placement">
      <h2>Placement</h2>
      <div class="hint">Configure target folder placement for <strong>${escapeHtml(instance.instance.name)}/${escapeHtml(target.target.name)}</strong>.</div>
      <div class="small">Base dashboard UID: ${escapeHtml(placement?.baseDashboardUid ?? dashboard.entry.uid)}</div>
      <div class="small">Target dashboard UID: ${escapeHtml(placement?.overrideDashboardUid ?? "(not set, base UID will be used)")}</div>
      <div class="small">Effective dashboard UID: ${escapeHtml(placement?.effectiveDashboardUid ?? dashboard.entry.uid)}</div>
      <div class="small">Base folder path: ${escapeHtml(placement?.baseFolderPath ?? "(root)")}</div>
      <form id="placement-form" class="grid">
        <div style="display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center;">
          <input
            id="${inputId}"
            type="text"
            name="folderPath"
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
        <div class="small">Current value: ${escapeHtml(normalizeFolderPathValue(value) ?? "(root)")}</div>
        ${missingWarning}
        ${browser}
        <div class="actions">
          <button
            id="${browseButtonId}"
            type="button"
            class="secondary"
            data-command="openPlacementBrowser"
            data-placement-control="${inputId}"
          >Browse Folders</button>
          <button type="submit">Save Placement</button>
        </div>
      </form>
    </section>`;
  }

  private renderOverrideSection(
    dashboard: DashboardDetailsModel | undefined,
    instance: InstanceDetailsModel | undefined,
    target: DeploymentTargetDetailsModel | undefined,
    variables: OverrideEditorVariableModel[],
  ): string {
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
      .map(
        (variable, index) => {
          const inputId = `override-value-${index}`;
          const checked = variable.hasSavedOverride ? ' checked="checked"' : "";
          const value = variable.hasSavedOverride ? variable.savedOverride : variable.currentValue;
          const editor =
            variable.type === "custom" && (variable.overrideOptions?.length ?? 0) > 0
              ? `<select
              id="${inputId}"
              name="override_value__${escapeHtml(variable.name)}"
            >
              ${variable.overrideOptions!
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
        },
      )
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

  private async handleMessage(message: { type: string; payload?: Record<string, string> | string }): Promise<void> {
    const dashboardSelector = this.selectionState.selectedDashboardSelectorName;
    const alertUid = this.selectionState.selectedAlertUid;
    const instanceName = this.selectionState.selectedInstanceName ?? this.selectionState.activeInstanceName;
    const targetName = this.selectionState.selectedTargetName ?? this.selectionState.activeTargetName;

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
        await this.actions.createInstance((message.payload as Record<string, string>)?.instanceName ?? "");
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
          name: (message.payload as Record<string, string>)?.name || undefined,
          uid: (message.payload as Record<string, string>)?.uid ?? "",
          path: (message.payload as Record<string, string>)?.path ?? "",
        });
        return;
      case "saveInstanceEnv":
        if (!instanceName) {
          throw new Error("No instance selected.");
        }
        await this.actions.saveInstanceEnv(instanceName, message.payload as Record<string, string>);
        return;
      case "saveDashboardDatasourceMappings":
        if (!instanceName || !targetName || !dashboardSelector) {
          throw new Error("Select a dashboard and deployment target to save datasource mappings.");
        }
        await this.actions.saveDashboardDatasourceMappings(
          instanceName,
          targetName,
          dashboardSelector,
          message.payload as Record<string, string>,
        );
        return;
      case "saveAlertSettings":
        if (!instanceName || !targetName || !alertUid) {
          throw new Error("Select an alert and deployment target to save alert settings.");
        }
        await this.actions.saveAlertSettings(instanceName, targetName, alertUid, message.payload as Record<string, string>);
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
      case "setInstancePassword":
        await this.actions.setInstancePassword();
        return;
      case "clearInstancePassword":
        await this.actions.clearInstancePassword();
        return;
      case "saveOverride":
        if (!dashboardSelector || !instanceName || !targetName) {
          throw new Error("Select a dashboard and deployment target to save overrides.");
        }
        await this.actions.saveOverride(instanceName, targetName, dashboardSelector, message.payload as Record<string, string>);
        return;
      case "createRevision":
        if (!dashboardSelector) {
          throw new Error("No dashboard selected.");
        }
        await this.actions.createRevision(dashboardSelector);
        return;
      case "deployLatestRevision":
        if (!dashboardSelector || !instanceName || !targetName) {
          throw new Error("Select a dashboard and deployment target to deploy the latest revision.");
        }
        await this.actions.deployLatestRevision(dashboardSelector, instanceName, targetName);
        return;
      case "savePlacement":
        if (!dashboardSelector || !instanceName || !targetName) {
          throw new Error("Select a dashboard and deployment target to save placement.");
        }
        if (this.placementBrowserState) {
          this.placementBrowserState.inputPath = (message.payload as Record<string, string>)?.folderPath ?? "";
        }
        await this.actions.savePlacement(instanceName, targetName, dashboardSelector, message.payload as Record<string, string>);
        return;
      case "placementInputChanged":
        if (this.placementBrowserState) {
          this.placementBrowserState.inputPath = ((message.payload as Record<string, string>)?.folderPath ?? "").trim();
        }
        await this.refresh();
        return;
      case "openPlacementBrowser":
        if (!dashboardSelector || !instanceName || !targetName) {
          throw new Error("Select a dashboard and deployment target to browse placement.");
        }
        await this.openPlacementBrowser(instanceName);
        await this.refresh();
        return;
      case "placementNavigateUp":
        if (!instanceName || !this.placementBrowserState) {
          throw new Error("Placement browser is not active.");
        }
        await this.navigatePlacementBrowser(instanceName, this.placementBrowserState.currentChain.slice(0, -1));
        await this.refresh();
        return;
      case "placementEnterFolder":
        if (!instanceName || !this.placementBrowserState) {
          throw new Error("Placement browser is not active.");
        }
        {
          const payload = message.payload as { uid?: string; title?: string };
          if (!payload?.uid || !payload?.title) {
            throw new Error("Invalid placement folder selection.");
          }
          await this.navigatePlacementBrowser(instanceName, [
            ...this.placementBrowserState.currentChain,
            { uid: payload.uid, title: payload.title },
          ]);
        }
        await this.refresh();
        return;
      case "placementConfirm":
        if (this.placementBrowserState) {
          this.placementBrowserState.inputPath = folderPathFromChain(this.placementBrowserState.currentChain) ?? "";
          this.placementBrowserState.isOpen = false;
        }
        await this.refresh();
        return;
      case "placementCancel":
        if (this.placementBrowserState) {
          this.placementBrowserState.isOpen = false;
          this.placementBrowserState.currentChain = [];
          this.placementBrowserState.children = [];
          this.placementBrowserState.browserError = undefined;
        }
        await this.refresh();
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
      case "exportAlerts":
        await this.actions.exportAlerts();
        return;
      case "copySelectedAlertToTarget":
        await this.actions.copySelectedAlertToTarget();
        return;
      case "uploadSelectedAlert":
        await this.actions.uploadSelectedAlert();
        return;
      case "refreshSelectedAlertStatus":
        await this.actions.refreshSelectedAlertStatus();
        return;
      case "removeAlertFromProject":
        await this.actions.removeAlertFromProject();
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
