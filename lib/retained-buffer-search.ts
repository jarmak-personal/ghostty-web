import type { GhosttyTerminal } from './ghostty';
import type {
  IDisposable,
  IRetainedBufferRange,
  IRetainedBufferSearchOptions,
  IRetainedBufferSearchResult,
} from './interfaces';

const SEARCH_TASK_BUDGET_MS = 4;
const SEARCH_RANGE_BATCH_SIZE = 128;
const REFRESH_DELAY_MS = 75;

interface RangeIdentity {
  sessionId: number;
  occurrenceId: number;
}
interface SearchJob {
  terminal: GhosttyTerminal;
  result: RetainedBufferSearchResult;
  phase: 'search' | 'ranges';
  matchCount: number;
  nextMatch: number;
  ranges: IRetainedBufferRange[];
  rangesById: Map<number, IRetainedBufferRange>;
  timer?: ReturnType<typeof setTimeout>;
  resolve?: (value: IRetainedBufferSearchResult) => void;
  reject?: (reason: Error) => void;
}

class RetainedBufferSearchResult implements IRetainedBufferSearchResult {
  matches: readonly IRetainedBufferRange[] = Object.freeze([]);
  pending = true;
  invalidated = false;
  disposed = false;
  dirty = false;
  refreshTimer?: ReturnType<typeof setTimeout>;
  ranges = new Map<number, IRetainedBufferRange>();
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly owner: RetainedBufferSearchManager,
    readonly query: string,
    readonly caseSensitive: boolean,
    readonly sessionId: number,
    readonly signal?: AbortSignal
  ) {}
  readonly abort = (): void => this.owner.cancel();
  onUpdate(listener: () => void): IDisposable {
    if (this.disposed) return { dispose: () => {} };
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  publish(): void {
    for (const listener of [...this.listeners]) listener();
  }
  revoke(): void {
    const listeners = [...this.listeners];
    this.invalidated = true;
    this.pending = false;
    this.matches = Object.freeze([]);
    this.owner.releaseResult(this);
    for (const listener of listeners) listener();
  }
  clearListeners(): void {
    this.listeners.clear();
  }
  extract(range: IRetainedBufferRange): string | undefined {
    return this.owner.extract(this, range);
  }
  resolve(range: IRetainedBufferRange): IRetainedBufferRange | undefined {
    return this.owner.resolve(this, range);
  }
  dispose(): void {
    this.owner.releaseResult(this);
  }
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/** Finite native scans with authenticated cell identity and one coalesced refresh. */
export class RetainedBufferSearchManager implements IDisposable {
  private currentJob?: SearchJob;
  private currentResult?: RetainedBufferSearchResult;
  private readonly identities = new WeakMap<IRetainedBufferRange, RangeIdentity>();
  private disposed = false;
  constructor(private readonly getTerminal: () => GhosttyTerminal | undefined) {}

  search(
    query: string,
    options: IRetainedBufferSearchOptions
  ): Promise<IRetainedBufferSearchResult> {
    if (this.disposed) return Promise.reject(new Error('Terminal search is disposed'));
    this.cancel();
    if (options.signal?.aborted)
      return Promise.reject(abortError('Retained-buffer search was aborted'));
    const terminal = this.getTerminal();
    if (!terminal) return Promise.reject(new Error('Terminal is not open'));
    const sessionId =
      query.length === 0 ? 0 : terminal.createRetainedSearch(query, options.caseSensitive);
    if (query.length > 0 && sessionId === 0)
      return Promise.reject(new Error('Unable to create retained-buffer search'));
    const result = new RetainedBufferSearchResult(
      this,
      query,
      options.caseSensitive,
      sessionId,
      options.signal
    );
    this.currentResult = result;
    options.signal?.addEventListener('abort', result.abort, { once: true });
    if (sessionId === 0) {
      result.pending = false;
      return Promise.resolve(result);
    }
    return new Promise((resolve, reject) => {
      const job: SearchJob = {
        terminal,
        result,
        phase: 'search',
        matchCount: 0,
        nextMatch: 0,
        ranges: [],
        rangesById: new Map(),
        resolve,
        reject,
      };
      this.currentJob = job;
      this.schedule(job);
    });
  }

  noteWrite(): void {
    const result = this.currentResult;
    if (!result || result.disposed || result.sessionId === 0) return;
    result.dirty = true;
    // Revocation from a parser reset must be observable even after resolution.
    if (
      this.getTerminal()?.getRetainedSearchMatchCount(result.sessionId) === -1 &&
      !this.currentJob
    ) {
      // A valid refreshing query also reports -1, but owns currentJob.
      this.invalidateAll();
      return;
    }
    result.publish();
    this.scheduleRefresh(result);
  }

  invalidateAll(): void {
    const result = this.currentResult;
    if (result && !result.disposed) result.revoke();
  }

  cancel(): void {
    const job = this.currentJob;
    this.currentJob = undefined;
    if (job?.timer !== undefined) clearTimeout(job.timer);
    job?.reject?.(abortError('Retained-buffer search was revoked'));
    if (this.currentResult) this.releaseResult(this.currentResult);
  }

  private identity(
    result: RetainedBufferSearchResult,
    range: IRetainedBufferRange
  ): RangeIdentity | undefined {
    if (this.disposed || result.disposed || result.invalidated || this.currentResult !== result)
      return;
    const identity = this.identities.get(range);
    return identity?.sessionId === result.sessionId ? identity : undefined;
  }

  extract(result: RetainedBufferSearchResult, range: IRetainedBufferRange): string | undefined {
    const identity = this.identity(result, range);
    return identity
      ? (this.getTerminal()?.getRetainedSearchMatchText(
          identity.sessionId,
          identity.occurrenceId
        ) ?? undefined)
      : undefined;
  }

  resolve(
    result: RetainedBufferSearchResult,
    range: IRetainedBufferRange
  ): IRetainedBufferRange | undefined {
    const identity = this.identity(result, range);
    if (!identity) return;
    const cells = this.getTerminal()?.getRetainedSearchMatchRange(
      identity.sessionId,
      identity.occurrenceId
    );
    if (!cells) return;
    const resolved = Object.freeze({
      id: identity.occurrenceId,
      start: Object.freeze({ row: cells.startRow, column: cells.startColumn }),
      end: Object.freeze({ row: cells.endRow, column: cells.endColumn }),
    });
    this.identities.set(resolved, identity);
    return resolved;
  }

  extractCurrent(range: IRetainedBufferRange): string | undefined {
    return this.currentResult ? this.extract(this.currentResult, range) : undefined;
  }

  releaseResult(result: RetainedBufferSearchResult): void {
    if (result.disposed) return;
    result.disposed = true;
    if (result.refreshTimer !== undefined) clearTimeout(result.refreshTimer);
    result.signal?.removeEventListener('abort', result.abort);
    result.clearListeners();
    result.ranges.clear();
    if (result.sessionId !== 0) this.getTerminal()?.cancelRetainedSearch(result.sessionId);
    if (this.currentResult === result) this.currentResult = undefined;
    const job = this.currentJob;
    if (job?.result === result) {
      this.currentJob = undefined;
      if (job.timer !== undefined) clearTimeout(job.timer);
      job.reject?.(abortError('Retained-buffer search was disposed'));
    }
  }

  dispose(): void {
    if (!this.disposed) {
      this.cancel();
      this.disposed = true;
    }
  }

  private schedule(job: SearchJob): void {
    job.timer = setTimeout(() => {
      job.timer = undefined;
      this.run(job);
    }, 0);
  }

  private scheduleRefresh(result: RetainedBufferSearchResult): void {
    if (
      this.currentResult !== result ||
      result.disposed ||
      this.currentJob ||
      result.refreshTimer !== undefined ||
      !result.dirty
    )
      return;
    result.refreshTimer = setTimeout(() => {
      result.refreshTimer = undefined;
      if (this.currentResult !== result || result.disposed) return;
      const terminal = this.getTerminal();
      if (!terminal || !terminal.refreshRetainedSearch(result.sessionId)) {
        this.invalidateAll();
        return;
      }
      result.dirty = false;
      result.pending = true;
      const job: SearchJob = {
        terminal,
        result,
        phase: 'search',
        matchCount: 0,
        nextMatch: 0,
        ranges: [],
        rangesById: new Map(),
      };
      this.currentJob = job;
      result.publish();
      if (this.currentJob === job && !result.disposed) this.schedule(job);
    }, REFRESH_DELAY_MS);
  }

  private run(job: SearchJob): void {
    if (this.currentJob !== job || job.result.disposed) return;
    if (this.getTerminal() !== job.terminal || job.result.signal?.aborted) {
      this.cancel();
      return;
    }
    const deadline = performance.now() + SEARCH_TASK_BUDGET_MS;
    if (job.phase === 'search') {
      do {
        const status = job.terminal.stepRetainedSearch(job.result.sessionId);
        if (status < 0) {
          job.reject?.(new Error('Retained-buffer search failed'));
          this.invalidateAll();
          return;
        }
        if (status === 1) {
          job.matchCount = job.terminal.getRetainedSearchMatchCount(job.result.sessionId);
          job.phase = 'ranges';
          break;
        }
      } while (performance.now() < deadline);
      if (job.phase === 'search') {
        this.schedule(job);
        return;
      }
    }
    let processed = 0;
    while (
      job.nextMatch < job.matchCount &&
      processed < SEARCH_RANGE_BATCH_SIZE &&
      performance.now() < deadline
    ) {
      const id = job.terminal.getRetainedSearchMatchId(job.result.sessionId, job.nextMatch++);
      processed++;
      const cells = job.terminal.getRetainedSearchMatchRange(job.result.sessionId, id);
      if (!cells) continue;
      let range = job.result.ranges.get(id);
      if (!range) {
        range = Object.freeze({
          id,
          start: Object.freeze({ row: cells.startRow, column: cells.startColumn }),
          end: Object.freeze({ row: cells.endRow, column: cells.endColumn }),
        });
        this.identities.set(range, { sessionId: job.result.sessionId, occurrenceId: id });
      }
      job.ranges.push(range);
      job.rangesById.set(range.id, range);
    }
    if (job.nextMatch < job.matchCount) {
      this.schedule(job);
      return;
    }
    this.currentJob = undefined;
    // Build lookup metadata inside the same bounded batches, then publish by
    // swapping references rather than traversing all matches in the final task.
    job.result.ranges = job.rangesById;
    job.result.matches = Object.freeze(job.ranges);
    job.result.pending = false;
    job.resolve?.(job.result);
    job.result.publish();
    this.scheduleRefresh(job.result);
  }
}
