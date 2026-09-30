import { EventEmitter } from './event-emitter';
import type { IEvent, ITerminalDataEvent, TerminalDataSource } from './interfaces';

/** One ordered PTY-bound channel with compatible string and source-aware views. */
export class TerminalDataChannel {
  private readonly emitter = new EventEmitter<ITerminalDataEvent>();
  private pending: ITerminalDataEvent[] = [];
  private delivering = false;
  private disposed = false;
  private deliveryFailure?: { error: unknown };

  readonly onData: IEvent<string> = (listener) => this.subscribe((event) => listener(event.data));
  readonly onDataWithSource: IEvent<ITerminalDataEvent> = (listener) => this.subscribe(listener);

  emit(data: string, source: TerminalDataSource): void {
    if (this.disposed) return;
    this.pending.push(Object.freeze({ data, source }));
    if (this.delivering) return;
    this.delivering = true;
    try {
      // Nested producers append after the record all current subscribers see.
      for (let index = 0; index < this.pending.length; index++) {
        this.emitter.fire(this.pending[index]);
      }
    } finally {
      this.pending = [];
      this.delivering = false;
    }
    const failure = this.deliveryFailure;
    this.deliveryFailure = undefined;
    if (failure) throw failure.error;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending = [];
    this.emitter.dispose();
  }

  private subscribe(listener: (event: ITerminalDataEvent) => void) {
    if (this.disposed) return { dispose: () => {} };
    let active = !this.disposed;
    const subscription = this.emitter.event((event) => {
      if (!active || this.disposed) return;
      try {
        listener(event);
      } catch (error) {
        // A subscriber cannot discard later subscribers' or nested producers' bytes.
        // Preserve the first error and rethrow only after this delivery drains.
        this.deliveryFailure ??= { error };
      }
    });
    return {
      dispose: () => {
        active = false;
        subscription.dispose();
      },
    };
  }
}
