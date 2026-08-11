import { describe, expect, test } from 'bun:test';
import { GhosttyTerminal, KeyEncoder } from './ghostty';
import { InputHandler } from './input-handler';
import { Terminal } from './terminal';
import type { GhosttyWasmExports } from './types';

interface TrackedListener {
  type: string;
  listener: EventListenerOrEventListenerObject;
  capture: boolean;
}

interface ListenerTracker {
  active: TrackedListener[];
  restore(): void;
}

function captureOf(options?: boolean | AddEventListenerOptions | EventListenerOptions): boolean {
  return typeof options === 'boolean' ? options : options?.capture === true;
}

function trackListeners(target: EventTarget, failAdd?: (type: string) => boolean): ListenerTracker {
  const active: TrackedListener[] = [];
  const originalAdd = target.addEventListener;
  const originalRemove = target.removeEventListener;

  target.addEventListener = function (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ): void {
    if (failAdd?.(type)) throw new Error(`injected ${type} listener failure`);
    originalAdd.call(this, type, listener, options);
    if (!listener) return;
    const capture = captureOf(options);
    if (
      !active.some(
        (entry) => entry.type === type && entry.listener === listener && entry.capture === capture
      )
    ) {
      active.push({ type, listener, capture });
    }
  };

  target.removeEventListener = function (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions
  ): void {
    originalRemove.call(this, type, listener, options);
    if (!listener) return;
    const capture = captureOf(options);
    const index = active.findIndex(
      (entry) => entry.type === type && entry.listener === listener && entry.capture === capture
    );
    if (index >= 0) active.splice(index, 1);
  };

  return {
    active,
    restore: () => {
      target.addEventListener = originalAdd;
      target.removeEventListener = originalRemove;
    },
  };
}

describe('lifecycle disposal', () => {
  test('releases viewport, grapheme, and buffer-info scratch allocations on every native terminal free', () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const liveAllocations = new Map<number, number>();
    let nextPointer = 64;
    let terminalFrees = 0;

    const exports = {
      memory,
      ghostty_terminal_new: () => 1,
      ghostty_wasm_alloc_u8_array: (length: number) => {
        const pointer = nextPointer;
        nextPointer += length;
        liveAllocations.set(pointer, length);
        return pointer;
      },
      ghostty_wasm_free_u8_array: (pointer: number, length: number) => {
        expect(liveAllocations.get(pointer)).toBe(length);
        liveAllocations.delete(pointer);
      },
      ghostty_render_state_get_viewport: () => 1,
      ghostty_render_state_get_grapheme: (
        _handle: number,
        _row: number,
        _column: number,
        pointer: number
      ) => {
        new Uint32Array(memory.buffer, pointer, 1)[0] = 'é'.codePointAt(0)!;
        return 1;
      },
      ghostty_terminal_get_buffer_info: (_handle: number, _alternate: boolean, pointer: number) => {
        new Uint32Array(memory.buffer, pointer, 5).set([0, 0, 0, 1, 1]);
        return 5;
      },
      ghostty_terminal_free: () => {
        terminalFrees++;
      },
    } as unknown as GhosttyWasmExports;

    for (let cycle = 0; cycle < 3; cycle++) {
      const terminal = new GhosttyTerminal(exports, memory, 1, 1);
      terminal.getViewport(false);
      expect(terminal.getGrapheme(0, 0, false)).toEqual(['é'.codePointAt(0)]);
      expect(terminal.getBufferInfo('normal')).toEqual({
        scrollbackLength: 0,
        cursorX: 0,
        cursorY: 0,
        rows: 1,
        cols: 1,
      });
      expect(liveAllocations.size).toBe(3);

      terminal.free();
      terminal.free();
      expect(liveAllocations.size).toBe(0);
    }

    expect(terminalFrees).toBe(3);
  });

  test('InputHandler owns and disposes its native key encoder exactly once', () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    let encoderFrees = 0;
    let opaqueFrees = 0;
    const exports = {
      memory,
      ghostty_wasm_alloc_opaque: () => 8,
      ghostty_key_encoder_new: (_allocator: number, output: number) => {
        new DataView(memory.buffer).setUint32(output, 42, true);
        return 0;
      },
      ghostty_wasm_free_opaque: () => {
        opaqueFrees++;
      },
      ghostty_key_encoder_free: (encoder: number) => {
        expect(encoder).toBe(42);
        encoderFrees++;
      },
    } as unknown as GhosttyWasmExports;
    const ghostty = {
      createKeyEncoder: () => new KeyEncoder(exports),
    };
    const container = document.createElement('div');
    let injectFailure = true;
    const tracker = trackListeners(container, (type) => {
      if (injectFailure && type === 'compositionupdate') {
        injectFailure = false;
        return true;
      }
      return false;
    });

    expect(
      () =>
        new InputHandler(
          ghostty as never,
          container,
          () => {},
          () => {}
        )
    ).toThrow('injected compositionupdate listener failure');
    expect(tracker.active).toHaveLength(0);
    expect(opaqueFrees).toBe(1);
    expect(encoderFrees).toBe(1);

    const handler = new InputHandler(
      ghostty as never,
      container,
      () => {},
      () => {}
    );

    handler.dispose();
    handler.dispose();

    expect(tracker.active).toHaveLength(0);
    expect(opaqueFrees).toBe(2);
    expect(encoderFrees).toBe(2);
    tracker.restore();
  });

  test('balances listeners and native ownership across failed and successful opens', () => {
    const originalCreateElement = document.createElement.bind(document);
    const childTrackers: ListenerTracker[] = [];
    document.createElement = ((tagName: string, options?: ElementCreationOptions) => {
      const element = originalCreateElement(tagName, options);
      if (tagName.toLowerCase() === 'canvas' || tagName.toLowerCase() === 'textarea') {
        childTrackers.push(trackListeners(element));
      }
      return element;
    }) as typeof document.createElement;

    let injectFailure = true;
    const host = originalCreateElement('div');
    host.setAttribute('tabindex', '7');
    host.setAttribute('contenteditable', 'false');
    host.setAttribute('role', 'group');
    host.setAttribute('aria-label', 'Existing label');
    host.setAttribute('aria-multiline', 'false');
    host.style.outline = '1px dotted red';
    host.style.outlineOffset = '3px';
    host.style.cursor = 'crosshair';
    const initialOutline = host.style.outline;
    const initialOutlineOffset = host.style.outlineOffset;
    const initialCursor = host.style.cursor;
    document.body.appendChild(host);

    const hostTracker = trackListeners(host, (type) => {
      if (injectFailure && type === 'mouseleave') {
        injectFailure = false;
        return true;
      }
      return false;
    });
    const documentTracker = trackListeners(document);
    const windowTracker = trackListeners(window);
    let terminalCreates = 0;
    let terminalFrees = 0;
    let encoderCreates = 0;
    let encoderFrees = 0;
    const ghostty = {
      createTerminal: () => {
        terminalCreates++;
        return {
          free: () => {
            terminalFrees++;
          },
        };
      },
      createKeyEncoder: () => {
        encoderCreates++;
        return {
          dispose: () => {
            encoderFrees++;
          },
        };
      },
    };
    const terminal = new Terminal({ ghostty: ghostty as never, focusOnOpen: false });

    try {
      expect(() => terminal.open(host)).toThrow('injected mouseleave listener failure');
      expect(host.childNodes).toHaveLength(0);
      expect(hostTracker.active).toHaveLength(0);
      expect(documentTracker.active).toHaveLength(0);
      expect(windowTracker.active).toHaveLength(0);
      expect(childTrackers.every((tracker) => tracker.active.length === 0)).toBe(true);
      expect(terminalFrees).toBe(1);
      expect(encoderFrees).toBe(1);

      // A rolled-back open keeps the module usable and can be retried.
      terminal.open(host);
      terminal.dispose();

      expect(host.childNodes).toHaveLength(0);
      expect(hostTracker.active).toHaveLength(0);
      expect(documentTracker.active).toHaveLength(0);
      expect(windowTracker.active).toHaveLength(0);
      expect(childTrackers.every((tracker) => tracker.active.length === 0)).toBe(true);
      expect(terminalCreates).toBe(2);
      expect(terminalFrees).toBe(2);
      expect(encoderCreates).toBe(2);
      expect(encoderFrees).toBe(2);
      expect(host.getAttribute('tabindex')).toBe('7');
      expect(host.getAttribute('contenteditable')).toBe('false');
      expect(host.getAttribute('role')).toBe('group');
      expect(host.getAttribute('aria-label')).toBe('Existing label');
      expect(host.getAttribute('aria-multiline')).toBe('false');
      expect(host.style.outline).toBe(initialOutline);
      expect(host.style.outlineOffset).toBe(initialOutlineOffset);
      expect(host.style.cursor).toBe(initialCursor);

      const beforeInput = new InputEvent('beforeinput', { bubbles: true, cancelable: true });
      host.dispatchEvent(beforeInput);
      expect(beforeInput.defaultPrevented).toBe(false);
    } finally {
      terminal.dispose();
      hostTracker.restore();
      documentTracker.restore();
      windowTracker.restore();
      for (const tracker of childTrackers) tracker.restore();
      document.createElement = originalCreateElement;
      host.remove();
    }
  });
});
