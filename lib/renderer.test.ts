/**
 * Tests for Canvas Renderer
 *
 * Note: Most renderer tests are visual and require a browser environment.
 * These tests verify non-visual aspects like theme configuration.
 * Full visual tests are in examples/renderer-demo.html
 */

import { describe, expect, test } from 'bun:test';
import { CanvasRenderer, DEFAULT_THEME, type IRenderable } from './renderer';
import type { SelectionManager } from './selection-manager';
import { CellFlags, DirtyState, type GhosttyCell, type RenderStateSnapshot } from './types';

type PathCommand = [string, ...number[]];

function translatePathX(commands: PathCommand[], offset: number): PathCommand[] {
  return commands.map(([operation, x, ...rest]) =>
    x === undefined ? [operation] : [operation, x + offset, ...rest]
  );
}

function makeCell(character: string, overrides: Partial<GhosttyCell> = {}): GhosttyCell {
  return {
    codepoint: character.codePointAt(0) ?? 0,
    fg_r: 212,
    fg_g: 212,
    fg_b: 212,
    bg_r: 30,
    bg_g: 30,
    bg_b: 30,
    flags: 0,
    width: 1,
    hyperlink_id: 0,
    grapheme_len: 0,
    ...overrides,
  };
}

function makeState(cols: number, rows: number): RenderStateSnapshot {
  return {
    dirty: DirtyState.FULL,
    cursor: {
      x: 0,
      y: 0,
      viewportX: 0,
      viewportY: 0,
      visible: false,
      blinking: false,
      style: 'block',
      default: true,
    },
    colors: {
      background: { r: 30, g: 30, b: 30 },
      foreground: { r: 212, g: 212, b: 212 },
      cursor: { r: 255, g: 255, b: 255 },
      palette: Array.from({ length: 16 }, () => ({ r: 0, g: 0, b: 0 })),
    },
    dimensions: { cols, rows },
  };
}

function createRenderHarness(
  lines: GhosttyCell[][],
  options: {
    fontLigatures?: boolean;
    cursor?: Partial<RenderStateSnapshot['cursor']>;
    devicePixelRatio?: number;
    fontSize?: number;
  } = {}
): {
  renderer: CanvasRenderer;
  buffer: IRenderable;
  state: RenderStateSnapshot;
  fillTexts: Array<[string, number, number]>;
  clips: Array<[number, number, number, number]>;
  paths: Array<{
    operation: 'fill' | 'stroke';
    commands: PathCommand[];
    fillStyle: string | CanvasGradient | CanvasPattern;
    strokeStyle: string | CanvasGradient | CanvasPattern;
    alpha: number;
    lineWidth: number;
  }>;
  requestedFullFrames: boolean[];
} {
  const canvas = document.createElement('canvas');
  const requestedFullFrames: boolean[] = [];
  const renderer = new CanvasRenderer(canvas, {
    devicePixelRatio: options.devicePixelRatio ?? 1,
    fontSize: options.fontSize,
    fontLigatures: options.fontLigatures,
    requestRender: (forceAll) => requestedFullFrames.push(forceAll ?? false),
  });
  const cols = Math.max(1, ...lines.map((line) => line.length));
  const state = makeState(cols, lines.length);
  state.cursor = { ...state.cursor, ...options.cursor };
  let dirtyRows = new Set(lines.map((_, row) => row));
  const buffer: IRenderable = {
    getLine: (row) => lines[row] ?? null,
    getRenderState: () => state,
    getDimensions: () => state.dimensions,
    isRowDirty: (row) => dirtyRows.has(row),
    clearDirty: () => {
      dirtyRows = new Set();
      state.dirty = DirtyState.NONE;
    },
  };

  renderer.resize(cols, lines.length);
  const context = (renderer as unknown as { ctx: CanvasRenderingContext2D }).ctx;
  const fillTexts: Array<[string, number, number]> = [];
  const clips: Array<[number, number, number, number]> = [];
  const paths: Array<{
    operation: 'fill' | 'stroke';
    commands: PathCommand[];
    fillStyle: string | CanvasGradient | CanvasPattern;
    strokeStyle: string | CanvasGradient | CanvasPattern;
    alpha: number;
    lineWidth: number;
  }> = [];
  let pathCommands: PathCommand[] = [];
  context.fillText = ((text: string, x: number, y: number) => {
    fillTexts.push([text, x, y]);
  }) as CanvasRenderingContext2D['fillText'];
  context.beginPath = () => {
    pathCommands = [];
  };
  context.moveTo = (x, y) => {
    pathCommands.push(['moveTo', x, y]);
  };
  context.lineTo = (x, y) => {
    pathCommands.push(['lineTo', x, y]);
  };
  context.ellipse = (x, y, radiusX, radiusY, rotation, startAngle, endAngle) => {
    pathCommands.push(['ellipse', x, y, radiusX, radiusY, rotation, startAngle, endAngle]);
  };
  context.closePath = () => {
    pathCommands.push(['closePath']);
  };
  const recordPath = (operation: 'fill' | 'stroke') => {
    paths.push({
      operation,
      commands: [...pathCommands],
      fillStyle: context.fillStyle,
      strokeStyle: context.strokeStyle,
      alpha: context.globalAlpha,
      lineWidth: context.lineWidth,
    });
  };
  context.fill = (() => recordPath('fill')) as CanvasRenderingContext2D['fill'];
  context.stroke = (() => recordPath('stroke')) as CanvasRenderingContext2D['stroke'];
  context.rect = ((x: number, y: number, width: number, height: number) => {
    clips.push([x, y, width, height]);
  }) as CanvasRenderingContext2D['rect'];

  return { renderer, buffer, state, fillTexts, clips, paths, requestedFullFrames };
}

describe('CanvasRenderer', () => {
  describe('Default Theme', () => {
    test('has all required ANSI colors', () => {
      expect(DEFAULT_THEME.black).toBe('#000000');
      expect(DEFAULT_THEME.red).toBe('#cd3131');
      expect(DEFAULT_THEME.green).toBe('#0dbc79');
      expect(DEFAULT_THEME.yellow).toBe('#e5e510');
      expect(DEFAULT_THEME.blue).toBe('#2472c8');
      expect(DEFAULT_THEME.magenta).toBe('#bc3fbc');
      expect(DEFAULT_THEME.cyan).toBe('#11a8cd');
      expect(DEFAULT_THEME.white).toBe('#e5e5e5');
    });

    test('has all bright ANSI colors', () => {
      expect(DEFAULT_THEME.brightBlack).toBe('#666666');
      expect(DEFAULT_THEME.brightRed).toBe('#f14c4c');
      expect(DEFAULT_THEME.brightGreen).toBe('#23d18b');
      expect(DEFAULT_THEME.brightYellow).toBe('#f5f543');
      expect(DEFAULT_THEME.brightBlue).toBe('#3b8eea');
      expect(DEFAULT_THEME.brightMagenta).toBe('#d670d6');
      expect(DEFAULT_THEME.brightCyan).toBe('#29b8db');
      expect(DEFAULT_THEME.brightWhite).toBe('#ffffff');
    });

    test('has foreground and background colors', () => {
      expect(DEFAULT_THEME.foreground).toBe('#d4d4d4');
      expect(DEFAULT_THEME.background).toBe('#1e1e1e');
    });

    test('has cursor colors', () => {
      expect(DEFAULT_THEME.cursor).toBe('#ffffff');
      expect(DEFAULT_THEME.cursorAccent).toBe('#1e1e1e');
    });

    test('has selection colors', () => {
      // Selection colors are now solid (not semi-transparent overlay)
      // Ghostty-style: selection bg = foreground color, selection fg = background color
      expect(DEFAULT_THEME.selectionBackground).toBe('#d4d4d4');
      expect(DEFAULT_THEME.selectionForeground).toBe('#1e1e1e');
    });
  });

  describe('Theme Color Format', () => {
    test('all colors are valid hex strings', () => {
      const hexPattern = /^#[0-9a-f]{6}$/i;

      expect(DEFAULT_THEME.black).toMatch(hexPattern);
      expect(DEFAULT_THEME.foreground).toMatch(hexPattern);
      expect(DEFAULT_THEME.background).toMatch(hexPattern);
      expect(DEFAULT_THEME.cursor).toMatch(hexPattern);
    });
  });

  describe('bounded shaped line runs', () => {
    test('shapes compatible ASCII cells in one clipped owned span by default', () => {
      const harness = createRenderHarness([[makeCell('!'), makeCell('='), makeCell('=')]]);
      harness.renderer.render(harness.buffer, true);

      expect(harness.fillTexts).toEqual([['!==', 0, harness.renderer.getMetrics().baseline]]);
      expect(harness.clips).toEqual([
        [0, 0, harness.renderer.charWidth * 3, harness.renderer.charHeight],
      ]);
      expect(harness.renderer.getFrameStats()).toEqual({
        renderedRows: 1,
        textRuns: 1,
        textMeasurements: 4,
        shapedRuns: 1,
        shapedCells: 3,
        maxRunCells: 3,
      });
      harness.renderer.dispose();
    });

    test('retains isolated cell glyph draws when ligatures are disabled', () => {
      const harness = createRenderHarness([[makeCell('!'), makeCell('='), makeCell('=')]], {
        fontLigatures: false,
      });
      harness.renderer.render(harness.buffer, true);

      expect(harness.fillTexts.map(([text]) => text)).toEqual(['!', '=', '=']);
      expect(harness.renderer.getFrameStats()).toMatchObject({
        textRuns: 3,
        textMeasurements: 0,
        shapedRuns: 0,
        shapedCells: 0,
        maxRunCells: 1,
      });
      harness.renderer.dispose();
    });

    test('splits at rendition, color, inverse, decoration, faint, and hyperlink boundaries', () => {
      const boundaries: Array<[string, GhosttyCell]> = [
        ['bold', makeCell('b', { flags: CellFlags.BOLD })],
        ['italic', makeCell('b', { flags: CellFlags.ITALIC })],
        ['underline', makeCell('b', { flags: CellFlags.UNDERLINE })],
        ['strikethrough', makeCell('b', { flags: CellFlags.STRIKETHROUGH })],
        ['inverse', makeCell('b', { flags: CellFlags.INVERSE })],
        ['faint', makeCell('b', { flags: CellFlags.FAINT })],
        ['foreground', makeCell('b', { fg_r: 1 })],
        ['background', makeCell('b', { bg_r: 1 })],
        ['hyperlink', makeCell('b', { hyperlink_id: 7 })],
      ];

      for (const [name, boundary] of boundaries) {
        const harness = createRenderHarness([[makeCell('a'), boundary]]);
        harness.renderer.render(harness.buffer, true);
        expect(
          harness.fillTexts.map(([text]) => text),
          name
        ).toEqual(['a', 'b']);
        harness.renderer.dispose();
      }
    });

    test('isolates wide, grapheme, emoji, box-drawing, and fallback-sensitive glyphs', () => {
      const line = [
        makeCell('a'),
        makeCell('界', { width: 2 }),
        makeCell(' ', { width: 0 }),
        makeCell('e', { grapheme_len: 1 }),
        makeCell('😀', { width: 2 }),
        makeCell(' ', { width: 0 }),
        makeCell('─'),
        makeCell('\ue0b0'),
        makeCell('b'),
      ];
      const harness = createRenderHarness([line]);
      harness.buffer.getGraphemeString = (_row, column) => (column === 3 ? 'e\u0301' : ' ');
      harness.renderer.render(harness.buffer, true);

      expect(harness.fillTexts.map(([text]) => text)).toEqual([
        'a',
        '界',
        'e\u0301',
        '😀',
        '─',
        'b',
      ]);
      expect(harness.paths).toHaveLength(1);
      expect(harness.paths[0].operation).toBe('fill');
      expect(harness.renderer.getFrameStats().maxRunCells).toBe(1);
      harness.renderer.dispose();
    });

    describe('Powerline separator geometry', () => {
      const geometryMatrix = [
        { fontSize: 11, devicePixelRatio: 1 },
        { fontSize: 15, devicePixelRatio: 1.25 },
        { fontSize: 19, devicePixelRatio: 2 },
      ];

      for (const options of geometryMatrix) {
        test(`draws cell-bounded canonical shapes at ${options.fontSize}px / ${options.devicePixelRatio} DPR`, () => {
          const separators = Array.from({ length: 8 }, (_, index) =>
            makeCell(String.fromCodePoint(0xe0b0 + index))
          );
          const invisibleRow = separators.map(() => makeCell(' ', { flags: CellFlags.INVISIBLE }));
          const harness = createRenderHarness([invisibleRow, separators, invisibleRow], options);
          harness.renderer.render(harness.buffer, true);

          const { width, height } = harness.renderer.getMetrics();
          const rowY = height;
          expect(harness.fillTexts).toEqual([]);
          expect(harness.paths.map(({ operation }) => operation)).toEqual([
            'fill',
            'stroke',
            'fill',
            'stroke',
            'fill',
            'stroke',
            'fill',
            'stroke',
          ]);
          expect(harness.clips).toEqual(
            Array.from({ length: 8 }, (_, column) => [column * width, rowY, width, height])
          );

          expect(harness.paths[0].commands).toEqual([
            ['moveTo', 0, rowY],
            ['lineTo', width, rowY + height / 2],
            ['lineTo', 0, rowY + height],
            ['closePath'],
          ]);
          expect(harness.paths[2].commands).toEqual([
            ['moveTo', width * 3, rowY],
            ['lineTo', width * 2, rowY + height / 2],
            ['lineTo', width * 3, rowY + height],
            ['closePath'],
          ]);
          expect(harness.paths[4].commands).toEqual([
            ['moveTo', width * 4, rowY],
            [
              'ellipse',
              width * 4,
              rowY + height / 2,
              width,
              height / 2,
              0,
              -Math.PI / 2,
              Math.PI / 2,
            ],
            ['closePath'],
          ]);
          expect(harness.paths[6].commands).toEqual([
            ['moveTo', width * 7, rowY + height],
            [
              'ellipse',
              width * 7,
              rowY + height / 2,
              width,
              height / 2,
              0,
              Math.PI / 2,
              Math.PI * 1.5,
            ],
            ['closePath'],
          ]);
          expect(harness.paths[1].commands).toEqual(
            translatePathX(harness.paths[0].commands.slice(0, -1), width)
          );
          expect(harness.paths[3].commands).toEqual(
            translatePathX(harness.paths[2].commands.slice(0, -1), width)
          );
          expect(harness.paths[5].commands).toEqual(
            translatePathX(harness.paths[4].commands.slice(0, -1), width)
          );
          expect(harness.paths[7].commands).toEqual(
            translatePathX(harness.paths[6].commands.slice(0, -1), width)
          );
          for (const path of harness.paths) {
            expect(path.fillStyle).toBe('rgb(212, 212, 212)');
            expect(path.alpha).toBe(1);
            if (path.operation === 'stroke') {
              expect(path.strokeStyle).toBe(path.fillStyle);
              expect(path.lineWidth * options.devicePixelRatio).toBe(1);
            }
          }
          harness.renderer.dispose();
        });
      }

      test('preserves selection, inverse, faint, and block-cursor colors', () => {
        const harness = createRenderHarness(
          [
            [
              makeCell('\ue0b0', { fg_r: 1, fg_g: 2, fg_b: 3 }),
              makeCell('\ue0b2', {
                flags: CellFlags.INVERSE,
                bg_r: 4,
                bg_g: 5,
                bg_b: 6,
              }),
              makeCell('\ue0b4', { flags: CellFlags.FAINT, fg_r: 7, fg_g: 8, fg_b: 9 }),
            ],
          ],
          { cursor: { x: 1, visible: true, style: 'block' } }
        );
        harness.renderer.setSelectionManager({
          hasSelection: () => true,
          getSelectionCoords: () => ({ startCol: 0, startRow: 0, endCol: 0, endRow: 0 }),
          getDirtySelectionRows: () => new Set<number>(),
          clearDirtySelectionRows: () => {},
        } as unknown as SelectionManager);
        harness.renderer.render(harness.buffer, true);

        expect(harness.paths.map(({ fillStyle, alpha }) => ({ fillStyle, alpha }))).toEqual([
          { fillStyle: DEFAULT_THEME.selectionForeground, alpha: 1 },
          { fillStyle: 'rgb(4, 5, 6)', alpha: 1 },
          { fillStyle: 'rgb(7, 8, 9)', alpha: 0.5 },
          { fillStyle: DEFAULT_THEME.cursorAccent, alpha: 1 },
        ]);
        harness.renderer.dispose();
      });

      test('leaves other private-use and grapheme cells on the font path', () => {
        const harness = createRenderHarness([
          [
            makeCell('\ue0af'),
            makeCell('\ue0b8'),
            makeCell('\ue0a0'),
            makeCell('\ue0b0', { grapheme_len: 1 }),
          ],
        ]);
        harness.buffer.getGraphemeString = (_row, column) => (column === 3 ? '\ue0b0\ufe0f' : ' ');
        harness.renderer.render(harness.buffer, true);

        expect(harness.paths).toEqual([]);
        expect(harness.fillTexts.map(([text]) => text)).toEqual([
          '\ue0af',
          '\ue0b8',
          '\ue0a0',
          '\ue0b0\ufe0f',
        ]);
        harness.renderer.dispose();
      });
    });

    test('splits cursor ownership without changing its exact cell geometry', () => {
      const harness = createRenderHarness([[makeCell('a'), makeCell('b'), makeCell('c')]], {
        cursor: { x: 1, visible: true, style: 'block' },
      });
      const context = (harness.renderer as unknown as { ctx: CanvasRenderingContext2D }).ctx;
      const cursorFills: Array<[number, number, number, number]> = [];
      context.fillRect = ((x: number, y: number, width: number, height: number) => {
        cursorFills.push([x, y, width, height]);
      }) as CanvasRenderingContext2D['fillRect'];

      harness.renderer.render(harness.buffer, true);

      expect(harness.fillTexts.map(([text]) => text)).toEqual(['a', 'b', 'c', 'b']);
      expect(cursorFills).toContainEqual([
        harness.renderer.charWidth,
        0,
        harness.renderer.charWidth,
        harness.renderer.charHeight,
      ]);
      expect(harness.renderer.getFrameStats()).toMatchObject({ textRuns: 4, shapedRuns: 0 });
      harness.renderer.dispose();
    });

    test('splits selection and hovered regex-link boundaries at exact cells', () => {
      const harness = createRenderHarness([
        [makeCell('a'), makeCell('b'), makeCell('c'), makeCell('d')],
      ]);
      const selection = {
        hasSelection: () => true,
        getSelectionCoords: () => ({ startCol: 1, startRow: 0, endCol: 1, endRow: 0 }),
        getDirtySelectionRows: () => new Set<number>(),
        clearDirtySelectionRows: () => {},
      } as unknown as SelectionManager;
      harness.renderer.setSelectionManager(selection);
      harness.renderer.setHoveredLinkRange({ startX: 2, startY: 0, endX: 2, endY: 0 });
      harness.renderer.render(harness.buffer, true);

      expect(harness.fillTexts.map(([text]) => text)).toEqual(['a', 'b', 'c', 'd']);
      harness.renderer.dispose();
    });

    test('uses scrollback-owned graphemes instead of screen coordinates', () => {
      const harness = createRenderHarness([[makeCell('x', { grapheme_len: 1 })]]);
      const scrollbackProvider = {
        getScrollbackLength: () => 1,
        getScrollbackLine: () => [makeCell('e', { grapheme_len: 1 })],
        getScrollbackGraphemeString: (offset: number, col: number) => `${offset}:${col}:e\u0301`,
      };

      harness.renderer.render(harness.buffer, true, 1, scrollbackProvider);

      expect(harness.fillTexts.map(([text]) => text)).toEqual(['0:0:e\u0301']);
      harness.renderer.dispose();
    });

    test('limits partial updates to dirty rows and their established overflow neighbors', () => {
      const lines = Array.from({ length: 7 }, (_, row) => [makeCell(String(row))]);
      const harness = createRenderHarness(lines);
      const requestedRows: number[] = [];
      let dirtyRow = -1;
      harness.buffer.getLine = (row) => {
        requestedRows.push(row);
        return lines[row] ?? null;
      };
      harness.buffer.isRowDirty = (row) => row === dirtyRow;

      harness.renderer.render(harness.buffer, true);
      requestedRows.length = 0;
      harness.fillTexts.length = 0;
      dirtyRow = 3;
      harness.state.dirty = DirtyState.PARTIAL;
      harness.renderer.render(harness.buffer);

      expect(requestedRows).toEqual([2, 3, 4]);
      expect(harness.fillTexts.map(([text]) => text)).toEqual(['2', '3', '4']);
      expect(harness.renderer.getFrameStats()).toMatchObject({ renderedRows: 3, textRuns: 3 });
      harness.renderer.dispose();
    });

    test('requests one full repaint when the live ligatures mode changes', () => {
      const harness = createRenderHarness([[makeCell('a'), makeCell('b')]]);

      harness.renderer.setFontLigatures(false);
      harness.renderer.setFontLigatures(false);
      harness.renderer.setFontLigatures(true);

      expect(harness.requestedFullFrames).toEqual([true, true]);
      harness.renderer.dispose();
    });

    test('splits proportional and fallback ASCII advances while preserving a later safe run', () => {
      const harness = createRenderHarness([
        [makeCell('f'), makeCell('i'), makeCell('~'), makeCell('='), makeCell('>')],
      ]);
      const context = (harness.renderer as unknown as { ctx: CanvasRenderingContext2D }).ctx;
      context.measureText = ((text: string) => ({
        width: text === 'f' ? 5 : text === 'i' ? 4 : text === '~' ? 9 : text.length * 8,
      })) as CanvasRenderingContext2D['measureText'];

      harness.renderer.render(harness.buffer, true);

      expect(harness.fillTexts.map(([text]) => text)).toEqual(['f', 'i', '~', '=>']);
      expect(harness.renderer.getFrameStats()).toMatchObject({
        textRuns: 4,
        shapedRuns: 1,
        shapedCells: 2,
      });
      harness.renderer.dispose();
    });

    test('rejects a whole-run advance mismatch without suppressing a later compatible prefix', () => {
      const harness = createRenderHarness([[makeCell('a'), makeCell('b'), makeCell('c')]]);
      const context = (harness.renderer as unknown as { ctx: CanvasRenderingContext2D }).ctx;
      context.measureText = ((text: string) => ({
        width: text === 'ab' ? 17 : text.length * 8,
      })) as CanvasRenderingContext2D['measureText'];

      harness.renderer.render(harness.buffer, true);

      expect(harness.fillTexts.map(([text]) => text)).toEqual(['a', 'bc']);
      expect(harness.renderer.getFrameStats()).toMatchObject({
        textRuns: 2,
        shapedRuns: 1,
        shapedCells: 2,
      });
      harness.renderer.dispose();
    });

    test('maps a fixed-advance shaped run exactly onto its Ghostty-owned span', () => {
      const harness = createRenderHarness([[makeCell('='), makeCell('>')]]);
      const context = (harness.renderer as unknown as { ctx: CanvasRenderingContext2D }).ctx;
      const translations: Array<[number, number]> = [];
      const scales: Array<[number, number]> = [];
      context.measureText = ((text: string) => ({
        width: text.length * 7.5,
      })) as CanvasRenderingContext2D['measureText'];
      context.translate = ((x: number, y: number) => {
        translations.push([x, y]);
      }) as CanvasRenderingContext2D['translate'];
      context.scale = ((x: number, y: number) => {
        scales.push([x, y]);
      }) as CanvasRenderingContext2D['scale'];

      harness.renderer.render(harness.buffer, true);

      expect(translations).toContainEqual([0, 0]);
      expect(scales).toContainEqual([(harness.renderer.charWidth * 2) / 15, 1]);
      expect(harness.clips).toContainEqual([
        0,
        0,
        harness.renderer.charWidth * 2,
        harness.renderer.charHeight,
      ]);
      harness.renderer.dispose();
    });

    test('bounds shaped runs and measurements independently of line length', () => {
      const line = Array.from({ length: 130 }, () => makeCell('='));
      const harness = createRenderHarness([line]);

      harness.renderer.render(harness.buffer, true);

      expect(harness.fillTexts.map(([text]) => text.length)).toEqual([64, 64, 2]);
      expect(harness.renderer.getFrameStats()).toMatchObject({
        textRuns: 3,
        shapedRuns: 3,
        shapedCells: 130,
        maxRunCells: 64,
        textMeasurements: 128,
      });
      harness.renderer.dispose();
    });

    test('caches glyph advances and invalidates them on geometry-affecting changes', () => {
      const harness = createRenderHarness([[makeCell('a'), makeCell('a')]]);
      const context = (harness.renderer as unknown as { ctx: CanvasRenderingContext2D }).ctx;
      let measurements = 0;
      context.measureText = ((text: string) => {
        measurements++;
        return { width: text.length * 8 };
      }) as CanvasRenderingContext2D['measureText'];

      harness.renderer.render(harness.buffer, true);
      expect(measurements).toBe(2);

      harness.renderer.render(harness.buffer, true);
      expect(measurements).toBe(3);

      harness.renderer.resize(2, 1);
      harness.renderer.render(harness.buffer, true);
      expect(measurements).toBe(5);

      harness.renderer.setFontFamily('test-monospace');
      harness.renderer.render(harness.buffer, true);
      expect(measurements).toBe(7);
      harness.renderer.dispose();
    });
  });
});
