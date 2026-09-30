/** Engine-owned content-box fitting and presentation-controlled observation. */
import type { ITerminalAddon, ITerminalCore } from '../interfaces';

export interface ITerminalDimensions {
  cols: number;
  rows: number;
}

export interface FitAddonOptions {
  /** Delay before fitting the latest geometry (default: 100 ms). */
  resizeDebounceMs?: number;
}

type FittableTerminal = ITerminalCore & {
  resize?(cols: number, rows: number): void;
  renderer?: { getMetrics(): { width: number; height: number } };
};

export class FitAddon implements ITerminalAddon {
  private terminal?: FittableTerminal;
  private observer?: ResizeObserver;
  private timer?: ReturnType<typeof setTimeout>;
  private frame?: number;
  private completion?: () => void;
  private generation = 0;
  private observing = false;
  private suspended = false;
  private resizing = false;
  private readonly delay: number;

  constructor(options: FitAddonOptions = {}) {
    const delay = options.resizeDebounceMs;
    this.delay = typeof delay === 'number' && Number.isFinite(delay) && delay >= 0 ? delay : 100;
  }

  activate(terminal: ITerminalCore): void {
    this.terminal = terminal;
    this.suspended = false;
  }

  /** Initial manual fitting remains available before observation starts. */
  fit(): void {
    this.fitCurrentGeometry();
  }

  /** True only after current geometry is measurable, including an unchanged grid. */
  private fitCurrentGeometry(): boolean {
    if (!this.terminal || this.suspended) return false;
    if (this.resizing) {
      this.schedule();
      return false;
    }
    const dimensions = this.proposeDimensions();
    if (!dimensions) return false;
    if (dimensions.cols === this.terminal.cols && dimensions.rows === this.terminal.rows) {
      return true;
    }
    this.resizing = true;
    try {
      this.terminal.resize?.(dimensions.cols, dimensions.rows);
    } finally {
      this.resizing = false;
    }
    return true;
  }

  proposeDimensions(): ITerminalDimensions | undefined {
    const element = this.terminal?.element;
    const metrics = this.terminal?.renderer?.getMetrics();
    if (!element || !metrics) return undefined;
    const style = window.getComputedStyle(element);
    const width = element.clientWidth - pixels(style.paddingLeft) - pixels(style.paddingRight);
    const height = element.clientHeight - pixels(style.paddingTop) - pixels(style.paddingBottom);
    if (
      ![width, height, metrics.width, metrics.height].every(
        (value) => Number.isFinite(value) && value > 0
      )
    ) {
      return undefined;
    }
    return {
      cols: Math.max(2, Math.floor(width / metrics.width)),
      rows: Math.max(1, Math.floor(height / metrics.height)),
    };
  }

  observeResize(): void {
    this.resume();
  }

  /** Notify after a measurable settled fit; keep completion pending while geometry is invalid. */
  resume(afterSettledFit?: () => void): void {
    if (!this.terminal) return;
    this.suspended = false;
    this.observing = true;
    if (afterSettledFit) this.completion = afterSettledFit;
    if (!this.observer && this.terminal.element) {
      const observer = new ResizeObserver(() => {
        if (this.observer === observer) this.schedule();
      });
      this.observer = observer;
      observer.observe(this.terminal.element);
    }
    this.schedule();
  }

  suspend(): void {
    this.suspended = true;
    this.observing = false;
    this.generation++;
    this.observer?.disconnect();
    this.observer = undefined;
    this.cancel();
    this.completion = undefined;
  }

  onDevicePixelRatioChange(): void {
    this.onCellMetricsChange();
  }

  onCellMetricsChange(): void {
    if (!this.terminal || this.suspended) return;
    if (this.observing) this.schedule();
    else this.fit();
  }

  dispose(): void {
    this.suspend();
    this.terminal = undefined;
  }

  private cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.timer = undefined;
    this.frame = undefined;
  }

  private schedule(): void {
    if (!this.observing || this.suspended || !this.terminal) return;
    this.cancel();
    const generation = ++this.generation;
    this.timer = setTimeout(() => {
      if (!this.current(generation)) return;
      this.timer = undefined;
      this.frame = requestAnimationFrame(() => {
        if (!this.current(generation)) return;
        this.frame = undefined;
        if (!this.fitCurrentGeometry() || !this.current(generation)) return;
        const completion = this.completion;
        this.completion = undefined;
        completion?.();
      });
    }, this.delay);
  }

  private current(generation: number): boolean {
    return !!this.terminal && this.observing && !this.suspended && generation === this.generation;
  }
}

function pixels(value: string): number {
  return Number.parseFloat(value) || 0;
}
