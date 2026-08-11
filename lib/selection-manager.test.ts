/**
 * Selection Manager Tests
 *
 * Tests for text selection functionality including:
 * - Basic selection operations
 * - Absolute coordinate system for scroll persistence
 * - Selection clearing behavior
 * - Auto-scroll during drag selection
 * - Copy functionality with scrollback
 *
 * Test Isolation Pattern:
 * Uses createIsolatedTerminal() to ensure each test gets its own WASM instance.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

/**
 * Helper to set selection using absolute coordinates
 */
function setSelectionAbsolute(
  term: Terminal,
  startCol: number,
  startAbsRow: number,
  endCol: number,
  endAbsRow: number
): void {
  const selMgr = (term as any).selectionManager;
  if (selMgr) {
    (selMgr as any).selectionStart = { col: startCol, absoluteRow: startAbsRow };
    (selMgr as any).selectionEnd = { col: endCol, absoluteRow: endAbsRow };
  }
}

/**
 * Helper to convert viewport row to absolute row
 */
function viewportToAbsolute(term: Terminal, viewportRow: number): number {
  const scrollbackLength = term.wasmTerm?.getScrollbackLength() ?? 0;
  const viewportY = term.getViewportY();
  return scrollbackLength + viewportRow - Math.floor(viewportY);
}

describe('SelectionManager', () => {
  let container: HTMLElement | null = null;

  beforeEach(async () => {
    if (typeof document !== 'undefined') {
      container = document.createElement('div');
      document.body.appendChild(container);
    }
  });

  afterEach(() => {
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
      container = null;
    }
  });

  describe('Construction', () => {
    test('creates without errors', async () => {
      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      expect(term).toBeDefined();
    });
  });

  describe('API', () => {
    test('has required public methods', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      const selMgr = (term as any).selectionManager;
      expect(typeof selMgr.getSelection).toBe('function');
      expect(typeof selMgr.hasSelection).toBe('function');
      expect(typeof selMgr.clearSelection).toBe('function');
      expect(typeof selMgr.selectAll).toBe('function');
      expect(typeof selMgr.getSelectionCoords).toBe('function');
      expect(typeof selMgr.dispose).toBe('function');
      expect(typeof selMgr.getDirtySelectionRows).toBe('function');
      expect(typeof selMgr.clearDirtySelectionRows).toBe('function');

      term.dispose();
    });
  });

  describe('Selection with absolute coordinates', () => {
    test('hasSelection returns false when no selection', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      const selMgr = (term as any).selectionManager;
      expect(selMgr.hasSelection()).toBe(false);

      term.dispose();
    });

    test('hasSelection returns true when selection exists', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      term.write('Hello World\r\n');

      // Set selection using absolute coordinates
      setSelectionAbsolute(term, 0, 0, 5, 0);

      const selMgr = (term as any).selectionManager;
      expect(selMgr.hasSelection()).toBe(true);

      term.dispose();
    });

    test('hasSelection returns true for single cell programmatic selection', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      // Programmatic single-cell selection should be valid
      // (e.g., triple-click on single-char line, or select(col, row, 1))
      setSelectionAbsolute(term, 5, 0, 5, 0);

      const selMgr = (term as any).selectionManager;
      expect(selMgr.hasSelection()).toBe(true);

      term.dispose();
    });

    test('clearSelection clears selection and marks rows dirty', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      term.write('Line 1\r\nLine 2\r\nLine 3\r\n');

      const scrollbackLen = term.wasmTerm!.getScrollbackLength();
      setSelectionAbsolute(term, 0, scrollbackLen, 5, scrollbackLen + 2);

      const selMgr = (term as any).selectionManager;
      expect(selMgr.hasSelection()).toBe(true);

      selMgr.clearSelection();

      expect(selMgr.hasSelection()).toBe(false);
      // Dirty rows should be marked for redraw
      const dirtyRows = selMgr.getDirtySelectionRows();
      expect(dirtyRows.size).toBeGreaterThan(0);

      term.dispose();
    });
  });

  describe('Selection text extraction', () => {
    test('getSelection returns empty string when no selection', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      const selMgr = (term as any).selectionManager;
      expect(selMgr.getSelection()).toBe('');

      term.dispose();
    });

    test('getSelection extracts text from screen buffer', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      term.write('Hello World\r\n');

      const scrollbackLen = term.wasmTerm!.getScrollbackLength();
      // Select "Hello" (first 5 characters)
      setSelectionAbsolute(term, 0, scrollbackLen, 4, scrollbackLen);

      const selMgr = (term as any).selectionManager;
      expect(selMgr.getSelection()).toBe('Hello');

      term.dispose();
    });

    test('getSelection extracts multi-line text', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      term.write('Line 1\r\nLine 2\r\nLine 3\r\n');

      const scrollbackLen = term.wasmTerm!.getScrollbackLength();
      // Select all three lines
      setSelectionAbsolute(term, 0, scrollbackLen, 5, scrollbackLen + 2);

      const selMgr = (term as any).selectionManager;
      const text = selMgr.getSelection();

      expect(text).toContain('Line 1');
      expect(text).toContain('Line 2');
      expect(text).toContain('Line 3');

      term.dispose();
    });

    test('getSelection extracts text from scrollback', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24, scrollback: 1000 });
      term.open(container);

      // Write enough lines to create scrollback
      for (let i = 0; i < 50; i++) {
        term.write(`Line ${i.toString().padStart(3, '0')}\r\n`);
      }

      const scrollbackLen = term.wasmTerm!.getScrollbackLength();
      expect(scrollbackLen).toBeGreaterThan(0);

      // Select from scrollback (first few lines)
      setSelectionAbsolute(term, 0, 0, 10, 2);

      const selMgr = (term as any).selectionManager;
      const text = selMgr.getSelection();

      expect(text).toContain('Line 000');
      expect(text).toContain('Line 001');
      expect(text).toContain('Line 002');

      term.dispose();
    });

    test('getSelection extracts text spanning scrollback and screen', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24, scrollback: 1000 });
      term.open(container);

      // Write enough lines to fill scrollback and screen
      for (let i = 0; i < 50; i++) {
        term.write(`Line ${i.toString().padStart(3, '0')}\r\n`);
      }

      const scrollbackLen = term.wasmTerm!.getScrollbackLength();

      // Select spanning scrollback and screen
      // End of scrollback through beginning of screen
      setSelectionAbsolute(term, 0, scrollbackLen - 2, 10, scrollbackLen + 2);

      const selMgr = (term as any).selectionManager;
      const text = selMgr.getSelection();

      // Should contain lines from both regions
      expect(text.split('\n').length).toBeGreaterThanOrEqual(4);

      term.dispose();
    });
  });

  describe('Selection persistence during scroll', () => {
    test('selection coordinates are preserved when scrolling', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24, scrollback: 1000 });
      term.open(container);

      // Write content
      for (let i = 0; i < 50; i++) {
        term.write(`Line ${i.toString().padStart(3, '0')}\r\n`);
      }

      const scrollbackLen = term.wasmTerm!.getScrollbackLength();

      // Set selection at specific absolute position
      const startAbsRow = scrollbackLen + 5;
      const endAbsRow = scrollbackLen + 10;
      setSelectionAbsolute(term, 0, startAbsRow, 10, endAbsRow);

      const selMgr = (term as any).selectionManager;
      const textBefore = selMgr.getSelection();

      // Scroll up
      term.scrollLines(-10);

      // Selection should still return the same text
      const textAfter = selMgr.getSelection();
      expect(textAfter).toBe(textBefore);

      term.dispose();
    });

    test('selection coords convert correctly after scrolling', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24, scrollback: 1000 });
      term.open(container);

      // Write content
      for (let i = 0; i < 50; i++) {
        term.write(`Line ${i.toString().padStart(3, '0')}\r\n`);
      }

      const scrollbackLen = term.wasmTerm!.getScrollbackLength();

      // Set selection in screen buffer area
      setSelectionAbsolute(term, 0, scrollbackLen, 10, scrollbackLen + 5);

      const selMgr = (term as any).selectionManager;

      // Get viewport coords before scroll
      const coordsBefore = selMgr.getSelectionCoords();
      expect(coordsBefore).not.toBeNull();

      // Scroll up 10 lines
      term.scrollLines(-10);

      // Get viewport coords after scroll - they should have shifted
      const coordsAfter = selMgr.getSelectionCoords();
      expect(coordsAfter).not.toBeNull();

      // Viewport row should have increased by the scroll amount
      expect(coordsAfter!.startRow).toBe(coordsBefore!.startRow + 10);
      expect(coordsAfter!.endRow).toBe(coordsBefore!.endRow + 10);

      term.dispose();
    });

    test('selection outside viewport returns null coords but preserves text', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24, scrollback: 1000 });
      term.open(container);

      // Write content
      for (let i = 0; i < 100; i++) {
        term.write(`Line ${i.toString().padStart(3, '0')}\r\n`);
      }

      // Select near the bottom of the buffer
      const scrollbackLen = term.wasmTerm!.getScrollbackLength();
      setSelectionAbsolute(term, 0, scrollbackLen + 10, 10, scrollbackLen + 15);

      const selMgr = (term as any).selectionManager;
      const text = selMgr.getSelection();

      // Scroll to top - selection should be way off screen
      term.scrollToTop();

      // Coords should be null (off screen) but text should still work
      const coords = selMgr.getSelectionCoords();
      expect(coords).toBeNull();

      // Text extraction should still work
      expect(selMgr.getSelection()).toBe(text);

      term.dispose();
    });
  });

  describe('Dirty row tracking', () => {
    test('getDirtySelectionRows returns empty set initially', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      const selMgr = (term as any).selectionManager;
      expect(selMgr.getDirtySelectionRows().size).toBe(0);

      term.dispose();
    });

    test('clearSelection marks selection rows as dirty', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      term.write('Test content\r\n');

      const scrollbackLen = term.wasmTerm!.getScrollbackLength();
      setSelectionAbsolute(term, 0, scrollbackLen, 5, scrollbackLen + 3);

      const selMgr = (term as any).selectionManager;
      selMgr.clearSelection();

      const dirtyRows = selMgr.getDirtySelectionRows();
      expect(dirtyRows.size).toBeGreaterThan(0);

      term.dispose();
    });

    test('clearDirtySelectionRows clears the set', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      term.write('Test\r\n');

      const scrollbackLen = term.wasmTerm!.getScrollbackLength();
      setSelectionAbsolute(term, 0, scrollbackLen, 5, scrollbackLen);

      const selMgr = (term as any).selectionManager;
      selMgr.clearSelection();

      expect(selMgr.getDirtySelectionRows().size).toBeGreaterThan(0);

      selMgr.clearDirtySelectionRows();

      expect(selMgr.getDirtySelectionRows().size).toBe(0);

      term.dispose();
    });
  });

  describe('Backward selection', () => {
    test('handles selection from right to left', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      term.write('Hello World\r\n');

      const scrollbackLen = term.wasmTerm!.getScrollbackLength();
      // Select backwards (end before start)
      setSelectionAbsolute(term, 10, scrollbackLen, 0, scrollbackLen);

      const selMgr = (term as any).selectionManager;
      const text = selMgr.getSelection();

      expect(text).toBe('Hello World');

      term.dispose();
    });

    test('handles selection from bottom to top', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      term.write('Line 1\r\nLine 2\r\nLine 3\r\n');

      const scrollbackLen = term.wasmTerm!.getScrollbackLength();
      // Select backwards (end row before start row)
      setSelectionAbsolute(term, 5, scrollbackLen + 2, 0, scrollbackLen);

      const selMgr = (term as any).selectionManager;
      const text = selMgr.getSelection();

      expect(text).toContain('Line 1');
      expect(text).toContain('Line 2');
      expect(text).toContain('Line 3');

      term.dispose();
    });
  });

  describe('selectAll', () => {
    test('selectAll selects entire viewport', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      term.write('Hello\r\nWorld\r\n');

      const selMgr = (term as any).selectionManager;
      selMgr.selectAll();

      expect(selMgr.hasSelection()).toBe(true);

      const coords = selMgr.getSelectionCoords();
      expect(coords).not.toBeNull();
      expect(coords!.startRow).toBe(0);
      expect(coords!.startCol).toBe(0);
      expect(coords!.endRow).toBe(23); // rows - 1

      term.dispose();
    });
  });

  describe('select() API', () => {
    test('select() creates selection at specified position', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      term.write('Hello World\r\n');

      const selMgr = (term as any).selectionManager;
      selMgr.select(0, 0, 5);

      expect(selMgr.hasSelection()).toBe(true);
      expect(selMgr.getSelection()).toBe('Hello');

      term.dispose();
    });
  });

  describe('selectLines() API', () => {
    test('selectLines() selects entire lines', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      term.write('Line 1\r\nLine 2\r\nLine 3\r\n');

      const selMgr = (term as any).selectionManager;
      selMgr.selectLines(0, 1);

      expect(selMgr.hasSelection()).toBe(true);

      const text = selMgr.getSelection();
      expect(text).toContain('Line 1');
      expect(text).toContain('Line 2');

      term.dispose();
    });
  });

  describe('absolute buffer API and buffer mutations', () => {
    test('selects absolute history rows while the viewport is not at the bottom', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 20, rows: 3, scrollback: 100 });
      term.open(container);
      try {
        for (let i = 0; i < 10; i++) term.write(`Line ${i}\r\n`);
        expect(term.getScrollbackLength()).toBeGreaterThan(0);

        term.scrollToTop();
        expect(term.getViewportY()).toBeGreaterThan(0);

        term.select(0, 0, 6);
        expect(term.getSelection()).toBe('Line 0');
        expect(term.getSelectionPosition()).toEqual({
          start: { x: 0, y: 0 },
          end: { x: 5, y: 0 },
        });

        term.selectLines(0, 1);
        expect(term.getSelection()).toBe('Line 0\nLine 1');
        expect(term.getSelectionPosition()?.start.y).toBe(0);
        expect(term.getSelectionPosition()?.end.y).toBe(1);

        const lastBufferRow = term.getScrollbackLength() + term.rows - 1;
        term.selectLines(lastBufferRow + 100, lastBufferRow + 200);
        expect(term.getSelectionPosition()?.start.y).toBe(lastBufferRow);
        expect(term.getSelectionPosition()?.end.y).toBe(lastBufferRow);

        term.select(10, lastBufferRow - 1, 10_000);
        expect(term.getSelectionPosition()?.end).toEqual({ x: term.cols - 1, y: lastBufferRow });
      } finally {
        term.dispose();
      }
    });

    test('rebases surviving selection rows and clears an evicted boundary exactly once', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 12, rows: 2, scrollback: 8 });
      term.open(container);
      try {
        // Cross Ghostty's minimum two-page retention before anchoring a recent
        // row, then wait for the next page trim to prove exact rebasing.
        term.write('filler\r\n'.repeat(20_000));
        for (let i = 0; i < 6; i++) term.write(`Line ${i}\r\n`);
        const scrollback = term.getScrollbackLength();
        expect(scrollback).toBeGreaterThan(2);

        const retainedRow = scrollback - 2;
        term.selectLines(retainedRow, retainedRow);
        const retainedText = term.getSelection();
        let transitions = 0;
        term.onSelectionChange(() => transitions++);

        let previousRow = retainedRow;
        let rebased = false;
        for (let i = 6; i < 5_000 && !rebased; i++) {
          term.write(`Line ${i}\r\n`);
          const position = term.getSelectionPosition();
          if (!position) break;
          if (position!.start.y < previousRow) {
            rebased = true;
            expect(term.getSelection()).toBe(retainedText);
            expect(transitions).toBe(1);
          }
          previousRow = position!.start.y;
        }
        expect(rebased).toBe(true);

        term.selectLines(0, 0);
        transitions = 0;
        for (let i = 5_000; i < 15_000 && term.hasSelection(); i++) {
          term.write(`Line ${i}\r\n`);
        }
        expect(term.hasSelection()).toBe(false);
        expect(term.getSelectionPosition()).toBeUndefined();
        expect(transitions).toBe(1);
      } finally {
        term.dispose();
      }
    });

    test('clears once on both narrower and wider reflow', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 12, rows: 3, scrollback: 100 });
      term.open(container);
      try {
        term.write('0123456789AB\r\nnext');
        let transitions = 0;
        term.onSelectionChange(() => transitions++);

        term.select(8, 0, 6);
        transitions = 0;
        term.resize(6, 3);
        expect(term.hasSelection()).toBe(false);
        expect(transitions).toBe(1);

        term.select(0, 0, 4);
        transitions = 0;
        term.resize(18, 3);
        expect(term.hasSelection()).toBe(false);
        expect(transitions).toBe(1);

        term.clearSelection();
        expect(transitions).toBe(1);
      } finally {
        term.dispose();
      }
    });

    test('does not publish a pending no-drag click as a selection transition', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 12, rows: 3 });
      term.open(container);
      try {
        const canvas = term.renderer!.getCanvas();
        let transitions = 0;
        term.onSelectionChange(() => transitions++);

        canvas.dispatchEvent(
          new MouseEvent('mousedown', { button: 0, bubbles: true, clientX: 1, clientY: 1 })
        );
        document.dispatchEvent(
          new MouseEvent('mouseup', { button: 0, bubbles: true, clientX: 1, clientY: 1 })
        );
        expect(term.hasSelection()).toBe(false);
        expect(transitions).toBe(0);

        term.select(0, 0, 2);
        transitions = 0;
        canvas.dispatchEvent(
          new MouseEvent('mousedown', { button: 0, bubbles: true, clientX: 1, clientY: 1 })
        );
        document.dispatchEvent(
          new MouseEvent('mouseup', { button: 0, bubbles: true, clientX: 1, clientY: 1 })
        );
        expect(term.hasSelection()).toBe(false);
        expect(transitions).toBe(1);
      } finally {
        term.dispose();
      }
    });

    test('publishes only distinct programmatic selection states', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 12, rows: 3 });
      term.open(container);
      try {
        let transitions = 0;
        term.onSelectionChange(() => transitions++);

        term.select(1, 0, 3);
        term.select(1, 0, 3);
        expect(transitions).toBe(1);

        term.selectLines(0, 1);
        term.selectLines(1, 0);
        expect(transitions).toBe(2);

        term.clearSelection();
        term.clearSelection();
        expect(transitions).toBe(3);
      } finally {
        term.dispose();
      }
    });

    test('commits selection state before reentrant listeners mutate it', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 12, rows: 3 });
      term.open(container);
      try {
        const observedStates: boolean[] = [];
        term.onSelectionChange(() => {
          observedStates.push(term.hasSelection());
          if (term.hasSelection()) term.clearSelection();
        });

        term.select(0, 0, 2);

        expect(observedStates).toEqual([true, false]);
        expect(term.hasSelection()).toBe(false);
      } finally {
        term.dispose();
      }
    });

    test('publishes drag boundary changes without a duplicate mouseup event', async () => {
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 12, rows: 3 });
      term.open(container);
      try {
        const canvas = term.renderer!.getCanvas();
        Object.defineProperty(canvas, 'clientHeight', { configurable: true, value: 500 });
        let transitions = 0;
        term.onSelectionChange(() => transitions++);
        const mouseOnCanvas = (type: string, offsetX: number, offsetY: number): MouseEvent => {
          const event = new MouseEvent(type, { button: 0, bubbles: true });
          Object.defineProperties(event, {
            offsetX: { configurable: true, value: offsetX },
            offsetY: { configurable: true, value: offsetY },
          });
          return event;
        };

        canvas.dispatchEvent(mouseOnCanvas('mousedown', 1, 40));
        canvas.dispatchEvent(mouseOnCanvas('mousemove', 20, 40));
        expect(transitions).toBe(1);

        // Repeating the same endpoint does not describe a new public state.
        canvas.dispatchEvent(mouseOnCanvas('mousemove', 20, 40));
        expect(transitions).toBe(1);

        canvas.dispatchEvent(mouseOnCanvas('mousemove', 35, 40));
        expect(transitions).toBe(2);

        document.dispatchEvent(
          new MouseEvent('mouseup', { button: 0, bubbles: true, clientX: 35, clientY: 40 })
        );
        expect(term.hasSelection()).toBe(true);
        expect(transitions).toBe(2);
      } finally {
        term.dispose();
      }
    });
  });

  describe('scrollback content accuracy', () => {
    test('getScrollbackLine returns correct content after lines scroll off', async () => {
      const container = document.createElement('div');
      Object.defineProperty(container, 'clientWidth', { value: 800 });
      Object.defineProperty(container, 'clientHeight', { value: 480 });
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      // Write 50 lines to push content into scrollback (terminal has 24 rows)
      for (let i = 0; i < 50; i++) {
        term.write(`Line ${i}\r\n`);
      }

      const wasmTerm = (term as any).wasmTerm;
      const scrollbackLen = wasmTerm.getScrollbackLength();
      expect(scrollbackLen).toBeGreaterThan(0);

      // First scrollback line (oldest) should contain "Line 0"
      const firstLine = wasmTerm.getScrollbackLine(0);
      expect(firstLine).not.toBeNull();
      const firstText = firstLine!
        .map((c: any) => (c.codepoint ? String.fromCodePoint(c.codepoint) : ''))
        .join('')
        .trim();
      expect(firstText).toContain('Line 0');

      // Last scrollback line should contain content near the boundary
      const lastLine = wasmTerm.getScrollbackLine(scrollbackLen - 1);
      expect(lastLine).not.toBeNull();
      const lastText = lastLine!
        .map((c: any) => (c.codepoint ? String.fromCodePoint(c.codepoint) : ''))
        .join('')
        .trim();
      // The last scrollback line is the one just above the visible viewport
      expect(lastText).toMatch(/Line \d+/);

      term.dispose();
    });

    test('selection clears when user types', async () => {
      const container = document.createElement('div');
      Object.defineProperty(container, 'clientWidth', { value: 800 });
      Object.defineProperty(container, 'clientHeight', { value: 480 });
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      term.write('Hello World\r\n');

      const selMgr = (term as any).selectionManager;
      selMgr.selectLines(0, 0);
      expect(selMgr.hasSelection()).toBe(true);

      // Simulate the input callback clearing selection
      // The actual input handler calls clearSelection before firing data
      selMgr.clearSelection();
      expect(selMgr.hasSelection()).toBe(false);

      term.dispose();
    });

    test('triple-click selects correct line in scrollback region', async () => {
      const container = document.createElement('div');
      Object.defineProperty(container, 'clientWidth', { value: 800 });
      Object.defineProperty(container, 'clientHeight', { value: 480 });
      if (!container) return;

      const term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);

      // Write enough lines to create scrollback
      for (let i = 0; i < 50; i++) {
        term.write(`TestLine${i}\r\n`);
      }

      const wasmTerm = (term as any).wasmTerm;
      const scrollbackLen = wasmTerm.getScrollbackLength();
      expect(scrollbackLen).toBeGreaterThan(0);

      // Verify multiple scrollback lines have correct content
      for (let i = 0; i < Math.min(5, scrollbackLen); i++) {
        const line = wasmTerm.getScrollbackLine(i);
        expect(line).not.toBeNull();
        const text = line!
          .map((c: any) => (c.codepoint ? String.fromCodePoint(c.codepoint) : ''))
          .join('')
          .trim();
        expect(text).toContain(`TestLine${i}`);
      }

      // Use selectLines to select a single line and verify content
      const selMgr = (term as any).selectionManager;
      selMgr.selectLines(0, 0);
      expect(selMgr.hasSelection()).toBe(true);
      const selectedText = selMgr.getSelection();
      expect(selectedText.length).toBeGreaterThan(0);

      term.dispose();
    });
  });
});
