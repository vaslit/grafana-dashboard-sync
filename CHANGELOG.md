# Changelog

All notable changes to this project will be documented in this file.

## 0.9.9 - 2026-03-20

- Moved mass dashboard pull in the Instances view onto the dedicated Dev Target item and removed misleading pull actions from regular instance and target entries.

## 0.9.8 - 2026-03-20

- Added bulk revision actions from the dashboard revisions tree to set or deploy one revision across selected target scopes.

## 0.9.7 - 2026-03-20

- Added fallback Grafana URLs per instance and automatic retry to the next configured address when the primary host is unavailable.

## 0.9.6 - 2026-03-20

- Bumped extension version for the workspace-layout update release.

## 0.9.5 - 2026-03-20

- Added `layout.alertsDir` to `.grafana-dashboard-workspace.json` and resolved alerts storage through configured project layout.
- Alerts directory is now created as part of the standard project layout during initialization.

## 0.7.0 - 2026-03-13

- First public standalone release of `Grafana Dashboard Sync`.
- Renamed the extension from the internal workspace-specific branding.
- Added public package metadata for GitHub and VS Code Marketplace.
- Promoted target, instance, and all-instance render commands in the UI.
- Reworked documentation for public installation, usage, and publishing.
