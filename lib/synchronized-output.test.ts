import { describe, expect, test } from 'bun:test';
import { Ghostty, type GhosttyCell } from './ghostty';
import { createIsolatedTerminal } from './test-helpers';

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

function installTimeoutHarness(): {
  callbacks: Map<number, TimerHandler>;
  runOnly: () => void;
  restore: () => void;
} {
  const originalSet = window.setTimeout;
  const originalClear = window.clearTimeout;
  const callbacks = new Map<number, TimerHandler>();
  let nextTimer = 100_000;

  window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (timeout !== 1000) return originalSet(handler, timeout, ...args);
    const id = nextTimer++;
    callbacks.set(id, handler);
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id: number) => {
    if (!callbacks.delete(id)) originalClear(id);
  }) as typeof window.clearTimeout;

  return {
    callbacks,
    runOnly: () => {
      const only = callbacks.entries().next().value as [number, TimerHandler] | undefined;
      if (!only || callbacks.size !== 1) throw new Error('Expected exactly one pending timeout');
      callbacks.delete(only[0]);
      if (typeof only[1] !== 'function') throw new Error('Expected a timeout callback');
      only[1]();
    },
    restore: () => {
      window.setTimeout = originalSet;
      window.clearTimeout = originalClear;
    },
  };
}

function lineText(cells: GhosttyCell[] | null): string {
  return (cells ?? [])
    .filter((cell) => cell.codepoint > 0)
    .map((cell) => String.fromCodePoint(cell.codepoint))
    .join('');
}

describe('synchronized output', () => {
  test('exports parser-owned state, repeated-enable generation, reset, and resize semantics', async () => {
    const ghostty = await Ghostty.load();
    const terminal = ghostty.createTerminal(20, 4);
    try {
      expect(terminal.isSynchronizedOutput()).toBe(false);
      expect(terminal.getSynchronizedOutputGeneration()).toBe(0);

      terminal.write('\x1b[?202');
      expect(terminal.isSynchronizedOutput()).toBe(false);
      terminal.write('6h');
      expect(terminal.isSynchronizedOutput()).toBe(true);
      expect(terminal.getSynchronizedOutputGeneration()).toBe(1);

      terminal.write('\x1b[?2026x');
      expect(terminal.getSynchronizedOutputGeneration()).toBe(1);
      terminal.write('\x1b[?2026h');
      expect(terminal.getSynchronizedOutputGeneration()).toBe(2);

      terminal.write('\x1b[?2026l');
      expect(terminal.isSynchronizedOutput()).toBe(false);
      terminal.write('\x1b[?2026h\x1b[?2026l');
      expect(terminal.isSynchronizedOutput()).toBe(false);
      expect(terminal.getSynchronizedOutputGeneration()).toBe(3);

      terminal.write('\x1b[?2026h');
      terminal.resetSynchronizedOutput();
      expect(terminal.isSynchronizedOutput()).toBe(false);
      terminal.write('\x1b[?2026h\x1bc');
      expect(terminal.isSynchronizedOutput()).toBe(false);
      terminal.write('\x1b[?2026h');
      terminal.resize(30, 4);
      expect(terminal.isSynchronizedOutput()).toBe(false);
    } finally {
      terminal.free();
    }
  });

  test('parses and responds while deferring dirty state, then paints one complete frame', async () => {
    const frames = installAnimationFrameHarness();
    const timers = installTimeoutHarness();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const terminal = await createIsolatedTerminal({ cols: 30, rows: 4 });
    const responses: string[] = [];
    const responseListener = terminal.onData((data) => responses.push(data));
    try {
      terminal.open(container);
      frames.runNext();
      const before = terminal.getRenderStats();

      terminal.write('\x1b[?2026hfirst');
      terminal.write(' second\x1b[6n');
      terminal.renderer?.setTheme({ background: '#101010', foreground: '#eeeeee' });
      terminal.options.fontSize += 1;
      terminal.options.cursorStyle = 'bar';

      expect(frames.callbacks.size).toBe(0);
      expect(timers.callbacks.size).toBe(1);
      expect(lineText(terminal.wasmTerm?.getLine(0) ?? null)).toContain('first second');
      expect(responses).toContain('\x1b[1;13R');
      expect(terminal.getRenderStats()).toMatchObject({
        parsedWrites: before.parsedWrites + 2,
        renderFrames: before.renderFrames,
        synchronizedOutput: true,
      });

      terminal.write('\x1b[?2026lfinal');
      expect(timers.callbacks.size).toBe(0);
      expect(frames.callbacks.size).toBe(1);
      frames.runNext();

      expect(frames.callbacks.size).toBe(0);
      expect(terminal.getRenderStats()).toMatchObject({
        renderFrames: before.renderFrames + 1,
        fullRenderFrames: before.fullRenderFrames + 1,
        synchronizedOutput: false,
      });
      expect(lineText(terminal.wasmTerm?.getLine(0) ?? null)).toContain('first secondfinal');
    } finally {
      responseListener.dispose();
      terminal.dispose();
      container.remove();
      timers.restore();
      frames.restore();
    }
  });

  test('cancels a pending partial frame and restarts timeout only for repeated enables', async () => {
    const frames = installAnimationFrameHarness();
    const timers = installTimeoutHarness();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const terminal = await createIsolatedTerminal();
    try {
      terminal.open(container);
      frames.runNext();

      terminal.write('ordinary');
      expect(frames.callbacks.size).toBe(1);
      terminal.write('\x1b[?2026hheld');
      expect(frames.callbacks.size).toBe(0);
      const firstTimer = [...timers.callbacks.keys()];

      terminal.write('plain bytes');
      terminal.write('\x1b[?2026x');
      expect([...timers.callbacks.keys()]).toEqual(firstTimer);

      terminal.write('\x1b[?2026h');
      expect(timers.callbacks.size).toBe(1);
      expect([...timers.callbacks.keys()]).not.toEqual(firstTimer);
    } finally {
      terminal.dispose();
      container.remove();
      expect(timers.callbacks.size).toBe(0);
      timers.restore();
      frames.restore();
    }
  });

  test('bounds abandoned output, repaints it, and keeps later rendering functional', async () => {
    const frames = installAnimationFrameHarness();
    const timers = installTimeoutHarness();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const terminal = await createIsolatedTerminal();
    try {
      terminal.open(container);
      frames.runNext();
      const before = terminal.getRenderStats();

      terminal.write('\x1b[?2026habandoned');
      timers.runOnly();

      expect(terminal.wasmTerm?.isSynchronizedOutput()).toBe(false);
      expect(frames.callbacks.size).toBe(1);
      frames.runNext();
      expect(terminal.getRenderStats()).toMatchObject({
        renderFrames: before.renderFrames + 1,
        fullRenderFrames: before.fullRenderFrames + 1,
        synchronizedOutput: false,
        synchronizedOutputRecoveries: 1,
      });

      terminal.write(' later');
      expect(frames.callbacks.size).toBe(1);
      frames.runNext();
      expect(terminal.getRenderStats().renderFrames).toBe(before.renderFrames + 2);
    } finally {
      terminal.dispose();
      container.remove();
      timers.restore();
      frames.restore();
    }
  });

  test('pause and resume never expose an active synchronized frame', async () => {
    const frames = installAnimationFrameHarness();
    const timers = installTimeoutHarness();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const terminal = await createIsolatedTerminal();
    try {
      terminal.open(container);
      frames.runNext();

      terminal.setRenderPaused(true);
      terminal.write('\x1b[?2026hhidden');
      terminal.setRenderPaused(false);
      expect(frames.callbacks.size).toBe(0);

      terminal.write('\x1b[?2026l');
      expect(frames.callbacks.size).toBe(1);
      frames.runNext();

      terminal.setRenderPaused(true);
      terminal.write('\x1b[?2026hmore\x1b[?2026l');
      expect(frames.callbacks.size).toBe(0);
      terminal.setRenderPaused(false);
      expect(frames.callbacks.size).toBe(1);
      frames.runNext();

      terminal.setRenderPaused(true);
      terminal.write('\x1b[?2026hreset while paused');
      const renderer = terminal.renderer;
      if (!renderer) throw new Error('Expected renderer');
      const originalClear = renderer.clear;
      let clearCalls = 0;
      renderer.clear = () => {
        clearCalls++;
      };
      terminal.reset();
      renderer.clear = originalClear;
      expect(clearCalls).toBe(0);
      expect(frames.callbacks.size).toBe(0);
      terminal.setRenderPaused(false);
      expect(frames.callbacks.size).toBe(1);
      frames.runNext();
    } finally {
      terminal.dispose();
      container.remove();
      timers.restore();
      frames.restore();
    }
  });

  test('resize, reset, and disposal revoke synchronized deferred work safely', async () => {
    const frames = installAnimationFrameHarness();
    const timers = installTimeoutHarness();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const terminal = await createIsolatedTerminal({ cols: 20, rows: 4 });
    try {
      terminal.open(container);
      frames.runNext();

      terminal.write('\x1b[?2026hresize');
      terminal.resize(30, 4);
      expect(terminal.wasmTerm?.isSynchronizedOutput()).toBe(false);
      expect(timers.callbacks.size).toBe(0);
      expect(frames.callbacks.size).toBe(1);
      frames.runNext();

      const queuedWrites = (terminal as unknown as { writeQueue: Uint8Array[] }).writeQueue;
      const encoder = new TextEncoder();
      queuedWrites.push(encoder.encode('\x1b[?202'), encoder.encode('6hqueued'));
      terminal.resize(40, 4);
      expect(terminal.wasmTerm?.isSynchronizedOutput()).toBe(true);
      expect(timers.callbacks.size).toBe(1);
      expect(frames.callbacks.size).toBe(0);
      terminal.write('\x1b[?2026l');
      expect(frames.callbacks.size).toBe(1);
      frames.runNext();

      terminal.write('\x1b[?2026hreset');
      terminal.reset();
      expect(timers.callbacks.size).toBe(0);
      expect(terminal.getRenderStats().synchronizedOutput).toBe(false);
      expect(frames.callbacks.size).toBe(1);
      frames.runNext();

      terminal.write('\x1b[?2026hdispose');
      terminal.dispose();
      expect(timers.callbacks.size).toBe(0);
      expect(frames.callbacks.size).toBe(0);
    } finally {
      terminal.dispose();
      container.remove();
      timers.restore();
      frames.restore();
    }
  });
});
