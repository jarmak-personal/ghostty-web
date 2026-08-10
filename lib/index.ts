/**
 * Public API for @cmux/ghostty-terminal
 *
 * Main entry point following xterm.js conventions
 */

import defaultWasmUrl from '../ghostty-vt.wasm?url&no-inline';
import { Ghostty } from './ghostty';

// Module-level Ghostty instance (initialized by init())
let ghosttyInstance: Ghostty | null = null;
let ghosttyInitialization: Promise<Ghostty> | null = null;
let initializedWasmUrl: string | null = null;

export interface InitOptions {
  /** Exact URL or file path of the Ghostty WebAssembly binary. */
  wasmUrl?: string | URL;
}

/**
 * Initialize the ghostty-web library by loading the WASM module.
 * Must be called before creating any Terminal instances.
 *
 * This creates a shared WASM instance that all Terminal instances will use.
 * For test isolation, pass a Ghostty instance directly to Terminal constructor.
 *
 * @example
 * ```typescript
 * import { init, Terminal } from 'ghostty-web';
 *
 * await init();
 * const term = new Terminal();
 * term.open(document.getElementById('terminal'));
 * ```
 */
export async function init(options: InitOptions = {}): Promise<void> {
  const requestedWasmUrl = options.wasmUrl === undefined ? null : String(options.wasmUrl);
  if (ghosttyInitialization) {
    if (requestedWasmUrl !== null && requestedWasmUrl !== initializedWasmUrl) {
      throw new Error(
        'ghostty-web is already initializing or initialized with a different WASM URL.'
      );
    }
    ghosttyInstance = await ghosttyInitialization;
    return;
  }

  initializedWasmUrl = requestedWasmUrl ?? defaultWasmUrl;
  const initialization = Ghostty.load(options.wasmUrl);
  ghosttyInitialization = initialization;
  try {
    ghosttyInstance = await initialization;
  } catch (error) {
    if (ghosttyInitialization === initialization) {
      ghosttyInitialization = null;
      initializedWasmUrl = null;
    }
    throw error;
  }
}

/**
 * Get the initialized Ghostty instance.
 * Throws if init() hasn't been called.
 * @internal
 */
export function getGhostty(): Ghostty {
  if (!ghosttyInstance) {
    throw new Error(
      'ghostty-web not initialized. Call init() before creating Terminal instances.\n' +
        'Example:\n' +
        '  import { init, Terminal } from "ghostty-web";\n' +
        '  await init();\n' +
        '  const term = new Terminal();\n\n' +
        'For tests, pass a Ghostty instance directly:\n' +
        '  import { Ghostty, Terminal } from "ghostty-web";\n' +
        '  const ghostty = await Ghostty.load();\n' +
        '  const term = new Terminal({ ghostty });'
    );
  }
  return ghosttyInstance;
}

export type { ITerminalDimensions } from './addons/fit';
// Addons
export { FitAddon } from './addons/fit';
export { EventEmitter } from './event-emitter';
// Ghostty WASM components (for advanced usage)
export {
  CellFlags,
  DirtyState,
  Ghostty,
  GhosttyTerminal,
  KeyEncoder,
  KeyEncoderOption,
} from './ghostty';
export { InputHandler } from './input-handler';
// xterm.js-compatible interfaces
export type {
  IBufferRange,
  IDisposable,
  IEvent,
  IKeyEvent,
  IRetainedBufferExtractionOptions,
  IRetainedBufferRange,
  IRetainedBufferSearchOptions,
  IRetainedBufferSearchResult,
  ITerminalAddon,
  ITerminalCore,
  ITerminalOptions,
  ITheme,
  IUnicodeVersionProvider,
} from './interfaces';
export { LinkDetector } from './link-detector';
// Link providers
export { OSC8LinkProvider } from './providers/osc8-link-provider';
export { UrlRegexProvider } from './providers/url-regex-provider';
export type { FontMetrics, IRenderable, RendererFrameStats, RendererOptions } from './renderer';
// Low-level components (for custom integrations)
export { CanvasRenderer } from './renderer';
export {
  RetainedBufferExtractionError,
  type RetainedBufferExtractionErrorCode,
} from './retained-buffer-extraction';
export type { SelectionCoordinates } from './selection-manager';
export { SelectionManager } from './selection-manager';
export type { TerminalRenderStats } from './terminal';
// Main Terminal class
export { Terminal } from './terminal';
export type {
  Cursor,
  CursorBlink,
  CursorStyle,
  GhosttyCell,
  IBufferCellPosition,
  ILink,
  ILinkProvider,
  KeyEvent,
  RGB,
  TerminalEvent,
  TerminalEventProvenance,
  TerminalEventScreen,
  TerminalHandle,
  TerminalNotificationSource,
  TerminalPaletteRequest,
  TerminalPaletteTarget,
  TerminalProgressState,
  TerminalSemanticAction,
} from './types';
export { Key, KeyAction, Mods } from './types';
