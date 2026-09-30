import { afterEach, describe, expect, test } from 'bun:test';
import type { IDisposable, IRetainedBufferRange } from './interfaces';
import {
  RetainedRangeHighlight,
  type RetainedRangeHighlightFrame,
} from './retained-range-highlight';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

const style = { fill: 'rgba(255,0,0,0.4)', border: '#f00', borderWidth: 1 };
const terminals: Terminal[] = [];
const containers: HTMLElement[] = [];
const surfaces: RetainedRangeHighlight[] = [];

async function openTerminal() {
  const terminal = await createIsolatedTerminal({
    cols: 8,
    rows: 3,
    scrollback: 20,
    focusOnOpen: false,
  });
  const container = document.createElement('div');
  document.body.append(container);
  terminals.push(terminal);
  containers.push(container);
  terminal.open(container);
  return { terminal, container };
}

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
  for (const surface of surfaces.splice(0)) surface.dispose();
  for (const container of containers.splice(0)) container.remove();
});

describe('retained range presentation', () => {
  test('public operations authenticate ranges and preserve selection', async () => {
    const { terminal, container } = await openTerminal();
    terminal.write('old hit\r\nplain\r\nnew hit\r\nlast');
    terminal.select(0, terminal.getScrollbackLength(), 3);
    const selected = terminal.getSelection();
    const result = await terminal.searchRetainedBuffer('hit', { caseSensitive: true });
    expect(terminal.revealRetainedBufferRange(result.matches[0])).toBe(true);
    expect(terminal.getViewportY()).toBe(terminal.getScrollbackLength());
    const first = terminal.highlightRetainedBufferRange(result.matches[0], style)!;
    expect(first).toBeDefined();
    const second = terminal.highlightRetainedBufferRange(result.matches[1], style)!;
    first.dispose();
    first.dispose();
    expect(container.querySelectorAll('[data-ghostty-retained-range-highlight]')).toHaveLength(1);
    expect(terminal.getSelection()).toBe(selected);
    second.dispose();
    expect(container.querySelector('[data-ghostty-retained-range-highlight]')).toBeNull();
    result.dispose();
  });

  test('foreign and forged ranges cannot acquire presentation authority', async () => {
    const { terminal } = await openTerminal();
    const { terminal: other } = await openTerminal();
    terminal.write('hit');
    other.write('hit');
    const result = await terminal.searchRetainedBuffer('hit', { caseSensitive: true });
    const range = result.matches[0];
    const forged = { start: { ...range.start }, end: { ...range.end } };
    for (const [owner, candidate] of [
      [terminal, forged],
      [other, range],
    ] as const) {
      expect(owner.revealRetainedBufferRange(candidate)).toBe(false);
      expect(owner.highlightRetainedBufferRange(candidate, style)).toBeUndefined();
    }
    result.dispose();
    expect(terminal.revealRetainedBufferRange(range)).toBe(false);
    expect(terminal.highlightRetainedBufferRange(range, style)).toBeUndefined();
  });

  test('query cancellation, replacement, writes, reset, resize and disposal release surfaces', async () => {
    const { terminal, container } = await openTerminal();
    terminal.write('hit');
    const search = async () => {
      const result = await terminal.searchRetainedBuffer('hit', { caseSensitive: true });
      const handle = terminal.highlightRetainedBufferRange(result.matches[0], style);
      expect(handle).toBeDefined();
      return { result, handle: handle as IDisposable };
    };
    let current = await search();
    terminal.cancelRetainedBufferSearch();
    expect(container.querySelector('[data-ghostty-retained-range-highlight]')).toBeNull();
    current = await search();
    const old = current;
    current = await search();
    old.result.dispose();
    old.handle.dispose();
    expect(container.querySelectorAll('[data-ghostty-retained-range-highlight]')).toHaveLength(1);
    terminal.write(' more');
    expect(container.querySelector('[data-ghostty-retained-range-highlight]')).toBeNull();
    await search();
    terminal.resize(12, 3);
    expect(container.querySelector('[data-ghostty-retained-range-highlight]')).toBeNull();
    await search();
    terminal.reset();
    expect(container.querySelector('[data-ghostty-retained-range-highlight]')).toBeNull();
    terminal.write('hit');
    await search();
    terminal.dispose();
    expect(container.querySelector('[data-ghostty-retained-range-highlight]')).toBeNull();
    expect(terminal.revealRetainedBufferRange(current.result.matches[0])).toBe(false);
  });

  test('range surface uses viewport metrics, wide cells and device scaling', () => {
    const container = document.createElement('div');
    containers.push(container);
    document.body.append(container);
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 96;
    canvas.style.width = '80px';
    canvas.style.height = '48px';
    container.append(canvas);
    let range: IRetainedBufferRange | undefined = {
      start: { row: 5, column: 7 },
      end: { row: 6, column: 2 },
    };
    const highlight = new RetainedRangeHighlight(canvas, () => range, style);
    surfaces.push(highlight);
    const overlay = container.querySelector<HTMLCanvasElement>(
      '[data-ghostty-retained-range-highlight]'
    )!;
    const ctx = (highlight as unknown as { context: CanvasRenderingContext2D }).context;
    const rectangles: number[][] = [];
    const transforms: number[][] = [];
    ctx.fillRect = (...rect) => {
      rectangles.push(rect);
    };
    ctx.setTransform = (...transform: unknown[]) => {
      transforms.push(transform as number[]);
    };
    const frame: RetainedRangeHighlightFrame = {
      cols: 10,
      rows: 3,
      cellWidth: 8,
      cellHeight: 16,
      devicePixelRatio: 2,
      firstVisibleRow: 5,
      alternateScreen: false,
      endCellWidth: () => 2,
    };
    expect(highlight.paint(frame)).toBe(true);
    expect(rectangles).toEqual([
      [56, 0, 24, 16],
      [0, 16, 32, 16],
    ]);
    expect(transforms.at(-1)).toEqual([2, 0, 0, 2, 0, 0]);
    expect(overlay.width).toBe(canvas.width);
    rectangles.length = 0;
    highlight.paint({
      ...frame,
      firstVisibleRow: 6,
      cellWidth: 9,
      cellHeight: 18,
      devicePixelRatio: 1.5,
    });
    expect(rectangles).toEqual([[0, 0, 36, 18]]);
    expect(transforms.at(-1)).toEqual([1.5, 0, 0, 1.5, 0, 0]);
    highlight.hide();
    expect(overlay.style.visibility).toBe('hidden');
    highlight.paint({ ...frame, alternateScreen: true });
    expect(overlay.style.visibility).toBe('hidden');
    range = undefined;
    expect(highlight.paint(frame)).toBe(false);
  });

  test('paused terminals suppress highlight paint and alternate ranges cannot reveal', async () => {
    const { terminal, container } = await openTerminal();
    terminal.write('hit');
    const result = await terminal.searchRetainedBuffer('hit', { caseSensitive: true });
    terminal.highlightRetainedBufferRange(result.matches[0], style);
    const overlay = container.querySelector<HTMLCanvasElement>(
      '[data-ghostty-retained-range-highlight]'
    )!;
    terminal.setRenderPaused(true);
    const before = terminal.getRenderStats().renderFrames;
    terminal.requestRender(true);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(terminal.getRenderStats().renderFrames).toBe(before);
    expect(overlay.style.visibility).toBe('hidden');
    terminal.setRenderPaused(false);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(overlay.style.visibility).toBe('');
    terminal.write('\x1b[?1049h');
    expect(terminal.revealRetainedBufferRange(result.matches[0])).toBe(false);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(!overlay.isConnected || overlay.style.visibility === 'hidden').toBe(true);
  });
});
