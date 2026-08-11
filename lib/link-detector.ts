/**
 * Link detection and caching system
 *
 * The LinkDetector coordinates between multiple link providers and caches
 * results for performance. Links are cached by position range, and providers
 * earlier in the resolved registration order take precedence over later ones.
 */

import type { ILink, ILinkProvider } from './types';

const SCAN_REVOKED = Symbol('scan-revoked');

interface InFlightScan {
  generation: number;
  promise: Promise<void>;
  revoke(): void;
}

/**
 * Manages link detection across multiple providers with intelligent caching
 */
export class LinkDetector {
  private providers: ILinkProvider[] = [];

  // Cache links by position range: `r${row}:${startX}-${endX}`
  private linkCache = new Map<string, ILink>();

  // Track which rows have been scanned to avoid redundant provider calls
  private scannedRows = new Set<number>();

  // A row can have at most one provider scan in a content generation. Keeping
  // this separate from scannedRows means a row is only considered complete
  // after every provider has answered.
  private inFlightScans = new Map<number, InFlightScan>();

  // Every cache invalidation revokes work started against older content or an
  // older provider set. This also gives callers a cheap way to validate an
  // asynchronous result before applying UI state.
  private generation = 0;
  private disposed = false;

  // Terminal instance for buffer access
  constructor(
    private terminal: ITerminalForLinkDetector,
    private onInvalidate?: () => void
  ) {}

  /**
   * Register a link provider. Normal providers retain registration order;
   * high-priority providers are prepended, so the newest high-priority
   * registration takes precedence over existing providers.
   */
  registerProvider(provider: ILinkProvider, highPriority: boolean = false): void {
    if (this.disposed) {
      provider.dispose?.();
      return;
    }

    if (highPriority) {
      this.providers.unshift(provider);
    } else {
      this.providers.push(provider);
    }
    this.invalidateCache(); // New provider may detect different links
  }

  /**
   * Get link at the specified buffer position
   * @param col Column (0-based)
   * @param row Absolute row in buffer (0-based)
   * @returns Link at position, or undefined if none
   */
  async getLinkAt(col: number, row: number): Promise<ILink | undefined> {
    if (this.disposed) return undefined;

    const line = this.terminal.buffer.active.getLine(row);
    if (!line || col < 0 || col >= line.length) {
      return undefined;
    }

    const cell = line.getCell(col);
    if (!cell) {
      return undefined;
    }

    const generation = this.generation;

    const cached = this.findCachedLink(col, row);
    if (cached) return cached;

    // Slow path: scan this row if not already scanned
    if (!this.scannedRows.has(row)) {
      await this.scanRow(row);
    }

    // A write, row invalidation, provider change, or disposal occurred while
    // the providers were answering. The request belongs to the old content.
    if (!this.isGenerationCurrent(generation)) return undefined;

    return this.findCachedLink(col, row);
  }

  /**
   * Return every link intersecting one current buffer row.
   *
   * This shares the same provider scan and generation guards as point lookup,
   * allowing bounded non-visual consumers to expose a row without probing each
   * cell independently.
   */
  async getLinksForRow(row: number): Promise<ILink[]> {
    if (this.disposed || !this.terminal.buffer.active.getLine(row)) return [];

    const generation = this.generation;
    if (!this.scannedRows.has(row)) await this.scanRow(row);
    if (!this.isGenerationCurrent(generation)) return [];

    return [...this.linkCache.values()].filter(
      (link) => link.range.start.y <= row && link.range.end.y >= row
    );
  }

  /** Capture the cache generation for asynchronous UI result validation. */
  getGeneration(): number {
    return this.generation;
  }

  /** Check whether content and providers still match a captured generation. */
  isGenerationCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private findCachedLink(col: number, row: number): ILink | undefined {
    for (const link of this.linkCache.values()) {
      if (this.isPositionInLink(col, row, link)) {
        return link;
      }
    }
    return undefined;
  }

  /**
   * Scan a row for links using all registered providers
   */
  private async scanRow(row: number): Promise<void> {
    const generation = this.generation;
    const existing = this.inFlightScans.get(row);
    if (existing?.generation === generation) return existing.promise;

    let revoke!: () => void;
    const revoked = new Promise<typeof SCAN_REVOKED>((resolve) => {
      revoke = () => resolve(SCAN_REVOKED);
    });

    let scan!: InFlightScan;
    const promise = this.scanProviders(row, generation, revoked).finally(() => {
      if (this.inFlightScans.get(row) === scan) this.inFlightScans.delete(row);
    });
    scan = { generation, promise, revoke };
    this.inFlightScans.set(row, scan);

    return promise;
  }

  private async scanProviders(
    row: number,
    generation: number,
    revoked: Promise<typeof SCAN_REVOKED>
  ): Promise<void> {
    const providers = [...this.providers];

    const allLinks: ILink[] = [];

    // Query all providers
    for (const provider of providers) {
      const links = await Promise.race([
        new Promise<ILink[] | undefined>((resolve) => {
          provider.provideLinks(row, resolve);
        }),
        revoked,
      ]);

      if (links === SCAN_REVOKED || !this.isGenerationCurrent(generation)) return;

      if (links) {
        allLinks.push(...links);
      }
    }

    if (!this.isGenerationCurrent(generation)) return;

    // Cache all discovered links
    for (const link of allLinks) {
      this.cacheLink(link);
    }
    this.scannedRows.add(row);
  }

  /**
   * Cache a link for fast lookup
   *
   * Note: We cache by position range, not hyperlink_id, because the WASM
   * returns hyperlink_id as a boolean (0 or 1), not a unique identifier.
   * The actual unique identifier is the URI which is retrieved separately.
   */
  private cacheLink(link: ILink): void {
    // Cache by position range - this uniquely identifies links even when
    // multiple OSC 8 links exist on the same line
    const { start: s, end: e } = link.range;
    const cacheKey = `r${s.y}:${s.x}-${e.x}`;
    // Don't overwrite existing entries: providers earlier in the resolved
    // registration order take precedence for the same range.
    if (!this.linkCache.has(cacheKey)) {
      this.linkCache.set(cacheKey, link);
    }
  }

  /**
   * Check if a position is within a link's range
   */
  private isPositionInLink(col: number, row: number, link: ILink): boolean {
    const { start, end } = link.range;

    // Check if row is in range
    if (row < start.y || row > end.y) {
      return false;
    }

    // Single-line link
    if (start.y === end.y) {
      return col >= start.x && col <= end.x;
    }

    // Multi-line link
    if (row === start.y) {
      return col >= start.x; // First line: from start.x to end of line
    } else if (row === end.y) {
      return col <= end.x; // Last line: from start of line to end.x
    } else {
      return true; // Middle line: entire line is part of link
    }
  }

  /**
   * Invalidate cache when terminal content changes
   * Should be called on terminal write, resize, or clear
   */
  invalidateCache(): void {
    this.revokePendingScans();
    this.linkCache.clear();
    this.scannedRows.clear();
  }

  /**
   * Invalidate cache for specific rows
   * Used when only part of the terminal changed
   */
  invalidateRows(startRow: number, endRow: number): void {
    this.revokePendingScans();

    // Remove scanned markers
    for (let row = startRow; row <= endRow; row++) {
      this.scannedRows.delete(row);
    }

    // Remove cached links in this range
    // This is conservative - we remove any link that touches these rows
    const toDelete: string[] = [];
    for (const [key, link] of this.linkCache.entries()) {
      const { start, end } = link.range;
      if (
        (start.y >= startRow && start.y <= endRow) ||
        (end.y >= startRow && end.y <= endRow) ||
        (start.y < startRow && end.y > endRow)
      ) {
        toDelete.push(key);
      }
    }

    for (const key of toDelete) {
      this.linkCache.delete(key);
    }
  }

  /**
   * Dispose and cleanup
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.revokePendingScans();
    this.linkCache.clear();
    this.scannedRows.clear();

    // Dispose all providers
    for (const provider of this.providers) {
      provider.dispose?.();
    }
    this.providers = [];
  }

  private revokePendingScans(): void {
    this.generation++;
    for (const scan of this.inFlightScans.values()) scan.revoke();
    this.inFlightScans.clear();
    this.onInvalidate?.();
  }
}

/**
 * Minimal terminal interface required by LinkDetector
 * Keeps coupling low and testing easy
 */
export interface ITerminalForLinkDetector {
  buffer: {
    active: {
      getLine(y: number):
        | {
            length: number;
            getCell(x: number):
              | {
                  getHyperlinkId(): number;
                }
              | undefined;
          }
        | undefined;
    };
  };
}
