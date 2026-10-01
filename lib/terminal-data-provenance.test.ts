import { afterEach, describe, expect, test } from 'bun:test';
import type { ITerminalDataEvent } from './interfaces';
import type { Terminal } from './terminal';
import { TerminalDataChannel } from './terminal-data';
import { createIsolatedTerminal } from './test-helpers';

const terminals: Terminal[] = [];
const containers: HTMLElement[] = [];

async function openTerminal() {
  const terminal = await createIsolatedTerminal({ cols: 20, rows: 3, focusOnOpen: false });
  const container = document.createElement('div');
  document.body.append(container);
  terminals.push(terminal);
  containers.push(container);
  terminal.open(container);
  const tagged: ITerminalDataEvent[] = [];
  const legacy: string[] = [];
  terminal.onDataWithSource((event) => tagged.push(event));
  terminal.onData((data) => legacy.push(data));
  return { terminal, container, tagged, legacy };
}

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
  for (const container of containers.splice(0)) container.remove();
});

describe('Terminal data provenance', () => {
  test('keyboard and application mouse reports are user data', async () => {
    const { terminal, tagged, legacy } = await openTerminal();
    terminal.textarea!.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'a',
        code: 'KeyA',
      })
    );
    terminal.write('\x1b[?1000h\x1b[?1006h');
    terminal.renderer!.getCanvas().dispatchEvent(
      new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 8,
        clientY: 8,
      })
    );
    expect(tagged[0]).toEqual({ data: 'a', source: 'user' });
    expect(tagged[1]?.data).toStartWith('\x1b[<0;');
    expect(tagged.every((event) => event.source === 'user')).toBe(true);
    expect(legacy).toEqual(tagged.map((event) => event.data));
  });

  test('producer-assigned sources survive deferred channel delivery', async () => {
    const { terminal, tagged, legacy } = await openTerminal();
    const original = TerminalDataChannel.prototype.emit;
    const pending: Array<() => void> = [];
    TerminalDataChannel.prototype.emit = function (data, source) {
      pending.push(() => original.call(this, data, source));
    };
    try {
      terminal.write('\x1b[5n');
      terminal.paste('deferred paste');
    } finally {
      TerminalDataChannel.prototype.emit = original;
    }
    expect(tagged).toEqual([]);
    for (const deliver of pending) await Promise.resolve().then(deliver);
    expect(tagged).toEqual([
      { data: '\x1b[0n', source: 'terminal-response' },
      { data: 'deferred paste', source: 'user' },
    ]);
    expect(legacy).toEqual(tagged.map((event) => event.data));
  });
  test('real parser replies and bracketed paste retain exact bytes', async () => {
    const { terminal, tagged, legacy } = await openTerminal();
    terminal.write('\x1b[5n\x1b[6n');
    terminal.write('\x1b[?2004h');
    terminal.paste('pasted');
    terminal.input('typed', true);
    terminal.input('parser output');
    expect(tagged).toEqual([
      { data: '\x1b[0n\x1b[1;1R', source: 'terminal-response' },
      { data: '\x1b[200~pasted\x1b[201~', source: 'user' },
      { data: 'typed', source: 'user' },
    ]);
    expect(legacy).toEqual(tagged.map((event) => event.data));
  });

  test('user input reentered from a parser event is still user data', async () => {
    const { terminal, tagged, legacy } = await openTerminal();
    terminal.onTerminalEvent((event) => {
      if (event.type === 'title') terminal.paste('nested paste');
    });
    terminal.write('\x1b]2;title\x07\x1b[5n');
    expect(tagged).toEqual([
      { data: 'nested paste', source: 'user' },
      { data: '\x1b[0n', source: 'terminal-response' },
    ]);
    expect(legacy).toEqual(tagged.map((event) => event.data));
  });

  test('nested parser writes cannot reorder records between subscribers', async () => {
    const { terminal, tagged, legacy } = await openTerminal();
    terminal.onDataWithSource((event) => {
      if (event.source === 'user') terminal.write('\x1b[5n');
    });
    terminal.input('input', true);
    expect(tagged).toEqual([
      { data: 'input', source: 'user' },
      { data: '\x1b[0n', source: 'terminal-response' },
    ]);
    expect(legacy).toEqual(tagged.map((event) => event.data));
  });
});
