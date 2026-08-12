import { describe, expect, test } from 'bun:test';

import { Ghostty } from './ghostty';
import { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

describe('scrollback configuration', () => {
  test('keeps line counts distinct from exact native byte budgets', async () => {
    const ghostty = await Ghostty.load();
    const lines = ghostty.createTerminal(80, 24, { scrollbackLimit: 1_000 });
    const bytes = ghostty.createTerminal(80, 24, { scrollbackBytes: 1_000 });

    try {
      expect(bytes.getScrollbackByteLimit()).toBe(1_000);
      expect(lines.getScrollbackByteLimit()).toBeGreaterThan(1_000);
      expect(lines.getScrollbackByteLimit()).not.toBe(bytes.getScrollbackByteLimit());
    } finally {
      lines.free();
      bytes.free();
    }
  });

  test('passes and reports the hvir byte budget exactly across reset', async () => {
    const terminal = await createIsolatedTerminal({
      cols: 102,
      rows: 26,
      scrollbackBytes: 10_000_000,
    });
    terminal.open(document.createElement('div'));

    try {
      expect(terminal.options.scrollback).toBeUndefined();
      expect(terminal.options.scrollbackBytes).toBe(10_000_000);
      expect(terminal.getScrollbackByteLimit()).toBe(10_000_000);

      terminal.reset();
      expect(terminal.getScrollbackByteLimit()).toBe(10_000_000);
    } finally {
      terminal.dispose();
    }
  });

  test('rejects conflicting public and low-level options', async () => {
    expect(() => new Terminal({ scrollback: 1_000, scrollbackBytes: 10_000_000 })).toThrow(
      'scrollback and scrollbackBytes are mutually exclusive'
    );

    const ghostty = await Ghostty.load();
    expect(() =>
      ghostty.createTerminal(80, 24, {
        scrollbackLimit: 1_000,
        scrollbackBytes: 10_000_000,
      })
    ).toThrow('scrollbackLimit and scrollbackBytes are mutually exclusive');

    const terminal = await createIsolatedTerminal({ scrollbackBytes: 10_000_000 });
    expect(() => {
      terminal.options.scrollback = 1_000;
    }).toThrow('scrollback and scrollbackBytes are mutually exclusive');
    terminal.dispose();
  });

  test('reports zero as unlimited in both modes', async () => {
    const ghostty = await Ghostty.load();
    const lines = ghostty.createTerminal(80, 24, { scrollbackLimit: 0 });
    const bytes = ghostty.createTerminal(80, 24, { scrollbackBytes: 0 });

    try {
      expect(lines.getScrollbackByteLimit()).toBe(0);
      expect(bytes.getScrollbackByteLimit()).toBe(0);
    } finally {
      lines.free();
      bytes.free();
    }
  });

  test('reserves the native maximum value for the unlimited sentinel', async () => {
    const ghostty = await Ghostty.load();
    expect(() => ghostty.createTerminal(80, 24, { scrollbackBytes: 0xffffffff })).toThrow(
      'scrollbackBytes must be an integer from 0 to 4294967294'
    );
  });
});
