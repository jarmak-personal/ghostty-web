import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const PROBE_TIMEOUT_MS = 15_000;
const MAX_POST_WARMUP_WASM_GROWTH_BYTES = 16 * 1024 * 1024;
const MAX_WASM_BYTES = 128 * 1024 * 1024;

interface ProbeResult {
  readonly schemaVersion: number;
  readonly batches: number;
  readonly linesPerBatch: number;
  readonly warmupBatches: number;
  readonly measurements: ReadonlyArray<{
    readonly batch: number;
    readonly wasmBytes: number;
    readonly rssBytes: number;
    readonly scrollbackLines: number;
    readonly retainedHyperlinkCells: number;
  }>;
  readonly postWarmupWasmGrowthBytes: number;
  readonly peakWasmBytes: number;
  readonly retainedLineCount: number;
}

const children = new Set<ReturnType<typeof Bun.spawn>>();

afterEach(() => {
  for (const child of children) child.kill(9);
  children.clear();
});

describe('Ghostty managed-memory capacity', () => {
  test(
    'keeps OSC 8, style, and grapheme growth bounded after scrollback pruning',
    async () => {
      const root = resolve(import.meta.dir, '..');
      const wasmPath = resolve(
        process.env.GHOSTTY_WEB_MANAGED_MEMORY_WASM ?? `${root}/ghostty-vt.wasm`
      );
      const child = Bun.spawn(
        [process.execPath, `${root}/scripts/managed-memory-probe.ts`, wasmPath],
        {
          cwd: root,
          stdout: 'pipe',
          stderr: 'pipe',
        }
      );
      children.add(child);

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill(9);
      }, PROBE_TIMEOUT_MS);
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]).finally(() => clearTimeout(timer));
      children.delete(child);

      expect(timedOut, `Managed-memory probe exceeded ${PROBE_TIMEOUT_MS} ms`).toBe(false);
      expect(exitCode, stderr).toBe(0);

      const result = JSON.parse(stdout) as ProbeResult;
      expect(result.schemaVersion).toBe(1);
      expect(result.measurements).toHaveLength(result.batches);
      expect(result.batches * result.linesPerBatch).toBeGreaterThan(10_000);
      expect(result.retainedLineCount).toBeGreaterThan(0);
      const firstScrollbackLines = result.measurements[0]!.scrollbackLines;
      const lastScrollbackLines = result.measurements.at(-1)!.scrollbackLines;
      expect(lastScrollbackLines).toBeLessThan(result.batches * result.linesPerBatch);
      expect(lastScrollbackLines - firstScrollbackLines).toBeLessThanOrEqual(256);
      expect(result.measurements.at(-1)?.retainedHyperlinkCells).toBeGreaterThan(0);
      expect(result.postWarmupWasmGrowthBytes).toBeLessThanOrEqual(
        MAX_POST_WARMUP_WASM_GROWTH_BYTES
      );
      expect(result.peakWasmBytes).toBeLessThanOrEqual(MAX_WASM_BYTES);
    },
    PROBE_TIMEOUT_MS + 5_000
  );
});
