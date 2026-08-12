import type { IBuffer, IBufferLine, IBufferRange } from './interfaces';
import type { LinkDetector } from './link-detector';
import type { Terminal } from './terminal';
import type { ILink, RenderStateCursor } from './types';

const MAX_SELECTION_PREVIEW_CHARS = 512;
const MAX_SELECTION_PREVIEW_ROWS = 16;
const MAX_ANNOUNCEMENT_CHARS = 512;
const MAX_ANNOUNCEMENT_ROWS = 3;

let nextAccessibilityId = 1;

interface CellText {
  column: number;
  width: number;
  text: string;
}

interface RowBaseSnapshot {
  screen: 'normal' | 'alternate';
  absoluteRow: number;
  setSize: number;
  text: string;
  cells: CellText[];
  cursorColumn: number | null;
  selection: IBufferRange | undefined;
  selectionContinuesAbove: boolean;
  selectionContinuesBelow: boolean;
}

interface RowState {
  base: RowBaseSnapshot | null;
  links: ILink[];
  linkSignature: string;
  linkGeneration: number;
}

interface PresentedState {
  screen: 'normal' | 'alternate';
  cursorAbsoluteRow: number;
}

function sameSelection(left: IBufferRange | undefined, right: IBufferRange | undefined): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.start.x === right.start.x &&
      left.start.y === right.start.y &&
      left.end.x === right.end.x &&
      left.end.y === right.end.y)
  );
}

function sameCells(left: CellText[], right: CellText[]): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (cell, index) =>
      cell.column === right[index].column &&
      cell.width === right[index].width &&
      cell.text === right[index].text
  );
}

function sameBaseSnapshot(left: RowBaseSnapshot | null, right: RowBaseSnapshot): boolean {
  return (
    left !== null &&
    left.screen === right.screen &&
    left.absoluteRow === right.absoluteRow &&
    left.setSize === right.setSize &&
    left.text === right.text &&
    left.cursorColumn === right.cursorColumn &&
    left.selectionContinuesAbove === right.selectionContinuesAbove &&
    left.selectionContinuesBelow === right.selectionContinuesBelow &&
    sameSelection(left.selection, right.selection) &&
    sameCells(left.cells, right.cells)
  );
}

function isPositionInLink(column: number, row: number, link: ILink): boolean {
  const { start, end } = link.range;
  if (row < start.y || row > end.y) return false;
  if (start.y === end.y) return column >= start.x && column <= end.x;
  if (row === start.y) return column >= start.x;
  if (row === end.y) return column <= end.x;
  return true;
}

function linksSignature(links: ILink[]): string {
  return links
    .map(
      (link) =>
        `${link.range.start.y}:${link.range.start.x}-${link.range.end.y}:${link.range.end.x}:${link.text}`
    )
    .join('\u0000');
}

/**
 * A bounded DOM mirror of the currently presented terminal viewport.
 *
 * The Canvas remains the visual source of truth. This mirror keeps exactly one
 * persistent list item per visible row and updates it from the same presented
 * row ranges, making terminal text inspectable without mirroring scrollback.
 */
export class AccessibilityManager {
  private readonly root: HTMLDivElement;
  private readonly rowContainer: HTMLDivElement;
  private readonly cursorContext: HTMLDivElement;
  private readonly selectionContext: HTMLDivElement;
  private readonly liveRegion: HTMLDivElement;
  private readonly rowElements: HTMLDivElement[] = [];
  private readonly rowStates: RowState[] = [];
  private readonly rowRevisions: number[] = [];
  private readonly originalControls: string | null;
  private readonly originalDescribedBy: string | null;
  private disposed = false;
  private lastScreen: 'normal' | 'alternate' | undefined;
  private lastViewportTop: number | undefined;
  private lastSelectionContext = '';
  private lastCursorContext = '';
  private presentedState: PresentedState | undefined;

  constructor(
    private readonly terminal: Terminal,
    private readonly input: HTMLTextAreaElement,
    private readonly linkDetector: LinkDetector,
    host: HTMLElement
  ) {
    const id = nextAccessibilityId++;
    this.root = document.createElement('div');
    this.rowContainer = document.createElement('div');
    this.cursorContext = document.createElement('div');
    this.selectionContext = document.createElement('div');
    this.liveRegion = document.createElement('div');
    this.originalControls = input.getAttribute('aria-controls');
    this.originalDescribedBy = input.getAttribute('aria-describedby');

    const rowContainerId = `ghostty-screen-${id}`;
    const cursorContextId = `ghostty-cursor-${id}`;
    const selectionContextId = `ghostty-selection-${id}`;

    try {
      this.root.dataset.ghosttyAccessibility = '';
      this.root.setAttribute('contenteditable', 'false');
      this.root.style.position = 'absolute';
      this.root.style.width = '1px';
      this.root.style.height = '1px';
      this.root.style.padding = '0';
      this.root.style.margin = '-1px';
      this.root.style.overflow = 'hidden';
      this.root.style.clipPath = 'inset(50%)';
      this.root.style.whiteSpace = 'nowrap';
      this.root.style.border = '0';

      this.rowContainer.id = rowContainerId;
      this.rowContainer.dataset.ghosttyAccessibilityRows = '';
      this.rowContainer.setAttribute('role', 'list');
      this.rowContainer.setAttribute('aria-label', 'Terminal screen');
      this.rowContainer.setAttribute('aria-live', 'off');

      this.cursorContext.id = cursorContextId;
      this.cursorContext.dataset.ghosttyAccessibilityCursor = '';
      this.cursorContext.setAttribute('aria-live', 'off');

      this.selectionContext.id = selectionContextId;
      this.selectionContext.dataset.ghosttyAccessibilitySelection = '';
      this.selectionContext.setAttribute('aria-live', 'off');

      this.liveRegion.dataset.ghosttyAccessibilityLive = '';
      this.liveRegion.setAttribute('aria-live', 'polite');
      this.liveRegion.setAttribute('aria-atomic', 'true');
      this.liveRegion.setAttribute('aria-relevant', 'additions text');

      this.root.append(
        this.rowContainer,
        this.cursorContext,
        this.selectionContext,
        this.liveRegion
      );
      this.ensureRowCount();
      host.appendChild(this.root);

      input.setAttribute(
        'aria-controls',
        this.appendIdReference(this.originalControls, rowContainerId)
      );
      input.setAttribute(
        'aria-describedby',
        this.appendIdReference(this.originalDescribedBy, cursorContextId, selectionContextId)
      );
    } catch (error) {
      this.root.remove();
      this.restoreInputAssociations();
      throw error;
    }
  }

  /** Update the mirror from one completed Canvas presentation frame. */
  updateFrame(ranges: readonly { start: number; end: number }[], cursor: RenderStateCursor): void {
    if (this.disposed) return;

    try {
      this.ensureRowCount();
      const buffer = this.terminal.buffer.active;
      const screen = buffer.type;
      const viewportTop = buffer.viewportY;
      const mappingChanged = screen !== this.lastScreen || viewportTop !== this.lastViewportTop;
      const rows = mappingChanged ? this.allViewportRows() : this.rowsInRanges(ranges);
      const selection = this.terminal.getSelectionPosition();
      const cursorAbsoluteRow = buffer.baseY + cursor.y;
      const previousRowText = new Map<number, string>();
      for (const state of this.rowStates) {
        if (state.base?.screen === screen) {
          previousRowText.set(state.base.absoluteRow, state.base.text);
        }
      }
      const textChangedRows = new Set<number>();

      for (const viewportRow of rows) {
        this.updateRow(viewportRow, buffer, screen, viewportTop, cursor, selection);
        const base = this.rowStates[viewportRow]?.base;
        if (
          base &&
          (previousRowText.has(base.absoluteRow)
            ? previousRowText.get(base.absoluteRow) !== base.text
            : base.text.length > 0)
        ) {
          textChangedRows.add(base.absoluteRow);
        }
      }

      this.updateContexts(buffer, cursor, cursorAbsoluteRow, selection);
      this.updateAnnouncement(buffer, screen, cursorAbsoluteRow, textChangedRows);
      this.lastScreen = screen;
      this.lastViewportTop = viewportTop;
      this.presentedState = { screen, cursorAbsoluteRow };
    } catch (error) {
      // Accessibility must fail soft without interrupting terminal presentation
      // or preventing public render/cursor events from being delivered.
      console.error('Terminal accessibility update failed:', error);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (let index = 0; index < this.rowRevisions.length; index++) {
      this.rowRevisions[index]++;
    }
    this.restoreInputAssociations();
    this.root.remove();
    this.rowElements.length = 0;
    this.rowStates.length = 0;
    this.rowRevisions.length = 0;
  }

  private appendIdReference(existing: string | null, ...ids: string[]): string {
    return [...new Set([...(existing?.split(/\s+/).filter(Boolean) ?? []), ...ids])].join(' ');
  }

  private restoreInputAssociations(): void {
    if (this.originalControls === null) this.input.removeAttribute('aria-controls');
    else this.input.setAttribute('aria-controls', this.originalControls);
    if (this.originalDescribedBy === null) this.input.removeAttribute('aria-describedby');
    else this.input.setAttribute('aria-describedby', this.originalDescribedBy);
  }

  private ensureRowCount(): void {
    while (this.rowElements.length < this.terminal.rows) {
      const row = document.createElement('div');
      row.setAttribute('role', 'listitem');
      row.setAttribute('tabindex', '-1');
      row.dataset.ghosttyAccessibilityRow = `${this.rowElements.length}`;
      row.textContent = '\u00a0';
      this.rowContainer.appendChild(row);
      this.rowElements.push(row);
      this.rowStates.push({ base: null, links: [], linkSignature: '', linkGeneration: -1 });
      this.rowRevisions.push(0);
    }

    while (this.rowElements.length > this.terminal.rows) {
      this.rowRevisions[this.rowRevisions.length - 1]++;
      this.rowElements.pop()?.remove();
      this.rowStates.pop();
      this.rowRevisions.pop();
    }
  }

  private allViewportRows(): number[] {
    return Array.from({ length: this.terminal.rows }, (_, index) => index);
  }

  private rowsInRanges(ranges: readonly { start: number; end: number }[]): number[] {
    const rows = new Set<number>();
    for (const range of ranges) {
      const start = Math.max(0, Math.trunc(range.start));
      const end = Math.min(this.terminal.rows - 1, Math.trunc(range.end));
      for (let row = start; row <= end; row++) rows.add(row);
    }
    return [...rows].sort((left, right) => left - right);
  }

  private updateRow(
    viewportRow: number,
    buffer: IBuffer,
    screen: 'normal' | 'alternate',
    viewportTop: number,
    cursor: RenderStateCursor,
    selection: IBufferRange | undefined
  ): void {
    const element = this.rowElements[viewportRow];
    const state = this.rowStates[viewportRow];
    if (!element || !state) return;

    const absoluteRow = viewportTop + viewportRow;
    const line = buffer.getLine(absoluteRow);
    const cells = this.extractCells(line);
    const text = cells.map((cell) => cell.text).join('');
    const cursorColumn =
      cursor.visible && absoluteRow === buffer.baseY + cursor.y ? cursor.x : null;
    const rowSelection = this.selectionForRow(selection, absoluteRow, line);
    const base: RowBaseSnapshot = {
      screen,
      absoluteRow,
      setSize: buffer.length,
      text,
      cells,
      cursorColumn,
      selection: rowSelection,
      selectionContinuesAbove:
        viewportRow === 0 && selection !== undefined && selection.start.y < absoluteRow,
      selectionContinuesBelow:
        viewportRow === this.terminal.rows - 1 &&
        selection !== undefined &&
        selection.end.y > absoluteRow,
    };

    const baseChanged = !sameBaseSnapshot(state.base, base);
    const detectorGeneration = this.linkDetector.getGeneration();
    const linksStale = state.linkGeneration !== detectorGeneration;
    state.base = base;
    if (!baseChanged && !linksStale) return;

    const revision = ++this.rowRevisions[viewportRow];
    if (baseChanged || linksStale) {
      state.links = [];
      state.linkSignature = '';
      state.linkGeneration = detectorGeneration;
      this.renderRow(element, base, state.links);
    }

    void this.linkDetector.getLinksForRow(absoluteRow).then((links) => {
      if (
        this.disposed ||
        revision !== this.rowRevisions[viewportRow] ||
        !this.linkDetector.isGenerationCurrent(detectorGeneration)
      ) {
        return;
      }

      const current = this.rowStates[viewportRow];
      if (
        !current?.base ||
        current.base.screen !== screen ||
        current.base.absoluteRow !== absoluteRow
      ) {
        return;
      }

      const signature = linksSignature(links);
      if (signature === current.linkSignature) return;
      current.links = links;
      current.linkSignature = signature;
      this.renderRow(element, current.base, links);
    });
  }

  private extractCells(line: IBufferLine | undefined): CellText[] {
    if (!line) return [];
    const cells: Array<CellText & { nullPadding: boolean }> = [];
    for (let column = 0; column < line.length; column++) {
      const cell = line.getCell(column);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars();
      cells.push({
        column,
        width: Math.max(1, cell.getWidth()),
        text: chars || ' ',
        nullPadding: cell.getCode() === 0,
      });
    }
    while (cells[cells.length - 1]?.nullPadding) cells.pop();
    return cells.map(({ column, width, text }) => ({ column, width, text }));
  }

  private normalizeColumn(line: IBufferLine | undefined, column: number): number {
    const clamped = Math.max(0, Math.min(Math.trunc(column), this.terminal.cols - 1));
    if (clamped > 0 && line?.getCell(clamped)?.getWidth() === 0) {
      const previous = line.getCell(clamped - 1);
      if (previous?.getWidth() === 2) return clamped - 1;
    }
    return clamped;
  }

  private selectionForRow(
    selection: IBufferRange | undefined,
    absoluteRow: number,
    line: IBufferLine | undefined
  ): IBufferRange | undefined {
    if (!selection || absoluteRow < selection.start.y || absoluteRow > selection.end.y) {
      return undefined;
    }
    return {
      start: {
        x: absoluteRow === selection.start.y ? this.normalizeColumn(line, selection.start.x) : 0,
        y: absoluteRow,
      },
      end: {
        x:
          absoluteRow === selection.end.y
            ? this.normalizeColumn(line, selection.end.x)
            : this.terminal.cols - 1,
        y: absoluteRow,
      },
    };
  }

  private renderRow(element: HTMLDivElement, base: RowBaseSnapshot, links: ILink[]): void {
    element.setAttribute('aria-posinset', `${base.absoluteRow + 1}`);
    element.setAttribute('aria-setsize', `${base.setSize}`);
    if (base.cursorColumn === null) element.removeAttribute('aria-current');
    else element.setAttribute('aria-current', 'true');

    const fragment = document.createDocumentFragment();
    let currentLink: ILink | undefined;
    let currentLinkElement: HTMLSpanElement | undefined;
    let cursorRendered = false;
    let selectionStartRendered = false;
    let selectionEndRendered = false;

    const appendText = (text: string): void => {
      const target = currentLinkElement ?? fragment;
      target.appendChild(document.createTextNode(text));
    };
    const appendMarker = (kind: string, text: string): void => {
      const marker = document.createElement('span');
      marker.dataset.ghosttyAccessibilityMarker = kind;
      marker.textContent = text;
      const target = currentLinkElement ?? fragment;
      target.appendChild(marker);
    };
    const setLink = (link: ILink | undefined): void => {
      if (link === currentLink) return;
      currentLink = link;
      currentLinkElement = link ? this.createLinkElement(link) : undefined;
      if (currentLinkElement) fragment.appendChild(currentLinkElement);
    };

    if (base.selectionContinuesAbove) {
      appendMarker('selection-continues-above', 'Selection continues from above. ');
    }

    for (const cell of base.cells) {
      const link = links.find((candidate) =>
        isPositionInLink(cell.column, base.absoluteRow, candidate)
      );
      setLink(link);
      if (base.selection?.start.x === cell.column) {
        appendMarker('selection-start', 'Selection start. ');
        selectionStartRendered = true;
      }
      if (base.cursorColumn === cell.column) {
        appendMarker('cursor', 'Cursor. ');
        cursorRendered = true;
      }
      appendText(cell.text);
      if (base.selection?.end.x === cell.column) {
        appendMarker('selection-end', ' Selection end.');
        selectionEndRendered = true;
      }
    }

    setLink(undefined);
    if (base.cursorColumn !== null && !cursorRendered) {
      appendMarker('cursor', ' Cursor.');
      cursorRendered = true;
    }
    if (base.selection && !selectionStartRendered) {
      appendMarker('selection-start', 'Selection start. ');
    }
    if (base.selection && !selectionEndRendered) {
      appendMarker('selection-end', 'Selection end.');
    }
    if (base.selectionContinuesBelow) {
      appendMarker('selection-continues-below', ' Selection continues below.');
    }
    if (!fragment.hasChildNodes()) fragment.appendChild(document.createTextNode('\u00a0'));
    element.replaceChildren(fragment);
  }

  private createLinkElement(link: ILink): HTMLSpanElement {
    const element = document.createElement('span');
    element.setAttribute('role', 'link');
    // Cursor and selection markers can occur inside the link's inline text.
    // Keep its accessible name authoritative instead of inheriting markers.
    element.setAttribute('aria-label', link.text);
    element.setAttribute('tabindex', '-1');
    element.dataset.ghosttyAccessibilityLink = link.text;
    element.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      // The offscreen control itself is the explicit activation gesture. Add
      // the modifier expected by terminal links while retaining their existing
      // URI and host-handler validation policy.
      link.activate(
        new MouseEvent('click', {
          ctrlKey: true,
          bubbles: false,
          cancelable: true,
          detail: event.detail,
        })
      );
    });
    element.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      element.click();
    });
    return element;
  }

  private updateContexts(
    buffer: IBuffer,
    cursor: RenderStateCursor,
    cursorAbsoluteRow: number,
    selection: IBufferRange | undefined
  ): void {
    const cursorLine = this.extractCells(buffer.getLine(cursorAbsoluteRow))
      .map((cell) => cell.text)
      .join('');
    const cursorContext = cursor.visible
      ? `Cursor row ${cursorAbsoluteRow + 1}, column ${cursor.x + 1}${cursorLine ? `: ${cursorLine}` : ''}`
      : 'Terminal cursor hidden';
    if (cursorContext !== this.lastCursorContext) {
      this.cursorContext.textContent = cursorContext;
      this.lastCursorContext = cursorContext;
    }

    const selectionContext = selection ? this.buildSelectionContext(buffer, selection) : '';
    if (selectionContext !== this.lastSelectionContext) {
      this.selectionContext.textContent = selectionContext;
      this.lastSelectionContext = selectionContext;
    }
  }

  private buildSelectionContext(buffer: IBuffer, selection: IBufferRange): string {
    const prefix = `Selection from row ${selection.start.y + 1}, column ${selection.start.x + 1} to row ${selection.end.y + 1}, column ${selection.end.x + 1}`;
    let preview = '';
    let truncated = false;
    let rowsRead = 0;
    for (
      let row = selection.start.y;
      row <= selection.end.y && rowsRead < MAX_SELECTION_PREVIEW_ROWS;
      row++, rowsRead++
    ) {
      const cells = this.extractCells(buffer.getLine(row));
      const start = row === selection.start.y ? selection.start.x : 0;
      const end = row === selection.end.y ? selection.end.x : this.terminal.cols - 1;
      const rowText = cells
        .filter((cell) => cell.column >= start && cell.column <= end)
        .map((cell) => cell.text)
        .join('');
      const separator = preview && rowText ? '\n' : '';
      if (preview.length + separator.length + rowText.length > MAX_SELECTION_PREVIEW_CHARS) {
        preview += `${separator}${rowText.slice(
          0,
          MAX_SELECTION_PREVIEW_CHARS - preview.length - separator.length
        )}`;
        truncated = true;
        break;
      }
      preview += `${separator}${rowText}`;
      if (preview.length >= MAX_SELECTION_PREVIEW_CHARS && row < selection.end.y) {
        truncated = true;
        break;
      }
    }
    if (selection.end.y - selection.start.y + 1 > rowsRead) truncated = true;
    return `${prefix}.${preview ? ` Preview: ${preview}${truncated ? '…' : ''}` : ''}`;
  }

  private updateAnnouncement(
    buffer: IBuffer,
    screen: 'normal' | 'alternate',
    cursorAbsoluteRow: number,
    textChangedRows: ReadonlySet<number>
  ): void {
    const messages: string[] = [];
    const previous = this.presentedState;
    if (previous && previous.screen !== screen) {
      messages.push(screen === 'alternate' ? 'Alternate screen.' : 'Main screen.');
    } else if (
      previous?.screen === 'normal' &&
      screen === 'normal' &&
      this.terminal.getViewportY() === 0 &&
      cursorAbsoluteRow > previous.cursorAbsoluteRow &&
      [...textChangedRows].some(
        (row) => row >= previous.cursorAbsoluteRow && row <= cursorAbsoluteRow
      )
    ) {
      const firstRow = Math.max(
        previous.cursorAbsoluteRow,
        cursorAbsoluteRow - MAX_ANNOUNCEMENT_ROWS
      );
      for (let row = firstRow; row < cursorAbsoluteRow; row++) {
        const text = this.extractCells(buffer.getLine(row))
          .map((cell) => cell.text)
          .join('')
          .trimEnd();
        if (text) messages.push(text);
      }
      if (cursorAbsoluteRow - previous.cursorAbsoluteRow > MAX_ANNOUNCEMENT_ROWS) {
        messages.unshift('Additional terminal output available.');
      }
    }

    if (messages.length === 0) return;
    const message = messages.join('\n').slice(0, MAX_ANNOUNCEMENT_CHARS);
    const item = document.createElement('div');
    item.textContent = message;
    this.liveRegion.replaceChildren(item);
  }
}
