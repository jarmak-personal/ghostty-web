/**
 * Buffer API tests
 *
 * Test Isolation Pattern:
 * Uses createIsolatedTerminal() to ensure each test gets its own WASM instance.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

describe('Buffer API', () => {
  let term: Terminal | null = null;
  let container: HTMLElement | null = null;

  beforeEach(async () => {
    // Create a container element if document is available
    if (typeof document !== 'undefined') {
      container = document.createElement('div');
      document.body.appendChild(container);
      term = await createIsolatedTerminal({ cols: 80, rows: 24 });
      term.open(container);
    }
  });

  afterEach(() => {
    if (term) {
      term.dispose();
      term = null;
    }
    // Clean up container
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
      container = null;
    }
  });

  describe('BufferNamespace', () => {
    test('should have buffer property', () => {
      expect(term.buffer).toBeDefined();
    });

    test('should have active, normal, and alternate buffers', () => {
      expect(term.buffer.active).toBeDefined();
      expect(term.buffer.normal).toBeDefined();
      expect(term.buffer.alternate).toBeDefined();
    });

    test('active buffer should be normal by default', () => {
      expect(term.buffer.active.type).toBe('normal');
    });

    test('should switch to alternate buffer', () => {
      // Enter alternate screen (smcup)
      term.write('\x1b[?1049h');

      // Active buffer should now be alternate
      expect(term.buffer.active.type).toBe('alternate');
    });

    test('should switch back to normal buffer', () => {
      // Enter alternate screen
      term.write('\x1b[?1049h');
      expect(term.buffer.active.type).toBe('alternate');

      // Exit alternate screen (rmcup)
      term.write('\x1b[?1049l');
      expect(term.buffer.active.type).toBe('normal');
    });

    test('fires exactly once for each parser-owned screen transition', () => {
      const changes: string[] = [];
      const disposable = term.buffer.onBufferChange((buffer) => changes.push(buffer.type));

      for (const mode of ['47', '1047', '1049']) {
        term.write(`\x1b[?${mode}h\x1b[?${mode}h\x1b[?${mode}l\x1b[?${mode}l`);
      }

      expect(changes).toEqual([
        'alternate',
        'normal',
        'alternate',
        'normal',
        'alternate',
        'normal',
      ]);
      disposable.dispose();
    });

    test('preserves enter and reset transitions from the same write', () => {
      const changes: string[] = [];
      term.buffer.onBufferChange((buffer) => changes.push(buffer.type));

      term.write('\x1b[?1049h\x1bc');

      expect(changes).toEqual(['alternate', 'normal']);
    });

    test('retains every transition before reset and ignores no-op switches', () => {
      const changes: string[] = [];
      term.buffer.onBufferChange((buffer) => changes.push(buffer.type));

      term.write('\x1bc\x1b[?1049l');
      expect(changes).toEqual([]);

      term.write('\x1b[?1049h\x1b[?1049l\x1b[?1049h\x1bc');
      expect(changes).toEqual(['alternate', 'normal', 'alternate', 'normal']);
    });

    test('reconciles retained selection anchors before publishing screen transitions', () => {
      term.write('PRIMARY');
      term.select(0, 0, 7);
      expect(term.hasSelection()).toBe(true);

      const observed: Array<{ active: string; hasSelection: boolean }> = [];
      term.buffer.onBufferChange((buffer) => {
        observed.push({ active: buffer.type, hasSelection: term.hasSelection() });
      });

      term.write('\x1b[?1049h');

      expect(observed).toEqual([{ active: 'alternate', hasSelection: false }]);
      expect(term.hasSelection()).toBe(false);
    });

    test('keeps retained selection across balanced transitions in one write', () => {
      term.write('PRIMARY');
      term.select(0, 0, 7);
      const observed: Array<{ active: string; selection: string }> = [];
      term.buffer.onBufferChange((buffer) => {
        observed.push({ active: buffer.type, selection: term.getSelection() });
      });

      term.write('\x1b[?1049hALT\x1b[?1049l');

      expect(observed).toEqual([
        { active: 'alternate', selection: 'PRIMARY' },
        { active: 'normal', selection: 'PRIMARY' },
      ]);
      expect(term.getSelection()).toBe('PRIMARY');
    });
  });

  describe('Buffer', () => {
    test('should have correct type', () => {
      expect(term.buffer.normal.type).toBe('normal');
      expect(term.buffer.alternate.type).toBe('alternate');
    });

    test('should track cursor position', () => {
      term.write('Hello');
      const buffer = term.buffer.active;

      expect(buffer.cursorX).toBe(5);
      expect(buffer.cursorY).toBe(0);
    });

    test('should track cursor position after newline', () => {
      term.write('Hello\r\nWorld');
      const buffer = term.buffer.active;

      expect(buffer.cursorX).toBe(5);
      expect(buffer.cursorY).toBe(1);
    });

    test('should have correct length', () => {
      const buffer = term.buffer.normal;
      expect(buffer.length).toBeGreaterThanOrEqual(24);
    });

    test('should return null cell', () => {
      const buffer = term.buffer.active;
      const nullCell = buffer.getNullCell();

      expect(nullCell.getCode()).toBe(0);
      expect(nullCell.getChars()).toBe('');
      expect(nullCell.getWidth()).toBe(1);
    });

    test('represents a never-activated alternate buffer as empty', () => {
      const alternate = term.buffer.alternate;
      expect(alternate.length).toBe(term.rows);
      expect(alternate.cursorX).toBe(0);
      expect(alternate.cursorY).toBe(0);
      expect(alternate.getLine(0)?.translateToString(true)).toBe('');
      expect(alternate.getLine(term.rows)).toBeUndefined();
    });

    test('keeps normal and alternate contents and cursors independent', () => {
      term.write('PRIMARY');
      expect(term.buffer.normal.cursorX).toBe(7);

      term.write('\x1b[?1049h\x1b[HALT');

      expect(term.buffer.active.type).toBe('alternate');
      expect(term.buffer.normal.getLine(0)?.translateToString(true)).toBe('PRIMARY');
      expect(term.buffer.normal.cursorX).toBe(7);
      expect(term.buffer.alternate.getLine(0)?.translateToString(true)).toBe('ALT');
      expect(term.buffer.alternate.cursorX).toBe(3);

      term.write('\x1b[?1049l');
      expect(term.buffer.normal.getLine(0)?.translateToString(true)).toBe('PRIMARY');
      expect(term.buffer.alternate.getLine(0)?.translateToString(true)).toBe('ALT');
    });

    test('preserves graphemes, wide cells, and wraps while each screen is inactive', () => {
      term.write(`e\u0301👩‍💻\x1b[2;1H${'A'.repeat(80)}B`);
      term.write('\x1b[?1049h');

      const normalLine = term.buffer.normal.getLine(0)!;
      expect(normalLine.getCell(0)?.getChars()).toBe('e\u0301');
      expect(normalLine.getCell(1)?.getChars()).toBe('👩‍💻');
      expect(normalLine.getCell(1)?.getWidth()).toBe(2);
      expect(term.buffer.normal.getLine(2)?.isWrapped).toBe(true);

      term.write('\x1b[He\u0301👩‍💻');
      term.write('\x1b[?1049l');

      const alternateLine = term.buffer.alternate.getLine(0)!;
      expect(alternateLine.getCell(0)?.getChars()).toBe('e\u0301');
      expect(alternateLine.getCell(1)?.getChars()).toBe('👩‍💻');
      expect(alternateLine.getCell(1)?.getWidth()).toBe(2);
    });

    test('reads inactive primary scrollback in absolute buffer coordinates', () => {
      for (let line = 0; line < 30; line++) term.writeln(`line ${line}`);
      const baseY = term.buffer.normal.baseY;
      const oldest = term.buffer.normal.getLine(0)?.translateToString(true);
      expect(baseY).toBeGreaterThan(0);

      term.write('\x1b[?1049h');

      expect(term.buffer.normal.baseY).toBe(baseY);
      expect(term.buffer.normal.length).toBe(baseY + term.rows);
      expect(term.buffer.normal.getLine(0)?.translateToString(true)).toBe(oldest);
    });

    test('reports history base and viewport offsets in buffer coordinates', () => {
      for (let line = 0; line < 30; line++) term.writeln(`line ${line}`);

      const buffer = term.buffer.normal;
      expect(buffer.baseY).toBeGreaterThan(0);
      expect(buffer.viewportY).toBe(buffer.baseY);
      expect(buffer.length).toBe(buffer.baseY + term.rows);
      expect(buffer.cursorY).toBe(term.wasmTerm!.getCursor().y);

      term.scrollLines(-2);
      expect(buffer.viewportY).toBe(buffer.baseY - 2);
    });
  });

  describe('BufferLine', () => {
    test('should get line from buffer', () => {
      term.write('Hello, World!');
      const buffer = term.buffer.active;
      const line = buffer.getLine(0);

      expect(line).toBeDefined();
      expect(line!.length).toBe(80);
    });

    test('should return undefined for out of bounds line', () => {
      const buffer = term.buffer.active;
      const line = buffer.getLine(10000);

      expect(line).toBeUndefined();
    });

    test('should have correct isWrapped flag', () => {
      // Write a short line (should not wrap)
      term.write('Short line');
      const buffer = term.buffer.active;
      const line = buffer.getLine(0);

      expect(line).toBeDefined();
      expect(line!.isWrapped).toBe(false);
    });

    test('preserves soft-wrap metadata across retained rows', () => {
      term.write(`${'A'.repeat(80)}B`);

      expect(term.buffer.normal.getLine(0)?.isWrapped).toBe(false);
      expect(term.buffer.normal.getLine(1)?.isWrapped).toBe(true);
    });

    test('translateToString should return line content', () => {
      term.write('Hello, World!');
      const buffer = term.buffer.active;
      const line = buffer.getLine(0);
      const text = line!.translateToString();

      expect(text).toContain('Hello, World!');
    });

    test('translateToString should trim right when requested', () => {
      term.write('Hello');
      const buffer = term.buffer.active;
      const line = buffer.getLine(0);
      const text = line!.translateToString(true);

      expect(text).toBe('Hello');
      expect(text.length).toBe(5);
    });

    test('translateToString should respect startColumn and endColumn', () => {
      term.write('Hello, World!');
      const buffer = term.buffer.active;
      const line = buffer.getLine(0);
      const text = line!.translateToString(false, 7, 12);

      expect(text).toBe('World');
    });
  });

  describe('BufferCell', () => {
    test('should get cell from line', () => {
      term.write('Hello');
      const buffer = term.buffer.active;
      const line = buffer.getLine(0);
      const cell = line!.getCell(0);

      expect(cell).toBeDefined();
    });

    test('should return undefined for out of bounds cell', () => {
      term.write('Hello');
      const buffer = term.buffer.active;
      const line = buffer.getLine(0);
      const cell = line!.getCell(200);

      expect(cell).toBeUndefined();
    });

    test('getChars should return character', () => {
      term.write('H');
      const buffer = term.buffer.active;
      const line = buffer.getLine(0);
      const cell = line!.getCell(0);

      expect(cell!.getChars()).toBe('H');
    });

    test('getCode should return codepoint', () => {
      term.write('A');
      const buffer = term.buffer.active;
      const line = buffer.getLine(0);
      const cell = line!.getCell(0);

      expect(cell!.getCode()).toBe(65); // 'A' = 65
    });

    test('getWidth should return 1 for normal characters', () => {
      term.write('A');
      const buffer = term.buffer.active;
      const line = buffer.getLine(0);
      const cell = line!.getCell(0);

      expect(cell!.getWidth()).toBe(1);
    });

    test('should detect bold text', () => {
      term.write('\x1b[1mBold\x1b[0m');
      const buffer = term.buffer.active;
      const line = buffer.getLine(0);
      const cell = line!.getCell(0);

      expect(cell!.isBold()).toBe(1);
    });

    test('should detect italic text', () => {
      term.write('\x1b[3mItalic\x1b[0m');
      const buffer = term.buffer.active;
      const line = buffer.getLine(0);
      const cell = line!.getCell(0);

      expect(cell!.isItalic()).toBe(1);
    });

    test('should detect underline text', () => {
      term.write('\x1b[4mUnderline\x1b[0m');
      const buffer = term.buffer.active;
      const line = buffer.getLine(0);
      const cell = line!.getCell(0);

      expect(cell!.isUnderline()).toBe(1);
    });

    test('should detect strikethrough text', () => {
      term.write('\x1b[9mStrike\x1b[0m');
      const buffer = term.buffer.active;
      const line = buffer.getLine(0);
      const cell = line!.getCell(0);

      expect(cell!.isStrikethrough()).toBe(1);
    });

    test('should detect blink text', () => {
      term.write('\x1b[5mBlink\x1b[0m');
      const buffer = term.buffer.active;
      const line = buffer.getLine(0);
      const cell = line!.getCell(0);

      expect(cell!.isBlink()).toBe(1);
    });

    test('should detect inverse text', () => {
      term.write('\x1b[7mInverse\x1b[0m');
      const buffer = term.buffer.active;
      const line = buffer.getLine(0);
      const cell = line!.getCell(0);

      expect(cell!.isInverse()).toBe(1);
    });

    test('should detect invisible text', () => {
      term.write('\x1b[8mInvisible\x1b[0m');
      const buffer = term.buffer.active;
      const line = buffer.getLine(0);
      const cell = line!.getCell(0);

      expect(cell!.isInvisible()).toBe(1);
    });

    test('should detect faint text', () => {
      term.write('\x1b[2mFaint\x1b[0m');
      const buffer = term.buffer.active;
      const line = buffer.getLine(0);
      const cell = line!.getCell(0);

      expect(cell!.isFaint()).toBe(1);
    });

    test('should return RGB foreground color', () => {
      term.write('\x1b[31mRed\x1b[0m'); // ANSI red
      const buffer = term.buffer.active;
      const line = buffer.getLine(0);
      const cell = line!.getCell(0);

      const color = cell!.getFgColor();
      expect(color).toBeGreaterThan(0);
    });

    test('should return RGB background color', () => {
      term.write('\x1b[41mRed BG\x1b[0m'); // ANSI red background
      const buffer = term.buffer.active;
      const line = buffer.getLine(0);
      const cell = line!.getCell(0);

      const color = cell!.getBgColor();
      expect(color).toBeGreaterThan(0);
    });

    test('empty cell should return empty string', () => {
      // Get a cell that was never written to
      const buffer = term.buffer.active;
      const line = buffer.getLine(0);
      const cell = line!.getCell(50); // Far from any written text

      expect(cell!.getChars()).toBe('');
      expect(cell!.getCode()).toBe(0);
    });
  });

  describe('Multi-line content', () => {
    test('should handle multiple lines correctly', () => {
      term.write('Line 1\r\n');
      term.write('Line 2\r\n');
      term.write('Line 3');

      const buffer = term.buffer.active;

      const line0 = buffer.getLine(0);
      const line1 = buffer.getLine(1);
      const line2 = buffer.getLine(2);

      expect(line0!.translateToString(true)).toBe('Line 1');
      expect(line1!.translateToString(true)).toBe('Line 2');
      expect(line2!.translateToString(true)).toBe('Line 3');
    });

    test('should handle colored multi-line content', () => {
      term.write('\x1b[31mRed line\x1b[0m\r\n');
      term.write('\x1b[32mGreen line\x1b[0m\r\n');
      term.write('\x1b[34mBlue line\x1b[0m');

      const buffer = term.buffer.active;

      const line0 = buffer.getLine(0);
      const line1 = buffer.getLine(1);
      const line2 = buffer.getLine(2);

      expect(line0!.translateToString(true)).toBe('Red line');
      expect(line1!.translateToString(true)).toBe('Green line');
      expect(line2!.translateToString(true)).toBe('Blue line');

      // Check that first character of each line has correct style
      expect(line0!.getCell(0)!.getFgColor()).toBeGreaterThan(0);
      expect(line1!.getCell(0)!.getFgColor()).toBeGreaterThan(0);
      expect(line2!.getCell(0)!.getFgColor()).toBeGreaterThan(0);
    });
  });

  describe('Unicode support', () => {
    test('should handle emoji correctly', () => {
      term.write('😀');
      const buffer = term.buffer.active;
      const line = buffer.getLine(0);
      const cell = line!.getCell(0);

      expect(cell!.getChars()).toBe('😀');
      expect(cell!.getCode()).toBe(0x1f600); // Emoji codepoint
    });

    test('should handle accented characters', () => {
      term.write('Héllo');
      const buffer = term.buffer.active;
      const line = buffer.getLine(0);

      expect(line!.translateToString(true)).toBe('Héllo');
    });

    test('returns complete grapheme clusters from cells and lines', () => {
      term.write('e\u0301👩‍💻');
      const line = term.buffer.normal.getLine(0)!;

      expect(line.getCell(0)?.getChars()).toBe('e\u0301');
      expect(line.getCell(1)?.getChars()).toBe('👩‍💻');
      expect(line.translateToString(true)).toBe('e\u0301👩‍💻');
    });

    test('should handle various Unicode characters', () => {
      term.write('日本語');
      const buffer = term.buffer.active;
      const line = buffer.getLine(0);

      expect(line!.translateToString(true)).toBe('日本語');
    });
  });

  describe('Edge cases', () => {
    test('should handle empty buffer', () => {
      const buffer = term.buffer.active;
      const line = buffer.getLine(0);

      expect(line).toBeDefined();
      expect(line!.translateToString(true)).toBe('');
    });

    test('should handle full line of text', () => {
      // Write exactly 80 characters
      const fullLine = 'A'.repeat(80);
      term.write(fullLine);

      const buffer = term.buffer.active;
      const line = buffer.getLine(0);

      expect(line!.translateToString(true)).toBe(fullLine);
    });

    test('should handle cursor at end of line', () => {
      term.write('X'.repeat(80));
      const buffer = term.buffer.active;

      // Cursor stays at last column (79) until next character causes wrap
      // This is standard terminal behavior
      expect(buffer.cursorX).toBe(79);
    });

    test('should handle multiple style attributes', () => {
      term.write('\x1b[1;3;4mBold+Italic+Underline\x1b[0m');
      const buffer = term.buffer.active;
      const line = buffer.getLine(0);
      const cell = line!.getCell(0);

      expect(cell!.isBold()).toBe(1);
      expect(cell!.isItalic()).toBe(1);
      expect(cell!.isUnderline()).toBe(1);
    });
  });
});
