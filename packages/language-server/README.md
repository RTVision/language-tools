# @vue/language-server

<p>
  <a href="https://www.npmjs.com/package/@vue/language-server"><img src="https://img.shields.io/npm/v/@vue/language-server.svg?labelColor=18181B&color=1584FC" alt="NPM version"></a>
  <a href="https://github.com/vuejs/language-tools/blob/master/LICENSE"><img src="https://img.shields.io/github/license/vuejs/language-tools.svg?labelColor=18181B&color=1584FC" alt="License"></a>
</p>

A Vue language server based on the [Language Server Protocol](https://microsoft.github.io/language-server-protocol/). This package provides an executable language server that can be integrated with any LSP-compatible editor.

## Installation

```bash
npm install @vue/language-server
```

## Command-Line Usage

After installation, the `vue-language-server` command is available:

```bash
# Start in stdio mode
vue-language-server --stdio

# Check version
vue-language-server --version

# Specify TypeScript SDK path
vue-language-server --stdio --tsdk=/path/to/typescript/lib

# Use tsgo-backed request bridge (experimental)
vue-language-server --stdio --ts-backend=tsgo-lsp --tsgo=/path/to/tsgo
```

### `--tsdk` Parameter

The `--tsdk` parameter is used to specify the path to the TypeScript SDK. This is useful when you need to use a specific version of TypeScript from your project instead of the globally installed version. The path should point to TypeScript's `lib` directory.

### TypeScript Backend Selection

Use `--ts-backend=tsserver|tsgo-lsp|auto` to select the request backend used by the server:

- `tsserver` (default): current bridge through `tsserver/request` notifications
- `tsgo-lsp`: start a `tsgo --lsp` sidecar and use an internal tsserver IPC fallback for Vue plugin-specific requests
- `auto`: prefer `tsgo` when available, otherwise fallback to `tsserver`

Use `--tsgo=/path/to/tsgo` (or `VUE_LANGUAGE_SERVER_TSGO_PATH`) to override the `tsgo` executable path.

## Editor Integration

### VSCode

Simply install the [Vue (Official)](https://marketplace.visualstudio.com/items?itemName=Vue.volar) extension, which already includes this language server.

### Neovim

Configure via [nvim-lspconfig](https://github.com/neovim/nvim-lspconfig):

```lua
require('lspconfig').volar.setup({})
```

### Sublime Text

See [sublimelsp/LSP-volar](https://github.com/sublimelsp/LSP-volar).

### Emacs

See [lsp-mode](https://github.com/emacs-lsp/lsp-mode) for Vue support.

## Programmatic Usage

If you need to start the language server within your own program:

```typescript
import { startServer } from '@vue/language-server/lib/server';
import * as ts from 'typescript';

// startServer creates an LSP connection and starts listening
// Requires communication with the client via stdio or other means
startServer(ts);
```

> **Note**: `startServer` creates a stdio-based LSP connection. In `tsserver` backend mode it communicates with `@vue/typescript-plugin` through `tsserver/request` and `tsserver/response` notifications; in `tsgo-lsp` mode it uses local `tsgo` + tsserver sidecars.

## Collaboration with TypeScript Plugin

This language server can communicate with `@vue/typescript-plugin` through custom `tsserver/request` and `tsserver/response` notifications, or through an internal tsserver IPC sidecar when `--ts-backend=tsgo-lsp` is selected.

## Related Packages

- [`@vue/language-core`](../language-core) - Core module
- [`@vue/language-service`](../language-service) - Language service plugins
- [`@vue/typescript-plugin`](../typescript-plugin) - TypeScript plugin

## License

[MIT](https://github.com/vuejs/language-tools/blob/master/LICENSE) License
