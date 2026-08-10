import { afterEach, describe, expect, test } from 'bun:test';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { Ghostty } from './ghostty';
import { getGhostty, init } from './index';

const wasmPath = resolve(import.meta.dir, '../ghostty-vt.wasm');
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolveClose, reject) => {
          server.close((error) => (error ? reject(error) : resolveClose()));
        })
    )
  );
});

describe('external WASM loading', () => {
  test('init retries after failure and shares an exact external URL', async () => {
    const wasm = await Bun.file(wasmPath).arrayBuffer();
    let failNextRequest = true;
    let requests = 0;
    const requestedPaths: string[] = [];
    const server = createServer((request, response) => {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': 'GET',
          'Access-Control-Allow-Origin': '*',
        });
        response.end();
        return;
      }
      requests++;
      requestedPaths.push(request.url ?? '');
      if (failNextRequest) {
        failNextRequest = false;
        response.writeHead(503, 'Service Unavailable', {
          'Access-Control-Allow-Origin': '*',
          'Content-Length': 0,
        });
        response.end();
        return;
      }
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Content-Length': wasm.byteLength,
        'Content-Type': 'application/wasm',
      });
      response.end(Buffer.from(wasm));
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Test server did not bind a port.');

    const wasmUrl = new URL('/assets/ghostty-vt.wasm', `http://127.0.0.1:${address.port}`);
    await expect(init({ wasmUrl })).rejects.toThrow(
      `Failed to load Ghostty WASM from ${wasmUrl}: Failed to fetch WASM: 503 Service Unavailable`
    );
    await Promise.all([init({ wasmUrl }), init({ wasmUrl: new URL(String(wasmUrl)) })]);
    await init();

    expect(getGhostty()).toBeInstanceOf(Ghostty);
    expect(requests).toBe(2);
    expect(requestedPaths).toEqual(['/assets/ghostty-vt.wasm', '/assets/ghostty-vt.wasm']);
    await expect(
      init({ wasmUrl: new URL('/assets/other.wasm', `http://127.0.0.1:${address.port}`) })
    ).rejects.toThrow(
      'ghostty-web is already initializing or initialized with a different WASM URL.'
    );
  });

  test('reports the exact URL and HTTP failure', async () => {
    const server = createServer((request, response) => {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': 'GET',
          'Access-Control-Allow-Origin': '*',
        });
        response.end();
        return;
      }
      response.writeHead(404, 'Not Found', {
        'Access-Control-Allow-Origin': '*',
        'Content-Length': 0,
      });
      response.end();
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Test server did not bind a port.');
    const wasmUrl = new URL('/missing.wasm', `http://127.0.0.1:${address.port}`);

    await expect(Ghostty.load(wasmUrl)).rejects.toThrow(
      `Failed to load Ghostty WASM from ${wasmUrl}: Failed to fetch WASM: 404 Not Found`
    );
  });

  test('rejects an empty path and preserves local filesystem errors', async () => {
    await expect(Ghostty.load('')).rejects.toThrow('Ghostty WASM path must not be empty.');

    const missingPath = resolve(import.meta.dir, '../missing-ghostty-vt.wasm');
    await expect(Ghostty.load(missingPath)).rejects.toThrow(/ENOENT/);
  });
});
