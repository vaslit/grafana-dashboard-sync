# Local Build Notes

This project can be built and packaged even if the shell does not have `node` or `npm`,
as long as VS Code is installed and its bundled Electron binary is available.

## Use VS Code bundled Node

VS Code ships its own Node runtime inside the Electron binary. Use the actual binary, not
the `code` shell wrapper:

```bash
ELECTRON_RUN_AS_NODE=1 /usr/share/code/code -e "console.log(process.version)"
```

In this repository, the working build flow is:

```bash
ELECTRON_RUN_AS_NODE=1 /usr/share/code/code ./node_modules/typescript/bin/tsc -p ./
ELECTRON_RUN_AS_NODE=1 /usr/share/code/code --test ./out/test/*.test.js
ELECTRON_RUN_AS_NODE=1 /usr/share/code/code ./node_modules/@vscode/vsce/vsce package --no-dependencies -o grafana-dashboard-sync-<version>-local.vsix
code --install-extension ./grafana-dashboard-sync-<version>-local.vsix --force
```

If `/usr/share/code/code` is different on your machine, replace it with the actual VS Code binary path for your OS.

## Why `--no-dependencies`

`vsce` tries to call `npm -v` even when system `npm` is missing. In this repo, packaging works with:

```bash
vsce package --no-dependencies
```

That is acceptable here because `node_modules/` is already present and the extension payload is taken from `out/`, `media/`, and metadata files.

## Standard flow when system Node is available

If `node` and `npm` are installed in the shell, the regular commands are still preferred:

```bash
npm run compile
npm test
npm run package
code --install-extension ./grafana-dashboard-sync-<version>.vsix --force
```
