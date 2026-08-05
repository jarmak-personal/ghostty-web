import { describe, expect, test } from 'bun:test';
import { Ghostty } from './ghostty';
import { decodeTerminalEventRecord, MAX_TERMINAL_EVENT_BYTES } from './terminal-events';
import { createIsolatedTerminal } from './test-helpers';
import type { TerminalEvent } from './types';

async function createCore(cols = 80, rows = 24, scrollbackLimit = 10_000) {
  const ghostty = await Ghostty.load();
  return ghostty.createTerminal(cols, rows, { scrollbackLimit });
}

function semanticEvent(events: TerminalEvent[]) {
  const event = events.find((candidate) => candidate.type === 'semantic');
  if (!event || event.type !== 'semantic') throw new Error('expected semantic event');
  return event;
}

describe('structured terminal event core', () => {
  test('emits every supported family in parser order', async () => {
    const core = await createCore();
    try {
      core.write(
        '\x1b]2;Build logs\x07' +
          '\x1b]7;file://host/worktree\x1b\\' +
          '\x07' +
          '\x1b]777;notify;Done;Build finished\x1b\\' +
          '\x1b]9;4;1;42\x1b\\' +
          '\x1b]133;A;aid=7\x1b\\' +
          '\x1b]4;1;#112233\x1b\\' +
          '\x1b]52;c;SGVsbG8=\x1b\\' +
          '\x1b]52;s;?\x1b\\'
      );

      expect(core.readEvents()).toEqual([
        { type: 'title', title: 'Build logs' },
        { type: 'working-directory', uri: 'file://host/worktree' },
        { type: 'bell' },
        {
          type: 'notification',
          source: 'osc-777',
          title: 'Done',
          body: 'Build finished',
        },
        { type: 'progress', state: 'set', progress: 42 },
        {
          type: 'semantic',
          action: 'fresh-line-new-prompt',
          options: 'aid=7',
          provenance: expect.objectContaining({ id: expect.any(Number), screen: 'normal', row: 0 }),
        },
        {
          type: 'palette',
          operation: 4,
          request: {
            type: 'set',
            target: { kind: 'palette', index: 1 },
            color: { r: 0x11, g: 0x22, b: 0x33 },
          },
        },
        { type: 'clipboard', operation: 'write', selection: 'c', data: 'SGVsbG8=' },
        { type: 'clipboard', operation: 'read', selection: 's' },
      ]);
      expect(core.readEvents()).toEqual([]);
    } finally {
      core.free();
    }
  });

  test('distinguishes OSC 9 and OSC 777 sources across chunks and terminators', async () => {
    const core = await createCore();
    try {
      core.write('\x1b]9;attention');
      expect(core.readEvents()).toEqual([]);

      core.write(' requested\x07\x1b]777;notify;Passive;Only\x1b\\\x07');
      expect(core.readEvents()).toEqual([
        {
          type: 'notification',
          source: 'osc-9',
          title: '',
          body: 'attention requested',
        },
        {
          type: 'notification',
          source: 'osc-777',
          title: 'Passive',
          body: 'Only',
        },
        { type: 'bell' },
      ]);
    } finally {
      core.free();
    }
  });

  test('preserves chunked sequences and does not treat an OSC BEL terminator as a bell', async () => {
    const core = await createCore();
    try {
      core.write('\x1b]2;split');
      expect(core.readEvents()).toEqual([]);
      core.write(' title');
      expect(core.readEvents()).toEqual([]);
      core.write('\x07');
      expect(core.readEvents()).toEqual([{ type: 'title', title: 'split title' }]);
    } finally {
      core.free();
    }
  });

  test('fails closed for malformed, unsupported, incomplete, and oversized sequences', async () => {
    const core = await createCore();
    try {
      core.write('\x1b]2;incomplete');
      expect(core.readEvents()).toEqual([]);
      core.write('\x1b\\');
      expect(core.readEvents()).toEqual([{ type: 'title', title: 'incomplete' }]);

      core.write(new Uint8Array([0x1b, 0x5d, 0x32, 0x3b, 0xc0, 0x07]));
      core.write('\x1b]999;ignored\x07');
      expect(core.readEvents()).toEqual([]);

      core.write(`\x1b]52;c;${'A'.repeat(MAX_TERMINAL_EVENT_BYTES + 1)}\x1b\\`);
      expect(core.readEvents()).toEqual([]);

      core.write('\x1b]2;recovered\x1b\\');
      expect(core.readEvents()).toEqual([{ type: 'title', title: 'recovered' }]);
    } finally {
      core.free();
    }
  });

  test('bounds unread event retention and accepts new events after draining', async () => {
    const core = await createCore();
    try {
      const title = 'x'.repeat(1_024);
      core.write(Array.from({ length: 80 }, () => `\x1b]2;${title}\x1b\\`).join(''));
      const retained = core.readEvents();
      expect(retained.length).toBeGreaterThan(0);
      expect(retained.length).toBeLessThan(80);
      expect(retained.every((event) => event.type === 'title' && event.title === title)).toBe(true);

      core.write('\x1b]2;after drain\x1b\\');
      expect(core.readEvents()).toEqual([{ type: 'title', title: 'after drain' }]);
    } finally {
      core.free();
    }
  });

  test('types palette query and reset operations', async () => {
    const core = await createCore();
    try {
      core.write('\x1b]10;?\x1b\\\x1b]112\x1b\\\x1b]104\x1b\\');
      expect(core.readEvents()).toEqual([
        {
          type: 'palette',
          operation: 10,
          request: { type: 'query', target: { kind: 'dynamic', name: 'foreground' } },
        },
        {
          type: 'palette',
          operation: 112,
          request: { type: 'reset', target: { kind: 'dynamic', name: 'cursor' } },
        },
        { type: 'palette', operation: 104, request: { type: 'reset-palette' } },
      ]);
    } finally {
      core.free();
    }
  });

  test('tracks semantic rows across screens and invalidates them on reset', async () => {
    const core = await createCore(8, 3);
    try {
      core.write('\x1b]133;A\x1b\\');
      const normal = semanticEvent(core.readEvents());
      expect(core.resolveEventProvenance(normal.provenance)).toBe(0);

      core.write('\x1b[?1049h\x1b]133;P;k=i\x1b\\');
      const alternate = semanticEvent(core.readEvents());
      expect(alternate.provenance.screen).toBe('alternate');
      expect(core.resolveEventProvenance(alternate.provenance)).toBe(0);

      core.write('\x1bc');
      expect(core.resolveEventProvenance(normal.provenance)).toBeNull();
      expect(core.resolveEventProvenance(alternate.provenance)).toBeNull();
      expect(core.readEvents()).toEqual([]);
    } finally {
      core.free();
    }
  });

  test('invalidates semantic provenance after scrollback eviction', async () => {
    const core = await createCore(4, 2, 1);
    try {
      core.write('\x1b]133;A\x1b\\');
      const marker = semanticEvent(core.readEvents());
      expect(core.resolveEventProvenance(marker.provenance)).not.toBeNull();

      // Ghostty retains at least two backing pages regardless of a smaller
      // configured limit, so cross that bounded minimum before asserting expiry.
      core.write('x\r\n'.repeat(20_000));
      expect(core.resolveEventProvenance(marker.provenance)).toBeNull();
    } finally {
      core.free();
    }
  });
});

describe('Terminal structured events', () => {
  test('derives legacy title and bell events from the structured source', async () => {
    const term = await createIsolatedTerminal();
    const container = document.createElement('div');
    term.open(container);
    try {
      const typed: TerminalEvent[] = [];
      const titles: string[] = [];
      let bells = 0;
      term.onTerminalEvent((event) => typed.push(event));
      term.onTitleChange((title) => titles.push(title));
      term.onBell(() => bells++);

      term.write('\x1b]2;chunked');
      term.write(' title\x07');
      term.write('\x07\x07');

      expect(typed).toEqual([
        { type: 'title', title: 'chunked title' },
        { type: 'bell' },
        { type: 'bell' },
      ]);
      expect(titles).toEqual(['chunked title']);
      expect(bells).toBe(1);
    } finally {
      term.dispose();
    }
  });

  test('releases event subscriptions and parser carry on reset and disposal', async () => {
    const term = await createIsolatedTerminal();
    const container = document.createElement('div');
    term.open(container);

    const oldEvents: TerminalEvent[] = [];
    term.onTerminalEvent((event) => oldEvents.push(event));
    term.write('\x1b]2;before\x1b\\');
    term.write('\x1b]2;partial');
    const beforeReset = oldEvents[0];
    expect(beforeReset).toEqual({ type: 'title', title: 'before' });

    term.reset();
    term.write(' remainder\x1b\\');
    term.write('\x07');
    expect(oldEvents).toHaveLength(1);

    const newEvents: TerminalEvent[] = [];
    term.onTerminalEvent((event) => newEvents.push(event));
    term.write('\x1b]2;after\x1b\\\x1b]133;A\x1b\\');
    expect(newEvents[0]).toEqual({ type: 'title', title: 'after' });
    const marker = semanticEvent(newEvents);
    expect(term.resolveEventProvenance(marker.provenance)).not.toBeNull();

    term.dispose();
    expect(term.resolveEventProvenance(marker.provenance)).toBeNull();
  });
});

describe('event wire decoder', () => {
  test('rejects truncated, unknown-version, and inconsistent records', () => {
    expect(decodeTerminalEventRecord(new Uint8Array(35))).toBeNull();

    const unknownVersion = new Uint8Array(36);
    unknownVersion[0] = 2;
    expect(decodeTerminalEventRecord(unknownVersion)).toBeNull();

    const inconsistent = new Uint8Array(36);
    inconsistent[0] = 1;
    inconsistent[1] = 1;
    new DataView(inconsistent.buffer).setUint32(28, 1, true);
    expect(decodeTerminalEventRecord(inconsistent)).toBeNull();

    const unknownNotificationSource = new Uint8Array(36);
    unknownNotificationSource[0] = 1;
    unknownNotificationSource[1] = 4;
    unknownNotificationSource[2] = 2;
    expect(decodeTerminalEventRecord(unknownNotificationSource)).toBeNull();
  });
});
