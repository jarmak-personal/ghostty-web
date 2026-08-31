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

function installDevicePixelRatioHarness(
  initialDevicePixelRatio: number,
  mediaQueryApi: 'modern' | 'legacy' = 'modern'
): {
  set: (devicePixelRatio: number, signal?: 'media' | 'resize' | 'none') => void;
  activeMediaListeners: () => number;
  activeResizeListeners: () => number;
  restore: () => void;
} {
  const dprDescriptor = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
  const originalMatchMedia = window.matchMedia;
  const originalAddEventListener = window.addEventListener;
  const originalRemoveEventListener = window.removeEventListener;
  const mediaQueries: Array<{
    media: string;
    listeners: Set<(event: MediaQueryListEvent) => void>;
  }> = [];
  const resizeListeners = new Set<EventListenerOrEventListenerObject>();

  Object.defineProperty(window, 'devicePixelRatio', {
    configurable: true,
    value: initialDevicePixelRatio,
  });
  window.matchMedia = ((media: string) => {
    const query = {
      media,
      listeners: new Set<(event: MediaQueryListEvent) => void>(),
    };
    mediaQueries.push(query);
    const eventTargetApi =
      mediaQueryApi === 'modern'
        ? {
            addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
              query.listeners.add(listener),
            removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
              query.listeners.delete(listener),
          }
        : {};
    const legacyApi =
      mediaQueryApi === 'legacy'
        ? {
            addListener: (listener: (event: MediaQueryListEvent) => void) =>
              query.listeners.add(listener),
            removeListener: (listener: (event: MediaQueryListEvent) => void) =>
              query.listeners.delete(listener),
          }
        : { addListener: () => {}, removeListener: () => {} };
    return {
      media,
      matches: true,
      onchange: null,
      ...eventTargetApi,
      ...legacyApi,
      dispatchEvent: () => true,
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
  window.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) => {
    if (type === 'resize') resizeListeners.add(listener);
    originalAddEventListener.call(window, type, listener, options);
  }) as typeof window.addEventListener;
  window.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions
  ) => {
    if (type === 'resize') resizeListeners.delete(listener);
    originalRemoveEventListener.call(window, type, listener, options);
  }) as typeof window.removeEventListener;

  return {
    set: (devicePixelRatio, signal = 'media') => {
      Object.defineProperty(window, 'devicePixelRatio', {
        configurable: true,
        value: devicePixelRatio,
      });
      if (signal === 'media') {
        const query = mediaQueries.at(-1);
        if (!query) throw new Error('Expected an active resolution media query');
        const event = { matches: false, media: query.media } as MediaQueryListEvent;
        for (const listener of [...query.listeners]) listener(event);
      } else if (signal === 'resize') {
        window.dispatchEvent(new Event('resize'));
      }
    },
    activeMediaListeners: () =>
      mediaQueries.reduce((total, query) => total + query.listeners.size, 0),
    activeResizeListeners: () => resizeListeners.size,
    restore: () => {
      window.matchMedia = originalMatchMedia;
      window.addEventListener = originalAddEventListener;
      window.removeEventListener = originalRemoveEventListener;
      if (dprDescriptor) {
        Object.defineProperty(window, 'devicePixelRatio', dprDescriptor);
      } else {
        Reflect.deleteProperty(window, 'devicePixelRatio');
      }
    },
  };
}

function createSchedulerHarness(): Terminal & {
  renderCalls: RenderCall[];
  renderedRanges: Array<{ start: number; end: number }>;
  renderEvents: Array<{ start: number; end: number }>;
  cursorMoveEvents: number;
  cursorResetCount: number;
  rendererPauseStates: boolean[];
  scrollEvents: number[];
} {
  const renderCalls: RenderCall[] = [];
  const rendererPauseStates: boolean[] = [];
  const scrollEvents: number[] = [];
  const renderedRanges: Array<{ start: number; end: number }> = [];
  const renderEvents: Array<{ start: number; end: number }> = [];
  const renderer = {
    render: (...args: RenderCall) => {
      renderCalls.push(args);
      return { x: 0, y: 0 };
    },
    getRenderedRowRanges: () => renderedRanges.map((range) => ({ ...range })),
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
    scrollAnimationStartViewportY: 0,
    scrollAnimationGeneration: 0,
    targetViewportY: 0,
    scrollbarVisible: false,
    scrollbarOpacity: 0,
    viewportY: 0,
    lastCursorX: 0,
    lastCursorY: 0,
    lastCursorAlternateScreen: false,
    cursorScreenGeneration: 0,
    lastPresentedCursorScreenGeneration: 0,
    renderer,
    wasmTerm: { isAlternateScreen: () => false },
    cursorMoveEvents: 0,
    cursorMoveEmitter: {
      fire: () => terminal.cursorMoveEvents++,
      dispose: () => {},
    },
    addons: [],
    cleanupComponents: () => {},
    dataEmitter: disposable,
    resizeEmitter: disposable,
    bellEmitter: disposable,
    selectionChangeEmitter: disposable,
    keyEmitter: disposable,
    titleChangeEmitter: disposable,
    scrollEmitter: { fire: (viewportY: number) => scrollEvents.push(viewportY), dispose: () => {} },
    renderEmitter: {
      fire: (range: { start: number; end: number }) => renderEvents.push(range),
      dispose: () => {},
    },
    terminalEventEmitter: disposable,
    renderCalls,
    renderedRanges,
    renderEvents,
    cursorResetCount: 0,
    rendererPauseStates,
    scrollEvents,
  }) as ReturnType<typeof createSchedulerHarness>;
  return terminal;
}

describe('hvir presentation scheduler', () => {
  test('forwards each actual painted row range once', () => {
    const frames = installAnimationFrameHarness();
    try {
      const terminal = createSchedulerHarness();
      terminal.renderedRanges.push({ start: 1, end: 3 }, { start: 7, end: 8 });

      terminal.requestRender();
      frames.runNext();

      expect(terminal.renderEvents).toEqual([
        { start: 1, end: 3 },
        { start: 7, end: 8 },
      ]);
    } finally {
      frames.restore();
    }
  });

  test('coalesces cursor axes and buffer switches by presented frame', () => {
    const frames = installAnimationFrameHarness();
    try {
      const terminal = createSchedulerHarness();
      const cursor = { x: 0, y: 0 };
      let alternateScreen = false;
      (terminal.renderer as CanvasRenderer).render = (() => ({
        ...cursor,
      })) as CanvasRenderer['render'];
      terminal.wasmTerm!.isAlternateScreen = () => alternateScreen;

      cursor.x = 1;
      terminal.requestRender();
      frames.runNext();
      expect(terminal.cursorMoveEvents).toBe(1);

      terminal.requestRender();
      frames.runNext();
      expect(terminal.cursorMoveEvents).toBe(1);

      cursor.y = 2;
      terminal.requestRender();
      frames.runNext();
      expect(terminal.cursorMoveEvents).toBe(2);

      alternateScreen = true;
      Object.assign(terminal, { cursorScreenGeneration: 1 });
      terminal.requestRender();
      frames.runNext();
      expect(terminal.cursorMoveEvents).toBe(3);

      // Entering and leaving a screen between frames is still one observable
      // presentation transition, even when the final screen is unchanged.
      alternateScreen = false;
      Object.assign(terminal, { cursorScreenGeneration: 3 });
      terminal.requestRender();
      frames.runNext();
      expect(terminal.cursorMoveEvents).toBe(4);
    } finally {
      frames.restore();
    }
  });

  test('publishes real horizontal, vertical, and same-write screen transitions', async () => {
    const frames = installAnimationFrameHarness();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const terminal = await createIsolatedTerminal({ cols: 20, rows: 4, focusOnOpen: false });
    try {
      terminal.open(container);
      frames.runNext();

      let cursorMoves = 0;
      const renderEvents: Array<{ start: number; end: number }> = [];
      terminal.onCursorMove(() => cursorMoves++);
      terminal.onRender((range) => renderEvents.push(range));

      terminal.write('x');
      frames.runNext();
      expect(cursorMoves).toBe(1);
      expect(renderEvents).toEqual(terminal.renderer!.getRenderedRowRanges());
      expect(renderEvents.length).toBeGreaterThan(0);

      renderEvents.length = 0;
      terminal.requestRender();
      frames.runNext();
      expect(renderEvents).toEqual([]);

      terminal.write('\r\n');
      frames.runNext();
      expect(cursorMoves).toBe(2);

      // The final cursor and screen match the pre-write presentation, but both
      // parser-owned buffer transitions must still produce one coalesced event.
      terminal.write('\x1b[?1049h\x1b[?1049l');
      frames.runNext();
      expect(cursorMoves).toBe(3);

      terminal.reset();
      frames.runNext();
      expect(cursorMoves).toBe(4);
    } finally {
      terminal.dispose();
      container.remove();
      frames.restore();
    }
  });

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
        lastFrame: {
          renderedRows: 0,
          materializedRows: 0,
          materializedCells: 0,
          textRuns: 0,
          textMeasurements: 0,
          shapedRuns: 0,
          shapedCells: 0,
          maxRunCells: 0,
        },
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

  test('atomically repaints 1→2 and 2→1 DPR transitions and notifies addons', async () => {
    const frames = installAnimationFrameHarness();
    const dpr = installDevicePixelRatioHarness(1);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const terminal = await createIsolatedTerminal({ cols: 20, rows: 4 });
    let addonNotifications = 0;
    let lateAddonNotifications = 0;
    let installedLateAddon = false;
    const originalConsoleError = console.error;
    const addonErrors: unknown[][] = [];
    console.error = (...args: unknown[]) => addonErrors.push(args);
    terminal.loadAddon({
      activate: () => {},
      onDevicePixelRatioChange: () => {
        if (installedLateAddon) return;
        installedLateAddon = true;
        terminal.loadAddon({
          activate: () => {},
          onDevicePixelRatioChange: () => lateAddonNotifications++,
          dispose: () => {},
        });
      },
      dispose: () => {},
    });
    terminal.loadAddon({
      activate: () => {},
      onDevicePixelRatioChange: () => {
        throw new Error('injected addon DPR failure');
      },
      dispose: () => {},
    });
    terminal.loadAddon({
      activate: () => {},
      onDevicePixelRatioChange: () => addonNotifications++,
      dispose: () => {},
    });

    try {
      terminal.open(container);
      frames.runNext();

      const renderer = terminal.renderer;
      if (!renderer) throw new Error('Expected renderer');
      const canvas = renderer.getCanvas();
      const context = (renderer as unknown as { ctx: CanvasRenderingContext2D }).ctx;
      const originalScale = context.scale;
      const scales: Array<[number, number]> = [];
      context.scale = ((x: number, y: number) => {
        scales.push([x, y]);
        originalScale.call(context, x, y);
      }) as typeof context.scale;

      const initialWidth = canvas.width;
      const initialFullFrames = terminal.getRenderStats().fullRenderFrames;
      dpr.set(2);

      // The old backing store stays intact until one atomic presentation frame.
      expect(canvas.width).toBe(initialWidth);
      expect(frames.callbacks.size).toBe(1);
      frames.runNext();

      expect(canvas.width).toBe(renderer.charWidth * terminal.cols * 2);
      expect(canvas.height).toBe(renderer.charHeight * terminal.rows * 2);
      expect(scales).toEqual([[2, 2]]);
      expect(addonNotifications).toBe(1);
      expect(lateAddonNotifications).toBe(0);
      expect(addonErrors).toHaveLength(1);
      expect(terminal.getRenderStats().fullRenderFrames).toBe(initialFullFrames + 1);
      expect(frames.callbacks.size).toBe(0);

      const highDpiWidth = canvas.width;
      dpr.set(1);
      expect(canvas.width).toBe(highDpiWidth);
      expect(frames.callbacks.size).toBe(1);
      frames.runNext();

      expect(canvas.width).toBe(renderer.charWidth * terminal.cols);
      expect(canvas.height).toBe(renderer.charHeight * terminal.rows);
      expect(scales).toEqual([
        [2, 2],
        [1, 1],
      ]);
      expect(addonNotifications).toBe(2);
      expect(lateAddonNotifications).toBe(1);
      expect(addonErrors).toHaveLength(2);
      expect(terminal.getRenderStats().fullRenderFrames).toBe(initialFullFrames + 2);
      expect(frames.callbacks.size).toBe(0);
    } finally {
      console.error = originalConsoleError;
      terminal.dispose();
      container.remove();
      dpr.restore();
      frames.restore();
    }
  });

  test('settles fractional DPR transitions without resize or repaint loops', async () => {
    const frames = installAnimationFrameHarness();
    const dpr = installDevicePixelRatioHarness(1);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const terminal = await createIsolatedTerminal({ cols: 21, rows: 5 });

    try {
      terminal.open(container);
      frames.runNext();

      const renderer = terminal.renderer;
      if (!renderer) throw new Error('Expected renderer');
      const canvas = renderer.getCanvas();
      const originalResize = renderer.resize;
      let resizeCalls = 0;
      renderer.resize = ((...args: Parameters<typeof renderer.resize>) => {
        resizeCalls++;
        originalResize.call(renderer, ...args);
      }) as typeof renderer.resize;

      for (const [ratio, signal] of [
        [1.25, 'resize'],
        [1.26, 'media'],
        [1.5, 'media'],
      ] as const) {
        dpr.set(ratio, signal);
        expect(frames.callbacks.size).toBe(1);
        frames.runNext();

        const metrics = renderer.getMetrics();
        expect(metrics.width * ratio).toBeCloseTo(Math.round(metrics.width * ratio));
        expect(metrics.height * ratio).toBeCloseTo(Math.round(metrics.height * ratio));
        expect(metrics.baseline * ratio).toBeCloseTo(Math.round(metrics.baseline * ratio));
        expect(canvas.width).toBe(Math.round(metrics.width * terminal.cols * ratio));
        expect(canvas.height).toBe(Math.round(metrics.height * terminal.rows * ratio));
        expect(frames.callbacks.size).toBe(0);

        terminal.requestRender();
        frames.runNext();
        expect(frames.callbacks.size).toBe(0);
      }

      expect(resizeCalls).toBe(3);
    } finally {
      terminal.dispose();
      container.remove();
      dpr.restore();
      frames.restore();
    }
  });

  test('releases DPR media-query and resize listeners on disposal', async () => {
    const frames = installAnimationFrameHarness();
    const dpr = installDevicePixelRatioHarness(1, 'legacy');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const terminal = await createIsolatedTerminal({ cols: 20, rows: 4 });

    try {
      terminal.open(container);
      frames.runNext();
      expect(dpr.activeMediaListeners()).toBe(1);
      expect(dpr.activeResizeListeners()).toBe(1);

      terminal.dispose();
      expect(dpr.activeMediaListeners()).toBe(0);
      expect(dpr.activeResizeListeners()).toBe(0);

      dpr.set(2, 'resize');
      expect(frames.callbacks.size).toBe(0);
    } finally {
      terminal.dispose();
      container.remove();
      dpr.restore();
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
