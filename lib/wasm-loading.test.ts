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
  test('init loads an exact external URL', async () => {
    const wasm = await Bun.file(wasmPath).arrayBuffer();
    let requests = 0;
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
      expect(request.url).toBe('/assets/ghostty-vt.wasm');
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
    await Promise.all([init({ wasmUrl }), init({ wasmUrl: new URL(String(wasmUrl)) })]);
    await init();

    expect(getGhostty()).toBeInstanceOf(Ghostty);
    expect(requests).toBe(1);
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
});
