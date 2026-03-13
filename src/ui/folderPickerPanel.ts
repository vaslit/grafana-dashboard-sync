import * as vscode from "vscode";

import { GrafanaFolder } from "../core/types";

type FolderPickerState = {
  currentChain: GrafanaFolder[];
  children: GrafanaFolder[];
  selectedPath?: string;
  baseFolderPath?: string;
  error?: string;
};

type FolderPickerActions = {
  listChildren(parentUid?: string): Promise<GrafanaFolder[]>;
  createFolder(parentUid: string | undefined, title: string): Promise<GrafanaFolder>;
  onConfirm(path: string | undefined): Promise<void>;
};

type FolderPickerContext = {
  instanceName: string;
  targetName: string;
  dashboardSelector: string;
  initialPath?: string;
  baseFolderPath?: string;
};

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

function folderPathFromChain(chain: GrafanaFolder[]): string | undefined {
  if (chain.length === 0) {
    return undefined;
  }
  return chain.map((folder) => folder.title).join("/");
}

export class FolderPickerPanel {
  private panel?: vscode.WebviewPanel;
  private state: FolderPickerState = {
    currentChain: [],
    children: [],
  };
  private context?: FolderPickerContext;
  private actions?: FolderPickerActions;

  async open(context: FolderPickerContext, actions: FolderPickerActions): Promise<void> {
    this.context = context;
    this.actions = actions;

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "grafanaDashboards.folderPicker",
        `Choose Folder: ${context.instanceName}/${context.targetName}`,
        vscode.ViewColumn.Active,
        { enableScripts: true },
      );

      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.context = undefined;
        this.actions = undefined;
      });

      this.panel.webview.onDidReceiveMessage(async (message) => {
        try {
          await this.handleMessage(message as { type: string; payload?: Record<string, string> | string });
        } catch (error) {
          this.state.error = String(error);
          await this.refresh();
        }
      });
    } else {
      this.panel.reveal(vscode.ViewColumn.Active);
      this.panel.title = `Choose Folder: ${context.instanceName}/${context.targetName}`;
    }

    this.state = {
      currentChain: [],
      children: [],
      selectedPath: context.initialPath,
      baseFolderPath: context.baseFolderPath,
    };

    if (context.initialPath) {
      const segments = context.initialPath.split("/").filter(Boolean);
      let parentUid: string | undefined;
      const chain: GrafanaFolder[] = [];
      for (const segment of segments) {
        const children = await actions.listChildren(parentUid);
        const folder = children.find((candidate) => candidate.title === segment);
        if (!folder) {
          break;
        }
        chain.push(folder);
        parentUid = folder.uid;
      }
      this.state.currentChain = chain;
    }

    await this.refresh();
  }

  private async handleMessage(message: { type: string; payload?: Record<string, string> | string }): Promise<void> {
    if (!this.actions || !this.context) {
      return;
    }

    switch (message.type) {
      case "navigateRoot":
        this.state.currentChain = [];
        this.state.error = undefined;
        await this.refresh();
        return;
      case "navigateUp":
        this.state.currentChain = this.state.currentChain.slice(0, -1);
        this.state.error = undefined;
        await this.refresh();
        return;
      case "navigateToIndex": {
        const index = Number((message.payload as Record<string, string>)?.index ?? "-1");
        this.state.currentChain = index >= 0 ? this.state.currentChain.slice(0, index + 1) : [];
        this.state.error = undefined;
        await this.refresh();
        return;
      }
      case "enterFolder": {
        const uid = (message.payload as Record<string, string>)?.uid ?? "";
        const title = (message.payload as Record<string, string>)?.title ?? "";
        if (!uid || !title) {
          throw new Error("Invalid folder selection.");
        }
        this.state.currentChain = [...this.state.currentChain, { uid, title }];
        this.state.error = undefined;
        await this.refresh();
        return;
      }
      case "selectCurrent":
        this.state.selectedPath = folderPathFromChain(this.state.currentChain);
        this.state.error = undefined;
        await this.refresh();
        return;
      case "createFolder": {
        const title = ((message.payload as Record<string, string>)?.title ?? "").trim();
        if (!title) {
          throw new Error("Folder name must not be empty.");
        }
        const parentUid = this.state.currentChain.at(-1)?.uid;
        const created = await this.actions.createFolder(parentUid, title);
        this.state.currentChain = [...this.state.currentChain, created];
        this.state.selectedPath = folderPathFromChain(this.state.currentChain);
        this.state.error = undefined;
        await this.refresh();
        return;
      }
      case "confirm":
        await this.actions.onConfirm(this.state.selectedPath);
        this.panel?.dispose();
        return;
      case "cancel":
        this.panel?.dispose();
        return;
      default:
        return;
    }
  }

  private async refresh(): Promise<void> {
    if (!this.panel || !this.context || !this.actions) {
      return;
    }

    const parentUid = this.state.currentChain.at(-1)?.uid;
    this.state.children = await this.actions.listChildren(parentUid);
    this.panel.webview.html = this.render();
  }

  private render(): string {
    if (!this.context) {
      return "";
    }

    const scriptNonce = nonce();
    const currentPath = folderPathFromChain(this.state.currentChain);
    const selectedPath = this.state.selectedPath ?? "(root)";
    const context = this.context;
    const breadcrumbs = [
      `<button type="button" data-command="navigateRoot">root</button>`,
      ...this.state.currentChain.map(
        (folder, index) =>
          `<button type="button" data-command="navigateToIndex" data-index="${index}">${escapeHtml(folder.title)}</button>`,
      ),
    ].join('<span class="sep">/</span>');
    const childRows =
      this.state.children.length > 0
        ? this.state.children
            .map(
              (folder) => `<button type="button" class="folder-row" data-command="enterFolder" data-uid="${escapeHtml(folder.uid)}" data-title="${escapeHtml(folder.title)}">
          <span>${escapeHtml(folder.title)}</span>
          <span class="small">${escapeHtml(folder.uid)}</span>
        </button>`,
            )
            .join("")
        : `<div class="hint">No child folders at this level.</div>`;
    const error = this.state.error ? `<div class="error">${escapeHtml(this.state.error)}</div>` : "";

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
    .toolbar, .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
      margin-bottom: 12px;
    }
    .breadcrumbs {
      display: flex;
      gap: 6px;
      align-items: center;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }
    .sep {
      color: var(--vscode-descriptionForeground);
    }
    .folder-list {
      display: grid;
      gap: 8px;
      margin-bottom: 12px;
    }
    .folder-row {
      display: flex;
      justify-content: space-between;
      width: 100%;
      text-align: left;
      padding: 8px 10px;
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      cursor: pointer;
    }
    .small {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .hint {
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
    }
    .error {
      color: var(--vscode-errorForeground);
      margin-bottom: 12px;
    }
    input {
      width: 260px;
      box-sizing: border-box;
      padding: 6px 8px;
      border: 1px solid var(--vscode-input-border, transparent);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
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
  </style>
</head>
<body>
  <div class="hint"><strong>${escapeHtml(context.instanceName)}/${escapeHtml(context.targetName)}</strong> • ${escapeHtml(context.dashboardSelector)}</div>
  <div class="small">Base path: ${escapeHtml(this.state.baseFolderPath ?? "(root)")}</div>
  <div class="small">Current path: ${escapeHtml(currentPath ?? "(root)")}</div>
  <div class="small">Selected path: ${escapeHtml(selectedPath)}</div>
  ${error}
  <div class="breadcrumbs">${breadcrumbs}</div>
  <div class="toolbar">
    <button type="button" class="secondary" data-command="navigateUp">Up</button>
    <button type="button" class="secondary" data-command="selectCurrent">Select Current Folder</button>
  </div>
  <div class="toolbar">
    <input id="new-folder-name" type="text" placeholder="New folder name" />
    <button type="button" data-command="createFolder">Create Folder</button>
  </div>
  <div class="folder-list">${childRows}</div>
  <div class="actions">
    <button type="button" data-command="confirm">OK</button>
    <button type="button" class="secondary" data-command="cancel">Cancel</button>
  </div>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll("[data-command]").forEach((element) => {
      element.addEventListener("click", () => {
        const type = element.dataset.command;
        if (type === "createFolder") {
          const input = document.getElementById("new-folder-name");
          vscode.postMessage({ type, payload: { title: input.value } });
          return;
        }
        if (type === "enterFolder") {
          vscode.postMessage({ type, payload: { uid: element.dataset.uid, title: element.dataset.title } });
          return;
        }
        if (type === "navigateToIndex") {
          vscode.postMessage({ type, payload: { index: element.dataset.index } });
          return;
        }
        vscode.postMessage({ type });
      });
    });
  </script>
</body>
</html>`;
  }
}
