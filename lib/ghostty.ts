/**
 * TypeScript wrapper for libghostty-vt WASM API
 *
 * High-performance terminal emulation using Ghostty's battle-tested VT100 parser.
 * The key optimization is the RenderState API which provides a pre-computed
 * snapshot of all render data in a single update call.
 */

import defaultWasmUrl from '../ghostty-vt.wasm?url&no-inline';
import {
  type DecodedTerminalEvent,
  decodeTerminalEventRecord,
  MAX_TERMINAL_EVENT_BYTES,
} from './terminal-events';
import {
  CellFlags,
  type Cursor,
  type CursorBlink,
  type CursorStyle,
  DirtyState,
  GHOSTTY_COLOR_CONFIG_SIZE,
  GHOSTTY_CONFIG_SIZE,
  type GhosttyCell,
  type GhosttyTerminalConfig,
  type GhosttyWasmExports,
  KeyEncoderOption,
  type KeyEvent,
  type KittyKeyFlags,
  type RenderStateColors,
  type RenderStateCursor,
  type RenderStateSnapshot,
  type RGB,
  type TerminalEvent,
  type TerminalEventProvenance,
  type TerminalHandle,
} from './types';

/** Matches the native retained-search query cap before crossing into WASM. */
const MAX_RETAINED_SEARCH_QUERY_BYTES = 64 * 1024;
const FOREGROUND_CONFIGURED = 1 << 0;
const BACKGROUND_CONFIGURED = 1 << 1;
const CURSOR_CONFIGURED = 1 << 2;
const PALETTE_CONFIGURED_SHIFT = 8;

export type GhosttyBufferType = 'normal' | 'alternate';

export interface GhosttyBufferInfo {
  scrollbackLength: number;
  cursorX: number;
  cursorY: number;
  rows: number;
  cols: number;
}

const CURSOR_STYLE_VALUES: Readonly<Record<CursorStyle, number>> = {
  block: 0,
  block_hollow: 1,
  bar: 2,
  underline: 3,
};

function isFileSystemSource(path: string | URL): boolean {
  if (path instanceof URL) return path.protocol === 'file:';
  if (path.startsWith('file:') || /^[A-Za-z]:[\\/]/.test(path)) return true;
  return !/^[A-Za-z][A-Za-z\d+.-]*:/.test(path);
}

function encodedCursorStyle(style: CursorStyle | undefined): number {
  return CURSOR_STYLE_VALUES[style ?? 'block'];
}

function encodedCursorBlink(blink: CursorBlink | undefined): number {
  if (blink === 'terminal') return 0;
  return (blink ?? false) ? 1 : 2;
}

function writeTerminalConfigTail(
  view: DataView,
  offset: number,
  config: GhosttyTerminalConfig
): number {
  view.setUint8(offset, encodedCursorStyle(config.cursorStyle));
  view.setUint8(offset + 1, encodedCursorBlink(config.cursorBlink));
  view.setUint8(offset + 2, config.scrollbackBytes === undefined ? 0 : 1);
  view.setUint8(offset + 3, 0);
  return offset + 4;
}

function encodedScrollbackLimit(config: GhosttyTerminalConfig): number {
  if (config.scrollbackLimit !== undefined && config.scrollbackBytes !== undefined) {
    throw new TypeError('scrollbackLimit and scrollbackBytes are mutually exclusive');
  }

  if (config.scrollbackBytes !== undefined) {
    if (
      !Number.isInteger(config.scrollbackBytes) ||
      config.scrollbackBytes < 0 ||
      config.scrollbackBytes >= 0xffffffff
    ) {
      throw new TypeError('scrollbackBytes must be an integer from 0 to 4294967294');
    }
    return config.scrollbackBytes;
  }

  return config.scrollbackLimit ?? 10000;
}

function validatedColor(value: number | undefined, field: string): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0 || value > 0xffffff) {
    throw new TypeError(`${field} must be an integer from 0x000000 to 0xffffff`);
  }
  return value;
}

/** Write the native color config and return the next byte offset. */
function writeColorConfig(view: DataView, offset: number, config: GhosttyTerminalConfig): number {
  if (config.palette && config.palette.length > 16) {
    throw new TypeError('palette must contain at most 16 colors');
  }

  let mask = 0;
  if (config.fgColor !== undefined) mask |= FOREGROUND_CONFIGURED;
  if (config.bgColor !== undefined) mask |= BACKGROUND_CONFIGURED;
  if (config.cursorColor !== undefined) mask |= CURSOR_CONFIGURED;
  for (let index = 0; index < 16; index++) {
    if (config.palette?.[index] !== undefined) mask |= 1 << (PALETTE_CONFIGURED_SHIFT + index);
  }

  view.setUint32(offset, mask, true);
  offset += 4;
  view.setUint32(offset, validatedColor(config.fgColor, 'fgColor'), true);
  offset += 4;
  view.setUint32(offset, validatedColor(config.bgColor, 'bgColor'), true);
  offset += 4;
  view.setUint32(offset, validatedColor(config.cursorColor, 'cursorColor'), true);
  offset += 4;
  for (let index = 0; index < 16; index++) {
    view.setUint32(offset, validatedColor(config.palette?.[index], `palette[${index}]`), true);
    offset += 4;
  }
  return offset;
}

// Re-export types for convenience
export {
  CellFlags,
  type Cursor,
  DirtyState,
  type GhosttyCell,
  type GhosttyTerminalConfig,
  KeyEncoderOption,
  type RenderStateColors,
  type RenderStateCursor,
  type RenderStateSnapshot,
  type RGB,
  type TerminalEvent,
  type TerminalEventProvenance,
};

/**
 * Main Ghostty WASM wrapper class
 */
export class Ghostty {
  private exports: GhosttyWasmExports;
  private memory: WebAssembly.Memory;

  constructor(wasmInstance: WebAssembly.Instance) {
    this.exports = wasmInstance.exports as GhosttyWasmExports;
    this.memory = this.exports.memory;
  }

  createKeyEncoder(): KeyEncoder {
    return new KeyEncoder(this.exports);
  }

  createTerminal(
    cols: number = 80,
    rows: number = 24,
    config?: GhosttyTerminalConfig
  ): GhosttyTerminal {
    return new GhosttyTerminal(this.exports, this.memory, cols, rows, config);
  }

  static async load(wasmPath: string | URL = defaultWasmUrl): Promise<Ghostty> {
    if (wasmPath === '') {
      throw new TypeError('Ghostty WASM path must not be empty.');
    }
    try {
      return await Ghostty.loadFromPath(wasmPath);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const wrapped = new Error(`Failed to load Ghostty WASM from ${String(wasmPath)}: ${detail}`);
      Object.defineProperty(wrapped, 'cause', { configurable: true, value: error });
      throw wrapped;
    }
  }

  private static async loadFromPath(path: string | URL): Promise<Ghostty> {
    let wasmBytes: ArrayBuffer | undefined;
    let fileSystemError: unknown;

    // Try Bun.file first (for Bun environments)
    if (typeof Bun !== 'undefined' && typeof Bun.file === 'function') {
      try {
        const file = Bun.file(path);
        if (await file.exists()) {
          wasmBytes = await file.arrayBuffer();
        }
      } catch {
        // Bun.file failed, try next method
      }
    }

    // Try Node.js fs module if Bun.file didn't work. The runtime guard keeps
    // browsers and workers from attempting to resolve a node: URL.
    if (!wasmBytes && typeof process !== 'undefined' && process.versions?.node) {
      try {
        const nodeFsSpecifier = ['node', 'fs/promises'].join(':');
        const fs = (await import(
          /* @vite-ignore */
          /* webpackIgnore: true */
          nodeFsSpecifier
        )) as typeof import('node:fs/promises');
        const filePath =
          typeof path === 'string' && path.startsWith('file:') ? new URL(path) : path;
        const buffer = await fs.readFile(filePath);
        wasmBytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      } catch (error) {
        fileSystemError = error;
        // fs failed, try fetch
      }
    }

    if (!wasmBytes && fileSystemError && isFileSystemSource(path)) {
      throw fileSystemError;
    }

    // Fall back to fetch (for browser environments)
    if (!wasmBytes) {
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(`Failed to fetch WASM: ${response.status} ${response.statusText}`);
      }
      wasmBytes = await response.arrayBuffer();
      if (wasmBytes.byteLength === 0) {
        throw new Error(`WASM file is empty (0 bytes). Check path: ${path}`);
      }
    }

    if (!wasmBytes) {
      throw new Error(`Could not load WASM from path: ${path}`);
    }

    const wasmModule = await WebAssembly.compile(wasmBytes);
    const wasmInstance = await WebAssembly.instantiate(wasmModule, {
      env: {
        log: (ptr: number, len: number) => {
          const bytes = new Uint8Array(
            (wasmInstance.exports as GhosttyWasmExports).memory.buffer,
            ptr,
            len
          );
          console.log('[ghostty-vt]', new TextDecoder().decode(bytes));
        },
      },
    });
    return new Ghostty(wasmInstance);
  }
}

/**
 * Key Encoder - converts keyboard events into terminal escape sequences
 */
export class KeyEncoder {
  private exports: GhosttyWasmExports;
  private encoder: number = 0;

  constructor(exports: GhosttyWasmExports) {
    this.exports = exports;
    const encoderPtrPtr = this.exports.ghostty_wasm_alloc_opaque();
    try {
      const result = this.exports.ghostty_key_encoder_new(0, encoderPtrPtr);
      if (result !== 0) throw new Error(`Failed to create key encoder: ${result}`);
      const view = new DataView(this.exports.memory.buffer);
      this.encoder = view.getUint32(encoderPtrPtr, true);
    } finally {
      this.exports.ghostty_wasm_free_opaque(encoderPtrPtr);
    }
  }

  setOption(option: KeyEncoderOption, value: boolean | number): void {
    const valuePtr = this.exports.ghostty_wasm_alloc_u8();
    const view = new DataView(this.exports.memory.buffer);
    view.setUint8(valuePtr, typeof value === 'boolean' ? (value ? 1 : 0) : value);
    this.exports.ghostty_key_encoder_setopt(this.encoder, option, valuePtr);
    this.exports.ghostty_wasm_free_u8(valuePtr);
  }

  setKittyFlags(flags: KittyKeyFlags): void {
    this.setOption(KeyEncoderOption.KITTY_KEYBOARD_FLAGS, flags);
  }

  encode(event: KeyEvent): Uint8Array {
    const cleanups: Array<() => void> = [];
    const releaseTemporaryResources = (preserveActiveError: boolean): void => {
      let cleanupFailed = false;
      let cleanupError: unknown;
      for (let index = cleanups.length - 1; index >= 0; index--) {
        try {
          cleanups[index]();
        } catch (error) {
          if (!cleanupFailed) {
            cleanupFailed = true;
            cleanupError = error;
          }
        }
      }

      if (!preserveActiveError && cleanupFailed) throw cleanupError;
    };
    let encodingFailed = true;

    try {
      const eventPtrPtr = this.exports.ghostty_wasm_alloc_opaque();
      cleanups.push(() => this.exports.ghostty_wasm_free_opaque(eventPtrPtr));

      const createResult = this.exports.ghostty_key_event_new(0, eventPtrPtr);
      if (createResult !== 0) throw new Error(`Failed to create key event: ${createResult}`);

      // Native calls can grow memory, so acquire a fresh view after creating the event.
      const eventPtr = new DataView(this.exports.memory.buffer).getUint32(eventPtrPtr, true);
      cleanups.push(() => this.exports.ghostty_key_event_free(eventPtr));

      this.exports.ghostty_key_event_set_action(eventPtr, event.action);
      this.exports.ghostty_key_event_set_key(eventPtr, event.key);
      this.exports.ghostty_key_event_set_mods(eventPtr, event.mods);
      if (event.unshiftedCodepoint !== undefined) {
        this.exports.ghostty_key_event_set_unshifted_codepoint(eventPtr, event.unshiftedCodepoint);
      }

      if (event.utf8) {
        const utf8Bytes = new TextEncoder().encode(event.utf8);
        const utf8Ptr = this.exports.ghostty_wasm_alloc_u8_array(utf8Bytes.length);
        cleanups.push(() => this.exports.ghostty_wasm_free_u8_array(utf8Ptr, utf8Bytes.length));
        new Uint8Array(this.exports.memory.buffer).set(utf8Bytes, utf8Ptr);
        this.exports.ghostty_key_event_set_utf8(eventPtr, utf8Ptr, utf8Bytes.length);
      }

      const bufferSize = 32;
      const bufPtr = this.exports.ghostty_wasm_alloc_u8_array(bufferSize);
      cleanups.push(() => this.exports.ghostty_wasm_free_u8_array(bufPtr, bufferSize));
      const writtenPtr = this.exports.ghostty_wasm_alloc_usize();
      cleanups.push(() => this.exports.ghostty_wasm_free_usize(writtenPtr));

      const encodeResult = this.exports.ghostty_key_encoder_encode(
        this.encoder,
        eventPtr,
        bufPtr,
        bufferSize,
        writtenPtr
      );

      if (encodeResult !== 0) throw new Error(`Failed to encode key: ${encodeResult}`);

      // Encoding may grow WASM memory and detach every view of the old buffer.
      const bytesWritten = new DataView(this.exports.memory.buffer).getUint32(writtenPtr, true);
      const encoded = new Uint8Array(this.exports.memory.buffer, bufPtr, bytesWritten).slice();
      encodingFailed = false;
      return encoded;
    } finally {
      // A cleanup failure should be visible after a successful encode, but must not
      // replace the original exception when encoding itself failed.
      releaseTemporaryResources(encodingFailed);
    }
  }

  dispose(): void {
    if (this.encoder) {
      this.exports.ghostty_key_encoder_free(this.encoder);
      this.encoder = 0;
    }
  }
}

/**
 * GhosttyTerminal - High-performance terminal emulator
 *
 * Uses Ghostty's native RenderState for optimal performance:
 * - ONE call to update all state (renderStateUpdate)
 * - ONE call to get all cells (getViewport)
 * - No per-row WASM boundary crossings!
 */
export class GhosttyTerminal {
  private readonly provenanceIdentities = new WeakMap<
    TerminalEventProvenance,
    Readonly<{ id: number; screen: TerminalEventProvenance['screen'] }>
  >();
  private exports: GhosttyWasmExports;
  private memory: WebAssembly.Memory;
  private handle: TerminalHandle;
  private _cols: number;
  private _rows: number;

  /** Size of GhosttyCell in WASM (16 bytes) */
  private static readonly CELL_SIZE = 16;

  /** Reusable buffer for viewport operations */
  private viewportBufferPtr: number = 0;
  private viewportBufferSize: number = 0;

  /** Reusable five-u32 buffer for named screen metadata. */
  private bufferInfoPtr: number = 0;

  /** Cell pool for zero-allocation rendering */
  private cellPool: GhosttyCell[] = [];

  /** Reusable renderer-owned retained viewport representation. */
  private scrollbackViewportCellPool: GhosttyCell[] = [];
  private scrollbackViewportRows: GhosttyCell[][] = [];

  constructor(
    exports: GhosttyWasmExports,
    memory: WebAssembly.Memory,
    cols: number = 80,
    rows: number = 24,
    config?: GhosttyTerminalConfig
  ) {
    this.exports = exports;
    this.memory = memory;
    this._cols = cols;
    this._rows = rows;

    if (config) {
      // Allocate config struct in WASM memory
      const configPtr = this.exports.ghostty_wasm_alloc_u8_array(GHOSTTY_CONFIG_SIZE);
      if (configPtr === 0) {
        throw new Error('Failed to allocate config (out of memory)');
      }

      try {
        // Write config to WASM memory
        const view = new DataView(this.memory.buffer);
        let offset = configPtr;

        // scrollback_limit (u32 in the unit encoded in the config tail)
        view.setUint32(offset, encodedScrollbackLimit(config), true);
        offset += 4;
        offset = writeColorConfig(view, offset, config);
        writeTerminalConfigTail(view, offset, config);

        this.handle = this.exports.ghostty_terminal_new_with_config(cols, rows, configPtr);
      } finally {
        // Free the config memory
        this.exports.ghostty_wasm_free_u8_array(configPtr, GHOSTTY_CONFIG_SIZE);
      }
    } else {
      this.handle = this.exports.ghostty_terminal_new(cols, rows);
    }

    if (!this.handle) throw new Error('Failed to create terminal');

    this.initCellPool();
  }

  get cols(): number {
    return this._cols;
  }
  get rows(): number {
    return this._rows;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  write(data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const ptr = this.exports.ghostty_wasm_alloc_u8_array(bytes.length);
    new Uint8Array(this.memory.buffer).set(bytes, ptr);
    this.exports.ghostty_terminal_write(this.handle, ptr, bytes.length);
    this.exports.ghostty_wasm_free_u8_array(ptr, bytes.length);
  }

  resize(cols: number, rows: number): void {
    if (cols === this._cols && rows === this._rows) return;
    this._cols = cols;
    this._rows = rows;
    this.exports.ghostty_terminal_resize(this.handle, cols, rows);
    this.invalidateBuffers();
    this.initCellPool();
  }

  /** Change configured base colors while preserving contents and app overrides. */
  setColorConfig(config: GhosttyTerminalConfig): boolean {
    if (!this.handle) return false;
    const configPtr = this.exports.ghostty_wasm_alloc_u8_array(GHOSTTY_COLOR_CONFIG_SIZE);
    if (configPtr === 0) return false;
    try {
      writeColorConfig(new DataView(this.memory.buffer), configPtr, config);
      return this.exports.ghostty_terminal_set_color_config(this.handle, configPtr);
    } finally {
      this.exports.ghostty_wasm_free_u8_array(configPtr, GHOSTTY_COLOR_CONFIG_SIZE);
    }
  }

  /** Change configured cursor defaults without replacing terminal or presentation state. */
  setCursorConfig(config: Pick<GhosttyTerminalConfig, 'cursorStyle' | 'cursorBlink'>): boolean {
    if (!this.handle) return false;
    return this.exports.ghostty_terminal_set_cursor_config(
      this.handle,
      encodedCursorStyle(config.cursorStyle),
      encodedCursorBlink(config.cursorBlink)
    );
  }

  free(): void {
    this.invalidateBuffers();
    if (!this.handle) return;
    this.exports.ghostty_terminal_free(this.handle);
    this.handle = 0;
  }

  // ========================================================================
  // Retained normal-buffer search
  // ========================================================================

  createRetainedSearch(query: string, caseSensitive: boolean): number {
    if (!this.handle || query.length === 0) return 0;
    // Every UTF-16 code unit contributes at least one UTF-8 byte. Reject this
    // cheap lower bound before TextEncoder can duplicate a pathological input.
    if (query.length > MAX_RETAINED_SEARCH_QUERY_BYTES) return 0;
    const bytes = new TextEncoder().encode(query);
    if (bytes.length === 0 || bytes.length > MAX_RETAINED_SEARCH_QUERY_BYTES) return 0;
    const ptr = this.exports.ghostty_wasm_alloc_u8_array(bytes.length);
    if (ptr === 0) return 0;
    try {
      new Uint8Array(this.memory.buffer).set(bytes, ptr);
      return (
        this.exports.ghostty_terminal_retained_search_create(
          this.handle,
          ptr,
          bytes.length,
          caseSensitive
        ) >>> 0
      );
    } finally {
      this.exports.ghostty_wasm_free_u8_array(ptr, bytes.length);
    }
  }

  stepRetainedSearch(searchId: number): number {
    if (!this.handle || searchId === 0) return -1;
    return this.exports.ghostty_terminal_retained_search_step(this.handle, searchId);
  }

  cancelRetainedSearch(searchId: number): void {
    if (!this.handle || searchId === 0) return;
    this.exports.ghostty_terminal_retained_search_cancel(this.handle, searchId);
  }

  getRetainedSearchMatchCount(searchId: number): number {
    if (!this.handle || searchId === 0) return -1;
    return this.exports.ghostty_terminal_retained_search_match_count(this.handle, searchId);
  }

  getRetainedSearchMatchRange(
    searchId: number,
    matchIndex: number
  ): { startRow: number; startColumn: number; endRow: number; endColumn: number } | null {
    if (!this.handle || searchId === 0) return null;
    const byteLength = 4 * Uint32Array.BYTES_PER_ELEMENT;
    const ptr = this.exports.ghostty_wasm_alloc_u8_array(byteLength);
    if (ptr === 0) return null;
    try {
      const count = this.exports.ghostty_terminal_retained_search_match_range(
        this.handle,
        searchId,
        matchIndex,
        ptr,
        4
      );
      if (count !== 4) return null;
      const values = new Uint32Array(this.memory.buffer, ptr, 4);
      return {
        startRow: values[0],
        startColumn: values[1],
        endRow: values[2],
        endColumn: values[3],
      };
    } finally {
      this.exports.ghostty_wasm_free_u8_array(ptr, byteLength);
    }
  }

  getRetainedSearchMatchText(searchId: number, matchIndex: number): string | null {
    if (!this.handle || searchId === 0) return null;
    const byteLength = this.exports.ghostty_terminal_retained_search_match_text(
      this.handle,
      searchId,
      matchIndex,
      0,
      0
    );
    if (byteLength < 0) return null;
    if (byteLength === 0) return '';
    const ptr = this.exports.ghostty_wasm_alloc_u8_array(byteLength);
    if (ptr === 0) return null;
    try {
      const written = this.exports.ghostty_terminal_retained_search_match_text(
        this.handle,
        searchId,
        matchIndex,
        ptr,
        byteLength
      );
      if (written !== byteLength) return null;
      return new TextDecoder().decode(new Uint8Array(this.memory.buffer, ptr, written).slice());
    } finally {
      this.exports.ghostty_wasm_free_u8_array(ptr, byteLength);
    }
  }

  getPrimaryScreenGeneration(): number {
    if (!this.handle) return 0;
    return this.exports.ghostty_terminal_get_primary_screen_generation(this.handle) >>> 0;
  }

  getAlternateScreenGeneration(): number {
    if (!this.handle) return 0;
    return this.exports.ghostty_terminal_get_alternate_screen_generation(this.handle) >>> 0;
  }

  captureRetainedBufferBoundary(): TerminalEventProvenance | null {
    if (!this.handle) return null;
    const byteLength = 4 * Uint32Array.BYTES_PER_ELEMENT;
    const ptr = this.exports.ghostty_wasm_alloc_u8_array(byteLength);
    if (ptr === 0) return null;
    try {
      const count = this.exports.ghostty_terminal_capture_retained_buffer_boundary(
        this.handle,
        ptr,
        4
      );
      if (count !== 4) return null;
      const values = new Uint32Array(this.memory.buffer, ptr, 4);
      const provenance: TerminalEventProvenance = Object.freeze({
        id: values[0],
        screen: values[1] === 1 ? 'alternate' : 'normal',
        row: values[2],
        column: values[3],
      });
      this.rememberProvenance(provenance);
      return provenance;
    } finally {
      this.exports.ghostty_wasm_free_u8_array(ptr, byteLength);
    }
  }

  /** Track one absolute cell on the active screen across scrollback trimming. */
  captureRetainedBufferPosition(row: number, column: number): TerminalEventProvenance | null {
    if (
      !this.handle ||
      !Number.isInteger(row) ||
      !Number.isInteger(column) ||
      row < 0 ||
      column < 0 ||
      row > 0xffffffff ||
      column > 0xffffffff
    ) {
      return null;
    }

    const byteLength = 4 * Uint32Array.BYTES_PER_ELEMENT;
    const ptr = this.exports.ghostty_wasm_alloc_u8_array(byteLength);
    if (ptr === 0) return null;
    try {
      const count = this.exports.ghostty_terminal_capture_retained_buffer_position(
        this.handle,
        row,
        column,
        ptr,
        4
      );
      if (count !== 4) return null;
      const values = new Uint32Array(this.memory.buffer, ptr, 4);
      const provenance: TerminalEventProvenance = Object.freeze({
        id: values[0],
        screen: values[1] === 1 ? 'alternate' : 'normal',
        row: values[2],
        column: values[3],
      });
      this.rememberProvenance(provenance);
      return provenance;
    } finally {
      this.exports.ghostty_wasm_free_u8_array(ptr, byteLength);
    }
  }

  /** Release a short-lived tracked boundary without waiting for registry eviction. */
  releaseRetainedBufferBoundary(provenance: TerminalEventProvenance): void {
    if (!this.handle || !this.ownsProvenance(provenance)) return;
    this.exports.ghostty_terminal_release_retained_buffer_boundary(
      this.handle,
      provenance.id,
      provenance.screen === 'alternate'
    );
  }

  createRetainedRange(start: TerminalEventProvenance, end: TerminalEventProvenance): number {
    if (!this.handle || start.screen !== end.screen) return 0;
    if (!this.ownsProvenance(start) || !this.ownsProvenance(end)) return 0;
    return (
      this.exports.ghostty_terminal_retained_range_create(
        this.handle,
        start.id,
        end.id,
        start.screen === 'alternate'
      ) >>> 0
    );
  }

  stepRetainedRange(rangeId: number): number {
    if (!this.handle || rangeId === 0) return -1;
    return this.exports.ghostty_terminal_retained_range_step(this.handle, rangeId);
  }

  cancelRetainedRange(rangeId: number): void {
    if (!this.handle || rangeId === 0) return;
    this.exports.ghostty_terminal_retained_range_cancel(this.handle, rangeId);
  }

  getRetainedRangeText(rangeId: number): string | null {
    if (!this.handle || rangeId === 0) return null;
    const byteLength = this.exports.ghostty_terminal_retained_range_text(
      this.handle,
      rangeId,
      0,
      0
    );
    if (byteLength < 0) return null;
    if (byteLength === 0) return '';
    const ptr = this.exports.ghostty_wasm_alloc_u8_array(byteLength);
    if (ptr === 0) return null;
    try {
      const written = this.exports.ghostty_terminal_retained_range_text(
        this.handle,
        rangeId,
        ptr,
        byteLength
      );
      if (written !== byteLength) return null;
      return new TextDecoder().decode(new Uint8Array(this.memory.buffer, ptr, written).slice());
    } finally {
      this.exports.ghostty_wasm_free_u8_array(ptr, byteLength);
    }
  }

  // ========================================================================
  // Structured terminal events
  // ========================================================================

  /** Drain all complete parser events currently queued by Ghostty. */
  readEvents(): DecodedTerminalEvent[] {
    const events: DecodedTerminalEvent[] = [];
    while (this.handle) {
      const recordSize = this.exports.ghostty_terminal_peek_event_size(this.handle);
      if (recordSize === 0) break;
      if (recordSize < 0 || recordSize > MAX_TERMINAL_EVENT_BYTES) break;

      const recordPtr = this.exports.ghostty_wasm_alloc_u8_array(recordSize);
      if (recordPtr === 0) break;
      try {
        const bytesRead = this.exports.ghostty_terminal_read_event(
          this.handle,
          recordPtr,
          recordSize
        );
        if (bytesRead !== recordSize) break;
        const record = new Uint8Array(this.memory.buffer, recordPtr, bytesRead).slice();
        const event = decodeTerminalEventRecord(record);
        if (event) {
          if (event.type === 'semantic') this.rememberProvenance(event.provenance);
          events.push(event);
        }
      } finally {
        this.exports.ghostty_wasm_free_u8_array(recordPtr, recordSize);
      }
    }
    return events;
  }

  /** Resolve a semantic marker to its current retained row, or null after expiry. */
  resolveEventProvenance(provenance: TerminalEventProvenance): number | null {
    return this.resolveEventBoundary(provenance)?.row ?? null;
  }

  /** Resolve an authenticated semantic marker to exact retained coordinates. */
  resolveEventBoundary(
    provenance: TerminalEventProvenance
  ): { row: number; column: number } | null {
    if (!this.handle || !this.ownsProvenance(provenance)) return null;
    const byteLength = 2 * Uint32Array.BYTES_PER_ELEMENT;
    const ptr = this.exports.ghostty_wasm_alloc_u8_array(byteLength);
    if (ptr === 0) return null;
    try {
      const count = this.exports.ghostty_terminal_resolve_event_boundary(
        this.handle,
        provenance.id,
        provenance.screen === 'alternate',
        ptr,
        2
      );
      if (count !== 2) return null;
      const values = new Uint32Array(this.memory.buffer, ptr, 2);
      return { row: values[0], column: values[1] };
    } finally {
      this.exports.ghostty_wasm_free_u8_array(ptr, byteLength);
    }
  }

  private rememberProvenance(provenance: TerminalEventProvenance): void {
    this.provenanceIdentities.set(provenance, {
      id: provenance.id,
      screen: provenance.screen,
    });
  }

  private ownsProvenance(provenance: TerminalEventProvenance): boolean {
    const identity = this.provenanceIdentities.get(provenance);
    return (
      !!identity &&
      identity.id === provenance.id &&
      identity.screen === provenance.screen &&
      provenance.id > 0
    );
  }

  // ==========================================================================
  // RenderState API - The key performance optimization
  // ==========================================================================

  /**
   * Update render state from terminal.
   *
   * This syncs the RenderState with the current Terminal state.
   * The dirty state (full/partial/none) is stored in the WASM RenderState
   * and can be queried via isRowDirty(). When dirty==full, isRowDirty()
   * returns true for ALL rows.
   *
   * The WASM layer automatically detects screen switches (normal <-> alternate)
   * and returns FULL dirty state when switching screens (e.g., vim exit).
   *
   * Safe to call multiple times - dirty state persists until markClean().
   */
  update(): DirtyState {
    return this.exports.ghostty_render_state_update(this.handle) as DirtyState;
  }

  /**
   * Get cursor state from render state.
   * Ensures render state is fresh by calling update().
   */
  getCursor(): RenderStateCursor {
    // Call update() to ensure render state is fresh.
    // This is safe to call multiple times - dirty state persists until markClean().
    this.update();
    return this.readCursor();
  }

  /** Refresh once and collect every Canvas frame-level presentation value. */
  getRenderState(): RenderStateSnapshot {
    const dirty = this.update();
    return {
      dirty,
      cursor: this.readCursor(),
      colors: this.readColors(),
      dimensions: this.getDimensions(),
    };
  }

  /**
   * Get effective colors from render state.
   */
  getColors(): RenderStateColors {
    this.update();
    return this.readColors();
  }

  private readCursor(): RenderStateCursor {
    return {
      x: this.exports.ghostty_render_state_get_cursor_x(this.handle),
      y: this.exports.ghostty_render_state_get_cursor_y(this.handle),
      viewportX: this.exports.ghostty_render_state_get_cursor_x(this.handle),
      viewportY: this.exports.ghostty_render_state_get_cursor_y(this.handle),
      visible: !!this.exports.ghostty_render_state_get_cursor_visible(this.handle),
      blinking: !!this.exports.ghostty_render_state_get_cursor_blinking(this.handle),
      style: this.decodeCursorStyle(
        this.exports.ghostty_render_state_get_cursor_style(this.handle)
      ),
      default: !!this.exports.ghostty_render_state_get_cursor_default(this.handle),
    };
  }

  private decodeCursorStyle(value: number): CursorStyle {
    switch (value) {
      case 1:
        return 'block_hollow';
      case 2:
        return 'bar';
      case 3:
        return 'underline';
      default:
        return 'block';
    }
  }

  private readColors(): RenderStateColors {
    const bg = this.exports.ghostty_render_state_get_bg_color(this.handle);
    const fg = this.exports.ghostty_render_state_get_fg_color(this.handle);
    const cursor = this.exports.ghostty_render_state_get_cursor_color(this.handle);
    const decode = (value: number): RGB => ({
      r: (value >> 16) & 0xff,
      g: (value >> 8) & 0xff,
      b: value & 0xff,
    });
    return {
      background: decode(bg),
      foreground: decode(fg),
      cursor: decode(cursor),
      palette: Array.from({ length: 16 }, (_, index) =>
        decode(this.exports.ghostty_render_state_get_palette_color(this.handle, index))
      ),
    };
  }

  /**
   * Check if a specific row is dirty
   */
  isRowDirty(y: number): boolean {
    return this.exports.ghostty_render_state_is_row_dirty(this.handle, y);
  }

  /**
   * Mark render state as clean (call after rendering)
   */
  markClean(): void {
    this.exports.ghostty_render_state_mark_clean(this.handle);
  }

  /**
   * Get ALL viewport cells in ONE WASM call - the key performance optimization!
   * Returns a reusable cell array (zero allocation after warmup).
   */
  getViewport(refreshRenderState: boolean = true): GhosttyCell[] {
    if (refreshRenderState) this.update();

    const totalCells = this._cols * this._rows;
    const neededSize = totalCells * GhosttyTerminal.CELL_SIZE;

    // Ensure buffer is allocated
    if (!this.viewportBufferPtr || this.viewportBufferSize < neededSize) {
      if (this.viewportBufferPtr) {
        this.exports.ghostty_wasm_free_u8_array(this.viewportBufferPtr, this.viewportBufferSize);
      }
      this.viewportBufferPtr = this.exports.ghostty_wasm_alloc_u8_array(neededSize);
      this.viewportBufferSize = neededSize;
    }

    // Get all cells in one call
    const count = this.exports.ghostty_render_state_get_viewport(
      this.handle,
      this.viewportBufferPtr,
      totalCells
    );

    if (count < 0) return this.cellPool;

    // Parse cells into pool (reuses existing objects)
    this.parseCellsIntoPool(this.viewportBufferPtr, totalCells);
    return this.cellPool;
  }

  // ==========================================================================
  // Compatibility methods (delegate to render state)
  // ==========================================================================

  /**
   * Get line - for compatibility, extracts from viewport.
   * Ensures render state is fresh by calling update().
   * Returns a COPY of the cells to avoid pool reference issues.
   */
  getLine(y: number): GhosttyCell[] | null {
    if (y < 0 || y >= this._rows) return null;
    // Call update() to ensure render state is fresh.
    // This is safe to call multiple times - dirty state persists until markClean().
    this.update();
    const viewport = this.getViewport(false);
    const start = y * this._cols;
    // Return deep copies to avoid cell pool reference issues
    return viewport.slice(start, start + this._cols).map((cell) => ({ ...cell }));
  }

  /** For compatibility with old API */
  isDirty(): boolean {
    return this.update() !== DirtyState.NONE;
  }

  /**
   * Check if a full redraw is needed (screen change, resize, etc.)
   * Note: This calls update() to ensure fresh state. Safe to call multiple times.
   */
  needsFullRedraw(): boolean {
    return this.update() === DirtyState.FULL;
  }

  /** Mark render state as clean after rendering */
  clearDirty(): void {
    this.markClean();
  }

  // ==========================================================================
  // Terminal modes
  // ==========================================================================

  isAlternateScreen(): boolean {
    return !!this.exports.ghostty_terminal_is_alternate_screen(this.handle);
  }

  /** Read metadata for either Ghostty screen without activating it. */
  getBufferInfo(type: GhosttyBufferType): GhosttyBufferInfo | null {
    if (!this.handle) return null;
    const byteLength = 5 * Uint32Array.BYTES_PER_ELEMENT;
    if (!this.bufferInfoPtr) {
      this.bufferInfoPtr = this.exports.ghostty_wasm_alloc_u8_array(byteLength);
      if (!this.bufferInfoPtr) return null;
    }

    const count = this.exports.ghostty_terminal_get_buffer_info(
      this.handle,
      type === 'alternate',
      this.bufferInfoPtr,
      5
    );
    if (count !== 5) return null;
    const values = new Uint32Array(this.memory.buffer, this.bufferInfoPtr, 5);
    return {
      scrollbackLength: values[0],
      cursorX: values[1],
      cursorY: values[2],
      rows: values[3],
      cols: values[4],
    };
  }

  /** Copy an absolute retained row from either screen without activating it. */
  getBufferLine(
    type: GhosttyBufferType,
    y: number,
    refreshRenderState: boolean = true
  ): GhosttyCell[] | null {
    if (!this.handle || y < 0) return null;
    const neededSize = this._cols * GhosttyTerminal.CELL_SIZE;
    if (!this.viewportBufferPtr || this.viewportBufferSize < neededSize) {
      if (this.viewportBufferPtr) {
        this.exports.ghostty_wasm_free_u8_array(this.viewportBufferPtr, this.viewportBufferSize);
      }
      this.viewportBufferPtr = this.exports.ghostty_wasm_alloc_u8_array(neededSize);
      this.viewportBufferSize = neededSize;
    }
    if (!this.viewportBufferPtr) return null;

    if (refreshRenderState) this.update();
    const count = this.exports.ghostty_terminal_get_buffer_line(
      this.handle,
      type === 'alternate',
      y,
      this.viewportBufferPtr,
      this._cols
    );
    return count < 0 ? null : this.parseCells(this.viewportBufferPtr, count);
  }

  /** Read every codepoint for a cell in either named screen. */
  getBufferGrapheme(type: GhosttyBufferType, y: number, col: number): number[] | null {
    if (!this.handle || y < 0 || col < 0) return null;
    if (!this.graphemeBufferPtr) {
      this.graphemeBufferPtr = this.exports.ghostty_wasm_alloc_u8_array(16 * 4);
      if (!this.graphemeBufferPtr) return null;
      this.graphemeBuffer = new Uint32Array(this.memory.buffer, this.graphemeBufferPtr, 16);
    }
    const count = this.exports.ghostty_terminal_get_buffer_grapheme(
      this.handle,
      type === 'alternate',
      y,
      col,
      this.graphemeBufferPtr,
      16
    );
    if (count < 0) return null;
    return Array.from(new Uint32Array(this.memory.buffer, this.graphemeBufferPtr, count));
  }

  /** Whether an absolute retained row in a named screen continues a soft wrap. */
  isBufferRowWrapped(type: GhosttyBufferType, y: number): boolean {
    return (
      !!this.handle &&
      !!this.exports.ghostty_terminal_is_buffer_row_wrapped(this.handle, type === 'alternate', y)
    );
  }

  hasBracketedPaste(): boolean {
    // Mode 2004 = bracketed paste (DEC mode)
    return this.getMode(2004, false);
  }

  hasFocusEvents(): boolean {
    // Mode 1004 = focus events (DEC mode)
    return this.getMode(1004, false);
  }

  hasMouseTracking(): boolean {
    return this.exports.ghostty_terminal_has_mouse_tracking(this.handle) !== 0;
  }

  /** Whether Ghostty's parser-owned synchronized-output mode is active. */
  isSynchronizedOutput(): boolean {
    return this.getMode(2026, false);
  }

  /** Changes for every parsed synchronized-output enable, including repeats. */
  getSynchronizedOutputGeneration(): number {
    return this.exports.ghostty_terminal_get_synchronized_output_generation(this.handle) >>> 0;
  }

  /** Clear abandoned synchronized output without injecting synthetic PTY bytes. */
  resetSynchronizedOutput(): void {
    this.exports.ghostty_terminal_reset_synchronized_output(this.handle);
  }

  // ==========================================================================
  // Extended API (scrollback, modes, etc.)
  // ==========================================================================

  /** Get dimensions - for compatibility */
  getDimensions(): { cols: number; rows: number } {
    return { cols: this._cols, rows: this._rows };
  }

  /** Get number of scrollback lines (history, not including active screen) */
  getScrollbackLength(): number {
    return this.exports.ghostty_terminal_get_scrollback_length(this.handle);
  }

  /** Get the configured native page-list byte limit; 0 means unlimited. */
  getScrollbackByteLimit(): number {
    return this.exports.ghostty_terminal_get_scrollback_limit_bytes(this.handle) >>> 0;
  }

  /**
   * Get a line from the scrollback buffer.
   * Ensures render state is fresh by calling update().
   * @param offset 0 = oldest line, (length-1) = most recent scrollback line
   */
  getScrollbackLine(offset: number): GhosttyCell[] | null {
    const neededSize = this._cols * GhosttyTerminal.CELL_SIZE;

    // Ensure buffer is allocated
    if (!this.viewportBufferPtr || this.viewportBufferSize < neededSize) {
      if (this.viewportBufferPtr) {
        this.exports.ghostty_wasm_free_u8_array(this.viewportBufferPtr, this.viewportBufferSize);
      }
      this.viewportBufferPtr = this.exports.ghostty_wasm_alloc_u8_array(neededSize);
      this.viewportBufferSize = neededSize;
    }

    // Call update() to ensure render state is fresh (needed for colors).
    // This is safe to call multiple times - dirty state persists until markClean().
    this.update();

    const count = this.exports.ghostty_terminal_get_scrollback_line(
      this.handle,
      offset,
      this.viewportBufferPtr,
      this._cols
    );

    if (count < 0) return null;

    // Parse cells
    const cells: GhosttyCell[] = [];
    const buffer = this.memory.buffer;
    const u8 = new Uint8Array(buffer, this.viewportBufferPtr, count * GhosttyTerminal.CELL_SIZE);
    const view = new DataView(buffer, this.viewportBufferPtr, count * GhosttyTerminal.CELL_SIZE);

    for (let i = 0; i < count; i++) {
      const cellOffset = i * GhosttyTerminal.CELL_SIZE;
      cells.push({
        codepoint: view.getUint32(cellOffset, true),
        fg_r: u8[cellOffset + 4],
        fg_g: u8[cellOffset + 5],
        fg_b: u8[cellOffset + 6],
        bg_r: u8[cellOffset + 7],
        bg_g: u8[cellOffset + 8],
        bg_b: u8[cellOffset + 9],
        flags: u8[cellOffset + 10],
        width: u8[cellOffset + 11],
        hyperlink_id: view.getUint16(cellOffset + 12, true),
        grapheme_len: u8[cellOffset + 14],
      });
    }

    return cells;
  }

  /**
   * Copy one visible retained-history slice in a single WASM call. The result
   * is bounded to the active viewport height and reuses its row/cell objects.
   */
  getScrollbackViewport(start: number, rows: number): GhosttyCell[][] | null {
    if (
      !this.handle ||
      !Number.isInteger(start) ||
      !Number.isInteger(rows) ||
      start < 0 ||
      rows < 0 ||
      rows > this._rows
    ) {
      return null;
    }
    if (rows === 0) return [];

    const totalCells = rows * this._cols;
    const neededSize = totalCells * GhosttyTerminal.CELL_SIZE;
    if (!this.viewportBufferPtr || this.viewportBufferSize < neededSize) {
      if (this.viewportBufferPtr) {
        this.exports.ghostty_wasm_free_u8_array(this.viewportBufferPtr, this.viewportBufferSize);
      }
      this.viewportBufferPtr = this.exports.ghostty_wasm_alloc_u8_array(neededSize);
      this.viewportBufferSize = neededSize;
    }
    if (!this.viewportBufferPtr) return null;

    this.update();
    const count = this.exports.ghostty_terminal_get_scrollback_viewport(
      this.handle,
      start,
      rows,
      this.viewportBufferPtr,
      totalCells
    );
    if (count !== totalCells) return null;

    this.ensureCellPool(this.scrollbackViewportCellPool, count);
    this.parseCellsInto(this.viewportBufferPtr, count, this.scrollbackViewportCellPool);
    this.scrollbackViewportRows.length = rows;
    for (let row = 0; row < rows; row++) {
      let line = this.scrollbackViewportRows[row];
      if (!line || line.length !== this._cols) {
        line = new Array<GhosttyCell>(this._cols);
        this.scrollbackViewportRows[row] = line;
      }
      const startCell = row * this._cols;
      for (let col = 0; col < this._cols; col++) {
        line[col] = this.scrollbackViewportCellPool[startCell + col];
      }
    }
    return this.scrollbackViewportRows;
  }

  /** Check if a row in the active screen is wrapped (soft-wrapped to next line) */
  isRowWrapped(row: number): boolean {
    return this.exports.ghostty_terminal_is_row_wrapped(this.handle, row) !== 0;
  }

  /**
   * Get the hyperlink URI for a cell at the given position.
   * @param row Row index (0-based, in active viewport)
   * @param col Column index (0-based)
   * @returns The URI string, or null if no hyperlink at that position
   */
  getHyperlinkUri(row: number, col: number): string | null {
    // Check if WASM has this function (requires rebuilt WASM with hyperlink support)
    if (!this.exports.ghostty_terminal_get_hyperlink_uri) {
      return null;
    }

    // Try with initial buffer, retry with larger if needed (for very long URLs)
    const bufferSizes = [2048, 8192, 32768];

    for (const bufSize of bufferSizes) {
      const bufPtr = this.exports.ghostty_wasm_alloc_u8_array(bufSize);

      try {
        const bytesWritten = this.exports.ghostty_terminal_get_hyperlink_uri(
          this.handle,
          row,
          col,
          bufPtr,
          bufSize
        );

        // 0 means no hyperlink at this position
        if (bytesWritten === 0) return null;

        // -1 means buffer too small, try next size
        if (bytesWritten === -1) continue;

        // Negative values other than -1 are errors
        if (bytesWritten < 0) return null;

        const bytes = new Uint8Array(this.memory.buffer, bufPtr, bytesWritten);
        return new TextDecoder().decode(bytes.slice());
      } finally {
        this.exports.ghostty_wasm_free_u8_array(bufPtr, bufSize);
      }
    }

    // URI too long even for largest buffer
    return null;
  }

  /**
   * Get the hyperlink URI for a cell in the scrollback buffer.
   * @param offset Scrollback line offset (0 = oldest, scrollback_len-1 = newest)
   * @param col Column index (0-based)
   * @returns The URI string, or null if no hyperlink at that position
   */
  getScrollbackHyperlinkUri(offset: number, col: number): string | null {
    // Check if WASM has this function
    if (!this.exports.ghostty_terminal_get_scrollback_hyperlink_uri) {
      return null;
    }

    // Try with initial buffer, retry with larger if needed (for very long URLs)
    const bufferSizes = [2048, 8192, 32768];

    for (const bufSize of bufferSizes) {
      const bufPtr = this.exports.ghostty_wasm_alloc_u8_array(bufSize);

      try {
        const bytesWritten = this.exports.ghostty_terminal_get_scrollback_hyperlink_uri(
          this.handle,
          offset,
          col,
          bufPtr,
          bufSize
        );

        // 0 means no hyperlink at this position
        if (bytesWritten === 0) return null;

        // -1 means buffer too small, try next size
        if (bytesWritten === -1) continue;

        // Negative values other than -1 are errors
        if (bytesWritten < 0) return null;

        const bytes = new Uint8Array(this.memory.buffer, bufPtr, bytesWritten);
        return new TextDecoder().decode(bytes.slice());
      } finally {
        this.exports.ghostty_wasm_free_u8_array(bufPtr, bufSize);
      }
    }

    // URI too long even for largest buffer
    return null;
  }

  /**
   * Check if there are pending responses from the terminal.
   * Responses are generated by escape sequences like DSR (Device Status Report).
   */
  hasResponse(): boolean {
    return this.exports.ghostty_terminal_has_response(this.handle);
  }

  /**
   * Read pending responses from the terminal.
   * Returns the response string, or null if no responses pending.
   *
   * Responses are generated by escape sequences that require replies:
   * - DSR 6 (cursor position): Returns \x1b[row;colR
   * - DSR 5 (operating status): Returns \x1b[0n
   */
  readResponse(): string | null {
    if (!this.hasResponse()) return null;

    const bufSize = 256; // Most responses are small
    const bufPtr = this.exports.ghostty_wasm_alloc_u8_array(bufSize);

    try {
      const bytesRead = this.exports.ghostty_terminal_read_response(this.handle, bufPtr, bufSize);

      if (bytesRead <= 0) return null;

      const bytes = new Uint8Array(this.memory.buffer, bufPtr, bytesRead);
      return new TextDecoder().decode(bytes.slice());
    } finally {
      this.exports.ghostty_wasm_free_u8_array(bufPtr, bufSize);
    }
  }

  /**
   * Query arbitrary terminal mode by number
   * @param mode Mode number (e.g., 25 for cursor visibility, 2004 for bracketed paste)
   * @param isAnsi True for ANSI modes, false for DEC modes (default: false)
   */
  getMode(mode: number, isAnsi: boolean = false): boolean {
    return this.exports.ghostty_terminal_get_mode(this.handle, mode, isAnsi) !== 0;
  }

  getKittyKeyboardFlags(): KittyKeyFlags {
    return this.exports.ghostty_terminal_get_kitty_keyboard_flags(this.handle) as KittyKeyFlags;
  }

  hasModifyOtherKeysState2(): boolean {
    return this.exports.ghostty_terminal_has_modify_other_keys_state_2(this.handle) !== 0;
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  private initCellPool(): void {
    const total = this._cols * this._rows;
    this.ensureCellPool(this.cellPool, total);
  }

  private ensureCellPool(pool: GhosttyCell[], total: number): void {
    if (pool.length < total) {
      for (let i = pool.length; i < total; i++) {
        pool.push({
          codepoint: 0,
          fg_r: 204,
          fg_g: 204,
          fg_b: 204,
          bg_r: 0,
          bg_g: 0,
          bg_b: 0,
          flags: 0,
          width: 1,
          hyperlink_id: 0,
          grapheme_len: 0,
        });
      }
    }
  }

  private parseCellsIntoPool(ptr: number, count: number): void {
    this.parseCellsInto(ptr, count, this.cellPool);
  }

  private parseCellsInto(ptr: number, count: number, pool: GhosttyCell[]): void {
    const buffer = this.memory.buffer;
    const u8 = new Uint8Array(buffer, ptr, count * GhosttyTerminal.CELL_SIZE);
    const view = new DataView(buffer, ptr, count * GhosttyTerminal.CELL_SIZE);

    for (let i = 0; i < count; i++) {
      const offset = i * GhosttyTerminal.CELL_SIZE;
      const cell = pool[i];
      cell.codepoint = view.getUint32(offset, true);
      cell.fg_r = u8[offset + 4];
      cell.fg_g = u8[offset + 5];
      cell.fg_b = u8[offset + 6];
      cell.bg_r = u8[offset + 7];
      cell.bg_g = u8[offset + 8];
      cell.bg_b = u8[offset + 9];
      cell.flags = u8[offset + 10];
      cell.width = u8[offset + 11];
      cell.hyperlink_id = view.getUint16(offset + 12, true);
      cell.grapheme_len = u8[offset + 14]; // grapheme_len is at byte 14
    }
  }

  private parseCells(ptr: number, count: number): GhosttyCell[] {
    const buffer = this.memory.buffer;
    const u8 = new Uint8Array(buffer, ptr, count * GhosttyTerminal.CELL_SIZE);
    const view = new DataView(buffer, ptr, count * GhosttyTerminal.CELL_SIZE);
    const cells: GhosttyCell[] = [];
    for (let i = 0; i < count; i++) {
      const offset = i * GhosttyTerminal.CELL_SIZE;
      cells.push({
        codepoint: view.getUint32(offset, true),
        fg_r: u8[offset + 4],
        fg_g: u8[offset + 5],
        fg_b: u8[offset + 6],
        bg_r: u8[offset + 7],
        bg_g: u8[offset + 8],
        bg_b: u8[offset + 9],
        flags: u8[offset + 10],
        width: u8[offset + 11],
        hyperlink_id: view.getUint16(offset + 12, true),
        grapheme_len: u8[offset + 14],
      });
    }
    return cells;
  }

  /** Small buffer for grapheme lookups (reused to avoid allocation) */
  private graphemeBuffer: Uint32Array | null = null;
  private graphemeBufferPtr: number = 0;

  /**
   * Get all codepoints for a grapheme cluster at the given position.
   * For most cells this returns a single codepoint, but for complex scripts
   * (Hindi, emoji with ZWJ, etc.) it returns multiple codepoints.
   * @returns Array of codepoints, or null on error
   */
  getGrapheme(row: number, col: number, refreshRenderState: boolean = true): number[] | null {
    // Allocate buffer on first use (16 codepoints should be enough for any grapheme)
    if (!this.graphemeBuffer) {
      this.graphemeBufferPtr = this.exports.ghostty_wasm_alloc_u8_array(16 * 4);
      this.graphemeBuffer = new Uint32Array(this.memory.buffer, this.graphemeBufferPtr, 16);
    }

    if (refreshRenderState) this.update();

    const count = this.exports.ghostty_render_state_get_grapheme(
      this.handle,
      row,
      col,
      this.graphemeBufferPtr,
      16
    );

    if (count < 0) return null;

    // Re-create view in case memory grew
    const view = new Uint32Array(this.memory.buffer, this.graphemeBufferPtr, count);
    return Array.from(view);
  }

  /**
   * Get a string representation of the grapheme at the given position.
   * This properly handles complex scripts like Hindi, emoji with ZWJ, etc.
   */
  getGraphemeString(row: number, col: number, refreshRenderState: boolean = true): string {
    const codepoints = this.getGrapheme(row, col, refreshRenderState);
    if (!codepoints || codepoints.length === 0) return ' ';
    return String.fromCodePoint(...codepoints);
  }

  /**
   * Get all codepoints for a grapheme cluster in the scrollback buffer.
   * @param offset Scrollback line offset (0 = oldest)
   * @param col Column index
   * @returns Array of codepoints, or null on error
   */
  getScrollbackGrapheme(offset: number, col: number): number[] | null {
    // Reuse the same buffer as getGrapheme
    if (!this.graphemeBuffer) {
      this.graphemeBufferPtr = this.exports.ghostty_wasm_alloc_u8_array(16 * 4);
      this.graphemeBuffer = new Uint32Array(this.memory.buffer, this.graphemeBufferPtr, 16);
    }

    const count = this.exports.ghostty_terminal_get_scrollback_grapheme(
      this.handle,
      offset,
      col,
      this.graphemeBufferPtr,
      16
    );

    if (count < 0) return null;

    // Re-create view in case memory grew
    const view = new Uint32Array(this.memory.buffer, this.graphemeBufferPtr, count);
    return Array.from(view);
  }

  /**
   * Get a string representation of a grapheme in the scrollback buffer.
   */
  getScrollbackGraphemeString(offset: number, col: number): string {
    const codepoints = this.getScrollbackGrapheme(offset, col);
    if (!codepoints || codepoints.length === 0) return ' ';
    return String.fromCodePoint(...codepoints);
  }

  private invalidateBuffers(): void {
    if (this.viewportBufferPtr) {
      this.exports.ghostty_wasm_free_u8_array(this.viewportBufferPtr, this.viewportBufferSize);
      this.viewportBufferPtr = 0;
      this.viewportBufferSize = 0;
    }
    if (this.graphemeBufferPtr) {
      this.exports.ghostty_wasm_free_u8_array(this.graphemeBufferPtr, 16 * 4);
      this.graphemeBufferPtr = 0;
    }
    if (this.bufferInfoPtr) {
      this.exports.ghostty_wasm_free_u8_array(
        this.bufferInfoPtr,
        5 * Uint32Array.BYTES_PER_ELEMENT
      );
      this.bufferInfoPtr = 0;
    }
    this.graphemeBuffer = null;
  }
}
