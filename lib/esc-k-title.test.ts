import { afterEach, describe, expect, test } from 'bun:test';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

let container: HTMLElement | undefined;
let terminal: Terminal | undefined;

async function openTerminal(options: { cols?: number; rows?: number } = {}): Promise<Terminal> {
  container = document.createElement('div');
  document.body.appendChild(container);
  terminal = await createIsolatedTerminal(options);
  terminal.open(container);
  return terminal;
}

function retainedText(term: Terminal): string {
  const lines: string[] = [];
  for (let y = 0; y < term.buffer.normal.length; y++) {
    const line = term.buffer.normal.getLine(y);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join('\n');
}

afterEach(() => {
  terminal?.dispose();
  container?.remove();
  terminal = undefined;
  container = undefined;
});

describe('GNU screen/tmux ESC k title strings', () => {
  test('consumes split ST-terminated payloads while preserving adjacent retained text', async () => {
    const term = await openTerminal({ cols: 40, rows: 2 });

    term.write('before');
    term.write('\x1b');
    term.write('k/tmp');
    term.write('\x1b');
    term.write('\\after\r\nnext\r\n');

    const retained = retainedText(term);
    expect(retained).toContain('beforeafter');
    expect(retained).toContain('next');
    expect(retained).not.toContain('/tmp');
  });

  test('accepts BEL and 8-bit ST terminators without leaking title bytes', async () => {
    const term = await openTerminal({ cols: 40, rows: 2 });

    term.write('\x1bkbel-title\x07A');
    term.write(
      new Uint8Array([0x1b, 0x6b, 0x63, 0x31, 0x2d, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x9c, 0x42])
    );

    expect(retainedText(term)).toContain('AB');
    expect(retainedText(term)).not.toMatch(/bel-title|c1-title/);
  });

  test('does not change existing OSC title events', async () => {
    const term = await openTerminal({ cols: 40, rows: 2 });
    let title = '';
    term.onTitleChange((value) => {
      title = value;
    });

    term.write('\x1b]2;OSC title\x07');
    term.write('\x1bkscreen title\x1b\\visible');

    expect(title).toBe('OSC title');
    expect(retainedText(term)).toContain('visible');
    expect(retainedText(term)).not.toContain('screen title');
  });
});
