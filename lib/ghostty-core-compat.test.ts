import { describe, expect, test } from 'bun:test';

import { Ghostty, type GhosttyCell } from './ghostty';
import { Key, KeyAction, KittyKeyFlags, Mods } from './types';

function cellsToText(cells: readonly GhosttyCell[]): string {
  return cells
    .filter((cell) => cell.width !== 0 && cell.codepoint !== 0)
    .map((cell) => String.fromCodePoint(cell.codepoint))
    .join('')
    .trimEnd();
}

describe('Ghostty v1.3 core compatibility', () => {
  test('batches a viewport-bounded retained slice into reusable cells', async () => {
    const ghostty = await Ghostty.load();
    const terminal = ghostty.createTerminal(12, 3, { scrollbackLimit: 20 });

    try {
      for (let line = 0; line < 10; line++) terminal.write(`line-${line}\r\n`);
      const scrollbackLength = terminal.getScrollbackLength();
      expect(scrollbackLength).toBeGreaterThan(4);

      const first = terminal.getScrollbackViewport(1, 3);
      expect(first).not.toBeNull();
      expect(first!.map(cellsToText)).toEqual(
        Array.from({ length: 3 }, (_, row) =>
          cellsToText(terminal.getScrollbackLine(row + 1) ?? [])
        )
      );

      const firstRow = first![0];
      const firstCell = firstRow[0];
      const second = terminal.getScrollbackViewport(2, 3);
      expect(second).not.toBeNull();
      expect(second![0]).toBe(firstRow);
      expect(second![0][0]).toBe(firstCell);
      expect(second!.map(cellsToText)).toEqual(
        Array.from({ length: 3 }, (_, row) =>
          cellsToText(terminal.getScrollbackLine(row + 2) ?? [])
        )
      );
    } finally {
      terminal.free();
    }
  });

  test('reuses WASM page buffers safely after multi-codepoint graphemes', async () => {
    const ghostty = await Ghostty.load();

    for (const grapheme of ['🇺🇸', 'e\u0301', '👨‍👩‍👧‍👦']) {
      const first = ghostty.createTerminal(80, 24);
      try {
        first.write(grapheme);
      } finally {
        first.free();
      }

      const second = ghostty.createTerminal(80, 24);
      try {
        second.write('Hello');
        second.update();
        expect(cellsToText(second.getLine(0) ?? [])).toBe('Hello');
      } finally {
        second.free();
      }
    }
  });

  test('encodes control letters from their unshifted codepoints', async () => {
    const ghostty = await Ghostty.load();
    const encoder = ghostty.createKeyEncoder();
    const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

    try {
      encoder.setKittyFlags(KittyKeyFlags.DISAMBIGUATE);

      for (const [key, text, expected] of [
        [Key.A, 'a', '\x1b[97;5u'],
        [Key.C, 'c', '\x1b[99;5u'],
        [Key.U, 'u', '\x1b[117;5u'],
        [Key.W, 'w', '\x1b[119;5u'],
      ] as const) {
        expect(
          decode(
            encoder.encode({
              action: KeyAction.PRESS,
              key,
              mods: Mods.CTRL,
              utf8: text,
              unshiftedCodepoint: text.codePointAt(0),
            })
          )
        ).toBe(expected);
      }

      encoder.setKittyFlags(KittyKeyFlags.DISABLED);
      expect(
        encoder.encode({
          action: KeyAction.PRESS,
          key: Key.U,
          mods: Mods.CTRL,
          utf8: 'u',
          unshiftedCodepoint: 'u'.codePointAt(0),
        })
      ).toEqual(Uint8Array.of(0x15));
    } finally {
      encoder.dispose();
    }
  });

  test('processes semantic prompt actions without exposing control text', async () => {
    const ghostty = await Ghostty.load();
    const terminal = ghostty.createTerminal(80, 24);

    try {
      terminal.write(
        '\x1b]133;A\x07prompt$ \x1b]133;B\x07echo ready\r\n' +
          '\x1b]133;C\x07ready\r\n\x1b]133;D;0\x07'
      );
      terminal.update();

      expect(cellsToText(terminal.getLine(0) ?? [])).toBe('prompt$ echo ready');
      expect(cellsToText(terminal.getLine(1) ?? [])).toBe('ready');
    } finally {
      terminal.free();
    }
  });

  test('preserves ordered terminal responses from one write', async () => {
    const ghostty = await Ghostty.load();
    const terminal = ghostty.createTerminal(80, 24);

    try {
      terminal.write('\x1b[5n\x1b[6n');
      const responses: string[] = [];

      while (terminal.hasResponse()) {
        const response = terminal.readResponse();
        if (response === null) break;
        responses.push(response);
      }

      expect(responses.join('')).toBe('\x1b[0n\x1b[1;1R');
      expect(terminal.hasResponse()).toBeFalsy();
    } finally {
      terminal.free();
    }
  });

  test('reports active Kitty keyboard flags', async () => {
    const ghostty = await Ghostty.load();
    const terminal = ghostty.createTerminal(80, 24);

    try {
      terminal.write('\x1b[?u');
      expect(terminal.readResponse()).toBe('\x1b[?0u');

      terminal.write('\x1b[>1u\x1b[?u');
      expect(terminal.getKittyKeyboardFlags()).toBe(1);
      expect(terminal.readResponse()).toBe('\x1b[?1u');

      terminal.write('\x1b[<u\x1b[?u');
      expect(terminal.getKittyKeyboardFlags()).toBe(0);
      expect(terminal.readResponse()).toBe('\x1b[?0u');
    } finally {
      terminal.free();
    }
  });

  test('isolates negotiated keyboard state per terminal', async () => {
    const ghostty = await Ghostty.load();
    const first = ghostty.createTerminal(80, 24);
    const second = ghostty.createTerminal(80, 24);

    try {
      first.write('\x1b[>1u\x1b[>4;2m');

      expect(first.getKittyKeyboardFlags()).toBe(1);
      expect(first.hasModifyOtherKeysState2()).toBe(true);
      expect(second.getKittyKeyboardFlags()).toBe(0);
      expect(second.hasModifyOtherKeysState2()).toBe(false);

      first.write('\x1bc');
      expect(first.getKittyKeyboardFlags()).toBe(0);
      expect(first.hasModifyOtherKeysState2()).toBe(false);
    } finally {
      first.free();
      second.free();
    }
  });
});
