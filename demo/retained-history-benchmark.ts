import { init, type RendererFrameStats, Terminal } from '../lib/index';

const COLS = 160;
const ROWS = 60;
const FULL_BUDGET_BYTES = 10_000_000;
const ESC = '\x1b';

interface BenchmarkCase {
  scrollbackBudgetBytes: number;
  inputBytesWritten: number;
  estimatedRetainedCellBytes: number;
  retainedRows: number;
  viewport: { cols: number; rows: number };
  renderRequests: number;
  frameCount: number;
  rowsMaterialized: number;
  cellsMaterialized: number;
  rowsPainted: number;
  frameMs: { p50: number; p95: number; max: number };
}

interface BenchmarkResult {
  schemaVersion: 1;
  platform: string;
  devicePixelRatio: number;
  warmupMs: number;
  measurementMs: number;
  fullToTenthP95Ratio: number;
  withinHistoryRatioBudget: boolean;
  withinFrameBudget: boolean;
  tenthBudget: BenchmarkCase;
  fullBudget: BenchmarkCase;
}

declare global {
  interface Window {
    __retainedHistoryBenchmarkResult?: BenchmarkResult;
    __retainedHistoryBenchmarkError?: string;
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

function buildAnsiBatch(batch: number): string {
  const lines: string[] = [];
  for (let line = 0; line < 200; line++) {
    const id = `${batch.toString(36).padStart(3, '0')}-${line.toString(36).padStart(2, '0')}`;
    const colors = Array.from({ length: 8 }, (_, segment) => {
      const red = (batch * 31 + line * 17 + segment * 47) % 256;
      const green = (batch * 53 + line * 29 + segment * 67) % 256;
      const blue = (batch * 71 + line * 43 + segment * 89) % 256;
      return `${ESC}[38;2;${red};${green};${blue}m${id}:${segment} agent-output`;
    }).join(' ');
    lines.push(
      `${ESC}]8;id=${id};https://example.invalid/${id}${ESC}\\` +
        `${colors} 🌐 é ${ESC}]8;;${ESC}\\${ESC}[0m`
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

async function fillRetainedHistory(terminal: Terminal, budgetBytes: number): Promise<number> {
  const encoder = new TextEncoder();
  let inputBytes = 0;
  let batch = 0;

  while (batch < 100) {
    const payload = buildAnsiBatch(batch++);
    inputBytes += encoder.encode(payload).byteLength;
    terminal.write(payload);
    await nextFrame();

    const retainedRows = terminal.getScrollbackLength();
    const estimatedRetainedCellBytes = retainedRows * COLS * 16;
    if (estimatedRetainedCellBytes >= budgetBytes * 0.75 || inputBytes >= budgetBytes * 2) {
      break;
    }
  }
  return inputBytes;
}

function instrumentRenderer(terminal: Terminal): {
  durations: number[];
  frameStats: RendererFrameStats[];
  reset(): void;
  restore(): void;
} {
  const owner = terminal as unknown as {
    renderer: {
      render: (...args: unknown[]) => unknown;
      getFrameStats(): RendererFrameStats;
    };
  };
  const renderer = owner.renderer;
  const originalRender = renderer.render.bind(renderer);
  const durations: number[] = [];
  const frameStats: RendererFrameStats[] = [];

  renderer.render = (...args: unknown[]) => {
    const started = performance.now();
    const result = originalRender(...args);
    durations.push(performance.now() - started);
    frameStats.push({ ...renderer.getFrameStats() });
    return result;
  };

  return {
    durations,
    frameStats,
    reset: () => {
      durations.length = 0;
      frameStats.length = 0;
    },
    restore: () => {
      renderer.render = originalRender;
    },
  };
}

async function driveScroll(
  terminal: Terminal,
  element: HTMLElement,
  durationMs: number
): Promise<void> {
  const scrollbackLength = terminal.getScrollbackLength();
  let deltaLines = -7;
  const deadline = performance.now() + durationMs;

  while (performance.now() < deadline) {
    const viewportY = terminal.getViewportY();
    if (viewportY > scrollbackLength * 0.75) deltaLines = 7;
    if (viewportY < scrollbackLength * 0.25) deltaLines = -7;
    element.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        deltaY: deltaLines,
      })
    );
    await nextFrame();
  }
}

async function runCase(
  container: HTMLElement,
  budgetBytes: number,
  warmupMs: number,
  measurementMs: number
): Promise<BenchmarkCase> {
  const terminal = new Terminal({
    cols: COLS,
    rows: ROWS,
    scrollbackBytes: budgetBytes,
    smoothScrollDuration: 100,
    cursorBlink: false,
    focusOnOpen: false,
  });
  terminal.open(container);

  try {
    const inputBytesWritten = await fillRetainedHistory(terminal, budgetBytes);
    const retainedRows = terminal.getScrollbackLength();
    terminal.scrollToLine(Math.floor(retainedRows / 2));
    await nextFrame();

    const instrument = instrumentRenderer(terminal);
    try {
      await driveScroll(terminal, container, warmupMs);
      await new Promise((resolve) => setTimeout(resolve, 1_250));
      instrument.reset();

      const requestsBefore = terminal.getRenderStats().renderRequests;
      await driveScroll(terminal, container, measurementMs);
      await new Promise((resolve) => setTimeout(resolve, 1_250));
      const renderRequests = terminal.getRenderStats().renderRequests - requestsBefore;
      const totals = instrument.frameStats.reduce(
        (result, frame) => ({
          rowsMaterialized: result.rowsMaterialized + frame.materializedRows,
          cellsMaterialized: result.cellsMaterialized + frame.materializedCells,
          rowsPainted: result.rowsPainted + frame.renderedRows,
        }),
        { rowsMaterialized: 0, cellsMaterialized: 0, rowsPainted: 0 }
      );

      return {
        scrollbackBudgetBytes: budgetBytes,
        inputBytesWritten,
        estimatedRetainedCellBytes: retainedRows * COLS * 16,
        retainedRows,
        viewport: { cols: COLS, rows: ROWS },
        renderRequests,
        frameCount: instrument.durations.length,
        ...totals,
        frameMs: {
          p50: percentile(instrument.durations, 0.5),
          p95: percentile(instrument.durations, 0.95),
          max: Math.max(0, ...instrument.durations),
        },
      };
    } finally {
      instrument.restore();
    }
  } finally {
    terminal.dispose();
    container.replaceChildren();
  }
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const warmupMs = Number(params.get('warmupMs') ?? 10_000);
  const measurementMs = Number(params.get('measurementMs') ?? 2_000);
  const status = document.querySelector<HTMLElement>('#status')!;
  const resultElement = document.querySelector<HTMLElement>('#result')!;
  const container = document.querySelector<HTMLElement>('#terminal-container')!;

  await init();
  status.textContent = 'Benchmarking 10% retained-history budget…';
  const tenthBudget = await runCase(container, FULL_BUDGET_BYTES / 10, warmupMs, measurementMs);
  status.textContent = 'Benchmarking full retained-history budget…';
  const fullBudget = await runCase(container, FULL_BUDGET_BYTES, warmupMs, measurementMs);
  const fullToTenthP95Ratio =
    tenthBudget.frameMs.p95 === 0 ? 0 : fullBudget.frameMs.p95 / tenthBudget.frameMs.p95;
  const result: BenchmarkResult = {
    schemaVersion: 1,
    platform: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    warmupMs,
    measurementMs,
    fullToTenthP95Ratio,
    withinHistoryRatioBudget: fullToTenthP95Ratio <= 1.25,
    withinFrameBudget: fullBudget.frameMs.p95 <= 1000 / 60,
    tenthBudget,
    fullBudget,
  };
  window.__retainedHistoryBenchmarkResult = result;
  status.textContent = 'Complete';
  resultElement.textContent = JSON.stringify(result, null, 2);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  window.__retainedHistoryBenchmarkError = message;
  document.querySelector<HTMLElement>('#status')!.textContent = 'Failed';
  document.querySelector<HTMLElement>('#result')!.textContent = message;
  console.error(error);
});
