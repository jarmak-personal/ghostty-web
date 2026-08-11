import type { IEvent } from './interfaces';

interface ListenerEntry<T> {
  listener: (arg: T) => void;
  disposed: boolean;
}

export class EventEmitter<T> {
  private listeners: Array<ListenerEntry<T>> = [];

  fire(arg: T): void {
    // Each delivery observes the subscriptions present when it begins. Mutating
    // subscriptions from a listener therefore cannot skip a later listener or
    // add a new listener partway through the same delivery.
    for (const entry of [...this.listeners]) {
      entry.listener(arg);
    }
  }

  readonly event: IEvent<T> = (listener) => {
    const entry: ListenerEntry<T> = { listener, disposed: false };
    this.listeners.push(entry);
    return {
      dispose: () => {
        if (entry.disposed) return;
        entry.disposed = true;
        const index = this.listeners.indexOf(entry);
        if (index >= 0) {
          this.listeners.splice(index, 1);
        }
      },
    };
  };

  dispose(): void {
    this.listeners = [];
  }
}
