import { describe, expect, test } from 'bun:test';
import type { ITerminalDataEvent } from './interfaces';
import { TerminalDataChannel } from './terminal-data';

describe('PTY-bound data delivery', () => {
  test('both views keep the same order through nested producers', () => {
    const channel = new TerminalDataChannel();
    const tagged: ITerminalDataEvent[] = [];
    const legacy: string[] = [];
    channel.onDataWithSource((event) => {
      tagged.push(event);
      if (event.data === 'first') channel.emit('nested', 'user');
    });
    channel.onData((data) => legacy.push(data));
    channel.emit('first', 'terminal-response');
    expect(tagged).toEqual([
      { data: 'first', source: 'terminal-response' },
      { data: 'nested', source: 'user' },
    ]);
    expect(legacy).toEqual(['first', 'nested']);
    expect(Object.isFrozen(tagged[0])).toBe(true);
    channel.dispose();
  });

  test('deferred producers preserve source without a write stack', async () => {
    const channel = new TerminalDataChannel();
    const events: ITerminalDataEvent[] = [];
    channel.onDataWithSource((event) => events.push(event));
    await Promise.resolve().then(() => channel.emit('\x1b[0n', 'terminal-response'));
    await Promise.resolve().then(() => channel.emit('paste', 'user'));
    expect(events).toEqual([
      { data: '\x1b[0n', source: 'terminal-response' },
      { data: 'paste', source: 'user' },
    ]);
    channel.dispose();
  });

  test.each([
    ['Error', new Error('subscriber failed')],
    ['undefined', undefined],
  ] as const)(
    'drains both views and nested producers before rethrowing a subscriber error (%s)',
    (_description, failure) => {
      const channel = new TerminalDataChannel();
      const tagged: ITerminalDataEvent[] = [];
      const legacy: string[] = [];
      channel.onData((data) => {
        if (data === 'first') channel.emit('\x1b[0n', 'terminal-response');
      });
      channel.onDataWithSource((event) => {
        if (event.data === 'first') throw failure;
        if (event.source === 'terminal-response') throw new Error('later subscriber failure');
      });
      channel.onData((data) => legacy.push(data));
      channel.onDataWithSource((event) => tagged.push(event));
      let thrown = false;
      try {
        channel.emit('first', 'user');
      } catch (error) {
        thrown = true;
        expect(error).toBe(failure);
      }
      expect(thrown).toBe(true);
      channel.emit('later', 'user');
      expect(legacy).toEqual(['first', '\x1b[0n', 'later']);
      expect(tagged).toEqual([
        { data: 'first', source: 'user' },
        { data: '\x1b[0n', source: 'terminal-response' },
        { data: 'later', source: 'user' },
      ]);
      channel.dispose();
    }
  );

  test('subscription revocation and channel disposal reject late and queued delivery', async () => {
    const channel = new TerminalDataChannel();
    const legacy: string[] = [];
    const tagged: ITerminalDataEvent[] = [];
    const subscription = channel.onDataWithSource((event) => tagged.push(event));
    subscription.dispose();
    subscription.dispose();
    channel.onData((data) => {
      legacy.push(data);
      channel.emit('queued', 'user');
      channel.dispose();
    });
    channel.onData((data) => legacy.push(`late:${data}`));
    channel.emit('first', 'user');
    await Promise.resolve().then(() => channel.emit('deferred', 'terminal-response'));
    channel.onDataWithSource((event) => tagged.push(event));
    channel.emit('disposed', 'user');
    channel.dispose();
    expect(legacy).toEqual(['first']);
    expect(tagged).toEqual([]);
  });
});
