import { afterEach, describe, expect, test } from 'bun:test';
import { GhosttyTerminal } from './ghostty';
import type { ITerminalOptions } from './interfaces';
import { RetainedBufferSearchManager } from './retained-buffer-search';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';
import type { GhosttyWasmExports } from './types';

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
    expect(wide.matches[0]).toMatchObject({
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
    expect(softResult.matches[0]).toMatchObject({
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
    expect(result.matches[0]).toMatchObject({
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
    expect(result.extract(result.matches[0])).toBe('needle');
  });

  test('fails closed after primary output evicts retained scrollback', async () => {
    const terminal = await openTerminal({ cols: 80, rows: 2, scrollbackBytes: 65536 });
    terminal.write('evict-me\r\nline-1\r\nline-2');
    const result = await terminal.searchRetainedBuffer('evict-me', { caseSensitive: true });
    const range = result.matches[0];
    expect(result.extract(range)).toBe('evict-me');

    for (let i = 0; i < 4000; i++) terminal.write(`\r\nline-${i + 3}`);
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

    const allocations: number[] = [];
    const nativeCreates: number[] = [];
    const memory = new WebAssembly.Memory({ initial: 2 });
    const exports = {
      memory,
      ghostty_terminal_new: () => 1,
      ghostty_wasm_alloc_u8_array: (length: number) => {
        allocations.push(length);
        return 8;
      },
      ghostty_wasm_free_u8_array: () => {},
      ghostty_terminal_retained_search_create: (
        _handle: number,
        _pointer: number,
        length: number
      ) => {
        nativeCreates.push(length);
        return 1;
      },
    } as unknown as GhosttyWasmExports;
    const wrapper = new GhosttyTerminal(exports, memory, 1, 1);

    expect(wrapper.createRetainedSearch('x'.repeat(64 * 1024 + 1), true)).toBe(0);
    expect(wrapper.createRetainedSearch('界'.repeat((64 * 1024) / 3 + 1), true)).toBe(0);
    expect(allocations).toEqual([]);
    expect(nativeCreates).toEqual([]);

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

async function waitUntil(predicate: () => boolean, timeout = 2000): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('Search update timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('finite producer allows initial completion and new counts while still writing', async () => {
  const terminal = await openTerminal({ cols: 80, rows: 4, scrollbackBytes: 10_000_000 });
  terminal.write('needle-first\r\nneedle-second\r\n');
  let writes = 0;
  let active = true;
  const producer = setInterval(() => {
    terminal.write(`unrelated ${writes++}\r\n`);
    if (writes === 30) terminal.write('needle-third\r\n');
    if (writes === 200) {
      active = false;
      clearInterval(producer);
    }
  }, 5);
  try {
    const result = await terminal.searchRetainedBuffer('needle', { caseSensitive: true });
    expect(result.pending).toBe(false);
    expect(result.matches).toHaveLength(2);
    expect(active).toBe(true);
    const selected = result.matches[1];
    let updates = 0;
    const subscription = result.onUpdate(() => updates++);
    await waitUntil(() => !result.pending && result.matches.length === 3);
    expect(active).toBe(true);
    expect(result.matches[1]).toBe(selected);
    expect(result.resolve(selected)?.id).toBe(selected.id);
    expect(result.extract(selected)).toBe('needle');
    expect(updates).toBeGreaterThan(0);
    subscription.dispose();
    const stopped = updates;
    terminal.write('more\r\n');
    expect(updates).toBe(stopped);
  } finally {
    clearInterval(producer);
  }
});

test('same-row append preserves identity, identical overwrite and erase revoke it', async () => {
  const terminal = await openTerminal({ cols: 80, rows: 4 });
  terminal.write('needle');
  const result = await terminal.searchRetainedBuffer('needle', { caseSensitive: true });
  const old = result.matches[0];
  terminal.write(' suffix');
  expect(result.extract(old)).toBe('needle');
  await waitUntil(() => !result.pending && result.matches.length === 1);
  terminal.write('\rneedle');
  expect(result.resolve(old)).toBeUndefined();
  expect(result.extract(old)).toBeUndefined();
  await waitUntil(() => !result.pending && result.matches[0]?.id !== old.id);
  const replacement = result.matches[0];
  expect(result.extract(replacement)).toBe('needle');
  expect(result.extract({ ...replacement })).toBeUndefined();
  terminal.write('\r\x1b[2K');
  expect(result.extract(replacement)).toBeUndefined();
  await waitUntil(() => !result.pending && result.matches.length === 0);
});

test('Unicode identity survives append and compaction; grapheme mutation revokes it', async () => {
  const terminal = await openTerminal({ cols: 80, rows: 4, scrollbackBytes: 10_000_000 });
  terminal.write('界e\u0301👩‍💻\r\n');
  const result = await terminal.searchRetainedBuffer('界e\u0301👩‍💻', { caseSensitive: true });
  const selected = result.matches[0];
  for (let i = 0; i < 2000; i++) terminal.write(`other ${i}\r\n`);
  expect(result.extract(selected)).toBe('界e\u0301👩‍💻');
  expect(result.resolve(selected)).toBeDefined();
  const combining = await openTerminal({ cols: 20, rows: 3 });
  combining.write('e');
  const plain = await combining.searchRetainedBuffer('e', { caseSensitive: true });
  combining.write('\u0301');
  expect(plain.extract(plain.matches[0])).toBeUndefined();
});

test('reflow revokes updates before a listener can synchronously replace the query', async () => {
  const terminal = await openTerminal({ cols: 20, rows: 3 });
  terminal.write('needle');
  const old = await terminal.searchRetainedBuffer('needle', { caseSensitive: true });
  let replacement: ReturnType<Terminal['searchRetainedBuffer']> | undefined;
  let updates = 0;
  old.onUpdate(() => {
    updates++;
    if (old.invalidated)
      replacement = terminal.searchRetainedBuffer('needle', { caseSensitive: true });
  });
  terminal.resize(21, 3);
  expect(old.invalidated).toBe(true);
  expect(old.resolve(old.matches[0])).toBeUndefined();
  expect(replacement).toBeDefined();
  expect((await replacement!).matches).toHaveLength(1);
  const revokedUpdates = updates;
  terminal.write(' other');
  expect(updates).toBe(revokedUpdates);
});

test('resolved-query abort, parser reset and disposal revoke subscriptions and ranges', async () => {
  const terminal = await openTerminal({ cols: 20, rows: 3 });
  terminal.write('needle');
  const abort = new AbortController();
  const result = await terminal.searchRetainedBuffer('needle', {
    caseSensitive: true,
    signal: abort.signal,
  });
  const range = result.matches[0];
  let updates = 0;
  result.onUpdate(() => updates++);
  abort.abort();
  terminal.write('more');
  expect(result.extract(range)).toBeUndefined();
  expect(updates).toBe(0);
  const reset = await terminal.searchRetainedBuffer('needle', { caseSensitive: true });
  let invalidated = false;
  reset.onUpdate(() => {
    invalidated = reset.invalidated;
  });
  terminal.write('\x1bc');
  expect(invalidated).toBe(true);
  expect(reset.extract(reset.matches[0])).toBeUndefined();
});

test('engine reset invalidates a resolved query before revoking its update subscription', async () => {
  const terminal = await openTerminal({ cols: 20, rows: 3 });
  terminal.write('needle');
  const result = await terminal.searchRetainedBuffer('needle', { caseSensitive: true });
  const range = result.matches[0];
  let invalidations = 0;
  result.onUpdate(() => {
    expect(result.invalidated).toBe(true);
    expect(result.pending).toBe(false);
    expect(result.matches).toHaveLength(0);
    expect(result.resolve(range)).toBeUndefined();
    invalidations++;
  });
  terminal.reset();
  expect(invalidations).toBe(1);
  terminal.write('needle');
  const fresh = await terminal.searchRetainedBuffer('needle', { caseSensitive: true });
  expect(fresh.matches).toHaveLength(1);
  expect(invalidations).toBe(1);
});

test('clear revokes erased cells through parser updates while the query remains live', async () => {
  const terminal = await openTerminal({ cols: 20, rows: 3 });
  terminal.write('needle');
  const result = await terminal.searchRetainedBuffer('needle', { caseSensitive: true });
  const range = result.matches[0];
  let updates = 0;
  result.onUpdate(() => updates++);
  terminal.clear();
  expect(result.resolve(range)).toBeUndefined();
  expect(result.invalidated).toBe(false);
  const deadline = performance.now() + 2000;
  while (result.matches.length > 0 || result.pending) {
    if (performance.now() > deadline) throw new Error('cleared query did not update');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(updates).toBeGreaterThan(0);
  terminal.write('needle');
  while (result.matches.length === 0 || result.pending) {
    if (performance.now() > deadline) throw new Error('live cleared query did not find new output');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(result.extract(result.matches[0])).toBe('needle');
});

test('native replacement revokes the old owner without cancelling a foreign query with the same ID', async () => {
  const first = await openTerminal({ cols: 20, rows: 3 });
  const second = await openTerminal({ cols: 20, rows: 3 });
  first.write('first');
  second.write('second');
  let current = first.wasmTerm;
  const manager = new RetainedBufferSearchManager(() => current);
  try {
    const old = await manager.search('first', { caseSensitive: true });
    const range = old.matches[0];
    const foreign = await second.searchRetainedBuffer('second', { caseSensitive: true });
    let invalidated = false;
    old.onUpdate(() => {
      invalidated = old.invalidated;
    });
    current = second.wasmTerm;
    expect(old.extract(range)).toBeUndefined();
    manager.noteWrite();
    expect(invalidated).toBe(true);
    expect(old.matches).toHaveLength(0);
    expect(foreign.extract(foreign.matches[0])).toBe('second');
  } finally {
    manager.dispose();
  }
});
