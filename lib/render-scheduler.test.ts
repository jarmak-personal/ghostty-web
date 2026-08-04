import { describe, expect, test } from 'bun:test';
import { LinkDetector } from './link-detector';
import { CanvasRenderer } from './renderer';
import { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';
import type { ILinkProvider } from './types';

type RenderCall = [unknown, boolean, number, unknown, number];

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

function createSchedulerHarness(): Terminal & {
  renderCalls: RenderCall[];
  cursorResetCount: number;
} {
  const renderCalls: RenderCall[] = [];
  const renderer = {
    render: (...args: RenderCall) => renderCalls.push(args),
    getCursorVisible: () => true,
    resetCursorBlink: () => {
      terminal.cursorResetCount++;
    },
  };
  const disposable = { dispose: () => {} };
  const terminal = Object.assign(Object.create(Terminal.prototype) as Terminal, {
    isDisposed: false,
    isOpen: true,
    renderPaused: false,
    forceFullRender: false,
    parsedWrites: 7,
    renderRequests: 0,
    renderFrames: 0,
    fullRenderFrames: 0,
    writeQueue: [],
    animationFrameId: undefined,
    scrollAnimationFrame: undefined,
    scrollbarVisible: false,
    scrollbarOpacity: 0,
    viewportY: 0,
    lastCursorY: 0,
    renderer,
    wasmTerm: { getCursor: () => ({ y: 0 }) },
    cursorMoveEmitter: { fire: () => {}, dispose: () => {} },
    addons: [],
    cleanupComponents: () => {},
    dataEmitter: disposable,
    resizeEmitter: disposable,
    bellEmitter: disposable,
    selectionChangeEmitter: disposable,
    keyEmitter: disposable,
    titleChangeEmitter: disposable,
    scrollEmitter: disposable,
    renderEmitter: disposable,
    renderCalls,
    cursorResetCount: 0,
  }) as ReturnType<typeof createSchedulerHarness>;
  return terminal;
}

describe('hvir presentation scheduler', () => {
  test('coalesces requests and preserves a requested full repaint', () => {
    const frames = installAnimationFrameHarness();
    try {
      const terminal = createSchedulerHarness();

      terminal.requestRender();
      terminal.requestRender(true);

      expect(frames.callbacks.size).toBe(1);
      expect(terminal.getRenderStats()).toEqual({
        parsedWrites: 7,
        renderRequests: 2,
        renderFrames: 0,
        fullRenderFrames: 0,
        paused: false,
        pendingFrame: true,
        cursorVisible: true,
      });

      frames.runNext();

      expect(terminal.renderCalls).toHaveLength(1);
      expect(terminal.renderCalls[0][1]).toBe(true);
      expect(terminal.getRenderStats().renderFrames).toBe(1);
      expect(terminal.getRenderStats().fullRenderFrames).toBe(1);
      expect(frames.callbacks.size).toBe(0);
    } finally {
      frames.restore();
    }
  });

  test('parses while hidden and schedules one full reveal frame', async () => {
    const frames = installAnimationFrameHarness();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const terminal = await createIsolatedTerminal();
    try {
      terminal.setRenderPaused(true);
      terminal.open(container);
      terminal.write('hidden output');

      expect(terminal.getRenderStats()).toMatchObject({
        parsedWrites: 1,
        renderFrames: 0,
        paused: true,
        pendingFrame: false,
      });
      expect(frames.callbacks.size).toBe(0);

      terminal.setRenderPaused(false);
      expect(frames.callbacks.size).toBe(1);
      frames.runNext();

      expect(terminal.getRenderStats()).toMatchObject({
        parsedWrites: 1,
        renderFrames: 1,
        fullRenderFrames: 1,
        paused: false,
        pendingFrame: false,
      });
    } finally {
      terminal.dispose();
      container.remove();
      frames.restore();
    }
  });

  test('cancels a pending frame on disposal and ignores late requests', () => {
    const frames = installAnimationFrameHarness();
    try {
      const terminal = createSchedulerHarness();
      terminal.requestRender();

      terminal.dispose();
      terminal.resetCursorBlink();
      terminal.requestRender(true);

      expect(frames.callbacks.size).toBe(0);
      expect(terminal.getRenderStats()).toMatchObject({
        renderRequests: 1,
        renderFrames: 0,
        pendingFrame: false,
      });
      expect(terminal.renderCalls).toHaveLength(0);
      expect(terminal.cursorResetCount).toBe(0);
    } finally {
      frames.restore();
    }
  });

  test('resets the visible cursor and restarts one idle blink cadence', () => {
    const originalSetInterval = window.setInterval;
    const originalClearInterval = window.clearInterval;
    const intervals = new Map<number, TimerHandler>();
    let nextInterval = 0;
    let renderRequests = 0;

    window.setInterval = ((handler: TimerHandler) => {
      const id = nextInterval++;
      intervals.set(id, handler);
      return id;
    }) as typeof window.setInterval;
    window.clearInterval = ((id: number) => {
      intervals.delete(id);
    }) as typeof window.clearInterval;

    try {
      const renderer = Object.assign(Object.create(CanvasRenderer.prototype) as CanvasRenderer, {
        cursorBlink: true,
        cursorVisible: false,
        cursorBlinkInterval: undefined,
        requestRender: () => {
          renderRequests++;
        },
      });

      renderer.resetCursorBlink();
      renderer.resetCursorBlink();

      expect(renderer.getCursorVisible()).toBe(true);
      expect(intervals.size).toBe(1);
      expect(renderRequests).toBe(2);

      const blink = intervals.values().next().value as TimerHandler;
      if (typeof blink !== 'function') throw new Error('Expected interval callback');
      blink();
      expect(renderer.getCursorVisible()).toBe(false);
      expect(renderRequests).toBe(3);

      renderer.setCursorBlink(false);
      const requestsAfterDisable = renderRequests;
      renderer.resetCursorBlink();
      expect(intervals.size).toBe(0);
      expect(renderer.getCursorVisible()).toBe(true);
      expect(renderRequests).toBe(requestsAfterDisable);
    } finally {
      window.setInterval = originalSetInterval;
      window.clearInterval = originalClearInterval;
    }
  });

  test('registers custom link providers ahead of built-in providers', () => {
    const providers: ILinkProvider[] = [];
    const detector = new LinkDetector({} as ConstructorParameters<typeof LinkDetector>[0]);
    const builtin = { provideLinks: () => {} };
    const custom = { provideLinks: () => {} };
    detector.registerProvider(builtin);
    detector.registerProvider(custom, true);
    providers.push(...((detector as unknown as { providers: ILinkProvider[] }).providers ?? []));

    const terminalCalls: Array<[ILinkProvider, boolean | undefined]> = [];
    const terminal = Object.assign(Object.create(Terminal.prototype) as Terminal, {
      linkDetector: {
        registerProvider: (provider: ILinkProvider, highPriority?: boolean) => {
          terminalCalls.push([provider, highPriority]);
        },
      },
    });
    terminal.registerLinkProvider(custom);

    expect(providers).toEqual([custom, builtin]);
    expect(terminalCalls).toEqual([[custom, true]]);
  });

  test('resizes and fully paints atomically with device-pixel scaling', async () => {
    const frames = installAnimationFrameHarness();
    const dprDescriptor = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const terminal = await createIsolatedTerminal({ cols: 20, rows: 4 });

    try {
      terminal.open(container);
      frames.runNext();

      const renderer = terminal.renderer;
      if (!renderer) throw new Error('Expected renderer');
      const canvas = renderer.getCanvas();
      const previousWidth = canvas.width;
      const originalRender = renderer.render;
      const originalResize = renderer.resize;
      const renderForces: boolean[] = [];
      let resizeCalls = 0;
      renderer.resize = ((...args: Parameters<typeof renderer.resize>) => {
        resizeCalls++;
        originalResize.call(renderer, ...args);
      }) as typeof renderer.resize;
      renderer.render = ((...args: Parameters<typeof renderer.render>) => {
        renderForces.push(args[1]);
        originalRender.call(renderer, ...args);
      }) as typeof renderer.render;

      terminal.resize(30, 4);

      // WASM dimensions and the resize event update synchronously, but the
      // painted backing store remains intact until its presentation callback.
      expect(canvas.width).toBe(previousWidth);
      expect(resizeCalls).toBe(0);
      expect(frames.callbacks.size).toBe(1);

      frames.runNext();

      const metrics = renderer.getMetrics();
      expect(resizeCalls).toBe(1);
      expect(renderForces).toEqual([true]);
      expect(canvas.width).toBe(metrics.width * 30 * 2);
      expect(canvas.height).toBe(metrics.height * 4 * 2);
      expect(canvas.style.width).toBe(`${metrics.width * 30}px`);
      expect(canvas.style.height).toBe(`${metrics.height * 4}px`);
    } finally {
      terminal.dispose();
      container.remove();
      if (dprDescriptor) {
        Object.defineProperty(window, 'devicePixelRatio', dprDescriptor);
      } else {
        Reflect.deleteProperty(window, 'devicePixelRatio');
      }
      frames.restore();
    }
  });
});
