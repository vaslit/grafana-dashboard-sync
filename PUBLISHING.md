# Publishing Checklist

This repository is prepared for a public release under these defaults:

- GitHub repository: `vase/grafana-dashboard-sync`
- VS Code Marketplace publisher: `vase`
- Extension version: `0.7.0`

If your actual GitHub owner or Marketplace publisher differs, update [package.json](/home/vase/Projects/grafana-dashboard-sync/package.json) before publishing.

## GitHub

1. Create the GitHub repository `grafana-dashboard-sync` under the correct owner.
2. Ensure SSH or HTTPS credentials for that owner work locally.
3. Push the existing local history:

```bash
git push -u origin main --tags
```

Current remote:

```text
git@github.com:vase/grafana-dashboard-sync.git
```

## Visual Studio Marketplace

1. Create a publisher in the Visual Studio Marketplace management portal.
2. Create a Personal Access Token that can publish extensions.
3. Confirm that `publisher` in [package.json](/home/vase/Projects/grafana-dashboard-sync/package.json) exactly matches the Marketplace publisher ID.
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
grafana-dashboard-sync-0.7.0.vsix
```
