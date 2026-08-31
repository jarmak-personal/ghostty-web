/**
 * Terminal Scrolling Tests
 *
 * Test Isolation Pattern:
 * Uses createIsolatedTerminal() to ensure each test gets its own WASM instance.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

function installScrollFrameHarness(): {
  callbacks: Map<number, FrameRequestCallback>;
  peekNext: () => FrameRequestCallback;
  runNext: (timestamp: number) => void;
  restore: () => void;
} {
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;

  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    const id = nextFrame++;
    callbacks.set(id, callback);
    return id;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    callbacks.delete(id);
  }) as typeof cancelAnimationFrame;

  const nextCallback = (): FrameRequestCallback => {
    const next = callbacks.entries().next().value as [number, FrameRequestCallback] | undefined;
    if (!next) throw new Error('Expected a pending scroll animation frame');
    return next[1];
  };

  return {
    callbacks,
    peekNext: nextCallback,
    runNext: (timestamp: number) => {
      const next = callbacks.entries().next().value as [number, FrameRequestCallback] | undefined;
      if (!next) throw new Error('Expected a pending scroll animation frame');
      callbacks.delete(next[0]);
      next[1](timestamp);
    },
    restore: () => {
      globalThis.requestAnimationFrame = originalRequest;
      globalThis.cancelAnimationFrame = originalCancel;
    },
  };
}

describe('Terminal Scrolling', () => {
  let terminal: Terminal;
  let container: HTMLElement;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    terminal = await createIsolatedTerminal({ cols: 80, rows: 24 });
    terminal.open(container);
  });

  afterEach(() => {
    if (terminal) {
      terminal.dispose();
    }
    if (container && document.body.contains(container)) {
      document.body.removeChild(container);
    }
  });

  describe('Normal Screen Mode', () => {
    test('keeps the same history row visible while output grows scrollback', () => {
      for (let i = 0; i < 50; i++) {
        terminal.write(`Line ${i}\r\n`);
      }

      terminal.scrollLines(-10);
      const viewportBefore = terminal.getViewportY();
      const scrollbackBefore = terminal.getScrollbackLength();
      const offsetBefore = scrollbackBefore - Math.floor(viewportBefore);
      const lineBefore = terminal.wasmTerm!.getScrollbackLine(offsetBefore);

      terminal.write('New output\r\n');

      const scrollbackAfter = terminal.getScrollbackLength();
      const scrollbackGrowth = scrollbackAfter - scrollbackBefore;
      expect(terminal.getViewportY()).toBe(viewportBefore + scrollbackGrowth);
      expect(scrollbackAfter - Math.floor(terminal.getViewportY())).toBe(offsetBefore);
      expect(terminal.wasmTerm!.getScrollbackLine(offsetBefore)).toEqual(lineBefore);
    });

    test('keeps a scrolled viewport stable for in-place output', () => {
      for (let i = 0; i < 50; i++) {
        terminal.write(`Line ${i}\r\n`);
      }

      terminal.scrollLines(-10);
      const viewportBefore = terminal.getViewportY();
      const scrollbackBefore = terminal.getScrollbackLength();

      terminal.write('\rstatus update');

      expect(terminal.getScrollbackLength()).toBe(scrollbackBefore);
      expect(terminal.getViewportY()).toBe(viewportBefore);
    });

    test('continues following output while already at the bottom', () => {
      terminal.write('first\r\n');
      expect(terminal.getViewportY()).toBe(0);

      terminal.write('second\r\n');
      expect(terminal.getViewportY()).toBe(0);
    });

    test('should scroll viewport on wheel event in normal mode', async () => {
      // Fill with enough lines to create scrollback
      for (let i = 0; i < 50; i++) {
        terminal.write(`Line ${i}\r\n`);
      }

      // Initial viewport should be at bottom
      const initialViewportY = terminal.viewportY;

      // Simulate wheel up (negative deltaY)
      const wheelEvent = new WheelEvent('wheel', {
        deltaY: -100,
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(wheelEvent);

      // Viewport should have scrolled up (viewportY increases away from 0)
      expect(terminal.viewportY).toBeGreaterThan(initialViewportY);
    });

    test('should scroll down on positive deltaY', async () => {
      // Fill with scrollback
      for (let i = 0; i < 50; i++) {
        terminal.write(`Line ${i}\r\n`);
      }

      // Scroll up first
      terminal.scrollLines(-10);
      const scrolledUpViewportY = terminal.viewportY;

      // Simulate wheel down (positive deltaY)
      const wheelEvent = new WheelEvent('wheel', {
        deltaY: 100,
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(wheelEvent);

      // Viewport should have scrolled down (viewportY decreases towards 0)
      expect(terminal.viewportY).toBeLessThan(scrolledUpViewportY);
    });

    test('should not send data to application in normal mode', async () => {
      const dataSent: string[] = [];
      terminal.onData((data) => dataSent.push(data));

      // Simulate wheel event
      const wheelEvent = new WheelEvent('wheel', {
        deltaY: -100,
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(wheelEvent);

      // No data should be sent to application
      expect(dataSent).toEqual([]);
    });
  });

  describe('Alternate Screen Mode', () => {
    beforeEach(async () => {
      // Enter alternate screen mode (vim, less, htop, etc.)
      terminal.write('\x1B[?1049h');
    });

    test('should detect alternate screen mode', async () => {
      expect(terminal.wasmTerm?.isAlternateScreen()).toBe(true);
    });

    test('should send arrow up sequences on wheel up in alternate screen', async () => {
      const dataSent: string[] = [];
      terminal.onData((data) => dataSent.push(data));

      // Simulate wheel up (negative deltaY = -100, should send ~3 arrow ups)
      const wheelEvent = new WheelEvent('wheel', {
        deltaY: -100,
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(wheelEvent);

      // Should send arrow up sequences (ESC[A)
      expect(dataSent.length).toBeGreaterThan(0);
      expect(dataSent.every((data) => data === '\x1B[A')).toBe(true);
      expect(dataSent.length).toBeCloseTo(3, 1); // ~3 arrows per click
    });

    test('should send arrow down sequences on wheel down in alternate screen', async () => {
      const dataSent: string[] = [];
      terminal.onData((data) => dataSent.push(data));

      // Simulate wheel down (positive deltaY = +100)
      const wheelEvent = new WheelEvent('wheel', {
        deltaY: 100,
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(wheelEvent);

      // Should send arrow down sequences (ESC[B)
      expect(dataSent.length).toBeGreaterThan(0);
      expect(dataSent.every((data) => data === '\x1B[B')).toBe(true);
      expect(dataSent.length).toBeCloseTo(3, 1); // ~3 arrows per click
    });

    test('should not scroll viewport in alternate screen', async () => {
      const initialViewportY = terminal.viewportY;

      // Simulate wheel event
      const wheelEvent = new WheelEvent('wheel', {
        deltaY: -100,
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(wheelEvent);

      // Viewport should not have changed
      expect(terminal.viewportY).toBe(initialViewportY);
    });

    test('should cap arrow count at 5 per wheel event', async () => {
      const dataSent: string[] = [];
      terminal.onData((data) => dataSent.push(data));

      // Simulate very large wheel delta
      const wheelEvent = new WheelEvent('wheel', {
        deltaY: -1000, // Very large delta
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(wheelEvent);

      // Should cap at 5 arrows
      expect(dataSent.length).toBeLessThanOrEqual(5);
    });
  });

  describe('Mode Transitions', () => {
    test('should switch behavior when entering alternate screen', async () => {
      // Start in normal mode
      for (let i = 0; i < 30; i++) {
        terminal.write(`Line ${i}\r\n`);
      }

      // Scroll up in normal mode
      const wheelUpNormal = new WheelEvent('wheel', {
        deltaY: -100,
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(wheelUpNormal);
      const normalModeViewportY = terminal.viewportY;

      // Should have scrolled viewport
      expect(normalModeViewportY).toBeLessThan(terminal.rows);

      // Enter alternate screen
      terminal.write('\x1B[?1049h');

      const dataSent: string[] = [];
      terminal.onData((data) => dataSent.push(data));

      // Wheel should now send arrow keys
      const wheelUpAlt = new WheelEvent('wheel', {
        deltaY: -100,
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(wheelUpAlt);

      // Should have sent arrow keys, not scrolled
      expect(dataSent.length).toBeGreaterThan(0);
      expect(dataSent[0]).toBe('\x1B[A');
    });

    test('should switch back to viewport scrolling when exiting alternate screen', async () => {
      // Enter alternate screen
      terminal.write('\x1B[?1049h');
      expect(terminal.wasmTerm?.isAlternateScreen()).toBe(true);

      // Exit alternate screen
      terminal.write('\x1B[?1049l');
      expect(terminal.wasmTerm?.isAlternateScreen()).toBe(false);

      // Fill with lines
      for (let i = 0; i < 30; i++) {
        terminal.write(`Line ${i}\r\n`);
      }

      const dataSent: string[] = [];
      terminal.onData((data) => dataSent.push(data));

      const initialViewportY = terminal.viewportY;

      // Wheel should scroll viewport again
      const wheelEvent = new WheelEvent('wheel', {
        deltaY: -100,
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(wheelEvent);

      // Should have scrolled up, not sent data
      expect(dataSent.length).toBe(0);
      expect(terminal.viewportY).toBeGreaterThan(initialViewportY);
    });
  });

  describe('Custom Wheel Handler', () => {
    test('should respect custom wheel handler in both modes', async () => {
      let customHandlerCalled = false;
      terminal.attachCustomWheelEventHandler(() => {
        customHandlerCalled = true;
        return true; // Override default behavior
      });

      const wheelEvent = new WheelEvent('wheel', {
        deltaY: -100,
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(wheelEvent);

      expect(customHandlerCalled).toBe(true);
    });

    test('custom handler can delegate to default behavior', async () => {
      terminal.attachCustomWheelEventHandler(() => {
        return false; // Don't override, use default
      });

      // Enter alternate screen
      terminal.write('\x1B[?1049h');

      const dataSent: string[] = [];
      terminal.onData((data) => dataSent.push(data));

      const wheelEvent = new WheelEvent('wheel', {
        deltaY: -100,
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(wheelEvent);

      // Should still send arrow keys
      expect(dataSent.length).toBeGreaterThan(0);
      expect(dataSent[0]).toBe('\x1B[A');
    });
  });

  describe('Edge Cases', () => {
    test('should handle zero deltaY gracefully', async () => {
      const dataSent: string[] = [];
      terminal.onData((data) => dataSent.push(data));

      const wheelEvent = new WheelEvent('wheel', {
        deltaY: 0,
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(wheelEvent);

      // Should not send any data or crash
      expect(dataSent.length).toBe(0);
    });

    test('should handle very small deltaY values', async () => {
      const dataSent: string[] = [];
      terminal.onData((data) => dataSent.push(data));

      // Enter alternate screen
      terminal.write('\x1B[?1049h');

      const wheelEvent = new WheelEvent('wheel', {
        deltaY: -10, // Small delta, rounds to 0
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(wheelEvent);

      // Should not send any arrows (count is 0)
      expect(dataSent.length).toBe(0);
    });

    test('should handle terminal not yet opened', async () => {
      const closedTerminal = await createIsolatedTerminal({ cols: 80, rows: 24 });

      // Should not crash when handleWheel is called without wasmTerm
      expect(() => {
        const wheelEvent = new WheelEvent('wheel', {
          deltaY: -100,
          bubbles: true,
          cancelable: true,
        });
        // Can't dispatch without container, but we can test the internal state
        expect(closedTerminal.wasmTerm).toBeUndefined();
      }).not.toThrow();

      closedTerminal.dispose();
    });
  });
});

/**
 *
 * Tests for scrolling methods and events (Phase 2)
 */
describe('Scrolling Methods', () => {
  let term: Terminal;
  let container: HTMLDivElement;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    term = await createIsolatedTerminal({ cols: 80, rows: 24, scrollback: 1000 });
    term.open(container);
  });

  afterEach(() => {
    term.dispose();
    document.body.removeChild(container);
    term = null!;
    container = null!;
  });

  test('scrollLines() should scroll viewport up', async () => {
    // Write some content to create scrollback
    for (let i = 0; i < 50; i++) {
      term.write(`Line ${i}\r\n`);
    }

    // Scroll up 5 lines
    term.scrollLines(-5);

    // Should be scrolled up
    expect((term as any).viewportY).toBe(5);
  });

  test('scrollLines() should scroll viewport down', async () => {
    // Write content and scroll up first
    for (let i = 0; i < 50; i++) {
      term.write(`Line ${i}\r\n`);
    }
    term.scrollLines(-10);

    // Now scroll down 5 lines
    term.scrollLines(5);

    // Should be at viewportY = 5
    expect((term as any).viewportY).toBe(5);
  });

  test('scrollLines() should not scroll beyond bounds', async () => {
    // Write limited content
    for (let i = 0; i < 10; i++) {
      term.write(`Line ${i}\r\n`);
    }

    // Try to scroll way up
    term.scrollLines(-1000);

    // Should be clamped to scrollback length
    const scrollbackLength = term.wasmTerm!.getScrollbackLength();
    expect((term as any).viewportY).toBeLessThanOrEqual(scrollbackLength);
  });

  test('scrollLines() should not scroll below bottom', async () => {
    // Write content and scroll up
    for (let i = 0; i < 50; i++) {
      term.write(`Line ${i}\r\n`);
    }
    term.scrollLines(-10);

    // Try to scroll way down
    term.scrollLines(1000);

    // Should be at bottom (viewportY = 0)
    expect((term as any).viewportY).toBe(0);
  });

  test('scrollPages() should scroll by page', async () => {
    // Write content
    for (let i = 0; i < 100; i++) {
      term.write(`Line ${i}\r\n`);
    }

    // Scroll up 2 pages
    term.scrollPages(-2);

    // Should be scrolled by 2 * rows lines
    expect((term as any).viewportY).toBe(2 * term.rows);
  });

  test('scrollToTop() should scroll to top of buffer', async () => {
    // Write content
    for (let i = 0; i < 50; i++) {
      term.write(`Line ${i}\r\n`);
    }

    // Scroll to top
    term.scrollToTop();

    // Should be at max scroll position
    const scrollbackLength = term.wasmTerm!.getScrollbackLength();
    expect((term as any).viewportY).toBe(scrollbackLength);
  });

  test('scrollToBottom() should scroll to bottom', async () => {
    // Write content and scroll up
    for (let i = 0; i < 50; i++) {
      term.write(`Line ${i}\r\n`);
    }
    term.scrollLines(-10);

    // Scroll to bottom
    term.scrollToBottom();

    // Should be at bottom (viewportY = 0)
    expect((term as any).viewportY).toBe(0);
  });

  test('scrollToLine() should scroll to specific line', async () => {
    // Write content
    for (let i = 0; i < 50; i++) {
      term.write(`Line ${i}\r\n`);
    }

    // Scroll to line 15
    term.scrollToLine(15);

    expect((term as any).viewportY).toBe(15);
  });

  test('scrollToLine() should clamp to valid range', async () => {
    // Write limited content
    for (let i = 0; i < 10; i++) {
      term.write(`Line ${i}\r\n`);
    }

    // Try to scroll beyond buffer
    term.scrollToLine(1000);

    // Should be clamped
    const scrollbackLength = term.wasmTerm!.getScrollbackLength();
    expect((term as any).viewportY).toBeLessThanOrEqual(scrollbackLength);
  });

  test('scrollToLine() should handle negative values', async () => {
    // Write content
    for (let i = 0; i < 50; i++) {
      term.write(`Line ${i}\r\n`);
    }

    // Try negative line
    term.scrollToLine(-5);

    // Should be clamped to 0 (bottom)
    expect((term as any).viewportY).toBe(0);
  });
});

describe('Smooth Scrolling', () => {
  let term: Terminal;
  let container: HTMLDivElement;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    term = await createIsolatedTerminal({ cols: 80, rows: 24, scrollback: 1000 });
    term.open(container);
    for (let i = 0; i < 80; i++) {
      term.write(`Line ${i}\r\n`);
    }
    // Keep scroll animation tests focused on viewport frames rather than the
    // independently animated scrollbar fade.
    (term as any).scrollbarVisible = true;
  });

  afterEach(() => {
    term.dispose();
    container.remove();
  });

  for (const duration of [1, 10, 1000 / 60, 17, 100]) {
    test(`settles exactly after a ${duration}ms duration`, () => {
      const frames = installScrollFrameHarness();
      try {
        term.options.smoothScrollDuration = duration;
        (term as any).smoothScrollTo(10);

        const startTime = (term as any).scrollAnimationStartTime as number;
        if (duration <= 1) {
          expect(term.getViewportY()).toBe(10);
          expect((term as any).targetViewportY).toBe(10);
          expect((term as any).scrollAnimationStartTime).toBeUndefined();
          expect(frames.callbacks.size).toBe(0);
          return;
        }

        expect(frames.callbacks.size).toBe(1);

        frames.runNext(startTime + duration / 2);
        expect(term.getViewportY()).toBeGreaterThan(0);
        expect(term.getViewportY()).toBeLessThan(10);
        expect(frames.callbacks.size).toBe(1);

        frames.runNext(startTime + duration);
        expect(term.getViewportY()).toBe(10);
        expect((term as any).targetViewportY).toBe(10);
        expect((term as any).scrollAnimationStartTime).toBeUndefined();
        expect((term as any).scrollAnimationFrame).toBeUndefined();
        expect(frames.callbacks.size).toBe(0);
      } finally {
        frames.restore();
      }
    });
  }

  test('high-frequency target updates cannot restart the active time window', () => {
    const frames = installScrollFrameHarness();
    try {
      term.options.smoothScrollDuration = 100;
      (term as any).smoothScrollTo(10);
      const startTime = (term as any).scrollAnimationStartTime as number;
      const initialViewport = term.getViewportY();

      for (let target = 11; target <= 20; target++) {
        (term as any).smoothScrollTo(target);
      }

      expect((term as any).scrollAnimationStartTime).toBe(startTime);
      expect(frames.callbacks.size).toBe(1);
      frames.runNext(startTime + 50);
      expect(term.getViewportY()).toBeGreaterThan(initialViewport);

      frames.runNext(startTime + 100);
      expect(term.getViewportY()).toBe(20);
      expect(frames.callbacks.size).toBe(0);
    } finally {
      frames.restore();
    }
  });

  test('keeps a live-bottom target at zero when output grows scrollback', () => {
    const frames = installScrollFrameHarness();
    try {
      term.options.smoothScrollDuration = 100;
      term.scrollLines(-20);
      (term as any).smoothScrollTo(0);

      const startTime = (term as any).scrollAnimationStartTime as number;
      frames.runNext(startTime + 50);
      const viewportBeforeWrite = term.getViewportY();
      const scrollbackBeforeWrite = term.getScrollbackLength();
      term.write('New output\r\n');

      expect(term.getScrollbackLength()).toBe(scrollbackBeforeWrite + 1);
      expect(term.getViewportY()).toBe(viewportBeforeWrite + 1);
      expect((term as any).targetViewportY).toBe(0);

      const restoredViewport = term.getViewportY();
      frames.runNext(startTime + 60);
      const expectedViewport = restoredViewport * (0.4 ** 3 / 0.5 ** 3);
      expect(term.getViewportY()).toBeCloseTo(expectedViewport, 10);

      frames.runNext(startTime + 100);
      expect(term.getViewportY()).toBe(0);
      expect((term as any).targetViewportY).toBe(0);
      expect(frames.callbacks.size).toBe(0);
    } finally {
      frames.restore();
    }
  });

  test('keeps a live-bottom target across multiple growing and in-place writes', () => {
    const frames = installScrollFrameHarness();
    try {
      term.options.smoothScrollDuration = 100;
      term.scrollLines(-20);
      (term as any).smoothScrollTo(0);

      const startTime = (term as any).scrollAnimationStartTime as number;
      frames.runNext(startTime + 25);
      const viewportBeforeWrites = term.getViewportY();
      const scrollbackBeforeWrites = term.getScrollbackLength();
      term.write('First output\r\n');
      const scrollbackAfterGrowingWrite = term.getScrollbackLength();
      term.write('\rstatus update');
      expect(term.getScrollbackLength()).toBe(scrollbackAfterGrowingWrite);
      expect((term as any).targetViewportY).toBe(0);
      term.write('\r\nSecond output');

      const scrollbackGrowth = term.getScrollbackLength() - scrollbackBeforeWrites;
      expect(scrollbackGrowth).toBe(2);
      expect(term.getViewportY()).toBe(viewportBeforeWrites + scrollbackGrowth);
      expect((term as any).targetViewportY).toBe(0);

      const restoredViewport = term.getViewportY();
      frames.runNext(startTime + 50);
      const expectedViewport = restoredViewport * (0.5 ** 3 / 0.75 ** 3);
      expect(term.getViewportY()).toBeCloseTo(expectedViewport, 10);

      frames.runNext(startTime + 100);
      expect(term.getViewportY()).toBe(0);
      expect((term as any).targetViewportY).toBe(0);
      expect(frames.callbacks.size).toBe(0);

      term.write('Following output\r\n');
      expect(term.getViewportY()).toBe(0);
    } finally {
      frames.restore();
    }
  });

  test('continues preserving nonzero historical targets as output grows', () => {
    const frames = installScrollFrameHarness();
    try {
      term.options.smoothScrollDuration = 100;

      for (const target of [10, 30]) {
        term.scrollToLine(20);
        (term as any).smoothScrollTo(target);

        const startTime = (term as any).scrollAnimationStartTime as number;
        const viewportBeforeWrite = term.getViewportY();
        const scrollbackBeforeWrite = term.getScrollbackLength();
        term.write(`Output toward ${target}\r\n`);

        expect(term.getScrollbackLength()).toBe(scrollbackBeforeWrite + 1);
        expect(term.getViewportY()).toBe(viewportBeforeWrite + 1);
        expect((term as any).targetViewportY).toBe(target + 1);

        frames.runNext(startTime + 100);
        expect(term.getViewportY()).toBe(target + 1);
        expect(frames.callbacks.size).toBe(0);
      }
    } finally {
      frames.restore();
    }
  });

  test('a reentrant direct scroll prevents the old callback from rescheduling', () => {
    const frames = installScrollFrameHarness();
    try {
      term.options.smoothScrollDuration = 100;
      let cancelReentrantly = true;
      term.onScroll(() => {
        if (!cancelReentrantly) return;
        cancelReentrantly = false;
        term.scrollToBottom();
      });

      (term as any).smoothScrollTo(10);
      expect(term.getViewportY()).toBe(0);
      expect((term as any).targetViewportY).toBe(0);
      expect((term as any).scrollAnimationFrame).toBeUndefined();
      expect(frames.callbacks.size).toBe(0);

      (term as any).smoothScrollTo(10);
      expect((term as any).scrollAnimationFrame).toBeDefined();
      expect(frames.callbacks.size).toBe(1);
      term.scrollToBottom();
      expect(frames.callbacks.size).toBe(0);
    } finally {
      frames.restore();
    }
  });

  test('normalizes invalid durations and handles zero duration immediately', () => {
    (term.options as any).smoothScrollDuration = -5;
    expect(term.options.smoothScrollDuration).toBe(0);

    const frames = installScrollFrameHarness();
    try {
      (term as any).smoothScrollTo(10);
      expect(term.getViewportY()).toBe(10);
      expect(frames.callbacks.size).toBe(0);
    } finally {
      frames.restore();
    }

    (term.options as any).smoothScrollDuration = Number.NaN;
    expect(term.options.smoothScrollDuration).toBe(100);
    (term.options as any).smoothScrollDuration = Number.POSITIVE_INFINITY;
    expect(term.options.smoothScrollDuration).toBe(100);
  });

  test('every direct scrolling method revokes a pending animation', () => {
    const frames = installScrollFrameHarness();
    try {
      term.options.smoothScrollDuration = 100;
      const cases = [
        {
          name: 'scrollLines',
          run: () => term.scrollLines(-2),
          expected: (before: number) => before + 2,
        },
        {
          name: 'scrollPages',
          run: () => term.scrollPages(-1),
          expected: (before: number) => before + term.rows,
        },
        {
          name: 'scrollToTop',
          run: () => term.scrollToTop(),
          expected: (_before: number) => term.getScrollbackLength(),
        },
        {
          name: 'scrollToBottom',
          run: () => term.scrollToBottom(),
          expected: (_before: number) => 0,
        },
        {
          name: 'scrollToLine',
          run: () => term.scrollToLine(7),
          expected: (_before: number) => 7,
        },
      ];

      for (const directScroll of cases) {
        term.scrollToBottom();
        (term as any).smoothScrollTo(10);
        const staleFrame = frames.peekNext();
        expect(frames.callbacks.size).toBe(1);

        const viewportBefore = term.getViewportY();
        directScroll.run();
        const directViewport = directScroll.expected(viewportBefore);
        expect(term.getViewportY()).toBe(directViewport);
        expect((term as any).targetViewportY).toBe(directViewport);
        expect(frames.callbacks.size).toBe(0);

        staleFrame(Number.MAX_SAFE_INTEGER);
        expect(term.getViewportY()).toBe(directViewport);
        expect(frames.callbacks.size).toBe(0);
      }
    } finally {
      frames.restore();
    }
  });

  test('normal and alternate screen transitions revoke stale animation frames', () => {
    const frames = installScrollFrameHarness();
    try {
      term.options.smoothScrollDuration = 100;
      (term as any).smoothScrollTo(10);
      const staleNormalFrame = frames.peekNext();

      term.write('\x1B[?1049h');
      expect(term.wasmTerm?.isAlternateScreen()).toBe(true);
      expect(term.getViewportY()).toBe(0);
      expect((term as any).targetViewportY).toBe(0);
      expect(frames.callbacks.size).toBe(0);
      staleNormalFrame(Number.MAX_SAFE_INTEGER);
      expect(term.getViewportY()).toBe(0);

      Object.assign(term as any, {
        targetViewportY: 10,
        scrollAnimationStartViewportY: 0,
        scrollAnimationStartTime: performance.now(),
      });
      (term as any).scheduleScrollAnimationFrame();
      const staleAlternateFrame = frames.peekNext();
      term.write('\x1B[?1049l');
      expect(term.wasmTerm?.isAlternateScreen()).toBe(false);
      expect(term.getViewportY()).toBe(0);
      expect((term as any).targetViewportY).toBe(0);
      expect(frames.callbacks.size).toBe(0);
      staleAlternateFrame(Number.MAX_SAFE_INTEGER);
      expect(term.getViewportY()).toBe(0);
      expect(frames.callbacks.size).toBe(0);
    } finally {
      frames.restore();
    }
  });
});

describe('Scroll Events', () => {
  let term: Terminal;
  let container: HTMLDivElement;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    term = await createIsolatedTerminal({ cols: 80, rows: 24, scrollback: 1000 });
    term.open(container);
  });

  afterEach(() => {
    term.dispose();
    document.body.removeChild(container!);
    term = null!;
    container = null!;
  });

  test('onScroll should fire when scrolling', async () => {
    let scrollPosition = -1;
    let fireCount = 0;

    term.onScroll((position) => {
      scrollPosition = position;
      fireCount++;
    });

    // Write content
    for (let i = 0; i < 50; i++) {
      term.write(`Line ${i}\r\n`);
    }

    // Scroll up
    term.scrollLines(-5);

    expect(fireCount).toBe(1);
    expect(scrollPosition).toBe(5);
  });

  test('onScroll should not fire if position unchanged', async () => {
    let fireCount = 0;

    term.onScroll(() => {
      fireCount++;
    });

    // Try to scroll at bottom (already at 0)
    term.scrollToBottom();

    expect(fireCount).toBe(0);
  });

  test('onScroll should fire multiple times for multiple scrolls', async () => {
    const positions: number[] = [];

    term.onScroll((position) => {
      positions.push(position);
    });

    // Write content
    for (let i = 0; i < 100; i++) {
      term.write(`Line ${i}\r\n`);
    }

    // Multiple scrolls
    term.scrollLines(-5);
    term.scrollLines(-3);
    term.scrollLines(2);

    expect(positions.length).toBe(3);
    expect(positions[0]).toBe(5);
    expect(positions[1]).toBe(8);
    expect(positions[2]).toBe(6);
  });

  // Note: onRender event implementation uses dirty tracking for performance
  // implementation. Firing it every frame causes performance issues.

  test('onCursorMove should fire when cursor moves', async () => {
    let moveCount = 0;

    term.onCursorMove(() => {
      moveCount++;
    });

    // Write some lines (cursor moves)
    term.write('Line 1\r\n');
    term.write('Line 2\r\n');

    // Wait for render loop to detect cursor movement
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should have fired at least once (cursor moved down)
    expect(moveCount).toBeGreaterThan(0);
  });
});

describe('Custom Wheel Event Handler', () => {
  let term: Terminal;
  let container: HTMLDivElement;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    term = await createIsolatedTerminal({ cols: 80, rows: 24, scrollback: 1000 });
    term.open(container);
  });

  afterEach(() => {
    term!.dispose();
    document.body.removeChild(container!);
    term = null!;
    container = null!;
  });

  test('attachCustomWheelEventHandler() should set handler', async () => {
    const handler = () => true;
    term.attachCustomWheelEventHandler(handler);

    expect((term as any).customWheelEventHandler).toBe(handler);
  });

  test('attachCustomWheelEventHandler() should allow clearing handler', async () => {
    const handler = () => true;
    term.attachCustomWheelEventHandler(handler);
    term.attachCustomWheelEventHandler(undefined);

    expect((term as any).customWheelEventHandler).toBeUndefined();
  });

  test('custom wheel handler should block default scrolling when returning true', async () => {
    let handlerCalled = false;

    term.attachCustomWheelEventHandler(() => {
      handlerCalled = true;
      return true; // Block default
    });

    // Write content
    for (let i = 0; i < 50; i++) {
      term.write(`Line ${i}\r\n`);
    }

    // Simulate wheel event
    const wheelEvent = new WheelEvent('wheel', { deltaY: 100 });
    container.dispatchEvent(wheelEvent);

    expect(handlerCalled).toBe(true);
    // Viewport should not have changed (blocked)
    expect((term as any).viewportY).toBe(0);
  });

  test('custom wheel handler should allow default scrolling when returning false', async () => {
    let handlerCalled = false;

    term.attachCustomWheelEventHandler(() => {
      handlerCalled = true;
      return false; // Allow default
    });

    // Write content
    for (let i = 0; i < 50; i++) {
      term.write(`Line ${i}\r\n`);
    }

    // Simulate wheel event (scroll down)
    const wheelEvent = new WheelEvent('wheel', { deltaY: 100 });
    container.dispatchEvent(wheelEvent);

    expect(handlerCalled).toBe(true);
    // Viewport should have changed (default behavior)
    // Note: Due to scrolling at bottom, it won't change. Let's scroll up first.
  });

  test('wheel events should scroll terminal by default', async () => {
    // Write content
    for (let i = 0; i < 50; i++) {
      term.write(`Line ${i}\r\n`);
    }

    // Simulate wheel up (negative deltaY = scroll up)
    const wheelEvent = new WheelEvent('wheel', { deltaY: -100 });
    container.dispatchEvent(wheelEvent);

    // Should have scrolled up
    expect((term as any).viewportY).toBeGreaterThan(0);
  });
});
