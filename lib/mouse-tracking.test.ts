import { afterEach, describe, expect, test } from 'bun:test';
import type { ITerminalOptions } from './interfaces';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

const terminals: Terminal[] = [];
const hosts: HTMLElement[] = [];

async function openTerminal(options: Omit<ITerminalOptions, 'ghostty'> = {}): Promise<Terminal> {
  const terminal = await createIsolatedTerminal(options);
  const host = document.createElement('div');
  document.body.appendChild(host);
  terminal.open(host);
  terminals.push(terminal);
  hosts.push(host);
  return terminal;
}

function canvasFor(terminal: Terminal): HTMLCanvasElement {
  const canvas = terminal.element?.querySelector('canvas');
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Expected terminal canvas');
  return canvas;
}

function dispatchWheel(canvas: HTMLCanvasElement, deltaY: number, shiftKey = false): WheelEvent {
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    deltaY,
    shiftKey,
  });
  // Happy DOM's WheelEvent omits inherited MouseEvent constructor fields.
  Object.defineProperties(event, {
    clientX: { configurable: true, value: 1 },
    clientY: { configurable: true, value: 1 },
    shiftKey: { configurable: true, value: shiftKey },
  });
  canvas.dispatchEvent(event);
  return event;
}

function dispatchMouse(
  canvas: HTMLCanvasElement,
  type: 'mousedown' | 'mousemove' | 'mouseup',
  x: number,
  shiftKey: boolean,
  buttons = type === 'mouseup' ? 0 : 1
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons,
    clientX: x,
    clientY: 1,
    shiftKey,
  });
  Object.defineProperties(event, {
    offsetX: { configurable: true, value: x },
    offsetY: { configurable: true, value: 1 },
  });
  canvas.dispatchEvent(event);
}

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
  for (const host of hosts.splice(0)) host.remove();
});

describe('application mouse tracking ownership', () => {
  test('reports one SGR wheel event from the actual canvas in the normal buffer', async () => {
    const terminal = await openTerminal({ cols: 20, rows: 4 });
    for (let row = 0; row < 10; row++) terminal.write(`row ${row}\r\n`);
    terminal.write('\x1b[?1000h\x1b[?1006h');
    const data: string[] = [];
    terminal.onData((value) => data.push(value));
    const viewportBefore = terminal.getViewportY();

    const event = dispatchWheel(canvasFor(terminal), -100);

    expect(data).toEqual(['\x1b[<64;1;1M']);
    expect(terminal.getViewportY()).toBe(viewportBefore);
    expect(event.defaultPrevented).toBe(true);
  });

  test('reports one SGR wheel event from the actual canvas in the alternate buffer', async () => {
    const terminal = await openTerminal({ cols: 20, rows: 4 });
    terminal.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h');
    const data: string[] = [];
    terminal.onData((value) => data.push(value));
    const viewportBefore = terminal.getViewportY();

    dispatchWheel(canvasFor(terminal), 100);

    expect(data).toEqual(['\x1b[<65;1;1M']);
    expect(terminal.getViewportY()).toBe(viewportBefore);
  });

  test('runs a custom wheel handler before application reporting', async () => {
    const terminal = await openTerminal({ cols: 20, rows: 4 });
    terminal.write('\x1b[?1000h\x1b[?1006h');
    const canvas = canvasFor(terminal);
    const data: string[] = [];
    terminal.onData((value) => data.push(value));
    let customCalls = 0;

    terminal.attachCustomWheelEventHandler(() => {
      customCalls++;
      return true;
    });
    dispatchWheel(canvas, -100);
    expect(customCalls).toBe(1);
    expect(data).toEqual([]);

    terminal.attachCustomWheelEventHandler(() => {
      customCalls++;
      return false;
    });
    dispatchWheel(canvas, 100);
    expect(customCalls).toBe(2);
    expect(data).toEqual(['\x1b[<65;1;1M']);
  });

  test('keeps application mouse ownership while disableStdin blocks its report', async () => {
    const terminal = await openTerminal({ cols: 20, rows: 4, disableStdin: true });
    for (let row = 0; row < 10; row++) terminal.write(`row ${row}\r\n`);
    terminal.write('\x1b[?1000h\x1b[?1006h');
    const data: string[] = [];
    terminal.onData((value) => data.push(value));
    const viewportBefore = terminal.getViewportY();

    const event = dispatchWheel(canvasFor(terminal), -100);

    expect(data).toEqual([]);
    expect(terminal.getViewportY()).toBe(viewportBefore);
    expect(event.defaultPrevented).toBe(true);

    terminal.write('\x1b[?1000l\x1b[?1006l\x1b[?1049h');
    dispatchWheel(canvasFor(terminal), -100);
    expect(data).toEqual([]);
  });

  test('uses Shift-wheel as local scroll override in the normal buffer', async () => {
    const terminal = await openTerminal({ cols: 20, rows: 4 });
    for (let row = 0; row < 10; row++) terminal.write(`row ${row}\r\n`);
    terminal.write('\x1b[?1000h\x1b[?1006h');
    const data: string[] = [];
    terminal.onData((value) => data.push(value));

    dispatchWheel(canvasFor(terminal), -100, true);

    expect(data).toEqual([]);
    expect(terminal.getViewportY()).toBeGreaterThan(0);
  });

  test('encodes alternate-screen Shift-wheel fallback with negotiated cursor mode', async () => {
    const terminal = await openTerminal({ cols: 20, rows: 4 });
    terminal.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?1h');
    const data: string[] = [];
    terminal.onData((value) => data.push(value));

    dispatchWheel(canvasFor(terminal), -33, true);

    expect(data).toEqual(['\x1bOA']);
  });

  test('suppresses local selection unless Shift owns the complete gesture', async () => {
    const terminal = await openTerminal({ cols: 20, rows: 4 });
    terminal.write('hello world');
    terminal.write('\x1b[?1002h\x1b[?1006h');
    const canvas = canvasFor(terminal);
    const data: string[] = [];
    terminal.onData((value) => data.push(value));

    dispatchMouse(canvas, 'mousedown', 1, false);
    dispatchMouse(canvas, 'mousemove', 50, false);
    dispatchMouse(canvas, 'mouseup', 50, false);
    expect(terminal.hasSelection()).toBe(false);
    expect(data).toEqual(['\x1b[<0;1;1M', '\x1b[<32;7;1M', '\x1b[<0;7;1m']);

    data.length = 0;
    dispatchMouse(canvas, 'mousedown', 1, true);
    dispatchMouse(canvas, 'mousemove', 50, true);
    dispatchMouse(canvas, 'mouseup', 50, true);
    expect(terminal.hasSelection()).toBe(true);
    expect(terminal.getSelection().length).toBeGreaterThan(0);
    expect(data).toEqual([]);
  });

  test('recovers application motion after a Shift drag is released outside', async () => {
    const terminal = await openTerminal({ cols: 20, rows: 4 });
    terminal.write('hello world\x1b[?1003h\x1b[?1006h');
    const canvas = canvasFor(terminal);
    const data: string[] = [];
    terminal.onData((value) => data.push(value));

    dispatchMouse(canvas, 'mousedown', 1, true);
    document.body.dispatchEvent(
      new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 0,
        clientX: 50,
        clientY: 50,
        shiftKey: true,
      })
    );
    dispatchMouse(canvas, 'mousemove', 50, false, 0);

    expect(data).toEqual(['\x1b[<32;7;1M']);
  });
});
