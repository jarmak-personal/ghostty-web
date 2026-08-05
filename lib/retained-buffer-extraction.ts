import type { GhosttyTerminal } from './ghostty';
import type { IDisposable, IRetainedBufferExtractionOptions } from './interfaces';
import type { TerminalEventProvenance, TerminalEventScreen } from './types';

export type RetainedBufferExtractionErrorCode =
  'cancelled' | 'disposed' | 'not-open' | 'invalid-boundary' | 'stale' | 'too-large' | 'failed';

/** Typed all-or-nothing failure from exact retained-buffer extraction. */
export class RetainedBufferExtractionError extends Error {
  constructor(
    public readonly code: RetainedBufferExtractionErrorCode,
    message: string,
    options?: { abort?: boolean }
  ) {
    super(message);
    this.name = options?.abort ? 'AbortError' : 'RetainedBufferExtractionError';
  }
}

interface ExtractionJob {
  terminal: GhosttyTerminal;
  rangeId: number;
  screen: TerminalEventScreen;
  signal?: AbortSignal;
  abortListener?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (value: string) => void;
  reject: (reason: RetainedBufferExtractionError) => void;
  settled: boolean;
}

function extractionError(
  code: RetainedBufferExtractionErrorCode,
  message: string,
  abort = false
): RetainedBufferExtractionError {
  return new RetainedBufferExtractionError(code, message, { abort });
}

/** Owns one terminal's scheduled exact retained-range extraction lifecycle. */
export class RetainedBufferExtractionManager implements IDisposable {
  private currentJob?: ExtractionJob;
  private disposed = false;

  constructor(private readonly getTerminal: () => GhosttyTerminal | undefined) {}

  extract(
    start: TerminalEventProvenance,
    end: TerminalEventProvenance,
    options: IRetainedBufferExtractionOptions = {}
  ): Promise<string> {
    if (this.disposed) {
      return Promise.reject(extractionError('disposed', 'Retained-buffer extraction is disposed'));
    }
    this.cancelCurrent(extractionError('cancelled', 'Retained-buffer extraction was replaced'));

    if (options.signal?.aborted) {
      return Promise.reject(
        extractionError('cancelled', 'Retained-buffer extraction was aborted', true)
      );
    }

    const terminal = this.getTerminal();
    if (!terminal) {
      return Promise.reject(extractionError('not-open', 'Terminal is not open'));
    }
    const rangeId = terminal.createRetainedRange(start, end);
    if (rangeId === 0) {
      return Promise.reject(
        extractionError(
          'invalid-boundary',
          'Retained-buffer boundaries are stale, reversed, foreign, or cross-screen'
        )
      );
    }

    return new Promise<string>((resolve, reject) => {
      const job: ExtractionJob = {
        terminal,
        rangeId,
        screen: start.screen,
        signal: options.signal,
        resolve,
        reject,
        settled: false,
      };
      if (options.signal) {
        job.abortListener = () => {
          if (this.currentJob === job) {
            this.cancelJob(
              job,
              extractionError('cancelled', 'Retained-buffer extraction was aborted', true)
            );
          }
        };
        options.signal.addEventListener('abort', job.abortListener, { once: true });
      }
      this.currentJob = job;
      this.schedule(job);
    });
  }

  /** Revoke only work for the parser screen affected by a write. */
  noteWrite(screen: TerminalEventScreen): void {
    const job = this.currentJob;
    if (!this.disposed && job?.screen === screen) {
      this.cancelJob(job, extractionError('stale', 'Terminal changed during retained extraction'));
    }
  }

  invalidateAll(): void {
    if (!this.disposed) {
      this.cancelCurrent(
        extractionError('stale', 'Terminal buffer identity changed during retained extraction')
      );
    }
  }

  cancel(): void {
    this.cancelCurrent(extractionError('cancelled', 'Retained-buffer extraction was cancelled'));
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancelCurrent(extractionError('disposed', 'Retained-buffer extraction was disposed'));
    this.disposed = true;
  }

  private schedule(job: ExtractionJob): void {
    job.timer = setTimeout(() => {
      job.timer = undefined;
      this.run(job);
    }, 0);
  }

  private run(job: ExtractionJob): void {
    if (this.currentJob !== job || job.settled) return;
    if (job.signal?.aborted) {
      this.cancelJob(
        job,
        extractionError('cancelled', 'Retained-buffer extraction was aborted', true)
      );
      return;
    }
    if (this.getTerminal() !== job.terminal) {
      this.cancelJob(job, extractionError('stale', 'Terminal was replaced during extraction'));
      return;
    }

    const status = job.terminal.stepRetainedRange(job.rangeId);
    if (status === 0) {
      this.schedule(job);
      return;
    }
    if (status === -2) {
      this.failJob(
        job,
        extractionError('too-large', 'Retained-buffer extraction exceeds the 4 MiB limit')
      );
      return;
    }
    if (status < 0) {
      this.failJob(job, extractionError('stale', 'Retained-buffer extraction became stale'));
      return;
    }

    const text = job.terminal.getRetainedRangeText(job.rangeId);
    if (text === null) {
      this.failJob(job, extractionError('failed', 'Unable to copy retained-buffer text'));
      return;
    }
    this.cleanupJob(job);
    job.terminal.cancelRetainedRange(job.rangeId);
    job.settled = true;
    this.currentJob = undefined;
    job.resolve(text);
  }

  private cancelCurrent(error: RetainedBufferExtractionError): void {
    if (this.currentJob) this.cancelJob(this.currentJob, error);
  }

  private cancelJob(job: ExtractionJob, error: RetainedBufferExtractionError): void {
    this.failJob(job, error);
  }

  private failJob(job: ExtractionJob, error: RetainedBufferExtractionError): void {
    if (job.settled) return;
    this.cleanupJob(job);
    // Every terminal path explicitly releases native pins and transient text.
    // Cancellation is idempotent when native already failed closed in step().
    job.terminal.cancelRetainedRange(job.rangeId);
    job.settled = true;
    if (this.currentJob === job) this.currentJob = undefined;
    job.reject(error);
  }

  private cleanupJob(job: ExtractionJob): void {
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
