# @ghostty-web/demo

Cross-platform demo server for [ghostty-web](https://github.com/coder/ghostty-web) terminal emulator.

## Quick Start

```bash
npx @ghostty-web/demo@next
```

This starts a local web server with a fully functional terminal connected to your shell.
Works on **Linux** and **macOS** (no Windows support yet).

## What it does

- Starts an HTTP server on `127.0.0.1:8080` by default (`PORT` and `HOST` are configurable)
- Serves WebSocket PTY on the same port at `/ws` endpoint
- Protects `/ws` with a per-run capability in the launch URL fragment
- Rejects cross-origin WebSocket handshakes
- Opens a real shell session (bash, zsh, etc.)
- Provides full PTY support (colors, cursor positioning, resize, etc.)

## Retained-history benchmark

Run `bun run dev`, then open
`http://localhost:8000/demo/retained-history-benchmark.html`. The benchmark compares ANSI-rich
history at 10% and 100% of hvir's 10 MB scrollback budget using a 160×60 viewport. It warms each
case for 10 seconds and reports configured/estimated retained bytes, retained rows, input bytes,
render requests, frames, rows/cells materialized, rows painted, and frame p50/p95/max. Query
parameters `warmupMs` and `measurementMs` may shorten local smoke runs; acceptance evidence uses
the defaults.

## Usage

```bash
# Default (port 8080)
npx @ghostty-web/demo@next

# Custom port
PORT=3000 npx @ghostty-web/demo@next

# Explicit bind host for intentional non-default access
HOST=192.0.2.10 GHOSTTY_ALLOWED_HOSTS=demo.example npx @ghostty-web/demo@next
```

Then open the complete capability URL printed by the server in your browser.

## Bind host and proxy configuration

The demo binds to `127.0.0.1` by default and only allows loopback hostnames (`localhost`, `127.0.0.1`, and `::1`) unless configured otherwise. Set `HOST=<host>` to change the bind address. If you serve the demo through another hostname, or bind to a wildcard such as `HOST=0.0.0.0`, add the browser-visible hostnames with `GHOSTTY_ALLOWED_HOSTS=host1,host2`.

The browser reads the per-run capability from the launch URL fragment, which is not sent in HTTP requests, and authenticates as the first WebSocket message before a PTY is created. The server also rejects WebSocket upgrades when the `Host` is not allowed or the `Origin` does not match the request host. Do not publish, log, or share the launch URL.

### Example with nginx

```nginx
server {
    listen 80;
    server_name example.com;

    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

## Security Warning

⚠️ **This server provides full shell access.**

Only use for local development and demos. Keep the default loopback bind unless you intentionally need remote access and have configured `HOST` and `GHOSTTY_ALLOWED_HOSTS` for the exact hostnames you trust. Anyone who obtains the printed launch URL can open a shell as the user running the demo.
