import { resolve } from 'node:path';

import { Ghostty, type GhosttyCell } from '../lib/ghostty';

const BATCHES = 12;
const LINES_PER_BATCH = 1_200;
const WARMUP_BATCHES = 4;
const COLS = 160;
const ROWS = 24;
const SCROLLBACK_LIMIT = 256;
const ESC = '\x1b';

interface GhosttyMemoryOwner {
  readonly memory: WebAssembly.Memory;
}

interface BatchMeasurement {
  readonly batch: number;
  readonly wasmBytes: number;
  readonly rssBytes: number;
  readonly scrollbackLines: number;
  readonly retainedHyperlinkCells: number;
}

interface ProbeResult {
  readonly schemaVersion: 1;
  readonly batches: number;
  readonly linesPerBatch: number;
  readonly warmupBatches: number;
  readonly measurements: readonly BatchMeasurement[];
  readonly postWarmupWasmGrowthBytes: number;
  readonly peakWasmBytes: number;
  readonly retainedLineCount: number;
}

function buildBatch(batch: number): string {
  const lines: string[] = [];

  for (let line = 0; line < LINES_PER_BATCH; line++) {
    const marker = `B${batch.toString().padStart(2, '0')}L${line.toString().padStart(4, '0')}`;
    const red = (batch * 47 + line * 17) % 256;
    const green = (batch * 71 + line * 29) % 256;
    const blue = (batch * 101 + line * 43) % 256;
    const uri = `file:///tmp/hvir-managed-memory/${batch}/${line}/${marker.repeat(3)}.ts`;
    lines.push(
      `${ESC}]8;id=${marker};${uri}${ESC}\\` +
        `${ESC}[38;2;${red};${green};${blue}m${marker} agent-link 🌐 é${ESC}[0m` +
        `${ESC}]8;;${ESC}\\`
    );
  }

  return `${lines.join('\r\n')}\r\n`;
}

function cellsToText(cells: readonly GhosttyCell[]): string {
  return cells
    .filter((cell) => cell.width !== 0 && cell.codepoint !== 0)
    .map((cell) => String.fromCodePoint(cell.codepoint))
    .join('')
    .trimEnd();
}

function assertRetainedOrder(
  terminal: ReturnType<Ghostty['createTerminal']>,
  expectedLastMarker: string
): number {
  const scrollbackLength = terminal.getScrollbackLength();
  const retainedMarkers: string[] = [];

  for (let offset = 0; offset < scrollbackLength; offset++) {
    const line = terminal.getScrollbackLine(offset);
    if (!line) continue;
    const marker = cellsToText(line).match(/B\d{2}L\d{4}/)?.[0];
    if (marker) retainedMarkers.push(marker);
  }

  const viewport = terminal.getViewport();
  for (let row = 0; row < ROWS; row++) {
    const marker = cellsToText(viewport.slice(row * COLS, (row + 1) * COLS)).match(
      /B\d{2}L\d{4}/
    )?.[0];
    if (marker) retainedMarkers.push(marker);
  }

  if (retainedMarkers.at(-1) !== expectedLastMarker) {
    throw new Error(
      `Terminal output lost ordering: expected ${expectedLastMarker}, received ${retainedMarkers.at(-1) ?? 'no marker'}`
    );
  }

  for (let index = 1; index < retainedMarkers.length; index++) {
    if (retainedMarkers[index - 1]! >= retainedMarkers[index]!) {
      throw new Error(
        `Terminal output is duplicated or reordered: ${retainedMarkers[index - 1]} then ${retainedMarkers[index]}`
      );
    }
  }

  return retainedMarkers.length;
}

function countRetainedHyperlinkCells(terminal: ReturnType<Ghostty['createTerminal']>): number {
  return terminal.getViewport().reduce((count, cell) => count + (cell.hyperlink_id > 0 ? 1 : 0), 0);
}

async function main(): Promise<void> {
  const wasmPath = resolve(process.argv[2] ?? 'ghostty-vt.wasm');
  const originalLog = console.log;
  console.log = () => undefined;

  let terminal: ReturnType<Ghostty['createTerminal']> | undefined;
  try {
    const ghostty = await Ghostty.load(wasmPath);
    const memory = (ghostty as unknown as GhosttyMemoryOwner).memory;
    terminal = ghostty.createTerminal(COLS, ROWS, {
      scrollbackLimit: SCROLLBACK_LIMIT,
    });
    const measurements: BatchMeasurement[] = [];
    let retainedLineCount = 0;

    for (let batch = 0; batch < BATCHES; batch++) {
      terminal.write(buildBatch(batch));
      terminal.update();
      const expectedLastMarker = `B${batch.toString().padStart(2, '0')}L${(LINES_PER_BATCH - 1)
        .toString()
        .padStart(4, '0')}`;
      retainedLineCount = assertRetainedOrder(terminal, expectedLastMarker);
      measurements.push({
        batch,
        wasmBytes: memory.buffer.byteLength,
        rssBytes: process.memoryUsage.rss(),
        scrollbackLines: terminal.getScrollbackLength(),
        retainedHyperlinkCells: countRetainedHyperlinkCells(terminal),
      });
    }

    const postWarmup = measurements.slice(WARMUP_BATCHES - 1);
    const warmupBytes = postWarmup[0]!.wasmBytes;
    const peakWasmBytes = Math.max(...measurements.map(({ wasmBytes }) => wasmBytes));
    const postWarmupWasmGrowthBytes =
      Math.max(...postWarmup.map(({ wasmBytes }) => wasmBytes)) - warmupBytes;
    const result: ProbeResult = {
      schemaVersion: 1,
      batches: BATCHES,
      linesPerBatch: LINES_PER_BATCH,
      warmupBatches: WARMUP_BATCHES,
      measurements,
      postWarmupWasmGrowthBytes,
      peakWasmBytes,
      retainedLineCount,
    };

    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    terminal?.free();
    console.log = originalLog;
  }
}

await main();
