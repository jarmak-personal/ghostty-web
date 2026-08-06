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
  rendererPauseStates: boolean[];
  scrollEvents: number[];
} {
  const renderCalls: RenderCall[] = [];
  const rendererPauseStates: boolean[] = [];
  const scrollEvents: number[] = [];
  const renderer = {
    render: (...args: RenderCall) => {
      renderCalls.push(args);
      return { y: 0 };
    },
    getCursorVisible: () => true,
    setRenderPaused: (paused: boolean) => rendererPauseStates.push(paused),
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
    synchronizedOutputActive: false,
    synchronizedOutputGeneration: 0,
    synchronizedOutputTimeout: undefined,
    synchronizedOutputRecoveries: 0,
    animationFrameId: undefined,
    scrollAnimationFrame: undefined,
    scrollAnimationStartTime: undefined,
    targetViewportY: 0,
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
    scrollEmitter: { fire: (viewportY: number) => scrollEvents.push(viewportY), dispose: () => {} },
    renderEmitter: disposable,
    terminalEventEmitter: disposable,
    renderCalls,
    cursorResetCount: 0,
    rendererPauseStates,
    scrollEvents,
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
        synchronizedOutput: false,
        synchronizedOutputRecoveries: 0,
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
      expect(terminal.rendererPauseStates).toEqual([true]);
    } finally {
      frames.restore();
    }
  });

  test('normalizes an interrupted smooth scroll when presentation pauses', () => {
    const frames = installAnimationFrameHarness();
    try {
      const terminal = createSchedulerHarness();
      const scrollFrame = requestAnimationFrame(() => {});
      Object.assign(terminal, {
        viewportY: 1.75,
        targetViewportY: 4.9,
        scrollAnimationStartTime: Date.now(),
        scrollAnimationFrame: scrollFrame,
      });

      terminal.setRenderPaused(true);

      expect(frames.callbacks.size).toBe(0);
      expect(terminal.getViewportY()).toBe(4);
      expect(terminal.scrollEvents).toEqual([4]);
      expect(terminal.rendererPauseStates).toEqual([true]);

      terminal.setRenderPaused(false);
      expect(terminal.rendererPauseStates).toEqual([true, false]);
      expect(frames.callbacks.size).toBe(1);
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
        renderPaused: false,
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

      renderer.setRenderPaused(true);
      expect(intervals.size).toBe(0);
      expect(renderer.getCursorVisible()).toBe(true);
      renderer.resetCursorBlink();
      expect(intervals.size).toBe(0);
      expect(renderRequests).toBe(3);

      renderer.setRenderPaused(false);
      expect(intervals.size).toBe(0);
      // The reveal frame reconciles against freshly advanced native state.
      const cursorLifecycle = renderer as unknown as {
        reconcileCursorBlink(enabled: boolean): void;
      };
      cursorLifecycle.reconcileCursorBlink(true);
      expect(intervals.size).toBe(1);

      cursorLifecycle.reconcileCursorBlink(false);
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

  test('requests a repaint after font metrics are remeasured', () => {
    let renderRequests = 0;
    const renderer = new CanvasRenderer(document.createElement('canvas'), {
      requestRender: () => {
        renderRequests++;
      },
    });

    try {
      renderer.remeasureFont();
      expect(renderRequests).toBe(1);
    } finally {
      renderer.dispose();
    }
  });

  test('resolves custom link providers before built-ins with documented ordering', () => {
    const providers: ILinkProvider[] = [];
    const detector = new LinkDetector({} as ConstructorParameters<typeof LinkDetector>[0]);
    const osc8 = { provideLinks: () => {} };
    const urlRegex = { provideLinks: () => {} };
    const firstCustom = { provideLinks: () => {} };
    const latestCustom = { provideLinks: () => {} };
    detector.registerProvider(osc8);
    detector.registerProvider(urlRegex);
    detector.registerProvider(firstCustom, true);
    detector.registerProvider(latestCustom, true);
    providers.push(...((detector as unknown as { providers: ILinkProvider[] }).providers ?? []));

    const terminalCalls: Array<[ILinkProvider, boolean | undefined]> = [];
    const terminal = Object.assign(Object.create(Terminal.prototype) as Terminal, {
      linkDetector: {
        registerProvider: (provider: ILinkProvider, highPriority?: boolean) => {
          terminalCalls.push([provider, highPriority]);
        },
      },
    });
    terminal.registerLinkProvider(latestCustom);

    expect(providers).toEqual([latestCustom, firstCustom, osc8, urlRegex]);
    expect(terminalCalls).toEqual([[latestCustom, true]]);
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
        return originalRender.call(renderer, ...args);
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

  test('schedules a full repaint when a resize listener throws', async () => {
    const frames = installAnimationFrameHarness();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const terminal = await createIsolatedTerminal({ cols: 20, rows: 4 });
    const originalConsoleError = console.error;
    const resizeErrors: unknown[][] = [];
    console.error = (...args: unknown[]) => resizeErrors.push(args);

    try {
      terminal.open(container);
      frames.runNext();
      terminal.onResize(() => {
        throw new Error('resize listener failed');
      });

      terminal.resize(30, 4);

      expect(resizeErrors).toHaveLength(1);
      expect(frames.callbacks.size).toBe(1);
      frames.runNext();
      expect(terminal.getRenderStats()).toMatchObject({
        renderFrames: 2,
        fullRenderFrames: 2,
        pendingFrame: false,
      });
    } finally {
      console.error = originalConsoleError;
      terminal.dispose();
      container.remove();
      frames.restore();
    }
  });
});
