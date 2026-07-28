import { describe, expect, test } from 'bun:test';

import { Ghostty, type GhosttyCell } from './ghostty';

function cellsToText(cells: readonly GhosttyCell[]): string {
  return cells
    .filter((cell) => cell.width !== 0 && cell.codepoint !== 0)
    .map((cell) => String.fromCodePoint(cell.codepoint))
    .join('')
    .trimEnd();
}

describe('Ghostty v1.3 core compatibility', () => {
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
});
