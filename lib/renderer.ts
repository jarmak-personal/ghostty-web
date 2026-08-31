/**
 * Canvas Renderer for Terminal Display
 *
 * High-performance canvas-based renderer that draws the terminal using
 * Ghostty's WASM terminal emulator. Features:
 * - Font metrics measurement with DPI scaling
 * - Full color support (256-color palette + RGB)
 * - All text styles (bold, italic, underline, strikethrough, etc.)
 * - Multiple cursor styles (block, underline, bar)
 * - Dirty line optimization for 60 FPS
 */

import type { ITheme } from './interfaces';
import { ANSI_THEME_KEYS, DEFAULT_THEME, normalizeTheme, parsePaletteColor } from './palette';
import type { SelectionManager } from './selection-manager';
import type {
  CursorStyle,
  GhosttyCell,
  ILink,
  RenderStateColors,
  RenderStateCursor,
  RenderStateSnapshot,
  RGB,
} from './types';
import { CellFlags, DirtyState } from './types';

export { DEFAULT_THEME } from './palette';

// Interface for objects that can be rendered
export interface IRenderable {
  getLine(y: number): GhosttyCell[] | null;
  getRenderState(): RenderStateSnapshot;
  getDimensions(): { cols: number; rows: number };
  isRowDirty(y: number): boolean;
  clearDirty(): void;
  /**
   * Get the full grapheme string for a cell at (row, col).
   * For cells with grapheme_len > 0, this returns all codepoints combined.
   * For simple cells, returns the single character.
   */
  getGraphemeString?(row: number, col: number, refreshRenderState?: boolean): string;
}

export interface IScrollbackProvider {
  getScrollbackLine(offset: number): GhosttyCell[] | null;
  getScrollbackLength(): number;
  /** Changes when eviction or clearing remaps retained row offsets. */
  getScrollbackGeneration?(): number;
  getScrollbackGraphemeString?(offset: number, col: number): string;
  /**
   * Materialize one bounded, contiguous history slice. Implementations may
   * reuse both the returned row arrays and their cell objects until the next
   * call, because the renderer consumes the snapshot synchronously.
   */
  getScrollbackViewport?(start: number, rows: number): GhosttyCell[][] | null;
}

// ============================================================================
// Type Definitions
// ============================================================================

export interface RendererOptions {
  fontSize?: number; // Default: 15
  fontFamily?: string; // Default: 'monospace'
  fontLigatures?: boolean; // Default: true
  theme?: ITheme;
  devicePixelRatio?: number; // Default: window.devicePixelRatio
  requestRender?: (forceAll?: boolean) => void;
  onDevicePixelRatioChange?: () => void;
}

export interface FontMetrics {
  width: number; // Character cell width in CSS pixels
  height: number; // Character cell height in CSS pixels
  baseline: number; // Distance from top to text baseline
}

/** Bounded work performed by the most recent Canvas frame. */
export interface RendererFrameStats {
  renderedRows: number;
  materializedRows: number;
  materializedCells: number;
  textRuns: number;
  textMeasurements: number;
  shapedRuns: number;
  shapedCells: number;
  maxRunCells: number;
}

/** Inclusive viewport-row range painted during a Canvas frame. */
export interface RendererRowRange {
  start: number;
  end: number;
}

interface TextRunCell {
  cell: GhosttyCell;
  column: number;
  text: string;
  font: string;
  fillStyle: string;
  alpha: number;
  styleKey: string;
  joinable: boolean;
  advance: number | null;
}

interface TextRun {
  cells: TextRunCell[];
  startColumn: number;
  endColumn: number;
  text: string;
  measuredWidth: number | null;
  expectedWidth: number;
}

const MAX_SHAPED_RUN_CELLS = 64;
const MAX_GLYPH_ADVANCE_CACHE_ENTRIES = 512;
const ADVANCE_EPSILON = 0.01;
const POWERLINE_SEPARATOR_START = 0xe0b0;
const POWERLINE_SEPARATOR_END = 0xe0b7;
const BOX_UP = 1;
const BOX_RIGHT = 2;
const BOX_DOWN = 4;
const BOX_LEFT = 8;

interface BoxDrawingGlyph {
  directions: number;
  physicalStrokeWidth: 1 | 3;
  rounded?: true;
}

const BOX_DRAWING_GLYPHS: ReadonlyMap<number, BoxDrawingGlyph> = new Map([
  [0x2500, { directions: BOX_LEFT | BOX_RIGHT, physicalStrokeWidth: 1 }], // ─
  [0x2501, { directions: BOX_LEFT | BOX_RIGHT, physicalStrokeWidth: 3 }], // ━
  [0x2502, { directions: BOX_UP | BOX_DOWN, physicalStrokeWidth: 1 }], // │
  [0x2503, { directions: BOX_UP | BOX_DOWN, physicalStrokeWidth: 3 }], // ┃
  [0x250c, { directions: BOX_RIGHT | BOX_DOWN, physicalStrokeWidth: 1 }], // ┌
  [0x250f, { directions: BOX_RIGHT | BOX_DOWN, physicalStrokeWidth: 3 }], // ┏
  [0x2510, { directions: BOX_LEFT | BOX_DOWN, physicalStrokeWidth: 1 }], // ┐
  [0x2513, { directions: BOX_LEFT | BOX_DOWN, physicalStrokeWidth: 3 }], // ┓
  [0x2514, { directions: BOX_UP | BOX_RIGHT, physicalStrokeWidth: 1 }], // └
  [0x2517, { directions: BOX_UP | BOX_RIGHT, physicalStrokeWidth: 3 }], // ┗
  [0x2518, { directions: BOX_UP | BOX_LEFT, physicalStrokeWidth: 1 }], // ┘
  [0x251b, { directions: BOX_UP | BOX_LEFT, physicalStrokeWidth: 3 }], // ┛
  [0x251c, { directions: BOX_UP | BOX_RIGHT | BOX_DOWN, physicalStrokeWidth: 1 }], // ├
  [0x2523, { directions: BOX_UP | BOX_RIGHT | BOX_DOWN, physicalStrokeWidth: 3 }], // ┣
  [0x2524, { directions: BOX_UP | BOX_LEFT | BOX_DOWN, physicalStrokeWidth: 1 }], // ┤
  [0x252b, { directions: BOX_UP | BOX_LEFT | BOX_DOWN, physicalStrokeWidth: 3 }], // ┫
  [0x252c, { directions: BOX_LEFT | BOX_RIGHT | BOX_DOWN, physicalStrokeWidth: 1 }], // ┬
  [0x2533, { directions: BOX_LEFT | BOX_RIGHT | BOX_DOWN, physicalStrokeWidth: 3 }], // ┳
  [0x2534, { directions: BOX_UP | BOX_LEFT | BOX_RIGHT, physicalStrokeWidth: 1 }], // ┴
  [0x253b, { directions: BOX_UP | BOX_LEFT | BOX_RIGHT, physicalStrokeWidth: 3 }], // ┻
  [0x253c, { directions: BOX_UP | BOX_RIGHT | BOX_DOWN | BOX_LEFT, physicalStrokeWidth: 1 }], // ┼
  [0x254b, { directions: BOX_UP | BOX_RIGHT | BOX_DOWN | BOX_LEFT, physicalStrokeWidth: 3 }], // ╋
  [0x256d, { directions: BOX_RIGHT | BOX_DOWN, physicalStrokeWidth: 1, rounded: true }], // ╭
  [0x256e, { directions: BOX_LEFT | BOX_DOWN, physicalStrokeWidth: 1, rounded: true }], // ╮
  [0x256f, { directions: BOX_UP | BOX_LEFT, physicalStrokeWidth: 1, rounded: true }], // ╯
  [0x2570, { directions: BOX_UP | BOX_RIGHT, physicalStrokeWidth: 1, rounded: true }], // ╰
]);

const EMPTY_FRAME_STATS: RendererFrameStats = {
  renderedRows: 0,
  materializedRows: 0,
  materializedCells: 0,
  textRuns: 0,
  textMeasurements: 0,
  shapedRuns: 0,
  shapedCells: 0,
  maxRunCells: 0,
};

function themeRgb(value: string): RGB {
  const packed = parsePaletteColor(value);
  return { r: (packed >> 16) & 0xff, g: (packed >> 8) & 0xff, b: packed & 0xff };
}

function isPowerlineSeparator(cell: GhosttyCell): boolean {
  return (
    cell.grapheme_len === 0 &&
    cell.codepoint >= POWERLINE_SEPARATOR_START &&
    cell.codepoint <= POWERLINE_SEPARATOR_END
  );
}

function getBoxDrawingGlyph(cell: GhosttyCell): BoxDrawingGlyph | undefined {
  return cell.grapheme_len === 0 ? BOX_DRAWING_GLYPHS.get(cell.codepoint) : undefined;
}

function rgbEqual(left: RGB, right: RGB): boolean {
  return left.r === right.r && left.g === right.g && left.b === right.b;
}

function renderStateColorsEqual(left: RenderStateColors, right: RenderStateColors): boolean {
  return (
    rgbEqual(left.background, right.background) &&
    rgbEqual(left.foreground, right.foreground) &&
    rgbEqual(left.cursor, right.cursor) &&
    left.palette.length === right.palette.length &&
    left.palette.every((color, index) => rgbEqual(color, right.palette[index]!))
  );
}

function cloneRenderStateColors(colors: RenderStateColors): RenderStateColors {
  return {
    background: { ...colors.background },
    foreground: { ...colors.foreground },
    cursor: { ...colors.cursor },
    palette: colors.palette.map((color) => ({ ...color })),
  };
}

// ============================================================================
// CanvasRenderer Class
// ============================================================================

export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private fontSize: number;
  private fontFamily: string;
  private fontLigatures: boolean;
  private cursorBlink: boolean;
  private theme: Required<ITheme>;
  private effectiveColors: RenderStateColors;
  private lastEffectiveColors?: RenderStateColors;
  private devicePixelRatio: number;
  private readonly tracksWindowDevicePixelRatio: boolean;
  private resolutionMediaQuery?: MediaQueryList;
  private resolutionMediaQueryUsesLegacyListener = false;
  private disposed = false;
  private metrics: FontMetrics;
  private requestRender: (forceAll?: boolean) => void;
  private onDevicePixelRatioChange: () => void;
  private renderPaused = false;
  private frameStats: RendererFrameStats = { ...EMPTY_FRAME_STATS };
  private renderedRowRanges: RendererRowRange[] = [];
  private glyphAdvanceCache = new Map<string, number>();

  // Cursor blinking state
  private cursorVisible: boolean = true;
  private cursorBlinkInterval?: number;
  private lastCursorPosition: { x: number; y: number } = { x: 0, y: 0 };
  private lastCursorState?: RenderStateCursor;

  // Text viewport tracking. Fractional smooth-scroll movement affects only the
  // scrollbar until it crosses a retained row boundary.
  private lastScrollbackStart: number = 0;
  private lastHistoricalRows: number = 0;
  private lastScrollbackGeneration?: number;

  // Current buffer being rendered (for grapheme lookups)
  private currentBuffer: IRenderable | null = null;

  // Selection manager (for rendering selection)
  private selectionManager?: SelectionManager;
  // Cached selection coordinates for current render pass (viewport-relative)
  private currentSelectionCoords: {
    startCol: number;
    startRow: number;
    endCol: number;
    endRow: number;
  } | null = null;

  // Link rendering state
  private hoveredHyperlinkId: number = 0;
  private previousHoveredHyperlinkId: number = 0;

  // Regex link hover tracking (for links without hyperlink_id)
  private hoveredLinkRange: { startX: number; startY: number; endX: number; endY: number } | null =
    null;
  private previousHoveredLinkRange: {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  } | null = null;

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) {
      throw new Error('Failed to get 2D rendering context');
    }
    this.ctx = ctx;
    this.requestRender = options.requestRender ?? (() => {});
    this.onDevicePixelRatioChange = options.onDevicePixelRatioChange ?? (() => {});

    // Apply options
    this.fontSize = options.fontSize ?? 15;
    this.fontFamily = options.fontFamily ?? 'monospace';
    this.fontLigatures = options.fontLigatures ?? true;
    this.cursorBlink = false;
    this.theme = normalizeTheme(options.theme);
    this.effectiveColors = {
      foreground: themeRgb(this.theme.foreground),
      background: themeRgb(this.theme.background),
      cursor: themeRgb(this.theme.cursor),
      palette: ANSI_THEME_KEYS.map((key) => themeRgb(this.theme[key])),
    };
    this.tracksWindowDevicePixelRatio = options.devicePixelRatio === undefined;
    this.devicePixelRatio = this.normalizeDevicePixelRatio(
      options.devicePixelRatio ?? window.devicePixelRatio
    );

    // Measure font metrics
    this.metrics = this.measureFont();

    if (this.tracksWindowDevicePixelRatio) {
      window.addEventListener('resize', this.handleDevicePixelRatioSignal);
      this.watchCurrentResolution();
    }
  }

  // ==========================================================================
  // Font Metrics Measurement
  // ==========================================================================

  private measureFont(): FontMetrics {
    // Use an offscreen canvas for measurement
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;

    // Set font (use actual pixel size for accurate measurement)
    ctx.font = `${this.fontSize}px ${this.fontFamily}`;

    // Measure width using 'M' (typically widest character)
    const widthMetrics = ctx.measureText('M');

    // Measure height using ascent + descent with padding for glyph overflow
    const ascent = widthMetrics.actualBoundingBoxAscent || this.fontSize * 0.8;
    const descent = widthMetrics.actualBoundingBoxDescent || this.fontSize * 0.2;

    // Keep every cell edge on the physical-pixel grid. CSS-pixel rounding creates
    // fractional backing-store coordinates at zoom DPRs such as 1.25 and 1.5,
    // which can leave partially covered pixels where neighboring strokes meet.
    // Preserve the previous CSS-ceiled metrics as minimums so this correction
    // never fits extra columns or clips fallback glyphs into a smaller cell.
    const alignToDevicePixel = (value: number) =>
      Math.ceil(value * this.devicePixelRatio) / this.devicePixelRatio;
    const width = alignToDevicePixel(Math.ceil(widthMetrics.width));
    const height = alignToDevicePixel(Math.ceil(ascent + descent) + 2);
    const baseline = alignToDevicePixel(Math.ceil(ascent) + 1);

    return { width, height, baseline };
  }

  /**
   * Remeasure font metrics (call after font loads or changes)
   */
  public remeasureFont(): void {
    this.glyphAdvanceCache.clear();
    this.metrics = this.measureFont();
    this.requestRender();
  }

  private normalizeDevicePixelRatio(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
  }

  private readWindowDevicePixelRatio(): number {
    return this.normalizeDevicePixelRatio(window.devicePixelRatio);
  }

  /**
   * A resolution media query reports zoom and cross-display transitions even
   * when the window's CSS dimensions do not change. The resize listener is a
   * fallback for engines that do not dispatch resolution-query changes.
   */
  private watchCurrentResolution(): void {
    this.unwatchCurrentResolution();
    if (this.disposed || typeof window.matchMedia !== 'function') return;

    this.resolutionMediaQuery = window.matchMedia(`(resolution: ${this.devicePixelRatio}dppx)`);
    if (typeof this.resolutionMediaQuery.addEventListener === 'function') {
      this.resolutionMediaQuery.addEventListener('change', this.handleDevicePixelRatioSignal);
      return;
    }
    if (typeof this.resolutionMediaQuery.addListener === 'function') {
      this.resolutionMediaQuery.addListener(this.handleDevicePixelRatioSignal);
      this.resolutionMediaQueryUsesLegacyListener = true;
      return;
    }
    this.resolutionMediaQuery = undefined;
  }

  private unwatchCurrentResolution(): void {
    if (this.resolutionMediaQueryUsesLegacyListener) {
      this.resolutionMediaQuery?.removeListener?.(this.handleDevicePixelRatioSignal);
    } else {
      this.resolutionMediaQuery?.removeEventListener?.('change', this.handleDevicePixelRatioSignal);
    }
    this.resolutionMediaQuery = undefined;
    this.resolutionMediaQueryUsesLegacyListener = false;
  }

  private handleDevicePixelRatioSignal = (): void => {
    if (this.disposed || this.readWindowDevicePixelRatio() === this.devicePixelRatio) return;
    // Keep the old canvas intact until the next presentation callback can
    // remeasure, resize, rescale, and repaint it as one operation.
    this.requestRender(true);
  };

  /** Apply a pending browser DPR transition at the start of a Canvas frame. */
  private refreshDevicePixelRatio(): boolean {
    if (!this.tracksWindowDevicePixelRatio) return false;

    const nextDevicePixelRatio = this.readWindowDevicePixelRatio();
    if (nextDevicePixelRatio === this.devicePixelRatio) return false;

    this.devicePixelRatio = nextDevicePixelRatio;
    this.glyphAdvanceCache.clear();
    this.metrics = this.measureFont();
    this.watchCurrentResolution();
    this.onDevicePixelRatioChange();
    return true;
  }

  // ==========================================================================
  // Color Conversion
  // ==========================================================================

  private rgbToCSS(r: number, g: number, b: number): string {
    return `rgb(${r}, ${g}, ${b})`;
  }

  // ==========================================================================
  // Canvas Sizing
  // ==========================================================================

  /**
   * Resize canvas to fit terminal dimensions
   */
  public resize(cols: number, rows: number): void {
    this.glyphAdvanceCache.clear();
    const cssWidth = cols * this.metrics.width;
    const cssHeight = rows * this.metrics.height;

    // Set CSS size (what user sees)
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;

    // Set actual canvas size (scaled for DPI)
    this.canvas.width = this.toDevicePixels(cssWidth);
    this.canvas.height = this.toDevicePixels(cssHeight);

    // Scale context to match DPI (setting canvas.width/height resets the context)
    this.ctx.scale(this.devicePixelRatio, this.devicePixelRatio);

    // Set text rendering properties for crisp text
    this.ctx.textBaseline = 'alphabetic';
    this.ctx.textAlign = 'left';

    // Fill background after resize
    this.ctx.fillStyle = this.rgbToCSS(
      this.effectiveColors.background.r,
      this.effectiveColors.background.g,
      this.effectiveColors.background.b
    );
    this.ctx.fillRect(0, 0, cssWidth, cssHeight);
  }

  private toDevicePixels(cssPixels: number): number {
    return Math.round(cssPixels * this.devicePixelRatio);
  }

  // ==========================================================================
  // Main Rendering
  // ==========================================================================

  /**
   * Render the terminal buffer to canvas
   */
  public render(
    buffer: IRenderable,
    forceAll: boolean = false,
    viewportY: number = 0,
    scrollbackProvider?: IScrollbackProvider,
    scrollbarOpacity: number = 1
  ): RenderStateCursor {
    const devicePixelRatioChanged = this.refreshDevicePixelRatio();
    if (devicePixelRatioChanged) forceAll = true;
    this.frameStats = { ...EMPTY_FRAME_STATS };
    this.renderedRowRanges = [];
    // Store buffer reference for grapheme lookups in renderCell
    this.currentBuffer = buffer;

    // Refresh Ghostty's RenderState exactly once for this Canvas frame.
    const state = buffer.getRenderState();
    const cursor = state.cursor;
    this.reconcileCursorBlink(cursor.blinking);
    const colorsChanged =
      !this.lastEffectiveColors || !renderStateColorsEqual(this.lastEffectiveColors, state.colors);
    if (colorsChanged) this.lastEffectiveColors = cloneRenderStateColors(state.colors);
    this.effectiveColors = state.colors;
    const dims = state.dimensions;
    const scrollbackLength = scrollbackProvider ? scrollbackProvider.getScrollbackLength() : 0;

    // Resize canvas if dimensions changed
    const needsResize =
      devicePixelRatioChanged ||
      this.canvas.width !== this.toDevicePixels(dims.cols * this.metrics.width) ||
      this.canvas.height !== this.toDevicePixels(dims.rows * this.metrics.height);

    if (needsResize) {
      this.resize(dims.cols, dims.rows);
      forceAll = true; // Force full render after resize
    }

    const integerViewportY = Math.max(0, Math.floor(viewportY));
    const historicalRows = Math.min(dims.rows, integerViewportY);
    const scrollbackStart = Math.max(0, scrollbackLength - integerViewportY);

    // A native full dirty state describes the live screen. When history covers
    // part or all of the viewport, render only live rows that are actually
    // visible; viewport remapping and explicit presentation changes still
    // promote the whole Canvas below.
    if (colorsChanged || (state.dirty === DirtyState.FULL && historicalRows === 0)) {
      forceAll = true;
    }

    const scrollbackGeneration = scrollbackProvider?.getScrollbackGeneration?.();
    if (scrollbackGeneration !== undefined) {
      if (
        this.lastScrollbackGeneration !== undefined &&
        scrollbackGeneration !== this.lastScrollbackGeneration &&
        historicalRows > 0
      ) {
        forceAll = true;
      }
      this.lastScrollbackGeneration = scrollbackGeneration;
    } else {
      this.lastScrollbackGeneration = undefined;
    }

    // Text changes only when its retained-buffer mapping changes. Fractional
    // smooth-scroll frames still update the scrollbar below without replaying
    // the same historical rows.
    if (
      scrollbackStart !== this.lastScrollbackStart ||
      historicalRows !== this.lastHistoricalRows
    ) {
      forceAll = true;
      this.lastScrollbackStart = scrollbackStart;
      this.lastHistoricalRows = historicalRows;
    }

    let historicalViewport: GhosttyCell[][] | null | undefined;
    let fallbackHistoricalViewport: Array<GhosttyCell[] | null | undefined> | undefined;
    const getHistoricalLine = (viewportRow: number): GhosttyCell[] | null => {
      if (!scrollbackProvider || viewportRow < 0 || viewportRow >= historicalRows) return null;
      if (historicalViewport === undefined && scrollbackProvider.getScrollbackViewport) {
        historicalViewport = scrollbackProvider.getScrollbackViewport(
          scrollbackStart,
          historicalRows
        );
        if (historicalViewport) {
          this.frameStats.materializedRows += historicalViewport.length;
          this.frameStats.materializedCells += historicalViewport.reduce(
            (total, line) => total + line.length,
            0
          );
        }
      }
      if (historicalViewport) return historicalViewport[viewportRow] ?? null;

      fallbackHistoricalViewport ??= [];
      if (viewportRow in fallbackHistoricalViewport) {
        return fallbackHistoricalViewport[viewportRow] ?? null;
      }

      const line = scrollbackProvider.getScrollbackLine(scrollbackStart + viewportRow);
      fallbackHistoricalViewport[viewportRow] = line;
      if (line) {
        this.frameStats.materializedRows++;
        this.frameStats.materializedCells += line.length;
      }
      return line;
    };

    // Cursor presentation is native state. Repaint only its old/current rows.
    const cursorMoved =
      cursor.x !== this.lastCursorPosition.x || cursor.y !== this.lastCursorPosition.y;
    const cursorPresentationChanged =
      !this.lastCursorState ||
      cursor.visible !== this.lastCursorState.visible ||
      cursor.blinking !== this.lastCursorState.blinking ||
      cursor.style !== this.lastCursorState.style ||
      cursor.default !== this.lastCursorState.default;
    const cursorRows = new Set<number>();
    const cursorInViewport = historicalRows === 0;
    if (cursorInViewport && (cursorMoved || cursorPresentationChanged || cursor.blinking)) {
      cursorRows.add(cursor.y);
      if (cursorMoved || cursorPresentationChanged) cursorRows.add(this.lastCursorPosition.y);
    }

    // Check if we need to redraw selection-related lines
    const hasSelection = this.selectionManager && this.selectionManager.hasSelection();
    const selectionRows = new Set<number>();

    // Cache selection coordinates for use during cell rendering
    // This is used by isInSelection() to determine if a cell needs selection colors
    this.currentSelectionCoords = hasSelection ? this.selectionManager!.getSelectionCoords() : null;

    // Mark current selection rows for redraw (includes programmatic selections)
    if (this.currentSelectionCoords) {
      const coords = this.currentSelectionCoords;
      for (let row = coords.startRow; row <= coords.endRow; row++) {
        selectionRows.add(row);
      }
    }

    // Always mark dirty selection rows for redraw (to clear old overlay)
    if (this.selectionManager) {
      const dirtyRows = this.selectionManager.getDirtySelectionRows();
      if (dirtyRows.size > 0) {
        for (const row of dirtyRows) {
          selectionRows.add(row);
        }
        // Clear the dirty rows tracking after marking for redraw
        this.selectionManager.clearDirtySelectionRows();
      }
    }

    // Track rows with hyperlinks that need redraw when hover changes
    const hyperlinkRows = new Set<number>();
    const hyperlinkChanged = this.hoveredHyperlinkId !== this.previousHoveredHyperlinkId;
    const linkRangeChanged =
      JSON.stringify(this.hoveredLinkRange) !== JSON.stringify(this.previousHoveredLinkRange);

    if (hyperlinkChanged) {
      // Find rows containing the old or new hovered hyperlink
      // Must check the correct buffer based on viewportY (scrollback vs screen)
      for (let y = 0; y < dims.rows; y++) {
        let line: GhosttyCell[] | null = null;

        // Same logic as rendering: fetch from scrollback or screen
        if (integerViewportY > 0) {
          if (y < historicalRows) {
            line = getHistoricalLine(y);
          } else {
            const screenRow = y - historicalRows;
            line = buffer.getLine(screenRow);
          }
        } else {
          // At bottom - fetch from visible screen
          line = buffer.getLine(y);
        }

        if (line) {
          for (const cell of line) {
            if (
              cell.hyperlink_id === this.hoveredHyperlinkId ||
              cell.hyperlink_id === this.previousHoveredHyperlinkId
            ) {
              hyperlinkRows.add(y);
              break; // Found hyperlink in this row
            }
          }
        }
      }
      // Update previous state
      this.previousHoveredHyperlinkId = this.hoveredHyperlinkId;
    }

    // Track rows affected by link range changes (for regex URLs)
    if (linkRangeChanged) {
      // Add rows from old range
      if (this.previousHoveredLinkRange) {
        for (
          let y = this.previousHoveredLinkRange.startY;
          y <= this.previousHoveredLinkRange.endY;
          y++
        ) {
          hyperlinkRows.add(y);
        }
      }
      // Add rows from new range
      if (this.hoveredLinkRange) {
        for (let y = this.hoveredLinkRange.startY; y <= this.hoveredLinkRange.endY; y++) {
          hyperlinkRows.add(y);
        }
      }
      this.previousHoveredLinkRange = this.hoveredLinkRange;
    }

    // Determine which rows need rendering.
    // We also include adjacent rows (above and below) for each dirty row to handle
    // glyph overflow - tall glyphs like Devanagari vowel signs can extend into
    // adjacent rows' visual space.
    const rowsToRender = new Set<number>();
    for (let y = 0; y < dims.rows; y++) {
      const screenRow = y - historicalRows;
      const needsRender =
        forceAll ||
        (screenRow >= 0 && buffer.isRowDirty(screenRow)) ||
        cursorRows.has(y) ||
        selectionRows.has(y) ||
        hyperlinkRows.has(y);

      if (needsRender) {
        rowsToRender.add(y);
        // Include adjacent rows to handle glyph overflow
        if (y > 0) rowsToRender.add(y - 1);
        if (y < dims.rows - 1) rowsToRender.add(y + 1);
      }
    }

    // Render each line
    for (let y = 0; y < dims.rows; y++) {
      if (!rowsToRender.has(y)) {
        continue;
      }

      // Fetch line from scrollback or visible screen
      let line: GhosttyCell[] | null = null;
      let getGraphemeString: ((column: number) => string) | undefined;
      if (integerViewportY > 0) {
        // Scrolled up - need to fetch from scrollback + visible screen
        // When scrolled up N lines, we want to show:
        // - Scrollback lines (from the end) + visible screen lines

        // Check if this row should come from scrollback or visible screen
        if (y < historicalRows && scrollbackProvider) {
          const scrollbackOffset = scrollbackStart + y;
          line = getHistoricalLine(y);
          if (scrollbackProvider.getScrollbackGraphemeString) {
            getGraphemeString = (column) =>
              scrollbackProvider.getScrollbackGraphemeString!(scrollbackOffset, column);
          }
        } else {
          // This row is from visible screen (lower part of viewport)
          const screenRow = y - historicalRows;
          line = buffer.getLine(screenRow);
          if (buffer.getGraphemeString) {
            getGraphemeString = (column) => buffer.getGraphemeString!(screenRow, column, false);
          }
        }
      } else {
        // At bottom - fetch from visible screen
        line = buffer.getLine(y);
        if (buffer.getGraphemeString) {
          getGraphemeString = (column) => buffer.getGraphemeString!(y, column, false);
        }
      }

      if (line) {
        const cursorColumn = cursorInViewport && cursor.y === y && cursor.visible ? cursor.x : null;
        this.renderLine(line, y, dims.cols, cursorColumn, getGraphemeString);
        this.frameStats.renderedRows++;
        const previousRange = this.renderedRowRanges[this.renderedRowRanges.length - 1];
        if (previousRange?.end === y - 1) {
          previousRange.end = y;
        } else {
          this.renderedRowRanges.push({ start: y, end: y });
        }
      }
    }

    // Selection highlighting is now integrated into renderCellBackground/renderCellText
    // No separate overlay pass needed - this fixes z-order issues with complex glyphs

    // Link underlines are drawn during cell rendering (see renderCell)

    // Render the cursor while the integer text viewport still shows live rows.
    if (cursorInViewport && cursor.visible && this.cursorVisible) {
      this.renderCursor(cursor.x, cursor.y, cursor.style);
    }

    // Render scrollbar if scrolled or scrollback exists (with opacity for fade effect)
    if (scrollbackProvider && scrollbarOpacity > 0) {
      this.renderScrollbar(viewportY, scrollbackLength, dims.rows, scrollbarOpacity);
    }

    // Update last cursor position
    this.lastCursorPosition = { x: cursor.x, y: cursor.y };
    this.lastCursorState = { ...cursor };

    // ALWAYS clear dirty flags after rendering, regardless of forceAll.
    // This is critical - if we don't clear after a full redraw, the dirty
    // state persists and the next frame might not detect new changes properly.
    buffer.clearDirty();
    return cursor;
  }

  /**
   * Render a single line using two-pass approach:
   * 1. First pass: Draw all cell backgrounds
   * 2. Second pass: Draw all cell text and decorations
   *
   * This two-pass approach is necessary for proper rendering of complex scripts
   * like Devanagari where diacritics (like vowel sign ि) can extend LEFT of the
   * base character into the previous cell's visual area. If we draw backgrounds
   * and text in a single pass (cell by cell), the background of cell N would
   * cover any left-extending portions of graphemes from cell N-1.
   */
  private renderLine(
    line: GhosttyCell[],
    y: number,
    cols: number,
    cursorColumn: number | null,
    getGraphemeString?: (column: number) => string
  ): void {
    const lineY = y * this.metrics.height;
    const lineWidth = cols * this.metrics.width;

    // Clear line background then fill with Ghostty's effective color.
    // We clear just the cell area - glyph overflow is handled by also
    // redrawing adjacent rows (see render() method).
    // clearRect is needed because fillRect composites rather than replaces,
    // so transparent/translucent backgrounds wouldn't clear previous content.
    this.ctx.clearRect(0, lineY, lineWidth, this.metrics.height);
    this.ctx.fillStyle = this.rgbToCSS(
      this.effectiveColors.background.r,
      this.effectiveColors.background.g,
      this.effectiveColors.background.b
    );
    this.ctx.fillRect(0, lineY, lineWidth, this.metrics.height);

    // PASS 1: Draw all cell backgrounds first
    // This ensures all backgrounds are painted before any text, allowing text
    // to "bleed" across cell boundaries without being covered by adjacent backgrounds
    for (let x = 0; x < line.length; x++) {
      const cell = line[x];
      if (cell.width === 0) continue; // Skip spacer cells for wide characters
      this.renderCellBackground(cell, x, y);
    }

    // PASS 2: Draw bounded same-style runs. Ghostty cells remain authoritative:
    // only conservative width-1 ASCII cells may join, and every run is clipped
    // to the horizontal span of its source cells.
    const textCells: TextRunCell[] = [];
    for (let x = 0; x < line.length; x++) {
      const cell = line[x];
      if (cell.width === 0) continue; // Skip spacer cells for wide characters
      const prepared = this.prepareTextRunCell(cell, x, y, cursorColumn, getGraphemeString);
      if (prepared) textCells.push(prepared);
    }

    for (const run of this.buildTextRuns(textCells)) {
      this.renderTextRun(run, y);
      this.frameStats.textRuns++;
      this.frameStats.maxRunCells = Math.max(this.frameStats.maxRunCells, run.cells.length);
      if (this.fontLigatures && run.cells.length > 1) {
        this.frameStats.shapedRuns++;
        this.frameStats.shapedCells += run.cells.length;
      }
    }

    // Decorations retain exact cell ownership even when their text shaped as a run.
    for (const prepared of textCells) {
      this.renderCellDecorations(prepared, y);
    }
  }

  private prepareTextRunCell(
    cell: GhosttyCell,
    x: number,
    y: number,
    cursorColumn: number | null,
    getGraphemeString?: (column: number) => string,
    colorOverride?: string
  ): TextRunCell | null {
    if (cell.flags & CellFlags.INVISIBLE) return null;

    const isSelected = this.isInSelection(x, y);
    const fontStyle = `${cell.flags & CellFlags.ITALIC ? 'italic ' : ''}${
      cell.flags & CellFlags.BOLD ? 'bold ' : ''
    }`;
    const font = `${fontStyle}${this.fontSize}px ${this.fontFamily}`;

    let fillStyle: string;
    if (colorOverride) {
      fillStyle = colorOverride;
    } else if (isSelected) {
      fillStyle = this.theme.selectionForeground;
    } else {
      const inverse = (cell.flags & CellFlags.INVERSE) !== 0;
      fillStyle = this.rgbToCSS(
        inverse ? cell.bg_r : cell.fg_r,
        inverse ? cell.bg_g : cell.fg_g,
        inverse ? cell.bg_b : cell.fg_b
      );
    }

    const text =
      cell.grapheme_len > 0 && getGraphemeString
        ? getGraphemeString(x)
        : String.fromCodePoint(cell.codepoint || 32);
    const isAscii = cell.codepoint >= 0x20 && cell.codepoint <= 0x7e;
    const cursorOwned = cursorColumn === x;
    const advance =
      this.fontLigatures && !cursorOwned && cell.width === 1 && cell.grapheme_len === 0 && isAscii
        ? this.getGlyphAdvance(font, text)
        : null;
    const joinable = advance !== null && Number.isFinite(advance);
    const regexHovered = this.isInHoveredLinkRange(x, y);
    const alpha = cell.flags & CellFlags.FAINT ? 0.5 : 1;

    // Full flags intentionally participate: even decorations are presentation
    // boundaries, while hyperlink and regex hover identities preserve exact spans.
    const styleKey = [
      cell.flags,
      font,
      fillStyle,
      cell.fg_r,
      cell.fg_g,
      cell.fg_b,
      cell.bg_r,
      cell.bg_g,
      cell.bg_b,
      alpha,
      isSelected,
      cell.hyperlink_id,
      regexHovered,
      cell.width,
      cursorOwned ? `cursor:${x}` : 'no-cursor',
      isAscii ? 'ascii' : `fallback:${cell.codepoint}`,
    ].join('|');

    return { cell, column: x, text, font, fillStyle, alpha, styleKey, joinable, advance };
  }

  private getGlyphAdvance(font: string, text: string): number | null {
    const key = `${font}\0${text}`;
    const cached = this.glyphAdvanceCache.get(key);
    if (cached !== undefined) return cached;

    this.ctx.font = font;
    const width = this.ctx.measureText(text).width;
    this.frameStats.textMeasurements++;
    if (!Number.isFinite(width) || width <= 0) return null;

    if (this.glyphAdvanceCache.size >= MAX_GLYPH_ADVANCE_CACHE_ENTRIES) {
      this.glyphAdvanceCache.clear();
    }
    this.glyphAdvanceCache.set(key, width);
    return width;
  }

  private measureRunWidth(font: string, text: string): number | null {
    this.ctx.font = font;
    const width = this.ctx.measureText(text).width;
    this.frameStats.textMeasurements++;
    return Number.isFinite(width) && width > 0 ? width : null;
  }

  private advancesMatch(left: number | null, right: number | null): boolean {
    return left !== null && right !== null && Math.abs(left - right) <= ADVANCE_EPSILON;
  }

  private buildTextRuns(cells: TextRunCell[]): TextRun[] {
    const runs: TextRun[] = [];

    for (const prepared of cells) {
      const previous = runs[runs.length - 1];
      const previousLastCell = previous?.cells[previous.cells.length - 1];
      const canJoin =
        prepared.joinable &&
        previous !== undefined &&
        previousLastCell?.joinable &&
        previous.cells[0].styleKey === prepared.styleKey &&
        previous.endColumn === prepared.column &&
        previous.cells.length < MAX_SHAPED_RUN_CELLS &&
        this.advancesMatch(previousLastCell.advance, prepared.advance);

      if (canJoin) {
        const candidateText = previous.text + prepared.text;
        const measuredWidth = this.measureRunWidth(prepared.font, candidateText);
        const expectedWidth = previous.expectedWidth + (prepared.advance ?? 0);
        if (measuredWidth !== null && Math.abs(measuredWidth - expectedWidth) <= ADVANCE_EPSILON) {
          previous.cells.push(prepared);
          previous.endColumn = prepared.column + prepared.cell.width;
          previous.text = candidateText;
          previous.measuredWidth = measuredWidth;
          previous.expectedWidth = expectedWidth;
          continue;
        }
      }

      runs.push({
        cells: [prepared],
        startColumn: prepared.column,
        endColumn: prepared.column + prepared.cell.width,
        text: prepared.text,
        measuredWidth: prepared.advance,
        expectedWidth: prepared.advance ?? 0,
      });
    }

    return runs;
  }

  private renderTextRun(run: TextRun, y: number): void {
    const first = run.cells[0];
    const startX = run.startColumn * this.metrics.width;
    const ownedWidth = (run.endColumn - run.startColumn) * this.metrics.width;
    const canvasHeight = this.canvas.height / this.devicePixelRatio;
    const cellY = y * this.metrics.height;
    const powerlineSeparator =
      run.cells.length === 1 && isPowerlineSeparator(first.cell) ? first.cell.codepoint : null;
    const boxDrawingGlyph = run.cells.length === 1 ? getBoxDrawingGlyph(first.cell) : undefined;
    const ownsCellGeometry = powerlineSeparator !== null || boxDrawingGlyph !== undefined;

    this.ctx.save();
    this.ctx.beginPath();
    if (ownsCellGeometry) {
      // Custom geometry must never bleed into a neighboring cell. Ordinary text
      // retains the established vertical overflow behavior for complex scripts.
      this.ctx.rect(startX, cellY, ownedWidth, this.metrics.height);
    } else {
      // Clip horizontally to the Ghostty-owned columns while retaining the
      // renderer's established vertical overflow behavior for complex glyphs.
      this.ctx.rect(startX, 0, ownedWidth, canvasHeight);
    }
    this.ctx.clip();
    this.ctx.font = first.font;
    this.ctx.fillStyle = first.fillStyle;
    this.ctx.globalAlpha = first.alpha;
    if (powerlineSeparator !== null) {
      this.drawPowerlineSeparator(powerlineSeparator, startX, cellY, ownedWidth);
    } else if (boxDrawingGlyph) {
      this.drawBoxDrawingGlyph(boxDrawingGlyph, startX, cellY, ownedWidth);
    } else if (run.cells.length > 1 && run.measuredWidth !== null) {
      this.ctx.translate(startX, 0);
      this.ctx.scale(ownedWidth / run.measuredWidth, 1);
      this.ctx.fillText(run.text, 0, cellY + this.metrics.baseline);
    } else {
      this.ctx.fillText(run.text, startX, cellY + this.metrics.baseline);
    }
    this.ctx.restore();
  }

  /** Draw a focused set of uniform light/heavy box glyphs on the device-pixel grid. */
  private drawBoxDrawingGlyph(
    glyph: BoxDrawingGlyph,
    cellX: number,
    cellY: number,
    cellWidth: number
  ): void {
    const cellHeight = this.metrics.height;
    const right = cellX + cellWidth;
    const bottom = cellY + cellHeight;
    const centerX = this.snapStrokeCenter(cellX + cellWidth / 2);
    const centerY = this.snapStrokeCenter(cellY + cellHeight / 2);
    const thickness = glyph.physicalStrokeWidth / this.devicePixelRatio;
    const halfThickness = thickness / 2;
    const { directions } = glyph;

    if (glyph.rounded) {
      const turnsUp = (directions & BOX_UP) !== 0;
      const turnsLeft = (directions & BOX_LEFT) !== 0;
      const radius = Math.min(cellWidth, cellHeight) / 4;

      this.ctx.beginPath();
      this.ctx.moveTo(centerX, turnsUp ? cellY : bottom);
      this.ctx.lineTo(centerX, centerY + (turnsUp ? -radius : radius));
      this.ctx.quadraticCurveTo(
        centerX,
        centerY,
        centerX + (turnsLeft ? -radius : radius),
        centerY
      );
      this.ctx.lineTo(turnsLeft ? cellX : right, centerY);
      this.ctx.strokeStyle = this.ctx.fillStyle;
      this.ctx.lineWidth = thickness;
      this.ctx.lineCap = 'butt';
      this.ctx.lineJoin = 'round';
      this.ctx.stroke();
      return;
    }

    this.ctx.beginPath();
    if (directions & (BOX_LEFT | BOX_RIGHT)) {
      const left = directions & BOX_LEFT ? cellX : centerX - halfThickness;
      const horizontalRight = directions & BOX_RIGHT ? right : centerX + halfThickness;
      this.ctx.rect(left, centerY - halfThickness, horizontalRight - left, thickness);
    }
    if (directions & (BOX_UP | BOX_DOWN)) {
      const top = directions & BOX_UP ? cellY : centerY - halfThickness;
      const verticalBottom = directions & BOX_DOWN ? bottom : centerY + halfThickness;
      this.ctx.rect(centerX - halfThickness, top, thickness, verticalBottom - top);
    }
    this.ctx.fill();
  }

  private snapStrokeCenter(cssCoordinate: number): number {
    return (Math.floor(cssCoordinate * this.devicePixelRatio) + 0.5) / this.devicePixelRatio;
  }

  /** Draw the canonical Powerline separators as cell-sized vector geometry. */
  private drawPowerlineSeparator(
    codepoint: number,
    cellX: number,
    cellY: number,
    cellWidth: number
  ): void {
    const cellHeight = this.metrics.height;
    const right = cellX + cellWidth;
    const bottom = cellY + cellHeight;
    const middle = cellY + cellHeight / 2;

    this.ctx.beginPath();
    switch (codepoint) {
      case 0xe0b0: // Solid right-pointing triangle
      case 0xe0b1: // Right-pointing chevron
        this.ctx.moveTo(cellX, cellY);
        this.ctx.lineTo(right, middle);
        this.ctx.lineTo(cellX, bottom);
        break;
      case 0xe0b2: // Solid left-pointing triangle
      case 0xe0b3: // Left-pointing chevron
        this.ctx.moveTo(right, cellY);
        this.ctx.lineTo(cellX, middle);
        this.ctx.lineTo(right, bottom);
        break;
      case 0xe0b4: // Solid right half-circle
      case 0xe0b5: // Right half-circle outline
        this.ctx.moveTo(cellX, cellY);
        this.ctx.ellipse(cellX, middle, cellWidth, cellHeight / 2, 0, -Math.PI / 2, Math.PI / 2);
        break;
      case 0xe0b6: // Solid left half-circle
      case 0xe0b7: // Left half-circle outline
        this.ctx.moveTo(right, bottom);
        this.ctx.ellipse(right, middle, cellWidth, cellHeight / 2, 0, Math.PI / 2, Math.PI * 1.5);
        break;
    }

    if ((codepoint & 1) === 0) {
      this.ctx.closePath();
      this.ctx.fill();
      return;
    }

    // Keep outlines one physical pixel wide at fractional and high DPRs.
    this.ctx.strokeStyle = this.ctx.fillStyle;
    this.ctx.lineWidth = 1 / this.devicePixelRatio;
    this.ctx.lineCap = 'butt';
    this.ctx.lineJoin = 'miter';
    this.ctx.stroke();
  }

  private renderCellDecorations(prepared: TextRunCell, y: number): void {
    const { cell, column: x, fillStyle } = prepared;
    const cellX = x * this.metrics.width;
    const cellY = y * this.metrics.height;
    const cellWidth = this.metrics.width * cell.width;

    this.ctx.strokeStyle = fillStyle;
    this.ctx.lineWidth = 1;

    if (cell.flags & CellFlags.UNDERLINE) {
      const underlineY = cellY + this.metrics.baseline + 2;
      this.ctx.beginPath();
      this.ctx.moveTo(cellX, underlineY);
      this.ctx.lineTo(cellX + cellWidth, underlineY);
      this.ctx.stroke();
    }

    if (cell.flags & CellFlags.STRIKETHROUGH) {
      const strikeY = cellY + this.metrics.height / 2;
      this.ctx.beginPath();
      this.ctx.moveTo(cellX, strikeY);
      this.ctx.lineTo(cellX + cellWidth, strikeY);
      this.ctx.stroke();
    }

    const hyperlinkHovered = cell.hyperlink_id > 0 && cell.hyperlink_id === this.hoveredHyperlinkId;
    if (hyperlinkHovered || this.isInHoveredLinkRange(x, y)) {
      const underlineY = cellY + this.metrics.baseline + 2;
      this.ctx.strokeStyle = '#4A90E2';
      this.ctx.beginPath();
      this.ctx.moveTo(cellX, underlineY);
      this.ctx.lineTo(cellX + cellWidth, underlineY);
      this.ctx.stroke();
    }
  }

  /**
   * Render a cell's background only (Pass 1 of two-pass rendering)
   * Selection highlighting is integrated here to avoid z-order issues with
   * complex glyphs (like Devanagari) that extend outside their cell bounds.
   */
  private renderCellBackground(cell: GhosttyCell, x: number, y: number): void {
    const cellX = x * this.metrics.width;
    const cellY = y * this.metrics.height;
    const cellWidth = this.metrics.width * cell.width;

    // Check if this cell is selected
    const isSelected = this.isInSelection(x, y);

    if (isSelected) {
      // Draw selection background (solid color, not overlay)
      this.ctx.fillStyle = this.theme.selectionBackground;
      this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
      return; // Selection background replaces cell background
    }

    // Extract background color and handle inverse
    let bg_r = cell.bg_r,
      bg_g = cell.bg_g,
      bg_b = cell.bg_b;

    if (cell.flags & CellFlags.INVERSE) {
      // When inverted, background becomes foreground
      bg_r = cell.fg_r;
      bg_g = cell.fg_g;
      bg_b = cell.fg_b;
    }

    // The line was already filled with Ghostty's effective background.
    const effectiveBackground = this.effectiveColors.background;
    const isDefaultBg =
      bg_r === effectiveBackground.r &&
      bg_g === effectiveBackground.g &&
      bg_b === effectiveBackground.b;
    if (!isDefaultBg) {
      this.ctx.fillStyle = this.rgbToCSS(bg_r, bg_g, bg_b);
      this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
    }
  }

  /**
   * Render a cell's text and decorations (Pass 2 of two-pass rendering)
   * Selection foreground color is applied here to match the selection background.
   */
  private renderCellText(cell: GhosttyCell, x: number, y: number, colorOverride?: string): void {
    const prepared = this.prepareTextRunCell(
      cell,
      x,
      y,
      x,
      this.currentBuffer?.getGraphemeString
        ? (column) => this.currentBuffer!.getGraphemeString!(y, column)
        : undefined,
      colorOverride
    );
    if (!prepared) return;
    this.renderTextRun(
      {
        cells: [prepared],
        startColumn: x,
        endColumn: x + cell.width,
        text: prepared.text,
        measuredWidth: prepared.advance,
        expectedWidth: prepared.advance ?? 0,
      },
      y
    );
    this.frameStats.textRuns++;
    this.frameStats.maxRunCells = Math.max(this.frameStats.maxRunCells, 1);
    this.renderCellDecorations(prepared, y);
  }

  /**
   * Render cursor
   */
  private renderCursor(x: number, y: number, style: CursorStyle): void {
    const cursorX = x * this.metrics.width;
    const cursorY = y * this.metrics.height;

    this.ctx.fillStyle = this.rgbToCSS(
      this.effectiveColors.cursor.r,
      this.effectiveColors.cursor.g,
      this.effectiveColors.cursor.b
    );

    switch (style) {
      case 'block':
        // Full cell block
        this.ctx.fillRect(cursorX, cursorY, this.metrics.width, this.metrics.height);
        // Re-draw character under cursor with cursorAccent color
        {
          const line = this.currentBuffer?.getLine(y);
          if (line?.[x]) {
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(cursorX, cursorY, this.metrics.width, this.metrics.height);
            this.ctx.clip();
            this.renderCellText(line[x], x, y, this.theme.cursorAccent);
            this.ctx.restore();
          }
        }
        break;

      case 'block_hollow':
        this.ctx.strokeStyle = this.ctx.fillStyle;
        this.ctx.lineWidth = 1;
        this.ctx.strokeRect(
          cursorX + 0.5,
          cursorY + 0.5,
          Math.max(0, this.metrics.width - 1),
          Math.max(0, this.metrics.height - 1)
        );
        break;

      case 'underline':
        // Underline at bottom of cell
        const underlineHeight = Math.max(2, Math.floor(this.metrics.height * 0.15));
        this.ctx.fillRect(
          cursorX,
          cursorY + this.metrics.height - underlineHeight,
          this.metrics.width,
          underlineHeight
        );
        break;

      case 'bar':
        // Vertical bar at left of cell
        const barWidth = Math.max(2, Math.floor(this.metrics.width * 0.15));
        this.ctx.fillRect(cursorX, cursorY, barWidth, this.metrics.height);
        break;
    }
  }

  // ==========================================================================
  // Cursor Blinking
  // ==========================================================================

  private startCursorBlink(): void {
    // xterm.js uses ~530ms blink interval
    this.cursorBlinkInterval = window.setInterval(() => {
      this.cursorVisible = !this.cursorVisible;
      this.requestRender();
    }, 530);
  }

  private stopCursorBlink(): void {
    if (this.cursorBlinkInterval !== undefined) {
      clearInterval(this.cursorBlinkInterval);
      this.cursorBlinkInterval = undefined;
    }
    this.cursorVisible = true;
  }

  /** Reconcile animation ownership from the current native RenderState snapshot. */
  private reconcileCursorBlink(enabled: boolean): void {
    if (enabled === this.cursorBlink) {
      if (enabled && !this.renderPaused && this.cursorBlinkInterval === undefined) {
        this.startCursorBlink();
      }
      return;
    }

    this.cursorBlink = enabled;
    if (enabled) {
      this.cursorVisible = true;
      if (!this.renderPaused) this.startCursorBlink();
    } else {
      this.stopCursorBlink();
    }
  }

  /** Make a blinking cursor visible now and restart its idle cadence. */
  public resetCursorBlink(): void {
    if (!this.cursorBlink || this.renderPaused) return;
    this.stopCursorBlink();
    this.startCursorBlink();
    this.requestRender();
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Update theme colors
   */
  public setTheme(theme: ITheme): void {
    this.theme = normalizeTheme(theme);
    this.requestRender();
  }

  /**
   * Update font size
   */
  public setFontSize(size: number): void {
    this.fontSize = size;
    this.glyphAdvanceCache.clear();
    this.metrics = this.measureFont();
    this.requestRender();
  }

  /**
   * Update font family
   */
  public setFontFamily(family: string): void {
    this.fontFamily = family;
    this.glyphAdvanceCache.clear();
    this.metrics = this.measureFont();
    this.requestRender();
  }

  /** Enable bounded same-style shaping or retain isolated cell glyph draws. */
  public setFontLigatures(enabled: boolean): void {
    if (this.fontLigatures === enabled) return;
    this.fontLigatures = enabled;
    this.requestRender(true);
  }

  /** Suspend or resume cursor presentation timing with terminal rendering. */
  public setRenderPaused(paused: boolean): void {
    if (this.renderPaused === paused) return;

    this.renderPaused = paused;
    if (paused) {
      this.stopCursorBlink();
    }
  }

  /**
   * Get current font metrics
   */

  /**
   * Render scrollbar (Phase 2)
   * Shows scroll position and allows click/drag interaction
   * @param opacity Opacity level (0-1) for fade in/out effect
   */
  private renderScrollbar(
    viewportY: number,
    scrollbackLength: number,
    visibleRows: number,
    opacity: number = 1
  ): void {
    const ctx = this.ctx;
    const canvasHeight = this.canvas.height / this.devicePixelRatio;
    const canvasWidth = this.canvas.width / this.devicePixelRatio;

    // Scrollbar dimensions
    const scrollbarWidth = 8;
    const scrollbarX = canvasWidth - scrollbarWidth - 4;
    const scrollbarPadding = 4;
    const scrollbarTrackHeight = canvasHeight - scrollbarPadding * 2;

    // Always clear the scrollbar area first (fixes ghosting when fading out)
    ctx.clearRect(scrollbarX - 2, 0, scrollbarWidth + 6, canvasHeight);
    ctx.fillStyle = this.rgbToCSS(
      this.effectiveColors.background.r,
      this.effectiveColors.background.g,
      this.effectiveColors.background.b
    );
    ctx.fillRect(scrollbarX - 2, 0, scrollbarWidth + 6, canvasHeight);

    // Don't draw scrollbar if fully transparent or no scrollback
    if (opacity <= 0 || scrollbackLength === 0) return;

    // Calculate scrollbar thumb size and position
    const totalLines = scrollbackLength + visibleRows;
    const thumbHeight = Math.max(20, (visibleRows / totalLines) * scrollbarTrackHeight);

    // Position: 0 = at bottom, scrollbackLength = at top
    const scrollPosition = viewportY / scrollbackLength; // 0 to 1
    const thumbY = scrollbarPadding + (scrollbarTrackHeight - thumbHeight) * (1 - scrollPosition);

    // Draw scrollbar track (subtle background) with opacity
    ctx.fillStyle = `rgba(128, 128, 128, ${0.1 * opacity})`;
    ctx.fillRect(scrollbarX, scrollbarPadding, scrollbarWidth, scrollbarTrackHeight);

    // Draw scrollbar thumb with opacity
    const isScrolled = viewportY > 0;
    const baseOpacity = isScrolled ? 0.5 : 0.3;
    ctx.fillStyle = `rgba(128, 128, 128, ${baseOpacity * opacity})`;
    ctx.fillRect(scrollbarX, thumbY, scrollbarWidth, thumbHeight);
  }
  public getMetrics(): FontMetrics {
    return { ...this.metrics };
  }

  /**
   * Get canvas element (needed by SelectionManager)
   */
  public getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /**
   * Set selection manager (for rendering selection)
   */
  public setSelectionManager(manager: SelectionManager): void {
    this.selectionManager = manager;
  }

  /**
   * Check if a cell at (x, y) is within the current selection.
   * Uses cached selection coordinates for performance.
   */
  private isInSelection(x: number, y: number): boolean {
    const sel = this.currentSelectionCoords;
    if (!sel) return false;

    const { startCol, startRow, endCol, endRow } = sel;

    // Single line selection
    if (startRow === endRow) {
      return y === startRow && x >= startCol && x <= endCol;
    }

    // Multi-line selection
    if (y === startRow) {
      // First line: from startCol to end of line
      return x >= startCol;
    } else if (y === endRow) {
      // Last line: from start of line to endCol
      return x <= endCol;
    } else if (y > startRow && y < endRow) {
      // Middle lines: entire line is selected
      return true;
    }

    return false;
  }

  private isInHoveredLinkRange(x: number, y: number): boolean {
    const range = this.hoveredLinkRange;
    if (!range) return false;
    return (
      (y === range.startY && x >= range.startX && (y < range.endY || x <= range.endX)) ||
      (y > range.startY && y < range.endY) ||
      (y === range.endY && x <= range.endX && (y > range.startY || x >= range.startX))
    );
  }

  /**
   * Set the currently hovered hyperlink ID for rendering underlines
   */
  public setHoveredHyperlinkId(hyperlinkId: number): void {
    this.hoveredHyperlinkId = hyperlinkId;
    this.requestRender();
  }

  /**
   * Set the currently hovered link range for rendering underlines (for regex-detected URLs)
   * Pass null to clear the hover state
   */
  public setHoveredLinkRange(
    range: {
      startX: number;
      startY: number;
      endX: number;
      endY: number;
    } | null
  ): void {
    this.hoveredLinkRange = range;
    this.requestRender();
  }

  /** Current cursor presentation state, exposed through terminal diagnostics. */
  public getCursorVisible(): boolean {
    return this.cursorVisible;
  }

  public getFrameStats(): RendererFrameStats {
    return { ...this.frameStats };
  }

  /** Contiguous viewport-row ranges actually painted by the most recent frame. */
  public getRenderedRowRanges(): RendererRowRange[] {
    return this.renderedRowRanges.map((range) => ({ ...range }));
  }

  /**
   * Get character cell width (for coordinate conversion)
   */
  public get charWidth(): number {
    return this.metrics.width;
  }

  /**
   * Get character cell height (for coordinate conversion)
   */
  public get charHeight(): number {
    return this.metrics.height;
  }

  /**
   * Clear entire canvas
   */
  public clear(): void {
    // clearRect first because fillRect composites rather than replaces,
    // so transparent/translucent backgrounds wouldn't clear previous content.
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.fillStyle = this.rgbToCSS(
      this.effectiveColors.background.r,
      this.effectiveColors.background.g,
      this.effectiveColors.background.b
    );
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Cleanup resources
   */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('resize', this.handleDevicePixelRatioSignal);
    this.unwatchCurrentResolution();
    this.stopCursorBlink();
  }
}
