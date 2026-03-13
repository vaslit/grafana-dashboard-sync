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
exports.FolderPickerPanel = void 0;
const vscode = __importStar(require("vscode"));
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
function folderPathFromChain(chain) {
    if (chain.length === 0) {
        return undefined;
    }
    return chain.map((folder) => folder.title).join("/");
}
class FolderPickerPanel {
    panel;
    state = {
        currentChain: [],
        children: [],
    };
    context;
    actions;
    async open(context, actions) {
        this.context = context;
        this.actions = actions;
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel("grafanaDashboards.folderPicker", `Choose Folder: ${context.instanceName}/${context.targetName}`, vscode.ViewColumn.Active, { enableScripts: true });
            this.panel.onDidDispose(() => {
                this.panel = undefined;
                this.context = undefined;
                this.actions = undefined;
            });
            this.panel.webview.onDidReceiveMessage(async (message) => {
                try {
                    await this.handleMessage(message);
                }
                catch (error) {
                    this.state.error = String(error);
                    await this.refresh();
                }
            });
        }
        else {
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
            let parentUid;
            const chain = [];
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
    async handleMessage(message) {
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
                const index = Number(message.payload?.index ?? "-1");
                this.state.currentChain = index >= 0 ? this.state.currentChain.slice(0, index + 1) : [];
                this.state.error = undefined;
                await this.refresh();
                return;
            }
            case "enterFolder": {
                const uid = message.payload?.uid ?? "";
                const title = message.payload?.title ?? "";
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
                const title = (message.payload?.title ?? "").trim();
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
    async refresh() {
        if (!this.panel || !this.context || !this.actions) {
            return;
        }
        const parentUid = this.state.currentChain.at(-1)?.uid;
        this.state.children = await this.actions.listChildren(parentUid);
        this.panel.webview.html = this.render();
    }
    render() {
        if (!this.context) {
            return "";
        }
        const scriptNonce = nonce();
        const currentPath = folderPathFromChain(this.state.currentChain);
        const selectedPath = this.state.selectedPath ?? "(root)";
        const context = this.context;
        const breadcrumbs = [
            `<button type="button" data-command="navigateRoot">root</button>`,
            ...this.state.currentChain.map((folder, index) => `<button type="button" data-command="navigateToIndex" data-index="${index}">${escapeHtml(folder.title)}</button>`),
        ].join('<span class="sep">/</span>');
        const childRows = this.state.children.length > 0
            ? this.state.children
                .map((folder) => `<button type="button" class="folder-row" data-command="enterFolder" data-uid="${escapeHtml(folder.uid)}" data-title="${escapeHtml(folder.title)}">
          <span>${escapeHtml(folder.title)}</span>
          <span class="small">${escapeHtml(folder.uid)}</span>
        </button>`)
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
exports.FolderPickerPanel = FolderPickerPanel;
//# sourceMappingURL=folderPickerPanel.js.map