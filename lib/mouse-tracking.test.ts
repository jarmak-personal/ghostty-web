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

  test('unconfigured mouse reporting preserves fractional gesture distance', async () => {
    const terminal = await openTerminal({ cols: 20, rows: 4 });
    terminal.write('\x1b[?1000h\x1b[?1006h');
    const data: string[] = [];
    terminal.onData((value) => data.push(value));
    gesture(terminal, 1);
    gesture(terminal, 1);
    expect(data).toEqual([]);
    gesture(terminal, 1);
    expect(data).toEqual(['\x1b[<65;1;1M']);
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

const hvirWheelOptions: ITerminalOptions = {
  cols: 20,
  rows: 4,
  disableContextMenu: true,
  wheelScroll: {
    linesPerStep: 3,
    maxMouseReports: 5,
    maxFallbackKeys: 1,
    alternateScreenFallback: 'page',
    mouseEncoding: 'sgr',
  },
};

function gesture(terminal: Terminal, deltaY: number, fields: Partial<WheelEvent> = {}): void {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY });
  for (const [key, value] of Object.entries({
    deltaMode: 1,
    clientX: 1,
    clientY: 1,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    ...fields,
  }))
    Object.defineProperty(event, key, { configurable: true, value });
  canvasFor(terminal).dispatchEvent(event);
}

describe('hvir wheel compatibility configuration', () => {
  for (const mode of [1000, 1002, 1003]) {
    for (const alternate of [false, true]) {
      test(`routes fractional wheel once with mode ${mode}, alternate=${alternate}`, async () => {
        const terminal = await openTerminal(hvirWheelOptions);
        terminal.write(`${alternate ? '\x1b[?1049h' : ''}\x1b[?${mode}h\x1b[?1006h`);
        const data: string[] = [];
        terminal.onData((value) => data.push(value));
        gesture(terminal, 1);
        gesture(terminal, 1);
        expect(data).toEqual([]);
        gesture(terminal, 1);
        expect(data).toEqual(['\x1b[<65;1;1M']);
        gesture(terminal, -300, { altKey: true, ctrlKey: true, clientX: 1e6, clientY: -20 });
        expect(data.slice(1)).toEqual(Array(5).fill('\x1b[<88;20;1M'));
        gesture(terminal, -1);
        expect(data).toHaveLength(6);
      });
    }
  }

  test('dispatches bounded page fallback and resets on route and direction changes', async () => {
    const terminal = await openTerminal(hvirWheelOptions);
    terminal.write('\x1b[?1049h');
    const data: string[] = [];
    terminal.onData((value) => data.push(value));
    gesture(terminal, 2);
    gesture(terminal, -1);
    expect(data).toEqual([]);
    gesture(terminal, -2);
    gesture(terminal, 300);
    expect(data).toEqual(['\x1b[5~', '\x1b[6~']);
    gesture(terminal, 2);
    terminal.write('\x1b[?1000h\x1b[?1006h');
    gesture(terminal, 1);
    expect(data).toHaveLength(2);
    gesture(terminal, 2);
    expect(data.at(-1)).toBe('\x1b[<65;1;1M');
  });

  test('custom handler ownership discards an application remainder', async () => {
    const terminal = await openTerminal(hvirWheelOptions);
    terminal.write('\x1b[?1000h\x1b[?1006h');
    const data: string[] = [];
    terminal.onData((value) => data.push(value));
    gesture(terminal, 2);
    let customCalls = 0;
    terminal.attachCustomWheelEventHandler(() => {
      customCalls++;
      return true;
    });
    gesture(terminal, 3);
    expect(customCalls).toBe(1);
    expect(data).toEqual([]);
    terminal.attachCustomWheelEventHandler(() => false);
    gesture(terminal, 1);
    expect(data).toEqual([]);
    gesture(terminal, 2);
    expect(data).toEqual(['\x1b[<65;1;1M']);
  });

  test('normal-buffer local scrolling discards an application remainder', async () => {
    const terminal = await openTerminal(hvirWheelOptions);
    for (let row = 0; row < 10; row++) terminal.write(`row ${row}\r\n`);
    terminal.write('\x1b[?1000h\x1b[?1006h');
    const data: string[] = [];
    terminal.onData((value) => data.push(value));
    gesture(terminal, -2);
    terminal.write('\x1b[?1000l');
    gesture(terminal, -3);
    expect(terminal.getViewportY()).toBeGreaterThan(0);
    expect(data).toEqual([]);
    terminal.write('\x1b[?1000h');
    gesture(terminal, -1);
    expect(data).toEqual([]);
    gesture(terminal, -2);
    expect(data).toEqual(['\x1b[<64;1;1M']);
  });

  test('disableStdin transitions discard an application remainder', async () => {
    const terminal = await openTerminal(hvirWheelOptions);
    terminal.write('\x1b[?1000h\x1b[?1006h');
    const data: string[] = [];
    terminal.onData((value) => data.push(value));
    gesture(terminal, 2);
    terminal.options.disableStdin = true;
    gesture(terminal, 2);
    expect(data).toEqual([]);
    terminal.options.disableStdin = false;
    gesture(terminal, 1);
    expect(data).toEqual([]);
    gesture(terminal, 2);
    expect(data).toEqual(['\x1b[<65;1;1M']);
  });

  test('consumes unsupported encoding without reports or page fallback', async () => {
    const terminal = await openTerminal(hvirWheelOptions);
    terminal.write('\x1b[?1049h\x1b[?1000h');
    const data: string[] = [];
    terminal.onData((value) => data.push(value));
    gesture(terminal, 3);
    expect(data).toEqual([]);
    terminal.write('\x1b[?1006h');
    gesture(terminal, 1);
    expect(data).toEqual([]);
  });

  test('Shift takes local ownership and context menu buttons emit no reports', async () => {
    const terminal = await openTerminal(hvirWheelOptions);
    terminal.write('hello world\x1b[?1002h\x1b[?1006h');
    const canvas = canvasFor(terminal);
    const data: string[] = [];
    terminal.onData((value) => data.push(value));
    gesture(terminal, 2);
    gesture(terminal, -3, { shiftKey: true });
    gesture(terminal, 1);
    expect(data).toEqual([]);
    dispatchMouse(canvas, 'mousedown', 1, true);
    dispatchMouse(canvas, 'mousemove', 50, true);
    dispatchMouse(canvas, 'mouseup', 50, true);
    expect(terminal.hasSelection()).toBe(true);
    for (const type of ['mousedown', 'mouseup', 'contextmenu']) {
      canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 2, buttons: 0 }));
    }
    expect(data).toEqual([]);
  });

  test('disabled input blocks both mouse and page input without local scrolling', async () => {
    const terminal = await openTerminal({ ...hvirWheelOptions, disableStdin: true });
    const data: string[] = [];
    terminal.onData((value) => data.push(value));
    terminal.write('\x1b[?1049h');
    gesture(terminal, 300);
    terminal.write('\x1b[?1000h\x1b[?1006h');
    gesture(terminal, 300);
    expect(data).toEqual([]);
    expect(terminal.getViewportY()).toBe(0);
    const retainedCanvas = canvasFor(terminal);
    terminal.dispose();
    dispatchWheel(retainedCanvas, 300);
    expect(data).toEqual([]);
  });
});
