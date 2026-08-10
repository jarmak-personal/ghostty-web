import { describe, expect, test } from 'bun:test';
import {
  createAuthConfig,
  generateSessionToken,
  validateAuthenticationMessage,
  validateSessionToken,
  validateWebSocketUpgrade,
} from '../demo/bin/auth.js';

const TOKEN = '0123456789abcdef0123456789abcdef';

function testConfig(options = {}) {
  return createAuthConfig({ env: {}, token: TOKEN, ...options });
}

describe('demo auth helper', () => {
  test('generates non-empty unique session tokens', () => {
    const first = generateSessionToken();
    const second = generateSessionToken();

    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(second.length).toBeGreaterThanOrEqual(32);
    expect(first).not.toBe(second);
  });

  test('accepts a valid loopback websocket upgrade', () => {
    const result = validateWebSocketUpgrade(testConfig(), {
      host: '127.0.0.1:8080',
      origin: 'http://127.0.0.1:8080',
    });

    expect(result.ok).toBe(true);
  });

  test('rejects foreign websocket origins', () => {
    const result = validateWebSocketUpgrade(testConfig(), {
      host: '127.0.0.1:8080',
      origin: 'https://evil.example',
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
  });

  test('rejects missing websocket origins', () => {
    const result = validateWebSocketUpgrade(testConfig(), {
      host: '127.0.0.1:8080',
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
  });

  test('rejects malformed websocket origins', () => {
    const result = validateWebSocketUpgrade(testConfig(), {
      host: '127.0.0.1:8080',
      origin: 'not an origin',
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });

  test('rejects missing, malformed, and unallowed hosts', () => {
    const missing = validateWebSocketUpgrade(testConfig(), {
      origin: 'http://127.0.0.1:8080',
    });
    const malformed = validateWebSocketUpgrade(testConfig(), {
      host: 'bad host:8080',
      origin: 'http://bad host:8080',
    });
    const unallowed = validateWebSocketUpgrade(testConfig(), {
      host: 'evil.example:8080',
      origin: 'http://evil.example:8080',
    });

    expect(missing).toMatchObject({ ok: false, status: 400 });
    expect(malformed).toMatchObject({ ok: false, status: 400 });
    expect(unallowed).toMatchObject({ ok: false, status: 403 });
  });

  test('allows extra hosts only when explicitly configured', () => {
    const defaultResult = validateWebSocketUpgrade(testConfig(), {
      host: 'demo.example:8080',
      origin: 'http://demo.example:8080',
    });
    const configured = testConfig({ allowedHosts: ['demo.example'] });
    const configuredResult = validateWebSocketUpgrade(configured, {
      host: 'demo.example:8080',
      origin: 'http://demo.example:8080',
    });

    expect(defaultResult).toMatchObject({ ok: false, status: 403 });
    expect(configuredResult.ok).toBe(true);
  });

  test('allows hosts configured for wildcard and concrete binds', () => {
    const wildcard = testConfig({ env: { HOST: '0.0.0.0' } });
    const configuredWildcard = testConfig({
      env: { HOST: '0.0.0.0', GHOSTTY_ALLOWED_HOSTS: 'demo.example' },
    });
    const concrete = testConfig({ env: { HOST: 'demo.local' } });

    expect(
      validateWebSocketUpgrade(wildcard, {
        host: 'demo.example:8080',
        origin: 'http://demo.example:8080',
      })
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      validateWebSocketUpgrade(configuredWildcard, {
        host: 'demo.example:8080',
        origin: 'http://demo.example:8080',
      }).ok
    ).toBe(true);
    expect(
      validateWebSocketUpgrade(concrete, {
        host: 'demo.local:8080',
        origin: 'http://demo.local:8080',
      }).ok
    ).toBe(true);
  });

  test('authenticates session tokens without throwing on invalid lengths', () => {
    expect(validateSessionToken(testConfig(), TOKEN).ok).toBe(true);
    expect(validateSessionToken(testConfig(), undefined)).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(validateSessionToken(testConfig(), 'short')).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  test('accepts a complete authentication message', () => {
    expect(
      validateAuthenticationMessage(testConfig(), {
        type: 'authenticate',
        token: TOKEN,
        cols: 80,
        rows: 24,
      })
    ).toEqual({ ok: true, cols: 80, rows: 24 });
  });

  test('rejects missing or invalid authentication messages', () => {
    expect(validateAuthenticationMessage(testConfig(), null)).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(validateAuthenticationMessage(testConfig(), {})).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(
      validateAuthenticationMessage(testConfig(), {
        type: 'authenticate',
        token: 'invalid-token',
        cols: 80,
        rows: 24,
      })
    ).toMatchObject({ ok: false, status: 401 });
  });

  test('rejects invalid initial terminal dimensions', () => {
    for (const [cols, rows] of [
      [1, 24],
      [80, 0],
      [1001, 24],
      [80, 1001],
      [80.5, 24],
      [80, Number.NaN],
    ]) {
      expect(
        validateAuthenticationMessage(testConfig(), {
          type: 'authenticate',
          token: TOKEN,
          cols,
          rows,
        })
      ).toMatchObject({ ok: false, status: 400 });
    }
  });
});
