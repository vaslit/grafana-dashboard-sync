# Grafana Dashboard Sync

`Grafana Dashboard Sync` is a VS Code extension for teams that keep Grafana dashboards in git and want a workspace-native way to pull, render, review, back up, and deploy them.

The extension manages a local dashboard project rooted by `.grafana-dashboard-workspace.json` and adds a dedicated Grafana activity bar with dashboard, instance, backup, and details views.

## Features

- Pull dashboards from Grafana into a tracked repository layout.
- Render dashboards per deployment target before deploy.
- Deploy one dashboard, one target, one instance, or all instances.
- Create and restore grouped raw backups for dashboards, targets, instances, and whole projects.
- Manage deployment target placement overrides.
- Rewrite datasource bindings per instance and per dashboard.
- Store Grafana tokens in VS Code Secret Storage instead of plaintext files.

## Workspace Layout

The extension activates only for workspaces that contain `.grafana-dashboard-workspace.json`.

Default layout:

```text
project-root/
  .grafana-dashboard-workspace.json
  dashboard-manifest.json
  dashboards/
  backups/
  renders/
```

Minimal workspace marker:

```json
{
  "version": 1,
  "maxBackups": 20
}
```

You can keep the Grafana project at the workspace root or inside a subfolder. The `Initialize Grafana Dashboard Project` command bootstraps the required structure.

Instance and deployment-target definitions live in `.grafana-dashboard-workspace.json`, not in a dedicated `instances/` folder.

## Getting Started

1. Open the folder that should contain your Grafana dashboard project in VS Code.
2. Run `Initialize Grafana Dashboard Project` if the project structure does not exist yet.
3. Create one or more instances in the `Instances` view.
4. Set an API token for each instance with `Set Instance Token`.
5. Add dashboards to the manifest or pull them from a remote Grafana instance.
6. Render and deploy using the activity bar views or command palette.

## Core Workflows

### Pull

- `Pull Dashboard`
- `Pull All Managed Dashboards`

These commands fetch dashboards from the selected instance and persist them into `dashboards/` according to the manifest.

### Render

- `Render Dashboard`
- `Render Target`
- `Render Instance`
- `Render All Instances`
- `Open Render Folder`

Rendered artifacts are written to:

```text
renders/<instance>/<target>/
```

Each render produces dashboard JSON files plus `.render-manifest.json` with resolved dashboard UIDs and target folders.

### Deploy

- `Deploy Dashboard`
- `Restore Backup`

Deploy uses the rendered target state and can create raw backups before modifying live dashboards.

### Backups

The `Backups` view manages snapshots under:

```text
backups/<timestamp>/
```

Managed backups store the live dashboard JSON, effective dashboard UID, and target folder path for each captured dashboard in a grouped backup manifest.

Supported backup scopes:

- `dashboard`: one dashboard on one target
- `target`: all dashboards on one target
- `instance`: all dashboards across all targets of one instance
- `multi-instance`: backups that span more than one instance, including full-project backups

The `Backups` tree lets you restore:

- the whole backup
- one instance inside a multi-instance backup
- one target inside an instance or multi-instance backup
- one dashboard inside any backup that contains dashboards

## Datasource Mappings

Datasource mappings are stored in `.grafana-dashboard-workspace.json` and applied per instance when dashboards are rendered or deployed.

Example:

```json
{
  "datasources": {
    "Source Datasource": {
      "sourceUid": "source-uid",
      "uid": "target-uid",
      "name": "Target Datasource"
    }
  }
}
```

When the selected instance is reachable, the `Details` panel can load remote datasource options for direct editing.

## Tokens

Instance tokens are stored in VS Code Secret Storage. They are not written to workspace files.

## Development

Prerequisites:

- VS Code 1.88+
- Node.js LTS

Install dependencies:

```bash
npm install
```

Build:

```bash
npm run compile
```

Typecheck:

```bash
npm run lint
```

Test:

```bash
npm test
```

Run the extension in a development host by opening this repository in VS Code and pressing `F5`.

## Packaging And Publishing

Package the extension:

```bash
npm run package
```

GitHub Releases are published automatically when a commit or merge reaches `main` with a changed `version` in `package.json`. The workflow builds the `.vsix`, creates tag `v<version>`, and uploads the package to the corresponding GitHub Release.

The same workflow can also be started manually from the GitHub `Actions` tab with `force_release=true` to publish the current version without another version bump.

Publish to the Visual Studio Marketplace:

```bash
npm run publish:marketplace
```

You need:

- a Visual Studio Marketplace publisher
- a Personal Access Token for that publisher
- `publisher` in `package.json` that matches the Marketplace publisher ID

## License

MIT
