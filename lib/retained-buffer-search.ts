import type { GhosttyTerminal } from './ghostty';
import type {
  IDisposable,
  IRetainedBufferRange,
  IRetainedBufferSearchOptions,
  IRetainedBufferSearchResult,
} from './interfaces';

const SEARCH_TASK_BUDGET_MS = 4;
const SEARCH_RANGE_BATCH_SIZE = 128;

interface RangeIdentity {
  sessionId: number;
  matchIndex: number;
}

interface SearchJob {
  terminal: GhosttyTerminal;
  sessionId: number;
  query: string;
  caseSensitive: boolean;
  signal?: AbortSignal;
  abortListener?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  phase: 'search' | 'ranges';
  matchCount: number;
  nextMatch: number;
  ranges: RetainedBufferRange[];
  resolve: (value: IRetainedBufferSearchResult) => void;
  reject: (reason: Error) => void;
  settled: boolean;
}

class RetainedBufferRange implements IRetainedBufferRange {
  constructor(
    public readonly start: Readonly<{ row: number; column: number }>,
    public readonly end: Readonly<{ row: number; column: number }>
  ) {
    Object.freeze(this);
  }
}

class RetainedBufferSearchResult implements IRetainedBufferSearchResult {
  private disposed = false;

  constructor(
    private readonly owner: RetainedBufferSearchManager,
    public readonly query: string,
    public readonly caseSensitive: boolean,
    public readonly matches: readonly IRetainedBufferRange[],
    readonly sessionId: number
  ) {}

  extract(range: IRetainedBufferRange): string | undefined {
    if (this.disposed) return undefined;
    return this.owner.extract(this, range);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.owner.releaseResult(this);
  }
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

/**
 * Owns one terminal's current retained-buffer query and its native lifetime.
 * Native search advances one bounded Ghostty page step at a time; range
 * materialization is separately time-sliced for high-match buffers.
 */
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
    this.cancelCurrent(abortError('Retained-buffer search was replaced'));

    if (options.signal?.aborted) {
      return Promise.reject(abortError('Retained-buffer search was aborted'));
    }

    if (query.length === 0) {
      const result = new RetainedBufferSearchResult(
        this,
        query,
        options.caseSensitive,
        Object.freeze([]),
        0
      );
      this.currentResult = result;
      return Promise.resolve(result);
    }

    const terminal = this.getTerminal();
    if (!terminal) return Promise.reject(new Error('Terminal is not open'));
    const sessionId = terminal.createRetainedSearch(query, options.caseSensitive);
    if (sessionId === 0) {
      return Promise.reject(new Error('Unable to create retained-buffer search'));
    }

    return new Promise<IRetainedBufferSearchResult>((resolve, reject) => {
      const job: SearchJob = {
        terminal,
        sessionId,
        query,
        caseSensitive: options.caseSensitive,
        signal: options.signal,
        phase: 'search',
        matchCount: 0,
        nextMatch: 0,
        ranges: [],
        resolve,
        reject,
        settled: false,
      };
      if (options.signal) {
        job.abortListener = () => {
          if (this.currentJob === job) {
            this.cancelJob(job, abortError('Retained-buffer search was aborted'));
          }
        };
        options.signal.addEventListener('abort', job.abortListener, { once: true });
      }
      this.currentJob = job;
      this.schedule(job);
    });
  }

  /** A primary-affecting parser write invalidates the whole native snapshot. */
  noteWrite(): void {
    if (this.disposed) return;
    this.cancelCurrent(abortError('Terminal changed during retained-buffer search'));
  }

  /** Reflow/reset invalidates every range, including immutable history rows. */
  invalidateAll(): void {
    if (this.disposed) return;
    this.cancelCurrent(abortError('Terminal buffer identity changed'));
  }

  cancel(): void {
    this.cancelCurrent(abortError('Retained-buffer search was cancelled'));
  }

  extract(result: RetainedBufferSearchResult, range: IRetainedBufferRange): string | undefined {
    if (this.disposed || this.currentResult !== result || result.sessionId === 0) return undefined;
    const identity = this.identities.get(range);
    if (!identity || identity.sessionId !== result.sessionId) return undefined;
    return (
      this.getTerminal()?.getRetainedSearchMatchText(identity.sessionId, identity.matchIndex) ??
      undefined
    );
  }

  extractCurrent(range: IRetainedBufferRange): string | undefined {
    const result = this.currentResult;
    return result ? this.extract(result, range) : undefined;
  }

  releaseResult(result: RetainedBufferSearchResult): void {
    if (result.sessionId !== 0) this.getTerminal()?.cancelRetainedSearch(result.sessionId);
    if (this.currentResult === result) this.currentResult = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancelCurrent(abortError('Terminal search was disposed'));
    this.disposed = true;
  }

  private schedule(job: SearchJob): void {
    job.timer = setTimeout(() => {
      job.timer = undefined;
      this.run(job);
    }, 0);
  }

  private run(job: SearchJob): void {
    if (this.currentJob !== job || job.settled) return;
    if (job.signal?.aborted) {
      this.cancelJob(job, abortError('Retained-buffer search was aborted'));
      return;
    }
    if (this.getTerminal() !== job.terminal) {
      this.cancelJob(job, abortError('Terminal changed during retained-buffer search'));
      return;
    }

    if (job.phase === 'search') {
      const status = job.terminal.stepRetainedSearch(job.sessionId);
      if (status < 0) {
        this.cancelJob(job, new Error('Retained-buffer search failed'));
        return;
      }
      if (status === 0) {
        this.schedule(job);
        return;
      }
      job.matchCount = job.terminal.getRetainedSearchMatchCount(job.sessionId);
      if (job.matchCount < 0) {
        this.cancelJob(job, new Error('Retained-buffer search results became stale'));
        return;
      }
      job.phase = 'ranges';
    }

    const deadline = now() + SEARCH_TASK_BUDGET_MS;
    let processed = 0;
    while (
      job.nextMatch < job.matchCount &&
      processed < SEARCH_RANGE_BATCH_SIZE &&
      now() < deadline
    ) {
      const matchIndex = job.nextMatch;
      const nativeRange = job.terminal.getRetainedSearchMatchRange(job.sessionId, matchIndex);
      if (!nativeRange) {
        this.cancelJob(job, new Error('Retained-buffer search range became stale'));
        return;
      }
      const range = new RetainedBufferRange(
        Object.freeze({ row: nativeRange.startRow, column: nativeRange.startColumn }),
        Object.freeze({ row: nativeRange.endRow, column: nativeRange.endColumn })
      );
      this.identities.set(range, {
        sessionId: job.sessionId,
        matchIndex,
      });
      job.ranges.push(range);
      job.nextMatch++;
      processed++;
    }

    if (job.nextMatch < job.matchCount) {
      this.schedule(job);
      return;
    }

    this.finishJob(job);
  }

  private finishJob(job: SearchJob): void {
    if (this.currentJob !== job || job.settled) return;
    this.cleanupJob(job);
    job.settled = true;
    this.currentJob = undefined;
    const result = new RetainedBufferSearchResult(
      this,
      job.query,
      job.caseSensitive,
      Object.freeze(job.ranges.slice()),
      job.sessionId
    );
    this.currentResult = result;
    job.resolve(result);
  }

  private cancelCurrent(error: Error): void {
    if (this.currentJob) this.cancelJob(this.currentJob, error);
    this.currentResult?.dispose();
  }

  private cancelJob(job: SearchJob, error: Error): void {
    if (job.settled) return;
    this.cleanupJob(job);
    job.settled = true;
    job.terminal.cancelRetainedSearch(job.sessionId);
    if (this.currentJob === job) this.currentJob = undefined;
    job.reject(error);
  }

  private cleanupJob(job: SearchJob): void {
    if (job.timer !== undefined) {
      clearTimeout(job.timer);
      job.timer = undefined;
    }
    if (job.signal && job.abortListener) {
      job.signal.removeEventListener('abort', job.abortListener);
      job.abortListener = undefined;
    }
  }
}
