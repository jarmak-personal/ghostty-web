import { afterEach, describe, expect, test } from 'bun:test';
import type { ITerminalOptions } from './interfaces';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

const terminals: Terminal[] = [];
const containers: HTMLElement[] = [];

async function openTerminal(options: Omit<ITerminalOptions, 'ghostty'> = {}): Promise<Terminal> {
  const terminal = await createIsolatedTerminal(options);
  const container = document.createElement('div');
  document.body.appendChild(container);
  terminal.open(container);
  terminals.push(terminal);
  containers.push(container);
  return terminal;
}

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
  for (const container of containers.splice(0)) container.remove();
});

describe('retained normal-buffer search', () => {
  test('uses explicit literal case policy and keeps non-ASCII case byte-exact', async () => {
    const terminal = await openTerminal({ cols: 30, rows: 3 });
    terminal.write('Alpha alpha É é');

    const sensitive = await terminal.searchRetainedBuffer('Alpha', { caseSensitive: true });
    expect(sensitive.matches).toHaveLength(1);
    expect(sensitive.extract(sensitive.matches[0])).toBe('Alpha');

    const insensitive = await terminal.searchRetainedBuffer('alpha', { caseSensitive: false });
    expect(insensitive.matches).toHaveLength(2);
    expect(insensitive.matches.map((range) => insensitive.extract(range))).toEqual([
      'Alpha',
      'alpha',
    ]);

    const nonAscii = await terminal.searchRetainedBuffer('é', { caseSensitive: false });
    expect(nonAscii.matches).toHaveLength(1);
    expect(nonAscii.extract(nonAscii.matches[0])).toBe('é');
  });

  test('maps wide and multi-codepoint grapheme cells to deterministic inclusive ranges', async () => {
    const terminal = await openTerminal({ cols: 30, rows: 3 });
    terminal.write('xx界e\u0301👩‍💻yy');

    const wide = await terminal.searchRetainedBuffer('界', { caseSensitive: true });
    expect(wide.matches[0]).toEqual({
      start: { row: 0, column: 2 },
      end: { row: 0, column: 2 },
    });
    expect(wide.extract(wide.matches[0])).toBe('界');

    const combining = await terminal.searchRetainedBuffer('e\u0301', { caseSensitive: true });
    expect(combining.matches[0].start).toEqual(combining.matches[0].end);
    expect(combining.extract(combining.matches[0])).toBe('e\u0301');

    const emoji = await terminal.searchRetainedBuffer('👩‍💻', { caseSensitive: true });
    expect(emoji.matches[0].start).toEqual(emoji.matches[0].end);
    expect(emoji.extract(emoji.matches[0])).toBe('👩‍💻');
    expect(Object.isFrozen(emoji.matches[0])).toBe(true);
    expect(Object.isFrozen(emoji.matches[0].start)).toBe(true);
  });

  test('extracts only the matched substring inside surrounding cells', async () => {
    const terminal = await openTerminal({ cols: 20, rows: 2 });
    terminal.write('before TARGET after');

    const result = await terminal.searchRetainedBuffer('TARGET', { caseSensitive: true });
    expect(result.matches).toHaveLength(1);
    expect(result.extract(result.matches[0])).toBe('TARGET');
    expect(terminal.extractRetainedBufferText(result.matches[0])).toBe('TARGET');
  });

  test('joins soft wraps but preserves hard row boundaries in exact extraction', async () => {
    const soft = await openTerminal({ cols: 5, rows: 3 });
    soft.write('abcdeFGHIJ');
    const softResult = await soft.searchRetainedBuffer('deFG', { caseSensitive: true });
    expect(softResult.matches).toHaveLength(1);
    expect(softResult.matches[0]).toEqual({
      start: { row: 0, column: 3 },
      end: { row: 1, column: 1 },
    });
    expect(softResult.extract(softResult.matches[0])).toBe('deFG');

    const hard = await openTerminal({ cols: 10, rows: 3 });
    hard.write('left\r\nright');
    const hardResult = await hard.searchRetainedBuffer('ft\nri', { caseSensitive: true });
    expect(hardResult.matches).toHaveLength(1);
    expect(hardResult.extract(hardResult.matches[0])).toBe('ft\nri');
  });

  test('maps a hard match across the retained history-to-active boundary', async () => {
    const terminal = await openTerminal({ cols: 10, rows: 2, scrollback: 20 });
    terminal.write('zero\r\none\r\ntwo');
    expect(terminal.getScrollbackLength()).toBeGreaterThan(0);

    const result = await terminal.searchRetainedBuffer('zero\none', { caseSensitive: true });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toEqual({
      start: { row: 0, column: 0 },
      end: { row: 1, column: 2 },
    });
    expect(result.extract(result.matches[0])).toBe('zero\none');
  });

  test('orders matches from oldest to newest across retained rows', async () => {
    const terminal = await openTerminal({ cols: 16, rows: 2, scrollback: 20 });
    terminal.write('needle-old\r\nplain\r\nneedle-new');

    const result = await terminal.searchRetainedBuffer('needle', { caseSensitive: true });
    expect(result.matches).toHaveLength(2);
    expect(result.matches.map((range) => range.start.row)).toEqual([0, 2]);
    expect(result.matches.map((range) => result.extract(range))).toEqual(['needle', 'needle']);
  });

  test('searches primary cells while alternate is active and survives alt-only output', async () => {
    const terminal = await openTerminal({ cols: 20, rows: 3 });
    terminal.write('primary needle');
    terminal.write('\x1b[?1049h');
    terminal.write('alternate needle');

    const result = await terminal.searchRetainedBuffer('needle', { caseSensitive: true });
    expect(result.matches).toHaveLength(1);
    expect(result.extract(result.matches[0])).toBe('needle');

    terminal.write('\r\nalternate-only');
    expect(result.extract(result.matches[0])).toBe('needle');
    // One parser slice that leaves alt, mutates primary, and re-enters alt
    // must not be mistaken for wholly alternate output.
    terminal.write('\x1b[?1049lX\x1b[?1049h');
    expect(result.extract(result.matches[0])).toBeUndefined();
  });

  test('fails closed after primary output evicts retained scrollback', async () => {
    const terminal = await openTerminal({ cols: 12, rows: 2, scrollback: 8 });
    terminal.write('evict-me\r\nline-1\r\nline-2');
    const result = await terminal.searchRetainedBuffer('evict-me', { caseSensitive: true });
    const range = result.matches[0];
    expect(result.extract(range)).toBe('evict-me');

    for (let i = 0; i < 20; i++) terminal.write(`\r\nline-${i + 3}`);
    expect(result.extract(range)).toBeUndefined();
    expect(terminal.extractRetainedBufferText(range)).toBeUndefined();
  });

  test('rejects foreign, reset, resized, disposed, and explicitly released ranges', async () => {
    const first = await openTerminal({ cols: 20, rows: 3 });
    const second = await openTerminal({ cols: 20, rows: 3 });
    first.write('needle');
    second.write('needle');
    const firstResult = await first.searchRetainedBuffer('needle', { caseSensitive: true });
    const secondResult = await second.searchRetainedBuffer('needle', { caseSensitive: true });
    const firstRange = firstResult.matches[0];

    expect(second.extractRetainedBufferText(firstRange)).toBeUndefined();
    expect(secondResult.extract(firstRange)).toBeUndefined();

    first.resize(21, 3);
    expect(firstResult.extract(firstRange)).toBeUndefined();

    const afterResize = await first.searchRetainedBuffer('needle', { caseSensitive: true });
    const resizedRange = afterResize.matches[0];
    first.reset();
    expect(afterResize.extract(resizedRange)).toBeUndefined();

    secondResult.dispose();
    expect(secondResult.extract(secondResult.matches[0])).toBeUndefined();
    second.dispose();
    expect(secondResult.extract(secondResult.matches[0])).toBeUndefined();
  });

  test('query replacement, AbortSignal, manual cancellation, and disposal suppress stale completion', async () => {
    const terminal = await openTerminal({ cols: 20, rows: 3, scrollback: 2000 });
    for (let i = 0; i < 500; i++) terminal.write(`old-${i}\r\n`);
    terminal.write('current');

    const stale = terminal.searchRetainedBuffer('old', { caseSensitive: true });
    const current = terminal.searchRetainedBuffer('current', { caseSensitive: true });
    await expect(stale).rejects.toMatchObject({ name: 'AbortError' });
    expect((await current).matches).toHaveLength(1);

    const controller = new AbortController();
    const aborted = terminal.searchRetainedBuffer('old', {
      caseSensitive: true,
      signal: controller.signal,
    });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });

    const cancelled = terminal.searchRetainedBuffer('old', { caseSensitive: true });
    terminal.cancelRetainedBufferSearch();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });

    const disposed = terminal.searchRetainedBuffer('old', { caseSensitive: true });
    terminal.dispose();
    await expect(disposed).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('resize and reset cancel in-flight work before it can publish', async () => {
    const terminal = await openTerminal({ cols: 20, rows: 3, scrollback: 2000 });
    for (let i = 0; i < 500; i++) terminal.write(`needle-${i}\r\n`);

    const resized = terminal.searchRetainedBuffer('needle', { caseSensitive: true });
    terminal.resize(21, 3);
    await expect(resized).rejects.toMatchObject({ name: 'AbortError' });

    const reset = terminal.searchRetainedBuffer('needle', { caseSensitive: true });
    terminal.reset();
    await expect(reset).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('rejects over-64KiB UTF-8 queries without leaking current state', async () => {
    const terminal = await openTerminal({ cols: 20, rows: 3 });
    terminal.write('needle');

    await expect(
      terminal.searchRetainedBuffer('x'.repeat(64 * 1024 + 1), { caseSensitive: true })
    ).rejects.toThrow('Unable to create retained-buffer search');

    const result = await terminal.searchRetainedBuffer('needle', { caseSensitive: true });
    expect(result.matches).toHaveLength(1);
    expect(result.extract(result.matches[0])).toBe('needle');
  });

  test('empty and high-match queries remain bounded and release superseded state', async () => {
    const terminal = await openTerminal({ cols: 4, rows: 2, scrollback: 10_000_000 });
    const empty = await terminal.searchRetainedBuffer('', { caseSensitive: true });
    expect(empty.matches).toEqual([]);

    for (let i = 0; i < 400; i++) terminal.write('x\r\n');
    const originalSetTimeout = globalThis.setTimeout;
    let scheduled = 0;
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      scheduled++;
      return originalSetTimeout(handler, timeout, ...args);
    }) as typeof setTimeout;
    try {
      const result = await terminal.searchRetainedBuffer('x', { caseSensitive: true });
      expect(result.matches.length).toBeGreaterThan(128);
      expect(scheduled).toBeGreaterThan(2);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});
