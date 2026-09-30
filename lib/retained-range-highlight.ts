import type { IRetainedBufferRange, IRetainedRangeHighlightStyle } from './interfaces';

export interface RetainedRangeHighlightFrame {
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  devicePixelRatio: number;
  firstVisibleRow: number;
  alternateScreen: boolean;
  endCellWidth(row: number, column: number): number;
}

/** A single engine-owned search-range surface, painted by the existing renderer. */
export class RetainedRangeHighlight {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private disposed = false;

  constructor(
    private readonly sourceCanvas: HTMLCanvasElement,
    private readonly resolveRange: () => IRetainedBufferRange | undefined,
    private readonly style: IRetainedRangeHighlightStyle
  ) {
    this.canvas = document.createElement('canvas');
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('Unable to create retained-range highlight surface');
    this.context = context;
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.dataset.ghosttyRetainedRangeHighlight = '';
    Object.assign(this.canvas.style, {
      position: 'absolute',
      pointerEvents: 'none',
      visibility: 'hidden',
      color: style.fill,
      borderColor: style.border,
    });
    sourceCanvas.parentElement?.append(this.canvas);
  }

  hide(): void {
    this.canvas.style.visibility = 'hidden';
  }

  paint(frame: RetainedRangeHighlightFrame): boolean {
    if (this.disposed) return false;
    const range = this.resolveRange();
    if (!range) return false;
    if (frame.alternateScreen) {
      this.hide();
      return true;
    }
    if (this.canvas.width !== this.sourceCanvas.width) this.canvas.width = this.sourceCanvas.width;
    if (this.canvas.height !== this.sourceCanvas.height)
      this.canvas.height = this.sourceCanvas.height;
    Object.assign(this.canvas.style, {
      left: `${this.sourceCanvas.offsetLeft}px`,
      top: `${this.sourceCanvas.offsetTop}px`,
      width: this.sourceCanvas.style.width,
      height: this.sourceCanvas.style.height,
      visibility: '',
    });
    const ctx = this.context;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(frame.devicePixelRatio, 0, 0, frame.devicePixelRatio, 0, 0);
    const presentation = getComputedStyle(this.canvas);
    ctx.fillStyle = presentation.color;
    ctx.strokeStyle = presentation.borderTopColor;
    ctx.lineWidth = this.style.borderWidth;
    const lastVisibleRow = frame.firstVisibleRow + frame.rows - 1;
    const startRow = Math.max(range.start.row, frame.firstVisibleRow);
    const endRow = Math.min(range.end.row, lastVisibleRow);
    for (let row = startRow; row <= endRow; row++) {
      const startColumn = row === range.start.row ? range.start.column : 0;
      const endColumn =
        row === range.end.row
          ? range.end.column + Math.max(1, frame.endCellWidth(row, range.end.column))
          : frame.cols;
      const left = Math.max(0, startColumn) * frame.cellWidth;
      const top = (row - frame.firstVisibleRow) * frame.cellHeight;
      const width = (Math.min(frame.cols, endColumn) - Math.max(0, startColumn)) * frame.cellWidth;
      if (width <= 0) continue;
      ctx.fillRect(left, top, width, frame.cellHeight);
      const inset = Math.min(this.style.borderWidth, width, frame.cellHeight) / 2;
      if (inset > 0)
        ctx.strokeRect(left + inset, top + inset, width - inset * 2, frame.cellHeight - inset * 2);
    }
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.remove();
  }
}
