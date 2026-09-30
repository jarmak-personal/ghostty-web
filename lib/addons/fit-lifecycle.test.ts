import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { FitAddon } from './fit';

class ObservedResize {
  static instances: ObservedResize[] = [];
  disconnected = false;
  constructor(readonly callback: ResizeObserverCallback) {
    ObservedResize.instances.push(this);
  }
  observe(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
  emit(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

const original = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  ResizeObserver: globalThis.ResizeObserver,
};
let nextId: number;
let timers: Map<number, () => void>;
let frames: Map<number, FrameRequestCallback>;
let addons: FitAddon[];

beforeEach(() => {
  nextId = 1;
  timers = new Map();
  frames = new Map();
  addons = [];
  ObservedResize.instances = [];
  Object.assign(globalThis, {
    ResizeObserver: ObservedResize,
    setTimeout: (callback: () => void) => {
      const id = nextId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
});
afterEach(() => {
  for (const addon of addons) addon.dispose();
  Object.assign(globalThis, original);
  document.body.replaceChildren();
});

function fixture() {
  const element = document.createElement('div');
  document.body.append(element);
  let width = 800;
  let cellWidth = 10;
  Object.defineProperties(element, {
    clientWidth: { get: () => width },
    clientHeight: { get: () => 400 },
  });
  const sizes: { cols: number; rows: number }[] = [];
  const terminal = {
    element,
    cols: 80,
    rows: 20,
    renderer: { getMetrics: () => ({ width: cellWidth, height: 20 }) },
    resize(cols: number, rows: number) {
      terminal.cols = cols;
      terminal.rows = rows;
      sizes.push({ cols, rows });
    },
  };
  const addon = new FitAddon({ resizeDebounceMs: 75 });
  addon.activate(terminal);
  addons.push(addon);
  return {
    terminal,
    addon,
    sizes,
    setWidth: (value: number) => (width = value),
    setMetric: (value: number) => (cellWidth = value),
  };
}
function settle() {
  const pendingTimers = [...timers.values()];
  timers.clear();
  for (const timer of pendingTimers) timer();
  const pendingFrames = [...frames.values()];
  frames.clear();
  for (const frame of pendingFrames) frame(0);
}

describe('FitAddon presentation lifecycle', () => {
  test('fits fractional padding and rejects invalid geometry', () => {
    const f = fixture();
    f.terminal.element.style.padding = '0.5px 0.75px';
    f.addon.fit();
    expect(f.sizes).toEqual([{ cols: 79, rows: 19 }]);
    f.setWidth(0);
    expect(f.addon.proposeDimensions()).toBeUndefined();
    f.setWidth(800);
    f.setMetric(Number.NaN);
    expect(f.addon.proposeDimensions()).toBeUndefined();
  });

  test('coalesces latest dimensions and completes even if no resize is needed', () => {
    const f = fixture();
    let completions = 0;
    f.addon.resume(() => completions++);
    f.setWidth(900);
    ObservedResize.instances[0].emit();
    f.setWidth(1000);
    ObservedResize.instances[0].emit();
    expect(timers.size).toBe(1);
    settle();
    expect(f.sizes).toEqual([{ cols: 100, rows: 20 }]);
    expect(completions).toBe(1);
    f.addon.resume(() => completions++);
    settle();
    expect(f.sizes).toHaveLength(1);
    expect(completions).toBe(2);
  });

  test('waits for measurable geometry before completing, even for an unchanged grid', () => {
    const f = fixture();
    let completions = 0;
    f.setWidth(0);
    f.addon.resume(() => completions++);
    settle();
    expect(f.sizes).toEqual([]);
    expect(completions).toBe(0);
    expect(timers.size).toBe(0);
    expect(frames.size).toBe(0);
    f.setWidth(800);
    f.setMetric(Number.NaN);
    f.addon.onCellMetricsChange();
    settle();
    expect(completions).toBe(0);
    f.setMetric(10);
    ObservedResize.instances[0].emit();
    settle();
    expect(f.sizes).toEqual([]);
    expect(completions).toBe(1);
  });

  test('suspension cancels a completion waiting for measurable geometry', () => {
    const f = fixture();
    let completions = 0;
    f.setWidth(0);
    f.addon.resume(() => completions++);
    const observer = ObservedResize.instances[0];
    settle();
    f.addon.suspend();
    f.setWidth(900);
    observer.emit();
    f.addon.resume();
    settle();
    expect(f.sizes).toEqual([{ cols: 90, rows: 20 }]);
    expect(completions).toBe(0);
  });

  test('replaces a pending frame with latest metric and display-scale work', () => {
    const f = fixture();
    let completions = 0;
    f.addon.resume(() => completions++);
    for (const timer of timers.values()) timer();
    timers.clear();
    const staleFrame = [...frames.values()][0];
    f.setMetric(8);
    f.addon.onCellMetricsChange();
    staleFrame(0);
    expect(f.sizes).toEqual([]);
    f.setMetric(5);
    f.addon.onDevicePixelRatioChange();
    settle();
    expect(f.sizes).toEqual([{ cols: 160, rows: 20 }]);
    expect(completions).toBe(1);
  });

  test('retains resize feedback as trailing work instead of dropping it', () => {
    const f = fixture();
    const resize = f.terminal.resize;
    f.terminal.resize = (cols, rows) => {
      resize(cols, rows);
      if (cols === 90) {
        f.setWidth(1000);
        ObservedResize.instances[0].emit();
      }
    };
    let completions = 0;
    f.setWidth(900);
    f.addon.resume(() => completions++);
    settle();
    expect(f.sizes).toEqual([{ cols: 90, rows: 20 }]);
    expect(completions).toBe(0);
    settle();
    expect(f.sizes.at(-1)).toEqual({ cols: 100, rows: 20 });
    expect(completions).toBe(1);
  });

  test('suspends observation, timers, frames, and metric fitting; resumes fresh', () => {
    const f = fixture();
    let completions = 0;
    f.addon.resume(() => completions++);
    const staleTimer = [...timers.values()][0];
    for (const timer of timers.values()) timer();
    timers.clear();
    const staleFrame = [...frames.values()][0];
    const observer = ObservedResize.instances[0];
    f.addon.suspend();
    f.setWidth(900);
    observer.emit();
    staleTimer();
    staleFrame(0);
    f.addon.onCellMetricsChange();
    f.addon.onDevicePixelRatioChange();
    f.addon.fit();
    expect(observer.disconnected).toBe(true);
    expect(timers.size).toBe(0);
    expect(frames.size).toBe(0);
    expect(f.sizes).toEqual([]);
    expect(completions).toBe(0);
    f.addon.resume(() => completions++);
    settle();
    expect(ObservedResize.instances).toHaveLength(2);
    observer.emit();
    expect(timers.size).toBe(0);
    expect(f.sizes).toEqual([{ cols: 90, rows: 20 }]);
    expect(completions).toBe(1);
  });

  test('disposal rejects old callbacks and completion-triggered disposal is safe', () => {
    const f = fixture();
    let completions = 0;
    f.addon.resume(() => completions++);
    const staleTimer = [...timers.values()][0];
    f.addon.dispose();
    f.addon.dispose();
    staleTimer();
    settle();
    f.addon.resume();
    expect(completions).toBe(0);
    expect(f.sizes).toEqual([]);
    f.addon.activate(f.terminal);
    f.addon.resume(() => {
      completions++;
      f.addon.dispose();
    });
    settle();
    expect(completions).toBe(1);
    expect(timers.size).toBe(0);
    expect(frames.size).toBe(0);
  });
});
