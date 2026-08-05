# ghostty-web

> [!NOTE]
> This is an [hvir](https://github.com/jarmak-personal/hvir)-maintained compatibility fork of
> [ghostty-web](https://github.com/coder/ghostty-web). It is not intended to replace or compete
> with upstream. We maintain a small, reviewable patch set so hvir alpha users can validate
> selected reliability fixes while generally useful changes are prepared for upstream. We are
> grateful to the ghostty-web and Ghostty maintainers for the substantial work this fork builds
> on. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the fork and upstream contribution workflow.

[![NPM Version](https://img.shields.io/npm/v/ghostty-web)](https://npmjs.com/package/ghostty-web) [![NPM Downloads](https://img.shields.io/npm/dw/ghostty-web)](https://npmjs.com/package/ghostty-web) [![npm bundle size](https://img.shields.io/bundlephobia/minzip/ghostty-web)](https://npmjs.com/package/ghostty-web) [![license](https://img.shields.io/github/license/coder/ghostty-web)](./LICENSE)

[Ghostty](https://github.com/ghostty-org/ghostty) for the web with [xterm.js](https://github.com/xtermjs/xterm.js) API compatibility — giving you a proper VT100 implementation in the browser.

- Migrate from xterm by changing your import: `@xterm/xterm` → `ghostty-web`
- WASM-compiled parser from Ghostty—the same code that runs the native app
- Zero runtime dependencies, ~400KB WASM bundle

Originally created for [Mux](https://github.com/coder/mux) (a desktop app for isolated, parallel agentic development), but designed to be used anywhere.

## Try It

- [Live Demo](https://ghostty.ondis.co) on an ephemeral VM (thank you to Greg from [disco.cloud](https://disco.cloud) for hosting).

- On your computer:

  ```bash
  npx @ghostty-web/demo@next
  ```

  This starts a loopback-only HTTP server with a real shell on `http://127.0.0.1:8080`. The demo protects `/ws` with a per-run same-origin token and rejects cross-origin WebSocket handshakes. Works best on Linux and macOS.

  To intentionally bind somewhere else, set `HOST=<host>`. If you serve the demo through extra hostnames or a wildcard bind such as `HOST=0.0.0.0`, also set `GHOSTTY_ALLOWED_HOSTS=host1,host2`. Avoid remote exposure unless you understand the risk: the demo starts a real local shell.

![ghostty](https://github.com/user-attachments/assets/aceee7eb-d57b-4d89-ac3d-ee1885d0187a)

## Comparison with xterm.js

xterm.js is everywhere—VS Code, Hyper, countless web terminals. But it has fundamental issues:

| Issue                                    | xterm.js                                                         | ghostty-web                |
| ---------------------------------------- | ---------------------------------------------------------------- | -------------------------- |
| **Complex scripts** (Devanagari, Arabic) | Rendering issues                                                 | ✓ Proper grapheme handling |
| **XTPUSHSGR/XTPOPSGR**                   | [Not supported](https://github.com/xtermjs/xterm.js/issues/2570) | ✓ Full support             |

xterm.js reimplements terminal emulation in JavaScript. Every escape sequence, every edge case, every Unicode quirk—all hand-coded. Ghostty's emulator is the same battle-tested code that runs the native Ghostty app.

## Installation

```bash
npm install ghostty-web
```

## Usage

ghostty-web aims to be API-compatible with the xterm.js API.

```javascript
import { init, Terminal } from 'ghostty-web';

await init();

const term = new Terminal({
  fontSize: 14,
  theme: {
    background: '#1a1b26',
    foreground: '#a9b1d6',
  },
});

term.open(document.getElementById('terminal'));
term.onData((data) => websocket.send(data));
websocket.onmessage = (e) => term.write(e.data);
```

The hvir compatibility artifact also exposes typed events sourced directly from Ghostty's parser:

```typescript
term.onTerminalEvent((event) => {
  if (event.type === 'working-directory') {
    console.log(event.uri); // Untrusted application-provided value
  }
});
```

Event families cover title, working directory, bell, notification and progress requests, semantic
markers, palette operations, and clipboard requests. Clipboard and notification events are requests
only; ghostty-web does not grant clipboard or platform-notification authority. Semantic marker
provenance can be checked with `term.resolveEventProvenance()` and fails closed after its retained row
expires. Notification records expose the closed `osc-9` or `osc-777` parser source so an embedder can
preserve source-specific presentation policy without interpreting raw escape sequences.

The Canvas scheduler also honors Ghostty's parser-owned synchronized-output mode (DEC private mode
2026). Parsing and terminal responses continue while presentation is deferred; completion produces
one full frame, and abandoned synchronization is released after Ghostty's one-second safety timeout.
`getRenderStats()` reports the live synchronized-output state and timeout-recovery count without
retaining terminal content.

Embedding applications that own terminal menu presentation can disable ghostty-web's legacy
hidden-textarea bridge at construction time. The host remains responsible for clipboard access and
focus restoration:

```typescript
const term = new Terminal({ disableContextMenu: true });
```

With that option, right-click does not mutate or focus the hidden textarea and is not forwarded as
terminal mouse input. Selection remains available through side-effect-free `hasSelection()` and
`getSelection()` calls. Hosts can invoke `paste(text)`, `selectAll()`, `clear()`, and `reset()`;
clear and reset mutate only client-side terminal state and never emit PTY input through `onData`.

For a comprehensive client <-> server example, refer to the [demo](./demo/index.html#L141).

## Development

ghostty-web builds from Ghostty's source with a [patch](./patches/ghostty-wasm-api.patch) to expose additional
functionality.

> Requires Zig and Bun.

```bash
bun run build
```

Mitchell Hashimoto (author of Ghostty) has [been working](https://mitchellh.com/writing/libghostty-is-coming) on `libghostty` which makes this all possible. The patches are very minimal thanks to the work the Ghostty team has done, and we expect them to get smaller.

This library will eventually consume a native Ghostty WASM distribution once available, and will continue to provide an xterm.js compatible API.

At Coder we're big fans of Ghostty, so kudos to that team for all the amazing work.

## License

[MIT](./LICENSE)
