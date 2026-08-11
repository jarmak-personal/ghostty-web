import { describe, expect, test } from 'bun:test';
import { EventEmitter } from './event-emitter';

describe('EventEmitter', () => {
  test('delivers from a stable subscription snapshot', () => {
    const emitter = new EventEmitter<string>();
    const calls: string[] = [];
    let added = false;

    emitter.event((value) => {
      calls.push(`first:${value}`);
      if (!added) {
        added = true;
        emitter.event((nestedValue) => calls.push(`added:${nestedValue}`));
      }
    });
    emitter.event((value) => calls.push(`second:${value}`));

    emitter.fire('one');
    emitter.fire('two');

    expect(calls).toEqual(['first:one', 'second:one', 'first:two', 'second:two', 'added:two']);
  });

  test('does not skip listeners after self-disposal', () => {
    const emitter = new EventEmitter<void>();
    const calls: string[] = [];
    let firstSubscription = { dispose: () => {} };

    firstSubscription = emitter.event(() => {
      calls.push('first');
      firstSubscription.dispose();
    });
    emitter.event(() => calls.push('second'));

    emitter.fire();
    emitter.fire();

    expect(calls).toEqual(['first', 'second', 'second']);
  });

  test('applies other-listener disposal to the next delivery', () => {
    const emitter = new EventEmitter<void>();
    const calls: string[] = [];
    let secondSubscription = { dispose: () => {} };

    emitter.event(() => {
      calls.push('first');
      secondSubscription.dispose();
    });
    secondSubscription = emitter.event(() => calls.push('second'));

    emitter.fire();
    emitter.fire();

    expect(calls).toEqual(['first', 'second', 'first']);
  });

  test('tracks duplicate callbacks as independent idempotent subscriptions', () => {
    const emitter = new EventEmitter<void>();
    let calls = 0;
    const listener = () => calls++;
    const first = emitter.event(listener);
    emitter.event(listener);

    first.dispose();
    first.dispose();
    emitter.fire();

    expect(calls).toBe(1);
  });

  test('keeps nested delivery ordered independently of the outer snapshot', () => {
    const emitter = new EventEmitter<string>();
    const calls: string[] = [];

    emitter.event((value) => {
      calls.push(`first:${value}`);
      if (value === 'outer') emitter.fire('inner');
    });
    emitter.event((value) => calls.push(`second:${value}`));

    emitter.fire('outer');

    expect(calls).toEqual(['first:outer', 'first:inner', 'second:inner', 'second:outer']);
  });
});
