import { afterEach, describe, expect, test } from 'bun:test';
import type { ITerminalOptions } from './interfaces';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

const openedTerminals: Terminal[] = [];
const containers: HTMLElement[] = [];

async function openTerminal(options: Omit<ITerminalOptions, 'ghostty'> = {}): Promise<Terminal> {
  const terminal = await createIsolatedTerminal(options);
  const container = document.createElement('div');
  document.body.appendChild(container);
  terminal.open(container);
  openedTerminals.push(terminal);
  containers.push(container);
  return terminal;
}

function canvasFor(terminal: Terminal): HTMLCanvasElement {
  const canvas = terminal.element?.querySelector('canvas');
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Expected terminal canvas');
  return canvas;
}

afterEach(() => {
  for (const terminal of openedTerminals.splice(0)) terminal.dispose();
  for (const container of containers.splice(0)) container.remove();
});

describe('host-owned terminal actions', () => {
  test('keeps the built-in hidden-textarea context-menu bridge enabled by default', async () => {
    const terminal = await openTerminal({ cols: 20, rows: 4 });
    terminal.write('copy me');
    terminal.select(0, 0, 7);

    const textarea = terminal.textarea!;
    canvasFor(terminal).dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 17,
        clientY: 23,
      })
    );

    expect(textarea.value).toBe('copy me');
    expect(textarea.style.position).toBe('fixed');
    expect(textarea.style.left).toBe('17px');
    expect(textarea.style.top).toBe('23px');
    expect(textarea.style.pointerEvents).toBe('auto');
    expect(document.activeElement).toBe(textarea);
  });

  test('leaves textarea, clipboard, and PTY state untouched for a host-owned menu', async () => {
    const terminal = await openTerminal({ cols: 20, rows: 4, disableContextMenu: true });
    terminal.write('selected');
    terminal.select(0, 0, 8);
    terminal.write('\x1b[?1000h\x1b[?1006h');

    let clipboardCalls = 0;
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: () => {
          clipboardCalls++;
          return Promise.resolve('clipboard');
        },
        write: () => {
          clipboardCalls++;
          return Promise.resolve();
        },
        writeText: () => {
          clipboardCalls++;
          return Promise.resolve();
        },
      },
    });

    try {
      expect(terminal.hasSelection()).toBe(true);
      expect(terminal.getSelection()).toBe('selected');

      const textarea = terminal.textarea!;
      const before = {
        value: textarea.value,
        position: textarea.style.position,
        left: textarea.style.left,
        top: textarea.style.top,
        width: textarea.style.width,
        height: textarea.style.height,
        pointerEvents: textarea.style.pointerEvents,
        zIndex: textarea.style.zIndex,
      };
      const focusOwner = document.createElement('button');
      document.body.appendChild(focusOwner);
      focusOwner.focus();

      const ptyInput: string[] = [];
      terminal.onData((data) => ptyInput.push(data));
      const canvas = canvasFor(terminal);
      for (const type of ['mousedown', 'mouseup', 'contextmenu']) {
        canvas.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 2,
            clientX: 8,
            clientY: 8,
          })
        );
      }

      expect(ptyInput).toEqual([]);
      expect(clipboardCalls).toBe(0);
      expect(document.activeElement).toBe(focusOwner);
      expect({
        value: textarea.value,
        position: textarea.style.position,
        left: textarea.style.left,
        top: textarea.style.top,
        width: textarea.style.width,
        height: textarea.style.height,
        pointerEvents: textarea.style.pointerEvents,
        zIndex: textarea.style.zIndex,
      }).toEqual(before);

      // The option is a right-click ownership boundary, not a blanket input block.
      for (const type of ['mousedown', 'mouseup']) {
        canvas.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: 8,
            clientY: 8,
          })
        );
      }
      expect(ptyInput.length).toBe(2);
      expect(document.activeElement).toBe(terminal.textarea);

      ptyInput.length = 0;
      terminal.element!.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'a',
          code: 'KeyA',
        })
      );
      expect(ptyInput).toEqual(['a']);

      ptyInput.length = 0;
      terminal.paste('plain text');
      expect(ptyInput).toEqual(['plain text']);

      let wheelEvents = 0;
      terminal.attachCustomWheelEventHandler(() => {
        wheelEvents++;
        return true;
      });
      canvas.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 20 })
      );
      expect(wheelEvents).toBe(1);

      let linkActivations = 0;
      terminal.registerLinkProvider({
        provideLinks(row, callback) {
          callback(
            row === 0
              ? [
                  {
                    text: 'selected',
                    range: { start: { x: 0, y: 0 }, end: { x: 7, y: 0 } },
                    activate: () => {
                      linkActivations++;
                    },
                  },
                ]
              : undefined
          );
        },
      });
      canvas.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 1, clientY: 1 })
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(linkActivations).toBe(1);
      focusOwner.remove();
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
      } else {
        delete (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
      }
    }
  });

  test('selects all retained normal-screen text and pastes sanitized bracketed text exactly', async () => {
    const terminal = await openTerminal({ cols: 20, rows: 3, scrollback: 20 });
    for (let line = 0; line < 8; line++) terminal.writeln(`line-${line}`);
    expect(terminal.wasmTerm!.getScrollbackLength()).toBeGreaterThan(0);

    terminal.selectAll();
    const selection = terminal.getSelection();
    expect(selection).toContain('line-0');
    expect(selection).toContain('line-7');

    const ptyInput: string[] = [];
    terminal.onData((data) => ptyInput.push(data));
    terminal.write('\x1b[?2004h');
    terminal.paste('safe\x03text');
    expect(ptyInput).toEqual(['\x1b[200~safe text\x1b[201~']);
  });

  test('clears visible cells and retained history without replacing objects or emitting input', async () => {
    const terminal = await openTerminal({ cols: 20, rows: 3, scrollback: 20 });
    const publicTerminal = terminal;
    const canvas = canvasFor(terminal);
    const parser = terminal.wasmTerm;
    for (let line = 0; line < 8; line++) terminal.writeln(`line-${line}`);
    terminal.selectAll();
    terminal.scrollToTop();
    expect(terminal.wasmTerm!.getScrollbackLength()).toBeGreaterThan(0);

    const ptyInput: string[] = [];
    terminal.onData((data) => ptyInput.push(data));
    terminal.clear();

    expect(terminal).toBe(publicTerminal);
    expect(canvasFor(terminal)).toBe(canvas);
    expect(terminal.wasmTerm).toBe(parser);
    expect(terminal.wasmTerm!.getScrollbackLength()).toBe(0);
    expect(terminal.wasmTerm!.getCursor()).toMatchObject({ x: 0, y: 0 });
    expect(terminal.wasmTerm!.getLine(0)?.every((cell) => cell.codepoint === 0)).toBe(true);
    expect(terminal.hasSelection()).toBe(false);
    expect(terminal.getViewportY()).toBe(0);
    expect(ptyInput).toEqual([]);
  });

  test('clear and reset revoke pending below-threshold pointer selections', async () => {
    for (const action of ['clear', 'reset'] as const) {
      const terminal = await openTerminal({ cols: 20, rows: 3 });
      terminal.write('pending selection');
      const canvas = canvasFor(terminal);

      canvas.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 1,
          clientY: 1,
        })
      );
      expect(terminal.hasSelection()).toBe(false);

      terminal[action]();
      canvas.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          clientX: 80,
          clientY: 20,
        })
      );
      document.dispatchEvent(
        new MouseEvent('mouseup', {
          bubbles: true,
          button: 0,
          clientX: 80,
          clientY: 20,
        })
      );

      expect(terminal.hasSelection()).toBe(false);
      expect(terminal.getSelection()).toBe('');
    }
  });

  test('resets parser, modes, colors, cursor, selection, and buffer on retained UI objects', async () => {
    const terminal = await openTerminal({ cols: 20, rows: 3, scrollback: 20 });
    const publicTerminal = terminal;
    const canvas = canvasFor(terminal);
    const textarea = terminal.textarea;
    const oldParser = terminal.wasmTerm;

    terminal.write('\x1b[38;2;1;2;3mX');
    expect(terminal.wasmTerm!.getLine(0)?.[0]).toMatchObject({ fg_r: 1, fg_g: 2, fg_b: 3 });
    terminal.write('\x1b[?25l\x1b[?2004h');
    for (let line = 0; line < 8; line++) terminal.writeln(`line-${line}`);
    terminal.selectAll();
    terminal.scrollToTop();
    expect(terminal.wasmTerm!.getCursor().visible).toBe(false);
    expect(terminal.hasBracketedPaste()).toBe(true);

    const ptyInput: string[] = [];
    terminal.onData((data) => ptyInput.push(data));
    terminal.reset();

    expect(terminal).toBe(publicTerminal);
    expect(canvasFor(terminal)).toBe(canvas);
    expect(terminal.textarea).toBe(textarea);
    expect(terminal.wasmTerm).not.toBe(oldParser);
    expect(terminal.wasmTerm!.getScrollbackLength()).toBe(0);
    expect(terminal.wasmTerm!.getCursor()).toMatchObject({ x: 0, y: 0, visible: true });
    expect(terminal.wasmTerm!.getLine(0)?.every((cell) => cell.codepoint === 0)).toBe(true);
    expect(terminal.hasBracketedPaste()).toBe(false);
    expect(terminal.hasSelection()).toBe(false);
    expect(terminal.getSelection()).toBe('');
    expect(terminal.getViewportY()).toBe(0);
    expect(ptyInput).toEqual([]);

    terminal.write('fresh');
    expect(terminal.wasmTerm!.getLine(0)?.[0]).not.toMatchObject({ fg_r: 1, fg_g: 2, fg_b: 3 });
    terminal.select(0, 0, 5);
    expect(terminal.getSelection()).toBe('fresh');
    terminal.paste('after reset');
    expect(ptyInput).toEqual(['after reset']);
  });

  test('fails closed after disposal', async () => {
    const terminal = await openTerminal({ disableContextMenu: true });
    terminal.dispose();

    expect(() => terminal.clear()).toThrow('Terminal has been disposed');
    expect(() => terminal.reset()).toThrow('Terminal has been disposed');
    expect(() => terminal.paste('ignored')).toThrow('Terminal has been disposed');
    expect(() => terminal.selectAll()).not.toThrow();
    expect(terminal.hasSelection()).toBe(false);
    expect(terminal.getSelection()).toBe('');
  });
});
