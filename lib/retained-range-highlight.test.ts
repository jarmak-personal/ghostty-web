import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { IDisposable, IRetainedBufferRange, IRetainedRangeHighlightStyle } from './interfaces';
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

function captureHighlightPaint(
  terminal: Terminal,
  range: IRetainedBufferRange,
  presentation: IRetainedRangeHighlightStyle = style
) {
  // Record the real highlight's immediate Canvas boundary, retaining the native
  // range manager, renderer frame construction, and production frame scheduler.
  const acquireContext = spyOn(HTMLCanvasElement.prototype, 'getContext');
  let context: CanvasRenderingContext2D;
  try {
    expect(terminal.highlightRetainedBufferRange(range, presentation)).toBeDefined();
    context = acquireContext.mock.results.at(-1)!.value as CanvasRenderingContext2D;
  } finally {
    acquireContext.mockRestore();
  }
  const rectangles: number[][] = [];
  context.fillRect = (...rectangle) => rectangles.push(rectangle);
  const clear = spyOn(context, 'clearRect');
  return { context, rectangles, clear };
}

async function presentFrame(terminal: Terminal, forceAll = false) {
  const frames = terminal.getRenderStats().renderFrames;
  terminal.requestRender(forceAll);
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  expect(terminal.getRenderStats().renderFrames).toBeGreaterThan(frames);
}

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
  for (const surface of surfaces.splice(0)) surface.dispose();
  for (const container of containers.splice(0)) container.remove();
  mock.restore();
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
    const forged = { id: range.id, start: { ...range.start }, end: { ...range.end } };
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

  test('query cancellation, replacement, reset, resize and disposal release surfaces', async () => {
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
    expect(container.querySelectorAll('[data-ghostty-retained-range-highlight]')).toHaveLength(1);
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

  test('highlight identity survives streaming refresh and follows the selected match into history', async () => {
    const { terminal, container } = await openTerminal();
    terminal.write('hit');
    const result = await terminal.searchRetainedBuffer('hit', { caseSensitive: true });
    const range = result.matches[0];
    const paint = captureHighlightPaint(terminal, range);
    await presentFrame(terminal);
    terminal.write(' more\r\nplain\r\ntail\r\nhit-new');
    const deadline = performance.now() + 2000;
    while (result.pending || result.matches.length !== 2) {
      if (performance.now() > deadline) throw new Error('Streaming search did not refresh');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(result.matches[0]).toBe(range);
    expect(container.querySelectorAll('[data-ghostty-retained-range-highlight]')).toHaveLength(1);
    expect(terminal.revealRetainedBufferRange(range)).toBe(true);
    paint.rectangles.length = 0;
    await presentFrame(terminal);
    const metrics = terminal.renderer!.getMetrics();
    expect(paint.rectangles).toEqual([[0, 0, 3 * metrics.width, metrics.height]]);
    // The public resolved range carries the same authenticated presentation authority.
    const resolved = result.resolve(range)!;
    expect(resolved.id).toBe(range.id);
    expect(terminal.highlightRetainedBufferRange(resolved, style)).toBeDefined();
  });

  test('identical overwrite revokes the old highlight without affecting its replacement', async () => {
    const { terminal, container } = await openTerminal();
    terminal.write('hit');
    const result = await terminal.searchRetainedBuffer('hit', { caseSensitive: true });
    const range = result.matches[0];
    const handle = terminal.highlightRetainedBufferRange(range, style)!;
    await presentFrame(terminal);
    terminal.write('\rhit');
    expect(terminal.revealRetainedBufferRange(range)).toBe(false);
    expect(terminal.highlightRetainedBufferRange(range, style)).toBeUndefined();
    await presentFrame(terminal);
    expect(container.querySelector('[data-ghostty-retained-range-highlight]')).toBeNull();
    const deadline = performance.now() + 2000;
    while (result.pending || result.matches[0]?.id === range.id) {
      if (performance.now() > deadline) throw new Error('Replacement search did not refresh');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(terminal.highlightRetainedBufferRange(result.matches[0], style)).toBeDefined();
    handle.dispose();
    expect(container.querySelectorAll('[data-ghostty-retained-range-highlight]')).toHaveLength(1);
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
      id: 1,
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

  test('real renderer maps wrapped native history, clipped scrolling and fresh resize ranges', async () => {
    const { terminal } = await openTerminal();
    terminal.write('abcdef界Z\r\nplain\r\ntail\r\nlast');
    const result = await terminal.searchRetainedBuffer('f界Z', { caseSensitive: true });
    expect(result.extract(result.matches[0])).toBe('f界Z');
    expect(terminal.revealRetainedBufferRange(result.matches[0])).toBe(true);
    const paint = captureHighlightPaint(terminal, result.matches[0]);
    await presentFrame(terminal);
    const metrics = terminal.renderer!.getMetrics();
    expect(paint.rectangles).toEqual([
      [5 * metrics.width, 0, 3 * metrics.width, metrics.height],
      [0, metrics.height, metrics.width, metrics.height],
    ]);

    paint.rectangles.length = 0;
    terminal.scrollLines(1);
    await presentFrame(terminal);
    expect(paint.rectangles).toEqual([[0, 0, metrics.width, metrics.height]]);

    terminal.resize(12, 3);
    const fresh = await terminal.searchRetainedBuffer('f界Z', { caseSensitive: true });
    expect(terminal.revealRetainedBufferRange(fresh.matches[0])).toBe(true);
    const resized = captureHighlightPaint(terminal, fresh.matches[0]);
    await presentFrame(terminal);
    expect(resized.rectangles).toEqual([[5 * metrics.width, 0, 4 * metrics.width, metrics.height]]);
    fresh.dispose();
  });

  test('real renderer includes native wide endpoints in both history and live rows', async () => {
    const { terminal } = await openTerminal();
    terminal.write('f界\r\nplain\r\ntail\r\nq界');
    const metrics = terminal.renderer!.getMetrics();
    for (const [query, top] of [
      ['f界', 0],
      ['q界', 2 * metrics.height],
    ] as const) {
      const result = await terminal.searchRetainedBuffer(query, { caseSensitive: true });
      expect(result.extract(result.matches[0])).toBe(query);
      expect(terminal.revealRetainedBufferRange(result.matches[0])).toBe(true);
      const paint = captureHighlightPaint(terminal, result.matches[0]);
      await presentFrame(terminal);
      expect(paint.rectangles).toEqual([[0, top, 3 * metrics.width, metrics.height]]);
      result.dispose();
    }
  });

  test('unchanged cursor frames skip highlight work while full frames refresh live CSS colors', async () => {
    const { terminal, container } = await openTerminal();
    container.style.setProperty('--accent', 'red');
    terminal.write('hit');
    const result = await terminal.searchRetainedBuffer('hit', { caseSensitive: true });
    const paint = captureHighlightPaint(terminal, result.matches[0], {
      ...style,
      fill: 'var(--accent)',
    });
    const styles = spyOn(globalThis, 'getComputedStyle');
    const canvas = terminal.renderer!.getCanvas();
    const offset = { left: canvas.offsetLeft, top: canvas.offsetTop };
    let layoutReads = 0;
    Object.defineProperties(canvas, {
      offsetLeft: {
        configurable: true,
        get: () => {
          layoutReads++;
          return offset.left;
        },
      },
      offsetTop: {
        configurable: true,
        get: () => {
          layoutReads++;
          return offset.top;
        },
      },
    });
    await presentFrame(terminal, true);
    const color = paint.context.fillStyle;
    const reads = { styles: styles.mock.calls.length, layout: layoutReads };
    paint.rectangles.length = 0;
    paint.clear.mockClear();
    terminal.resetCursorBlink();
    await presentFrame(terminal);
    expect(paint.rectangles).toEqual([]);
    expect(paint.clear).not.toHaveBeenCalled();
    expect(styles.mock.calls.length).toBe(reads.styles);
    expect(layoutReads).toBe(reads.layout);

    container.style.setProperty('--accent', 'blue');
    terminal.options.theme = { background: '#111111' };
    await presentFrame(terminal);
    expect(paint.rectangles).toHaveLength(1);
    expect(paint.context.fillStyle).not.toBe(color);
    expect(paint.context.fillStyle).toBe(
      getComputedStyle(container.querySelector('[data-ghostty-retained-range-highlight]')!).color
    );
    result.dispose();
  });

  test('an empty replacement revokes both text and range-presentation authority', async () => {
    const { terminal } = await openTerminal();
    terminal.write('hit');
    const result = await terminal.searchRetainedBuffer('hit', { caseSensitive: true });
    const range = result.matches[0];
    const empty = await terminal.searchRetainedBuffer('', { caseSensitive: true });
    expect(empty.matches).toEqual([]);
    expect(result.extract(range)).toBeUndefined();
    expect(terminal.revealRetainedBufferRange(range)).toBe(false);
    expect(terminal.highlightRetainedBufferRange(range, style)).toBeUndefined();
    empty.dispose();
  });
});
