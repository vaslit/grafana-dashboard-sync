# Publishing Checklist

This repository is prepared for a public release under these defaults:

- GitHub repository: `vaslit/grafana-dashboard-sync`
- VS Code Marketplace publisher: `vaslit`
- Extension version: `0.9.0`

## GitHub Releases Automation

GitHub Actions publishes a release automatically on pushes to `main` when the `version` field in [package.json](package.json) changes.

Automation behavior:

- runs `npm ci`
- runs `npm test`
- runs `npm run package`
- creates tag `v<version>` if it does not exist yet
- creates or updates the matching GitHub Release
- uploads `grafana-dashboard-sync-<version>.vsix`
- supports manual `workflow_dispatch` with `force_release=true` for a one-off release without a version bump

If your actual GitHub owner or Marketplace publisher differs, update [package.json](package.json) before publishing.

## GitHub

1. Create the GitHub repository `grafana-dashboard-sync` under the correct owner.
2. Ensure SSH or HTTPS credentials for that owner work locally.
3. Push the existing local history:

```bash
git push -u origin main --tags
```

Current remote:

```text
git@github.com:vaslit/grafana-dashboard-sync.git
```

## Visual Studio Marketplace

1. Create a publisher in the Visual Studio Marketplace management portal.
2. Create a Personal Access Token that can publish extensions.
3. Confirm that `publisher` in [package.json](package.json) exactly matches the Marketplace publisher ID.
4. Publish:

```bash
npm run publish:marketplace
```

Or with an explicit token:

```bash
VSCE_PAT=your_token_here npm run publish:marketplace
```

## Local Validation

Build:

```bash
npm run compile
```

Test:

```bash
npm test
```

Package:

```bash
npm run package
```

Expected artifact:

```text
grafana-dashboard-sync-0.8.17.vsix
```
