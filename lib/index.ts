/**
 * Public API for @cmux/ghostty-terminal
 *
 * Main entry point following xterm.js conventions
 */

import { Ghostty } from './ghostty';

// Module-level Ghostty instance (initialized by init())
let ghosttyInstance: Ghostty | null = null;

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
export async function init(): Promise<void> {
  if (ghosttyInstance) {
    return; // Already initialized
  }
  ghosttyInstance = await Ghostty.load();
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
export type { FontMetrics, IRenderable, RendererOptions } from './renderer';
// Low-level components (for custom integrations)
export { CanvasRenderer } from './renderer';
export type { SelectionCoordinates } from './selection-manager';
export { SelectionManager } from './selection-manager';
export type { TerminalRenderStats } from './terminal';
// Main Terminal class
export { Terminal } from './terminal';
export type {
  Cursor,
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
