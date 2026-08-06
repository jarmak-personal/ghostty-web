import { describe, expect, test } from 'bun:test';
import { CanvasRenderer, type IRenderable } from './renderer';
import { createIsolatedTerminal } from './test-helpers';
import { type CursorStyle, DirtyState, type RenderStateSnapshot } from './types';

function installAnimationFrameHarness(): {
  callbacks: Map<number, FrameRequestCallback>;
  runNext: () => void;
  restore: () => void;
} {
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;

  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    const id = nextFrame++;
    callbacks.set(id, callback);
    return id;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    callbacks.delete(id);
  }) as typeof cancelAnimationFrame;

  return {
    callbacks,
    runNext: () => {
      const next = callbacks.entries().next().value as [number, FrameRequestCallback] | undefined;
      if (!next) throw new Error('Expected a pending animation frame');
      callbacks.delete(next[0]);
      next[1](0);
    },
    restore: () => {
      globalThis.requestAnimationFrame = originalRequest;
      globalThis.cancelAnimationFrame = originalCancel;
    },
  };
}

function installIntervalHarness(): {
  intervals: Map<number, TimerHandler>;
  restore: () => void;
} {
  const originalSetInterval = window.setInterval;
  const originalClearInterval = window.clearInterval;
  const intervals = new Map<number, TimerHandler>();
  let nextInterval = 1;

  window.setInterval = ((handler: TimerHandler) => {
    const id = nextInterval++;
    intervals.set(id, handler);
    return id;
  }) as typeof window.setInterval;
  window.clearInterval = ((id: number) => {
    intervals.delete(id);
  }) as typeof window.clearInterval;

  return {
    intervals,
    restore: () => {
      window.setInterval = originalSetInterval;
      window.clearInterval = originalClearInterval;
    },
  };
}

describe('native cursor state', () => {
  test('exports all configured defaults and distinguishes application block from hollow default', async () => {
    const terminal = await createIsolatedTerminal({ cursorBlink: false });
    const container = document.createElement('div');
    terminal.open(container);
    try {
      const styles: CursorStyle[] = ['block', 'block_hollow', 'bar', 'underline'];
      for (const style of styles) {
        terminal.options.cursorStyle = style;
        expect(terminal.wasmTerm!.getCursor()).toMatchObject({
          style,
          blinking: false,
          visible: true,
          default: true,
        });
      }

      terminal.options.cursorStyle = 'block_hollow';
      terminal.write('\x1b[2 q');
      expect(terminal.wasmTerm!.getCursor()).toMatchObject({
        style: 'block',
        blinking: false,
        default: false,
      });

      terminal.write('\x1b[0 q');
      expect(terminal.wasmTerm!.getCursor()).toMatchObject({
        style: 'block_hollow',
        blinking: false,
        default: true,
      });

      terminal.write('\x1b[?25l');
      expect(terminal.wasmTerm!.getCursor().visible).toBe(false);
      terminal.write('\x1b[?25h');
      expect(terminal.wasmTerm!.getCursor().visible).toBe(true);
    } finally {
      terminal.dispose();
    }
  });

  test('exports every blinking and steady DECSCUSR shape and resets to latest defaults', async () => {
    const terminal = await createIsolatedTerminal({
      cursorStyle: 'block_hollow',
      cursorBlink: true,
    });
    const container = document.createElement('div');
    terminal.open(container);
    try {
      const requests = [
        ['\x1b[1 q', 'block', true],
        ['\x1b[2 q', 'block', false],
        ['\x1b[3 q', 'underline', true],
        ['\x1b[4 q', 'underline', false],
        ['\x1b[5 q', 'bar', true],
        ['\x1b[6 q', 'bar', false],
      ] as const;

      for (const [sequence, style, blinking] of requests) {
        terminal.write(sequence);
        expect(terminal.wasmTerm!.getCursor()).toMatchObject({
          style,
          blinking,
          default: false,
        });
      }

      terminal.options.cursorStyle = 'underline';
      terminal.options.cursorBlink = false;
      expect(terminal.wasmTerm!.getCursor()).toMatchObject({
        style: 'bar',
        blinking: false,
        default: false,
      });
      terminal.write('\x1b[ q');
      expect(terminal.wasmTerm!.getCursor()).toMatchObject({
        style: 'underline',
        blinking: false,
        default: true,
      });

      terminal.write('\x1b[1 q');
      terminal.write('\x1bc');
      expect(terminal.wasmTerm!.getCursor()).toMatchObject({
        style: 'underline',
        blinking: false,
        default: true,
      });
    } finally {
      terminal.dispose();
    }
  });

  test('applies DEC blinking only to terminal-controlled defaults', async () => {
    const terminal = await createIsolatedTerminal({ cursorBlink: 'terminal' });
    const container = document.createElement('div');
    terminal.open(container);
    try {
      expect(terminal.wasmTerm!.getCursor().blinking).toBe(true);
      terminal.write('\x1b[?12l');
      expect(terminal.wasmTerm!.getCursor().blinking).toBe(false);
      terminal.write('\x1b[?12h');
      expect(terminal.wasmTerm!.getCursor().blinking).toBe(true);

      terminal.options.cursorBlink = false;
      terminal.write('\x1b[?12h');
      expect(terminal.wasmTerm!.getCursor()).toMatchObject({ blinking: false, default: true });

      terminal.options.cursorBlink = true;
      terminal.write('\x1b[?12l');
      expect(terminal.wasmTerm!.getCursor()).toMatchObject({ blinking: true, default: true });

      terminal.write('\x1b[4 q');
      terminal.write('\x1b[?12h');
      expect(terminal.wasmTerm!.getCursor()).toMatchObject({
        style: 'underline',
        blinking: false,
        default: false,
      });
    } finally {
      terminal.dispose();
    }
  });

  test('restores configured cursor ownership and terminal blinking control after RIS', async () => {
    const terminal = await createIsolatedTerminal({
      cursorStyle: 'block_hollow',
      cursorBlink: 'terminal',
    });
    const container = document.createElement('div');
    terminal.open(container);
    try {
      terminal.write('\x1b[4 q');
      expect(terminal.wasmTerm!.getCursor()).toMatchObject({
        style: 'underline',
        blinking: false,
        default: false,
      });

      terminal.write('\x1bc');
      expect(terminal.wasmTerm!.getCursor()).toMatchObject({
        style: 'block_hollow',
        blinking: true,
        default: true,
      });

      terminal.write('\x1b[?12l');
      expect(terminal.wasmTerm!.getCursor()).toMatchObject({
        style: 'block_hollow',
        blinking: false,
        default: true,
      });
    } finally {
      terminal.dispose();
    }
  });

  test('changes live defaults without replacing terminal, buffer, scrollback, or Canvas', async () => {
    const terminal = await createIsolatedTerminal({ rows: 2, scrollback: 20 });
    const container = document.createElement('div');
    terminal.open(container);
    try {
      terminal.write('first\r\nsecond\r\nthird');
      terminal.write('\x1b[5 q');
      const wasm = terminal.wasmTerm;
      const canvas = terminal.renderer!.getCanvas();
      const scrollback = terminal.getScrollbackLength();
      const text = terminal.buffer.active.getLine(1)?.translateToString(true);

      terminal.options.cursorStyle = 'block_hollow';
      terminal.options.cursorBlink = false;

      expect(terminal.wasmTerm).toBe(wasm);
      expect(terminal.renderer!.getCanvas()).toBe(canvas);
      expect(terminal.getScrollbackLength()).toBe(scrollback);
      expect(terminal.buffer.active.getLine(1)?.translateToString(true)).toBe(text);
      expect(terminal.wasmTerm!.getCursor()).toMatchObject({
        style: 'bar',
        blinking: true,
        default: false,
      });

      terminal.write('\x1b[0 q');
      expect(terminal.wasmTerm!.getCursor()).toMatchObject({
        style: 'block_hollow',
        blinking: false,
        default: true,
      });
    } finally {
      terminal.dispose();
    }
  });
});

describe('cursor Canvas presentation', () => {
  test('renders a hollow configured default but a filled application block', async () => {
    const frames = installAnimationFrameHarness();
    const terminal = await createIsolatedTerminal({
      cursorStyle: 'block_hollow',
      cursorBlink: false,
    });
    const container = document.createElement('div');
    terminal.open(container);
    try {
      const renderer = terminal.renderer!;
      const context = (renderer as unknown as { ctx: CanvasRenderingContext2D }).ctx;
      const strokes: number[][] = [];
      const fills: number[][] = [];
      context.strokeRect = (...args: number[]) => strokes.push(args);
      context.fillRect = (...args: number[]) => fills.push(args);

      frames.runNext();
      expect(strokes).toHaveLength(1);

      strokes.length = 0;
      fills.length = 0;
      terminal.write('\x1b[2 q');
      frames.runNext();

      expect(strokes).toHaveLength(0);
      expect(fills).toContainEqual([0, 0, renderer.charWidth, renderer.charHeight]);
    } finally {
      terminal.dispose();
      frames.restore();
    }
  });

  test('repaints only cursor-adjacent rows when native presentation changes', () => {
    const renderedRows: number[] = [];
    let snapshot: RenderStateSnapshot = {
      dirty: DirtyState.FULL,
      cursor: {
        x: 1,
        y: 2,
        viewportX: 1,
        viewportY: 2,
        visible: true,
        blinking: false,
        style: 'block',
        default: true,
      },
      colors: {
        background: { r: 0, g: 0, b: 0 },
        foreground: { r: 255, g: 255, b: 255 },
        cursor: { r: 255, g: 255, b: 255 },
        palette: Array.from({ length: 16 }, () => ({ r: 0, g: 0, b: 0 })),
      },
      dimensions: { cols: 4, rows: 5 },
    };
    const line = Array.from({ length: 4 }, () => ({
      codepoint: 32,
      fg_r: 255,
      fg_g: 255,
      fg_b: 255,
      bg_r: 0,
      bg_g: 0,
      bg_b: 0,
      flags: 0,
      width: 1,
      hyperlink_id: 0,
      grapheme_len: 0,
    }));
    const buffer: IRenderable = {
      getLine: (row) => {
        renderedRows.push(row);
        return line;
      },
      getRenderState: () => snapshot,
      getDimensions: () => snapshot.dimensions,
      isRowDirty: () => false,
      clearDirty: () => {},
    };
    const renderer = new CanvasRenderer(document.createElement('canvas'), {
      devicePixelRatio: 1,
    });
    renderer.resize(4, 5);

    renderer.render(buffer, true);
    renderedRows.length = 0;
    snapshot = {
      ...snapshot,
      dirty: DirtyState.NONE,
      cursor: { ...snapshot.cursor, style: 'underline', default: false },
    };
    renderer.render(buffer);

    expect(renderedRows).toEqual([1, 2, 3]);
    renderer.dispose();
  });

  test('suppresses hidden animation and starts only the freshly required reveal cadence', async () => {
    const frames = installAnimationFrameHarness();
    const timers = installIntervalHarness();
    const terminal = await createIsolatedTerminal({ cursorBlink: 'terminal' });
    const container = document.createElement('div');
    terminal.setRenderPaused(true);
    terminal.open(container);
    try {
      terminal.write('\x1b[5 q');
      expect(terminal.wasmTerm!.getCursor()).toMatchObject({ style: 'bar', blinking: true });
      expect(frames.callbacks.size).toBe(0);
      expect(timers.intervals.size).toBe(0);

      terminal.setRenderPaused(false);
      expect(timers.intervals.size).toBe(0);
      frames.runNext();
      expect(timers.intervals.size).toBe(1);

      terminal.setRenderPaused(true);
      expect(timers.intervals.size).toBe(0);
      terminal.write('\x1b[4 q');
      expect(terminal.wasmTerm!.getCursor()).toMatchObject({
        style: 'underline',
        blinking: false,
      });

      terminal.setRenderPaused(false);
      expect(timers.intervals.size).toBe(0);
      frames.runNext();
      expect(timers.intervals.size).toBe(0);

      terminal.dispose();
      expect(timers.intervals.size).toBe(0);
    } finally {
      terminal.dispose();
      frames.restore();
      timers.restore();
    }
  });
});
