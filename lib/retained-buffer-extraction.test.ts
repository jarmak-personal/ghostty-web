import { afterEach, describe, expect, test } from 'bun:test';
import type { GhosttyTerminal } from './ghostty';
import type { ITerminalOptions } from './interfaces';
import {
  type RetainedBufferExtractionError,
  RetainedBufferExtractionManager,
} from './retained-buffer-extraction';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';
import type { TerminalEvent, TerminalEventProvenance } from './types';

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

function semanticBoundaries(events: TerminalEvent[]): TerminalEventProvenance[] {
  return events.flatMap((event) => (event.type === 'semantic' ? [event.provenance] : []));
}

function expectCode(code: RetainedBufferExtractionError['code']) {
  return expect.objectContaining({ name: 'RetainedBufferExtractionError', code });
}

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
  for (const container of containers.splice(0)) container.remove();
});

describe('exact retained semantic-boundary extraction', () => {
  test('separates same-row prompt, command, and output with half-open endpoints', async () => {
    const terminal = await openTerminal({ cols: 40, rows: 3 });
    const events: TerminalEvent[] = [];
    terminal.onTerminalEvent((event) => events.push(event));

    terminal.write(
      '\x1b]133;A\x1b\\prompt' +
        '\x1b]133;B\x1b\\command' +
        '\x1b]133;C\x1b\\output' +
        '\x1b]133;D\x1b\\'
    );
    const [promptStart, commandStart, outputStart, commandEnd] = semanticBoundaries(events);

    expect([
      promptStart.column,
      commandStart.column,
      outputStart.column,
      commandEnd.column,
    ]).toEqual([0, 6, 13, 19]);
    expect(await terminal.extractRetainedBufferRange(promptStart, commandStart)).toBe('prompt');
    expect(await terminal.extractRetainedBufferRange(commandStart, outputStart)).toBe('command');
    expect(await terminal.extractRetainedBufferRange(outputStart, commandEnd)).toBe('output');
    expect(await terminal.extractRetainedBufferRange(commandStart, commandStart)).toBe('');
    await expect(terminal.extractRetainedBufferRange(commandEnd, promptStart)).rejects.toEqual(
      expectCode('invalid-boundary')
    );
  });

  test('extracts an open current range without mutating selection', async () => {
    const terminal = await openTerminal({ cols: 30, rows: 3 });
    const events: TerminalEvent[] = [];
    terminal.onTerminalEvent((event) => events.push(event));
    terminal.write('\x1b]133;C\x1b\\live output');
    const currentStart = semanticBoundaries(events)[0];
    const currentEnd = terminal.captureRetainedBufferBoundary();
    expect(terminal.hasSelection()).toBe(false);
    expect(await terminal.extractRetainedBufferRange(currentStart, currentEnd)).toBe('live output');
    expect(terminal.hasSelection()).toBe(false);
  });

  test('preserves Unicode graphemes, unwraps soft wraps, and preserves hard newlines', async () => {
    const unicode = await openTerminal({ cols: 30, rows: 3 });
    const unicodeStart = unicode.captureRetainedBufferBoundary();
    unicode.write('界e\u0301👩‍💻');
    const unicodeEnd = unicode.captureRetainedBufferBoundary();
    expect(await unicode.extractRetainedBufferRange(unicodeStart, unicodeEnd)).toBe('界e\u0301👩‍💻');

    const soft = await openTerminal({ cols: 5, rows: 3 });
    const softStart = soft.captureRetainedBufferBoundary();
    soft.write('abcdeFG');
    const softEnd = soft.captureRetainedBufferBoundary();
    expect(softEnd).toMatchObject({ row: 1, column: 2 });
    expect(await soft.extractRetainedBufferRange(softStart, softEnd)).toBe('abcdeFG');

    const hard = await openTerminal({ cols: 10, rows: 3 });
    const hardStart = hard.captureRetainedBufferBoundary();
    hard.write('left\r\nright');
    const hardEnd = hard.captureRetainedBufferBoundary();
    expect(await hard.extractRetainedBufferRange(hardStart, hardEnd)).toBe('left\nright');
  });

  test('keeps hard newline at a column-zero end and explicit spaces without blank padding', async () => {
    const terminal = await openTerminal({ cols: 12, rows: 4 });
    const start = terminal.captureRetainedBufferBoundary();
    terminal.write('alpha  \r\n');
    const end = terminal.captureRetainedBufferBoundary();

    expect(end).toMatchObject({ row: 1, column: 0 });
    expect(await terminal.extractRetainedBufferRange(start, end)).toBe('alpha  \n');

    const nextStart = terminal.captureRetainedBufferBoundary();
    terminal.write('beta\r\n');
    const nextEnd = terminal.captureRetainedBufferBoundary();
    expect(await terminal.extractRetainedBufferRange(nextStart, nextEnd)).toBe('beta\n');
  });

  test('models pending wrap as a virtual exclusive column at the right margin', async () => {
    const lastCell = await openTerminal({ cols: 5, rows: 3 });
    lastCell.write('\x1b[1;5H');
    const lastCellStart = lastCell.captureRetainedBufferBoundary();
    lastCell.write('X');
    const lastCellEnd = lastCell.captureRetainedBufferBoundary();
    expect(lastCellStart).toMatchObject({ row: 0, column: 4 });
    expect(lastCellEnd).toMatchObject({ row: 0, column: 5 });
    expect(lastCell.resolveEventProvenance(lastCellStart)).toEqual({
      screen: 'normal',
      row: 0,
      column: 4,
    });
    expect(lastCell.resolveEventProvenance(lastCellEnd)).toEqual({
      screen: 'normal',
      row: 0,
      column: 5,
    });
    expect(await lastCell.extractRetainedBufferRange(lastCellStart, lastCellEnd)).toBe('X');
    expect(await lastCell.extractRetainedBufferRange(lastCellEnd, lastCellEnd)).toBe('');
    await expect(lastCell.extractRetainedBufferRange(lastCellEnd, lastCellStart)).rejects.toEqual(
      expectCode('invalid-boundary')
    );

    const fullRow = await openTerminal({ cols: 5, rows: 3 });
    const fullStart = fullRow.captureRetainedBufferBoundary();
    fullRow.write('abcde');
    const fullEnd = fullRow.captureRetainedBufferBoundary();
    expect(fullEnd.column).toBe(5);
    expect(await fullRow.extractRetainedBufferRange(fullStart, fullEnd)).toBe('abcde');

    const wide = await openTerminal({ cols: 5, rows: 3 });
    const wideStart = wide.captureRetainedBufferBoundary();
    wide.write('abc界');
    const wideEnd = wide.captureRetainedBufferBoundary();
    expect(wideEnd.column).toBe(5);
    expect(await wide.extractRetainedBufferRange(wideStart, wideEnd)).toBe('abc界');
  });

  test('preserves exact-width OSC 133 endpoints at the virtual margin', async () => {
    const terminal = await openTerminal({ cols: 5, rows: 3 });
    const events: TerminalEvent[] = [];
    terminal.onTerminalEvent((event) => events.push(event));
    terminal.write('\x1b]133;A\x1b\\abcde\x1b]133;B\x1b\\');
    const [start, end] = semanticBoundaries(events);

    expect(start).toMatchObject({ row: 0, column: 0 });
    expect(end).toMatchObject({ row: 0, column: 5 });
    expect(terminal.resolveEventProvenance(end)).toEqual({
      screen: 'normal',
      row: 0,
      column: 5,
    });
    expect(await terminal.extractRetainedBufferRange(start, end)).toBe('abcde');
  });

  test('continues correctly from a pending-wrap start across soft and hard rows', async () => {
    const soft = await openTerminal({ cols: 5, rows: 3 });
    soft.write('abcde');
    const softStart = soft.captureRetainedBufferBoundary();
    soft.write('F');
    const softEnd = soft.captureRetainedBufferBoundary();
    expect(await soft.extractRetainedBufferRange(softStart, softEnd)).toBe('F');

    const hard = await openTerminal({ cols: 5, rows: 3 });
    hard.write('abcde');
    const hardStart = hard.captureRetainedBufferBoundary();
    hard.write('\r\nF');
    const hardEnd = hard.captureRetainedBufferBoundary();
    expect(await hard.extractRetainedBufferRange(hardStart, hardEnd)).toBe('\nF');
  });

  test('crosses retained history and native page boundaries over multiple tasks', async () => {
    const terminal = await openTerminal({ cols: 200, rows: 2, scrollback: 20_000_000 });
    const start = terminal.captureRetainedBufferBoundary();
    const lines = Array.from({ length: 3_000 }, (_, index) => `L${index}\r\n`).join('');
    terminal.write(lines);
    const end = terminal.captureRetainedBufferBoundary();
    expect(terminal.getScrollbackLength()).toBeGreaterThan(2_000);

    const originalSetTimeout = globalThis.setTimeout;
    let scheduled = 0;
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      scheduled++;
      return originalSetTimeout(handler, timeout, ...args);
    }) as typeof setTimeout;
    try {
      const text = await terminal.extractRetainedBufferRange(start, end);
      expect(text.startsWith('L0\nL1\n')).toBe(true);
      expect(text.endsWith('L2999\n')).toBe(true);
      expect(scheduled).toBeGreaterThan(2);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test('authenticates object identity and rejects foreign, forged, cross-screen, and evicted tokens', async () => {
    const first = await openTerminal({ cols: 8, rows: 2, scrollback: 1 });
    const second = await openTerminal({ cols: 8, rows: 2 });
    const firstStart = first.captureRetainedBufferBoundary();
    first.write('one');
    const firstEnd = first.captureRetainedBufferBoundary();

    await expect(second.extractRetainedBufferRange(firstStart, firstEnd)).rejects.toEqual(
      expectCode('invalid-boundary')
    );
    await expect(first.extractRetainedBufferRange({ ...firstStart }, firstEnd)).rejects.toEqual(
      expectCode('invalid-boundary')
    );

    first.write('\x1b[?1049h');
    const alternate = first.captureRetainedBufferBoundary();
    await expect(first.extractRetainedBufferRange(firstStart, alternate)).rejects.toEqual(
      expectCode('invalid-boundary')
    );

    first.write('\x1b[?1049l');
    const evictedStart = first.captureRetainedBufferBoundary();
    first.write('x\r\n'.repeat(20_000));
    const evictedEnd = first.captureRetainedBufferBoundary();
    await expect(first.extractRetainedBufferRange(evictedStart, evictedEnd)).rejects.toEqual(
      expectCode('invalid-boundary')
    );
  });

  test('normal extraction survives alternate-only output but fails on its own screen write', async () => {
    const terminal = await openTerminal({ cols: 8, rows: 2, scrollback: 10_000 });
    const start = terminal.captureRetainedBufferBoundary();
    terminal.write('x\r\n'.repeat(2_000));
    const end = terminal.captureRetainedBufferBoundary();
    terminal.write('\x1b[?1049h');

    const survives = terminal.extractRetainedBufferRange(start, end);
    terminal.write('alternate-only');
    expect((await survives).startsWith('x\n')).toBe(true);

    terminal.write('\x1b[?1049l');
    const stale = terminal.extractRetainedBufferRange(start, end);
    terminal.write('primary-change');
    await expect(stale).rejects.toEqual(expectCode('stale'));
  });

  test('extracts an exact same-screen alternate range', async () => {
    const terminal = await openTerminal({ cols: 12, rows: 3 });
    terminal.write('\x1b[?1049h');
    const start = terminal.captureRetainedBufferBoundary();
    terminal.write('alt text\r\nnext');
    const end = terminal.captureRetainedBufferBoundary();

    expect(start.screen).toBe('alternate');
    expect(end.screen).toBe('alternate');
    expect(await terminal.extractRetainedBufferRange(start, end)).toBe('alt text\nnext');
  });

  test('enforces the 4 MiB result ceiling at the native WASM seam', async () => {
    const terminal = await openTerminal({ cols: 200, rows: 2, scrollback: 100_000_000 });
    const start = terminal.captureRetainedBufferBoundary();
    terminal.write(`${'x'.repeat(4 * 1024 * 1024 + 1)}\r\n`);
    const end = terminal.captureRetainedBufferBoundary();

    await expect(terminal.extractRetainedBufferRange(start, end)).rejects.toEqual(
      expectCode('too-large')
    );
    expect(await terminal.extractRetainedBufferRange(end, end)).toBe('');
  });

  test('replacement, abort, manual cancel, resize, reset, and disposal suppress completion', async () => {
    const terminal = await openTerminal({ cols: 8, rows: 2, scrollback: 10_000 });
    const start = terminal.captureRetainedBufferBoundary();
    terminal.write('x\r\n'.repeat(2_000));
    const end = terminal.captureRetainedBufferBoundary();

    const replaced = terminal.extractRetainedBufferRange(start, end);
    const current = terminal.extractRetainedBufferRange(end, end);
    await expect(replaced).rejects.toEqual(expectCode('cancelled'));
    expect(await current).toBe('');

    const controller = new AbortController();
    const aborted = terminal.extractRetainedBufferRange(start, end, { signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError', code: 'cancelled' });

    const cancelled = terminal.extractRetainedBufferRange(start, end);
    terminal.cancelRetainedBufferExtraction();
    await expect(cancelled).rejects.toEqual(expectCode('cancelled'));

    const resized = terminal.extractRetainedBufferRange(start, end);
    terminal.resize(9, 2);
    await expect(resized).rejects.toEqual(expectCode('stale'));
    await expect(terminal.extractRetainedBufferRange(start, end)).rejects.toEqual(
      expectCode('invalid-boundary')
    );

    const resetStart = terminal.captureRetainedBufferBoundary();
    const resetting = terminal.extractRetainedBufferRange(resetStart, resetStart);
    terminal.reset();
    await expect(resetting).rejects.toEqual(expectCode('disposed'));
    await expect(terminal.extractRetainedBufferRange(resetStart, resetStart)).rejects.toEqual(
      expectCode('invalid-boundary')
    );

    const disposeStart = terminal.captureRetainedBufferBoundary();
    const disposing = terminal.extractRetainedBufferRange(disposeStart, disposeStart);
    terminal.dispose();
    await expect(disposing).rejects.toEqual(expectCode('disposed'));
  });

  test('releases native state immediately after stale and oversized terminal statuses', async () => {
    const statuses = [-1, -2];
    const cancelled: number[] = [];
    let nextId = 0;
    const fake = {
      createRetainedRange: () => ++nextId,
      stepRetainedRange: () => statuses.shift()!,
      cancelRetainedRange: (rangeId: number) => cancelled.push(rangeId),
      getRetainedRangeText: () => null,
    } as unknown as GhosttyTerminal;
    const boundary = Object.freeze({
      id: 1,
      screen: 'normal' as const,
      row: 0,
      column: 0,
    });
    const manager = new RetainedBufferExtractionManager(() => fake);

    await expect(manager.extract(boundary, boundary)).rejects.toEqual(expectCode('stale'));
    await expect(manager.extract(boundary, boundary)).rejects.toEqual(expectCode('too-large'));
    expect(cancelled).toEqual([1, 2]);
    manager.dispose();
  });
});
