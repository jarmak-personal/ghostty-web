/**
 * InputHandler - Converts browser keyboard events to terminal input
 *
 * Handles:
 * - Keyboard event listening on a container element
 * - Mapping KeyboardEvent.code to USB HID Key codes
 * - Extracting modifier keys (Ctrl, Alt, Shift, Meta)
 * - Encoding keys using Ghostty's KeyEncoder
 * - Emitting data for Terminal to send to PTY
 *
 * Limitations:
 * - Captures all keyboard input (preventDefault on everything)
 */

import type { Ghostty, KeyEncoder } from './ghostty';
import type { ClipboardFilePasteResolver, IKeyEvent } from './interfaces';
import { encodePaste } from './paste';
import { Key, KeyAction, KeyEncoderOption, KittyKeyFlags, Mods } from './types';

/**
 * Map KeyboardEvent.code values to USB HID Key enum values
 * Based on: https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/code
 */
const KEY_MAP: Record<string, Key> = {
  // Letters
  KeyA: Key.A,
  KeyB: Key.B,
  KeyC: Key.C,
  KeyD: Key.D,
  KeyE: Key.E,
  KeyF: Key.F,
  KeyG: Key.G,
  KeyH: Key.H,
  KeyI: Key.I,
  KeyJ: Key.J,
  KeyK: Key.K,
  KeyL: Key.L,
  KeyM: Key.M,
  KeyN: Key.N,
  KeyO: Key.O,
  KeyP: Key.P,
  KeyQ: Key.Q,
  KeyR: Key.R,
  KeyS: Key.S,
  KeyT: Key.T,
  KeyU: Key.U,
  KeyV: Key.V,
  KeyW: Key.W,
  KeyX: Key.X,
  KeyY: Key.Y,
  KeyZ: Key.Z,

  // Numbers
  Digit1: Key.ONE,
  Digit2: Key.TWO,
  Digit3: Key.THREE,
  Digit4: Key.FOUR,
  Digit5: Key.FIVE,
  Digit6: Key.SIX,
  Digit7: Key.SEVEN,
  Digit8: Key.EIGHT,
  Digit9: Key.NINE,
  Digit0: Key.ZERO,

  // Special keys
  Enter: Key.ENTER,
  Escape: Key.ESCAPE,
  Backspace: Key.BACKSPACE,
  Tab: Key.TAB,
  Space: Key.SPACE,

  // Punctuation
  Minus: Key.MINUS,
  Equal: Key.EQUAL,
  BracketLeft: Key.BRACKET_LEFT,
  BracketRight: Key.BRACKET_RIGHT,
  Backslash: Key.BACKSLASH,
  Semicolon: Key.SEMICOLON,
  Quote: Key.QUOTE,
  Backquote: Key.GRAVE,
  Comma: Key.COMMA,
  Period: Key.PERIOD,
  Slash: Key.SLASH,

  // Function keys
  CapsLock: Key.CAPS_LOCK,
  F1: Key.F1,
  F2: Key.F2,
  F3: Key.F3,
  F4: Key.F4,
  F5: Key.F5,
  F6: Key.F6,
  F7: Key.F7,
  F8: Key.F8,
  F9: Key.F9,
  F10: Key.F10,
  F11: Key.F11,
  F12: Key.F12,

  // Special function keys
  PrintScreen: Key.PRINT_SCREEN,
  ScrollLock: Key.SCROLL_LOCK,
  Pause: Key.PAUSE,
  Insert: Key.INSERT,
  Home: Key.HOME,
  PageUp: Key.PAGE_UP,
  Delete: Key.DELETE,
  End: Key.END,
  PageDown: Key.PAGE_DOWN,

  // Arrow keys
  ArrowRight: Key.RIGHT,
  ArrowLeft: Key.LEFT,
  ArrowDown: Key.DOWN,
  ArrowUp: Key.UP,

  // Keypad
  NumLock: Key.NUM_LOCK,
  NumpadDivide: Key.KP_DIVIDE,
  NumpadMultiply: Key.KP_MULTIPLY,
  NumpadSubtract: Key.KP_MINUS,
  NumpadAdd: Key.KP_PLUS,
  NumpadEnter: Key.KP_ENTER,
  Numpad1: Key.KP_1,
  Numpad2: Key.KP_2,
  Numpad3: Key.KP_3,
  Numpad4: Key.KP_4,
  Numpad5: Key.KP_5,
  Numpad6: Key.KP_6,
  Numpad7: Key.KP_7,
  Numpad8: Key.KP_8,
  Numpad9: Key.KP_9,
  Numpad0: Key.KP_0,
  NumpadDecimal: Key.KP_PERIOD,

  // International
  IntlBackslash: Key.INTL_BACKSLASH,
  ContextMenu: Key.CONTEXT_MENU,

  // Additional function keys
  F13: Key.F13,
  F14: Key.F14,
  F15: Key.F15,
  F16: Key.F16,
  F17: Key.F17,
  F18: Key.F18,
  F19: Key.F19,
  F20: Key.F20,
  F21: Key.F21,
  F22: Key.F22,
  F23: Key.F23,
  F24: Key.F24,
};

const UNSHIFTED_SYMBOLS: Readonly<Record<string, string>> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
};

/** Match Ghostty's browser example when translating a physical key to its base codepoint. */
function getUnshiftedCodepoint(event: KeyboardEvent): number {
  if (event.code.startsWith('Key')) {
    return event.code.substring(3).toLowerCase().codePointAt(0) ?? 0;
  }
  if (event.code.startsWith('Digit')) {
    return event.code.substring(5).codePointAt(0) ?? 0;
  }
  if (event.code === 'Space') return ' '.codePointAt(0) ?? 0;

  const symbol = UNSHIFTED_SYMBOLS[event.code];
  if (symbol) return symbol.codePointAt(0) ?? 0;

  return event.key.codePointAt(0) ?? 0;
}

type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: { platform?: string };
};

function getMacOSOptionLetter(event: KeyboardEvent): string | null {
  if (!event.altKey || event.ctrlKey || event.metaKey || typeof navigator === 'undefined') {
    return null;
  }

  const userAgentPlatform = (navigator as NavigatorWithUserAgentData).userAgentData?.platform;
  const platform = userAgentPlatform || navigator.platform || '';
  if (userAgentPlatform !== 'macOS' && !platform.startsWith('Mac')) return null;

  const match = /^Key([A-Z])$/.exec(event.code);
  if (!match) return null;
  return event.shiftKey ? match[1] : match[1].toLowerCase();
}

/**
 * InputHandler class
 * Attaches keyboard event listeners to a container and converts
 * keyboard events to terminal input data
 */
/**
 * Mouse tracking configuration
 */
export interface MouseTrackingConfig {
  /** Check if any mouse tracking mode is enabled */
  hasMouseTracking: () => boolean;
  /** Check whether this event is reserved for application mouse tracking */
  shouldReportEvent?: (event: MouseEvent) => boolean;
  /** Check whether a mouse button may be forwarded to the terminal */
  shouldReportButton?: (button: number) => boolean;
  /** Check if SGR extended mouse mode is enabled (mode 1006) */
  hasSgrMouseMode: () => boolean;
  /** Get cell dimensions for pixel to cell conversion */
  getCellDimensions: () => { width: number; height: number };
  /** Get canvas/container offset for accurate position calculation */
  getCanvasOffset: () => { left: number; top: number };
}

export interface KeyboardProtocolState {
  kittyFlags: KittyKeyFlags;
  modifyOtherKeysState2: boolean;
}

interface CompositionTransaction {
  phase: 'active' | 'ended';
  emittedData: string | null;
}

export class InputHandler {
  private encoder: KeyEncoder;
  private container: HTMLElement;
  private inputElement?: HTMLElement;
  private onDataCallback: (data: string) => void;
  private onBellCallback: () => void;
  private onKeyCallback?: (keyEvent: IKeyEvent) => void;
  private customKeyEventHandler?: (event: KeyboardEvent) => boolean;
  private getModeCallback?: (mode: number) => boolean;
  private onCopyCallback?: () => boolean;
  private mouseConfig?: MouseTrackingConfig;
  private getKeyboardProtocolStateCallback?: () => KeyboardProtocolState;
  private resolveClipboardFilePasteCallback?: ClipboardFilePasteResolver;
  private keydownListener: ((e: KeyboardEvent) => void) | null = null;
  private keypressListener: ((e: KeyboardEvent) => void) | null = null;
  private pasteListener: ((e: ClipboardEvent) => void) | null = null;
  private beforeInputListener: ((e: InputEvent) => void) | null = null;
  private compositionStartListener: ((e: CompositionEvent) => void) | null = null;
  private compositionUpdateListener: ((e: CompositionEvent) => void) | null = null;
  private compositionEndListener: ((e: CompositionEvent) => void) | null = null;
  private mousedownListener: ((e: MouseEvent) => void) | null = null;
  private mouseupListener: ((e: MouseEvent) => void) | null = null;
  private mousemoveListener: ((e: MouseEvent) => void) | null = null;
  private wheelListener: ((e: WheelEvent) => void) | null = null;
  private isComposing = false;
  private isDisposed = false;
  private mouseButtonsPressed = 0; // Track which buttons are pressed for motion reporting
  private locallyOwnedMouseButtons = 0; // Buttons reserved by a host/local-selection override
  private lastKeyDownData: string | null = null;
  private lastPasteData: string | null = null;
  private lastPasteTime = 0;
  private lastPasteSource: 'paste' | 'beforeinput' | null = null;
  private lastBeforeInputData: string | null = null;
  private compositionTransaction: CompositionTransaction | null = null;
  private inputStateResetTimeout: ReturnType<typeof setTimeout> | undefined;
  private static readonly BEFORE_INPUT_IGNORE_MS = 100;

  /**
   * Create a new InputHandler
   * @param ghostty - Ghostty instance (for creating KeyEncoder)
   * @param container - DOM element to attach listeners to
   * @param onData - Callback for terminal data (escape sequences to send to PTY)
   * @param onBell - Callback for bell/beep event
   * @param onKey - Optional callback for raw key events
   * @param customKeyEventHandler - Optional custom key event handler
   * @param getMode - Optional callback to query terminal mode state (for application cursor mode)
   * @param onCopy - Optional callback to handle copy (Cmd+C/Ctrl+C with selection)
   * @param inputElement - Optional input element for beforeinput events
   * @param mouseConfig - Optional mouse tracking configuration
   * @param getKeyboardProtocolState - Optional callback for negotiated keyboard protocol state
   * @param resolveClipboardFilePaste - Optional capability that maps one native clipboard file paste to text
   */
  constructor(
    ghostty: Ghostty,
    container: HTMLElement,
    onData: (data: string) => void,
    onBell: () => void,
    onKey?: (keyEvent: IKeyEvent) => void,
    customKeyEventHandler?: (event: KeyboardEvent) => boolean,
    getMode?: (mode: number) => boolean,
    onCopy?: () => boolean,
    inputElement?: HTMLElement,
    mouseConfig?: MouseTrackingConfig,
    getKeyboardProtocolState?: () => KeyboardProtocolState,
    resolveClipboardFilePaste?: ClipboardFilePasteResolver
  ) {
    this.encoder = ghostty.createKeyEncoder();
    this.container = container;
    this.inputElement = inputElement;
    this.onDataCallback = onData;
    this.onBellCallback = onBell;
    this.onKeyCallback = onKey;
    this.customKeyEventHandler = customKeyEventHandler;
    this.getModeCallback = getMode;
    this.onCopyCallback = onCopy;
    this.mouseConfig = mouseConfig;
    this.getKeyboardProtocolStateCallback = getKeyboardProtocolState;
    this.resolveClipboardFilePasteCallback = resolveClipboardFilePaste;

    try {
      this.attach();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  /**
   * Set custom key event handler (for runtime updates)
   */
  setCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
    this.customKeyEventHandler = handler;
  }

  /**
   * Emit synthesized arrow presses through Ghostty's negotiated key encoder.
   * Used by alternate-screen wheel fallback so cursor and keyboard modes stay authoritative.
   */
  sendArrowKeys(direction: 'up' | 'down', count: number): void {
    if (this.isDisposed || count <= 0) return;

    try {
      const keyboardProtocolState = this.getKeyboardProtocolStateCallback?.();
      this.syncEncoderOptions(keyboardProtocolState);
      const encoded = this.encoder.encode({
        action: KeyAction.PRESS,
        key: direction === 'up' ? Key.UP : Key.DOWN,
        mods: Mods.NONE,
      });
      const data = new TextDecoder().decode(encoded);

      if (data.length > 0) {
        for (let index = 0; index < count; index++) this.onDataCallback(data);
      }
    } catch (error) {
      console.warn(`Failed to encode ${direction} arrow wheel fallback:`, error);
    }
  }

  private syncEncoderOptions(keyboardProtocolState?: KeyboardProtocolState): void {
    if (this.getModeCallback) {
      this.encoder.setOption(KeyEncoderOption.CURSOR_KEY_APPLICATION, this.getModeCallback(1));
    }
    if (keyboardProtocolState) {
      this.encoder.setKittyFlags(keyboardProtocolState.kittyFlags);
      this.encoder.setOption(
        KeyEncoderOption.MODIFY_OTHER_KEYS_STATE_2,
        keyboardProtocolState.modifyOtherKeysState2
      );
    }
  }

  /**
   * Attach keyboard event listeners to container
   */
  private attach(): void {
    // Make container focusable so it can receive keyboard events (browser only)
    if (
      typeof this.container.hasAttribute === 'function' &&
      typeof this.container.setAttribute === 'function'
    ) {
      if (!this.container.hasAttribute('tabindex')) {
        this.container.setAttribute('tabindex', '0');
      }

      // Add visual focus indication (only if style exists - for browser environments)
      if (this.container.style) {
        this.container.style.outline = 'none'; // Remove default outline
      }
    }

    this.keydownListener = this.handleKeyDown.bind(this);
    this.container.addEventListener('keydown', this.keydownListener);

    this.pasteListener = this.handlePaste.bind(this);
    this.container.addEventListener('paste', this.pasteListener);
    if (this.inputElement && this.inputElement !== this.container) {
      this.inputElement.addEventListener('paste', this.pasteListener);
    }

    if (this.inputElement) {
      this.beforeInputListener = this.handleBeforeInput.bind(this);
      this.inputElement.addEventListener('beforeinput', this.beforeInputListener);
    }

    this.compositionStartListener = this.handleCompositionStart.bind(this);
    this.container.addEventListener('compositionstart', this.compositionStartListener);

    this.compositionUpdateListener = this.handleCompositionUpdate.bind(this);
    this.container.addEventListener('compositionupdate', this.compositionUpdateListener);

    this.compositionEndListener = this.handleCompositionEnd.bind(this);
    this.container.addEventListener('compositionend', this.compositionEndListener);

    // Mouse event listeners (for terminal mouse tracking)
    this.mousedownListener = this.handleMouseDown.bind(this);
    this.container.addEventListener('mousedown', this.mousedownListener);

    this.mouseupListener = this.handleMouseUp.bind(this);
    this.container.addEventListener('mouseup', this.mouseupListener);

    this.mousemoveListener = this.handleMouseMove.bind(this);
    this.container.addEventListener('mousemove', this.mousemoveListener);

    this.wheelListener = this.handleWheel.bind(this);
    this.container.addEventListener('wheel', this.wheelListener, { passive: false });
  }

  /**
   * Map KeyboardEvent.code to USB HID Key enum value
   * @param code - KeyboardEvent.code value
   * @returns Key enum value or null if unmapped
   */
  private mapKeyCode(code: string): Key | null {
    return KEY_MAP[code] ?? null;
  }

  /**
   * Extract modifier flags from KeyboardEvent
   * @param event - KeyboardEvent
   * @returns Mods flags
   */
  private extractModifiers(event: KeyboardEvent): Mods {
    let mods = Mods.NONE;

    if (event.shiftKey) mods |= Mods.SHIFT;
    if (event.ctrlKey) mods |= Mods.CTRL;
    if (event.altKey) mods |= Mods.ALT;
    if (event.metaKey) mods |= Mods.SUPER;

    // Note: CapsLock and NumLock are not in KeyboardEvent modifiers
    // They would need to be tracked separately if needed
    // For now, we don't set CAPSLOCK or NUMLOCK flags

    return mods;
  }

  /**
   * Check if this is a printable character with no special modifiers
   * @param event - KeyboardEvent
   * @returns true if printable character
   */
  private isPrintableCharacter(event: KeyboardEvent): boolean {
    // If Ctrl, Alt, or Meta (Cmd on Mac) is pressed, it's not a simple printable character
    // Exception: AltGr (Ctrl+Alt on some keyboards) can produce printable characters
    if (event.ctrlKey && !event.altKey) return false;
    if (event.altKey && !event.ctrlKey) return false;
    if (event.metaKey) return false; // Cmd key on Mac

    // If key produces a single printable character
    return event.key.length === 1;
  }

  /**
   * Handle keydown event
   * @param event - KeyboardEvent
   */
  private handleKeyDown(event: KeyboardEvent): void {
    if (this.isDisposed) return;

    // Ignore keydown events during composition
    // Note: Some browsers send keyCode 229 for all keys during composition
    if (this.isComposing || event.isComposing || event.keyCode === 229) {
      return;
    }

    // Emit onKey event first (before any processing)
    if (this.onKeyCallback) {
      this.onKeyCallback({ key: event.key, domEvent: event });
    }

    // Check custom key event handler
    if (this.customKeyEventHandler) {
      const handled = this.customKeyEventHandler(event);
      if (handled) {
        // Custom handler consumed the event
        event.preventDefault();
        return;
      }
    }

    // Allow Ctrl+V and Cmd+V to trigger paste event (don't preventDefault)
    if ((event.ctrlKey || event.metaKey) && event.code === 'KeyV') {
      // Let the browser's native paste event fire
      return;
    }

    // Handle Cmd+C for copy (on Mac, Cmd+C should copy, not send interrupt)
    if (event.metaKey && event.code === 'KeyC') {
      // Try to copy selection via callback
      // If there's a selection and copy succeeds, prevent default
      // If no selection, let it fall through (browser may have other text selected)
      if (this.onCopyCallback && this.onCopyCallback()) {
        event.preventDefault();
      }
      return;
    }

    // Ctrl+Shift+C is the conventional Linux terminal copy chord. Reserve it
    // even without a selection so it can never fall through as Ctrl+C.
    if (
      event.ctrlKey &&
      event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      event.code === 'KeyC'
    ) {
      this.onCopyCallback?.();
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // For printable characters without modifiers, send the character directly
    // This handles: a-z, A-Z (with shift), 0-9, punctuation, etc.
    if (this.isPrintableCharacter(event)) {
      event.preventDefault();
      this.onDataCallback(event.key);
      this.recordKeyDownData(event.key);
      return;
    }

    // Map the physical key code
    const key = this.mapKeyCode(event.code);
    if (key === null) {
      // Unknown key - ignore it
      return;
    }

    // Extract modifiers
    const mods = this.extractModifiers(event);
    const keyboardProtocolState = this.getKeyboardProtocolStateCallback?.();
    const hasExtendedKeyboardProtocol =
      keyboardProtocolState !== undefined &&
      (keyboardProtocolState.kittyFlags !== KittyKeyFlags.DISABLED ||
        keyboardProtocolState.modifyOtherKeysState2);

    // macOS Option-letter events expose composed characters (or "Dead") in
    // event.key. Legacy terminal applications expect the physical Alt-letter
    // chord; negotiated protocols continue through Ghostty's encoder below.
    const optionLetter = getMacOSOptionLetter(event);
    if (optionLetter !== null && !hasExtendedKeyboardProtocol) {
      const data = `\x1b${optionLetter}`;
      event.preventDefault();
      event.stopPropagation();
      this.onDataCallback(data);
      this.recordKeyDownData(data);
      return;
    }

    // Preserve legacy shortcuts only while no extended keyboard protocol is
    // active. Once negotiated, the Ghostty encoder owns mapped special keys
    // so its Kitty/modifyOtherKeys tables remain internally consistent.
    if ((mods === Mods.NONE || mods === Mods.SHIFT) && !hasExtendedKeyboardProtocol) {
      let simpleOutput: string | null = null;

      switch (key) {
        case Key.ENTER:
          simpleOutput = '\r'; // Carriage return
          break;
        case Key.TAB:
          if (mods === Mods.SHIFT) {
            simpleOutput = '\x1b[Z'; // Backtab
          } else {
            simpleOutput = '\t'; // Tab
          }
          break;
        case Key.BACKSPACE:
          simpleOutput = '\x7F'; // DEL (most terminals use 0x7F for backspace)
          break;
        case Key.ESCAPE:
          simpleOutput = '\x1B'; // ESC
          break;
        // Arrow keys are handled by the encoder (respects application cursor mode)
        // Navigation keys
        case Key.HOME:
          simpleOutput = '\x1B[H';
          break;
        case Key.END:
          simpleOutput = '\x1B[F';
          break;
        case Key.INSERT:
          simpleOutput = '\x1B[2~';
          break;
        case Key.DELETE:
          simpleOutput = '\x1B[3~';
          break;
        case Key.PAGE_UP:
          simpleOutput = '\x1B[5~';
          break;
        case Key.PAGE_DOWN:
          simpleOutput = '\x1B[6~';
          break;
        // Function keys
        case Key.F1:
          simpleOutput = '\x1BOP';
          break;
        case Key.F2:
          simpleOutput = '\x1BOQ';
          break;
        case Key.F3:
          simpleOutput = '\x1BOR';
          break;
        case Key.F4:
          simpleOutput = '\x1BOS';
          break;
        case Key.F5:
          simpleOutput = '\x1B[15~';
          break;
        case Key.F6:
          simpleOutput = '\x1B[17~';
          break;
        case Key.F7:
          simpleOutput = '\x1B[18~';
          break;
        case Key.F8:
          simpleOutput = '\x1B[19~';
          break;
        case Key.F9:
          simpleOutput = '\x1B[20~';
          break;
        case Key.F10:
          simpleOutput = '\x1B[21~';
          break;
        case Key.F11:
          simpleOutput = '\x1B[23~';
          break;
        case Key.F12:
          simpleOutput = '\x1B[24~';
          break;
      }

      if (simpleOutput !== null) {
        event.preventDefault();
        this.onDataCallback(simpleOutput);
        this.recordKeyDownData(simpleOutput);
        return;
      }
    }

    // Determine action (we only care about PRESS for now, not RELEASE or REPEAT)
    const action = KeyAction.PRESS;

    // For non-printable keys or keys with modifiers, encode using Ghostty
    try {
      // Sync negotiated terminal modes before every encoded key.
      this.syncEncoderOptions(keyboardProtocolState);

      // For letter/number keys, even with modifiers, pass the base character
      // This helps the encoder produce correct control sequences (e.g., Ctrl+A = 0x01)
      // For special keys (Enter, Arrow keys, etc.), don't pass utf8
      const utf8 =
        event.key.length === 1 && event.key.charCodeAt(0) < 128
          ? event.key.toLowerCase() // Use lowercase for consistency
          : undefined;

      const encoded = this.encoder.encode({
        action,
        key,
        mods,
        utf8,
        unshiftedCodepoint: getUnshiftedCodepoint(event),
      });

      // Convert Uint8Array to string
      const decoder = new TextDecoder();
      const data = decoder.decode(encoded);

      // Prevent default browser behavior
      event.preventDefault();
      event.stopPropagation();

      // Emit the data
      if (data.length > 0) {
        this.onDataCallback(data);
        this.recordKeyDownData(data);
      }
    } catch (error) {
      // Encoding failed - log but don't crash
      console.warn('Failed to encode key:', event.code, error);
    }
  }

  /**
   * Handle paste event from clipboard
   * @param event - ClipboardEvent
   */
  private handlePaste(event: ClipboardEvent): void {
    if (this.isDisposed) return;

    // Prevent default paste behavior
    event.preventDefault();
    event.stopPropagation();

    // Get clipboard data
    const clipboardData = event.clipboardData;
    if (!clipboardData) {
      console.warn('No clipboard data available');
      return;
    }

    // Plain text always wins. Chromium may expose an OS-copied file as one
    // pathless File, or omit the File while an Electron-style embedder retains
    // access to a native file-list format. Multiple browser files fail closed.
    const text = clipboardData.getData('text/plain');
    if (text) {
      this.acceptPasteText(text);
      return;
    }

    if (clipboardData.files.length > 1 || !this.resolveClipboardFilePasteCallback) {
      console.warn('No text in clipboard');
      return;
    }

    const file = clipboardData.files.length === 1 ? clipboardData.files.item(0) : undefined;
    if (clipboardData.files.length === 1 && !file) {
      console.warn('No text in clipboard');
      return;
    }

    try {
      const resolved = this.resolveClipboardFilePasteCallback(file ?? undefined);
      if (typeof resolved !== 'string' && resolved !== undefined) {
        void resolved.then(
          (value) => this.acceptResolvedClipboardFilePaste(value),
          () => console.warn('Clipboard file paste resolver failed')
        );
        return;
      }
      this.acceptResolvedClipboardFilePaste(resolved);
    } catch {
      console.warn('Clipboard file paste resolver failed');
    }
  }

  private acceptResolvedClipboardFilePaste(text: string | undefined): void {
    if (this.isDisposed) return;
    if (!text) {
      console.warn('No text in clipboard');
      return;
    }
    this.acceptPasteText(text);
  }

  private acceptPasteText(text: string): void {
    if (this.shouldIgnorePasteEvent(text, 'paste')) return;
    this.emitPasteData(text);
    this.recordPasteData(text, 'paste');
  }

  /**
   * Handle beforeinput event (mobile/IME input)
   * @param event - InputEvent
   */
  private handleBeforeInput(event: InputEvent): void {
    if (this.isDisposed) return;

    // Pre-edit updates must remain browser-owned so the IME can maintain its
    // candidate state in the textarea. A final insertFromComposition event has
    // isComposing=false and is handled as the commit for this transaction.
    if (event.isComposing) {
      return;
    }

    const inputType = event.inputType;
    const data = event.data ?? '';
    let output: string | null = null;

    switch (inputType) {
      case 'insertText':
      case 'insertReplacementText':
      case 'insertFromComposition':
        output = data.length > 0 ? data.replace(/\n/g, '\r') : null;
        break;
      case 'insertLineBreak':
      case 'insertParagraph':
        output = '\r';
        break;
      case 'deleteContentBackward':
        output = '\x7F';
        break;
      case 'deleteContentForward':
        output = '\x1B[3~';
        break;
      case 'insertFromPaste':
        if (!data) {
          return;
        }
        if (this.shouldIgnorePasteEvent(data, 'beforeinput')) {
          event.preventDefault();
          event.stopPropagation();
          this.scheduleInputStateReset();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.emitPasteData(data);
        this.recordPasteData(data, 'beforeinput');
        this.scheduleInputStateReset();
        return;
      default:
        return;
    }

    if (!output) {
      return;
    }

    const composition = this.compositionTransaction;
    const isCompositionTextCommit =
      inputType === 'insertText' ||
      inputType === 'insertReplacementText' ||
      inputType === 'insertFromComposition';
    if (composition?.phase === 'active' && isCompositionTextCommit) {
      // Let the browser finish its native IME commit. Cancelling this event can
      // leave candidate/pre-edit state open in Safari and Firefox; the deferred
      // reset removes the committed textarea value after that work completes.
      event.stopPropagation();
      this.onDataCallback(output);
      composition.emittedData = output;
      this.scheduleInputStateReset();
      return;
    }
    if (composition?.phase === 'active') return;

    if (composition?.phase === 'ended') {
      if (composition.emittedData === output) {
        // This is the browser-owned commit corresponding to compositionend.
        // Allow its default action to settle before the scheduled reset.
        event.stopPropagation();
        this.compositionTransaction = null;
        this.scheduleInputStateReset();
        return;
      }
      // A different beforeinput payload is a new transaction, not a duplicate
      // of the composition that just ended.
      this.compositionTransaction = null;
    }

    if (this.shouldIgnoreBeforeInput(output)) {
      event.preventDefault();
      event.stopPropagation();
      this.scheduleInputStateReset();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.onDataCallback(output);
    if (data) {
      this.lastBeforeInputData = output;
    }
    this.scheduleInputStateReset();
  }

  /**
   * Handle compositionstart event
   */
  private handleCompositionStart(_event: CompositionEvent): void {
    if (this.isDisposed) return;
    this.cancelInputStateReset();
    this.resetTextarea();
    this.clearTransientInputState();
    this.isComposing = true;
    this.compositionTransaction = { phase: 'active', emittedData: null };
  }

  /**
   * Handle compositionupdate event
   */
  private handleCompositionUpdate(_event: CompositionEvent): void {
    if (this.isDisposed) return;
    // We could track the current composition string here if we wanted to
    // display it in a custom way, but for now we rely on the browser's
    // input method editor UI.
  }

  /**
   * Handle compositionend event
   */
  private handleCompositionEnd(event: CompositionEvent): void {
    if (this.isDisposed) return;
    this.isComposing = false;

    const data = event.data?.replace(/\n/g, '\r') ?? '';
    const composition = this.compositionTransaction ?? {
      phase: 'active' as const,
      emittedData: null,
    };
    if (data && data.length > 0) {
      if (composition.emittedData === null && this.lastBeforeInputData === data) {
        composition.emittedData = data;
        this.lastBeforeInputData = null;
      } else if (composition.emittedData === null) {
        this.onDataCallback(data);
        composition.emittedData = data;
      } else {
        // One or more segmented commits were already emitted from beforeinput.
        // Retain compositionend's aggregate/final payload only as the expected
        // value for a possible trailing browser commit event.
        composition.emittedData = data;
      }
    }
    composition.phase = 'ended';
    this.compositionTransaction = composition;

    this.cleanupCompositionTextNodes();
    this.scheduleInputStateReset();
  }

  /**
   * Cleanup text nodes in container after composition
   */
  private cleanupCompositionTextNodes(): void {
    // Cleanup text nodes in container (fix for duplicate text display)
    // When the container is contenteditable, the browser might insert text nodes
    // upon composition end. We need to remove them to prevent duplicate display.
    if (this.container && this.container.childNodes) {
      for (let i = this.container.childNodes.length - 1; i >= 0; i--) {
        const node = this.container.childNodes[i];
        // Node.TEXT_NODE === 3
        if (node.nodeType === 3) {
          this.container.removeChild(node);
        }
      }
    }
  }

  // ==========================================================================
  // Mouse Event Handling (for terminal mouse tracking)
  // ==========================================================================

  /**
   * Convert pixel coordinates to terminal cell coordinates
   */
  private pixelToCell(event: MouseEvent): { col: number; row: number } | null {
    if (!this.mouseConfig) return null;

    const dims = this.mouseConfig.getCellDimensions();
    const offset = this.mouseConfig.getCanvasOffset();

    if (dims.width <= 0 || dims.height <= 0) return null;

    const x = event.clientX - offset.left;
    const y = event.clientY - offset.top;

    // Convert to 1-based cell coordinates (terminal uses 1-based)
    const col = Math.floor(x / dims.width) + 1;
    const row = Math.floor(y / dims.height) + 1;

    // Clamp to valid range (at least 1)
    return {
      col: Math.max(1, col),
      row: Math.max(1, row),
    };
  }

  /**
   * Get modifier flags for mouse event
   */
  private getMouseModifiers(event: MouseEvent): number {
    let mods = 0;
    if (event.shiftKey) mods |= 4;
    if (event.metaKey) mods |= 8; // Meta (Cmd on Mac)
    if (event.ctrlKey) mods |= 16;
    return mods;
  }

  /**
   * Encode mouse event as SGR sequence
   * SGR format: \x1b[<Btn;Col;RowM (press/motion) or \x1b[<Btn;Col;Rowm (release)
   */
  private encodeMouseSGR(
    button: number,
    col: number,
    row: number,
    isRelease: boolean,
    modifiers: number
  ): string {
    const btn = button + modifiers;
    const suffix = isRelease ? 'm' : 'M';
    return `\x1b[<${btn};${col};${row}${suffix}`;
  }

  /**
   * Encode mouse event as X10/normal sequence (legacy format)
   * Format: \x1b[M<Btn+32><Col+32><Row+32>
   */
  private encodeMouseX10(button: number, col: number, row: number, modifiers: number): string {
    // X10 format adds 32 to all values and encodes as characters
    // Button encoding: 0=left, 1=middle, 2=right, 3=release
    const btn = button + modifiers + 32;
    const colChar = String.fromCharCode(Math.min(col + 32, 255));
    const rowChar = String.fromCharCode(Math.min(row + 32, 255));
    return `\x1b[M${String.fromCharCode(btn)}${colChar}${rowChar}`;
  }

  /**
   * Send mouse event to terminal
   */
  private sendMouseEvent(
    button: number,
    col: number,
    row: number,
    isRelease: boolean,
    event: MouseEvent
  ): void {
    const modifiers = this.getMouseModifiers(event);

    // Check if SGR extended mode is enabled (mode 1006)
    const useSGR = this.mouseConfig?.hasSgrMouseMode?.() ?? true;

    let sequence: string;
    if (useSGR) {
      sequence = this.encodeMouseSGR(button, col, row, isRelease, modifiers);
    } else {
      // X10/normal mode doesn't support release events directly
      // Button 3 means release in X10 mode
      const x10Button = isRelease ? 3 : button;
      sequence = this.encodeMouseX10(x10Button, col, row, modifiers);
    }

    this.onDataCallback(sequence);
  }

  /**
   * Handle mousedown event
   */
  private handleMouseDown(event: MouseEvent): void {
    if (this.isDisposed) return;
    if (this.mouseConfig?.shouldReportButton?.(event.button) === false) return;
    const buttonMask = 1 << event.button;
    if (!this.mouseConfig?.hasMouseTracking()) {
      this.locallyOwnedMouseButtons &= ~buttonMask;
      return;
    }
    if (this.mouseConfig.shouldReportEvent?.(event) === false) {
      this.locallyOwnedMouseButtons |= buttonMask;
      this.mouseButtonsPressed &= ~buttonMask;
      return;
    }

    const cell = this.pixelToCell(event);
    if (!cell) return;

    // Map browser button to terminal button
    // event.button: 0=left, 1=middle, 2=right
    // Terminal: 0=left, 1=middle, 2=right
    const button = event.button;

    // Track pressed buttons for motion events
    this.locallyOwnedMouseButtons &= ~buttonMask;
    this.mouseButtonsPressed |= buttonMask;

    this.sendMouseEvent(button, cell.col, cell.row, false, event);

    // Don't prevent default - let SelectionManager handle selection
    // Only prevent if we actually handled the event
    // event.preventDefault();
  }

  /**
   * Handle mouseup event
   */
  private handleMouseUp(event: MouseEvent): void {
    if (this.isDisposed) return;
    if (this.mouseConfig?.shouldReportButton?.(event.button) === false) return;
    const buttonMask = 1 << event.button;
    if ((this.locallyOwnedMouseButtons & buttonMask) !== 0) {
      this.locallyOwnedMouseButtons &= ~buttonMask;
      return;
    }
    if (!this.mouseConfig?.hasMouseTracking()) {
      this.mouseButtonsPressed &= ~buttonMask;
      return;
    }
    const pressWasReported = (this.mouseButtonsPressed & buttonMask) !== 0;
    if (!pressWasReported && this.mouseConfig.shouldReportEvent?.(event) === false) return;

    const cell = this.pixelToCell(event);
    if (!cell) return;

    const button = event.button;

    // Clear pressed button
    this.mouseButtonsPressed &= ~buttonMask;

    this.sendMouseEvent(button, cell.col, cell.row, true, event);
  }

  /**
   * Handle mousemove event
   */
  private handleMouseMove(event: MouseEvent): void {
    if (this.isDisposed) return;
    if (!this.mouseConfig?.hasMouseTracking()) return;
    // A Shift-owned drag may end outside the container, where this handler's
    // mouseup listener cannot observe it. Reconcile with the browser's button
    // state so one missed release cannot suppress later any-motion reports.
    if (event.buttons === 0) {
      this.locallyOwnedMouseButtons = 0;
      this.mouseButtonsPressed = 0;
    }
    if (this.locallyOwnedMouseButtons !== 0) return;
    if (this.mouseConfig.shouldReportEvent?.(event) === false) return;

    // Check if button motion mode or any-event tracking is enabled
    // Mode 1002 = button motion, Mode 1003 = any motion
    const hasButtonMotion = this.getModeCallback?.(1002) ?? false;
    const hasAnyMotion = this.getModeCallback?.(1003) ?? false;

    if (!hasButtonMotion && !hasAnyMotion) return;

    // In button motion mode, only report if a button is pressed
    if (hasButtonMotion && !hasAnyMotion && this.mouseButtonsPressed === 0) return;

    const cell = this.pixelToCell(event);
    if (!cell) return;

    // Determine which button to report (or 32 for motion with no button)
    let button = 32; // Motion flag
    if (this.mouseButtonsPressed & 1)
      button += 0; // Left
    else if (this.mouseButtonsPressed & 2)
      button += 1; // Middle
    else if (this.mouseButtonsPressed & 4) button += 2; // Right

    this.sendMouseEvent(button, cell.col, cell.row, false, event);
  }

  /**
   * Handle wheel event (scroll)
   */
  private handleWheel(event: WheelEvent): void {
    if (this.isDisposed) return;
    if (!this.mouseConfig?.hasMouseTracking()) return;
    if (this.mouseConfig.shouldReportEvent?.(event) === false) return;

    // Application mouse tracking owns the wheel even when stdin is disabled;
    // the Terminal callback applies that input policy without exposing local scroll.
    event.preventDefault();
    event.stopPropagation();
    if (event.deltaY === 0) return;

    const cell = this.pixelToCell(event);
    if (!cell) return;

    // Wheel events: button 64 = scroll up, button 65 = scroll down
    const button = event.deltaY < 0 ? 64 : 65;

    this.sendMouseEvent(button, cell.col, cell.row, false, event);
  }

  /**
   * Emit paste data with bracketed paste support
   */
  private emitPasteData(text: string): void {
    const hasBracketedPaste = this.getModeCallback?.(2004) ?? false;
    this.onDataCallback(encodePaste(text, hasBracketedPaste));
  }

  /**
   * Record keydown data for beforeinput de-duplication
   */
  private recordKeyDownData(data: string): void {
    this.lastKeyDownData = data;
    this.scheduleInputStateReset();
  }

  /**
   * Record paste data for beforeinput de-duplication
   */
  private recordPasteData(data: string, source: 'paste' | 'beforeinput'): void {
    this.lastPasteData = data;
    this.lastPasteTime = this.getNow();
    this.lastPasteSource = source;
  }

  /**
   * Check if beforeinput should be ignored due to a recent keydown
   */
  private shouldIgnoreBeforeInput(data: string): boolean {
    const isDuplicate = this.lastKeyDownData === data;
    this.lastKeyDownData = null;
    return isDuplicate;
  }

  /**
   * Schedule cleanup after the browser finishes the current native input event
   * chain. In particular, compositionend can run before the browser commits the
   * final value to a textarea, so clearing synchronously leaves committed text
   * behind on several engines.
   */
  private scheduleInputStateReset(): void {
    this.cancelInputStateReset();
    this.inputStateResetTimeout = setTimeout(() => {
      this.inputStateResetTimeout = undefined;
      if (this.isDisposed || this.isComposing) return;
      this.resetTextarea();
      this.clearTransientInputState();
    }, 0);
  }

  private cancelInputStateReset(): void {
    if (this.inputStateResetTimeout !== undefined) {
      clearTimeout(this.inputStateResetTimeout);
      this.inputStateResetTimeout = undefined;
    }
  }

  private resetTextarea(): void {
    if (this.inputElement?.tagName?.toLowerCase() !== 'textarea') return;
    const textarea = this.inputElement as HTMLTextAreaElement;
    if (textarea.value === '' && textarea.selectionStart === 0 && textarea.selectionEnd === 0) {
      return;
    }
    textarea.value = '';
    textarea.setSelectionRange(0, 0);
  }

  private clearTransientInputState(): void {
    this.lastKeyDownData = null;
    this.lastBeforeInputData = null;
    this.compositionTransaction = null;
  }

  /**
   * Check if paste should be ignored due to a recent paste event from another source
   */
  private shouldIgnorePasteEvent(data: string, source: 'paste' | 'beforeinput'): boolean {
    if (!this.lastPasteData) {
      return false;
    }
    if (this.lastPasteSource === source) {
      return false;
    }
    const now = this.getNow();
    const isDuplicate =
      now - this.lastPasteTime < InputHandler.BEFORE_INPUT_IGNORE_MS && this.lastPasteData === data;
    if (isDuplicate) {
      this.lastPasteData = null;
      this.lastPasteSource = null;
    }
    return isDuplicate;
  }

  /**
   * Get current time in milliseconds
   */
  private getNow(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  /**
   * Dispose the InputHandler and remove event listeners
   */
  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.cancelInputStateReset();
    this.resetTextarea();
    this.clearTransientInputState();
    this.isComposing = false;

    if (this.keydownListener) {
      this.container.removeEventListener('keydown', this.keydownListener);
      this.keydownListener = null;
    }

    if (this.keypressListener) {
      this.container.removeEventListener('keypress', this.keypressListener);
      this.keypressListener = null;
    }

    if (this.pasteListener) {
      this.container.removeEventListener('paste', this.pasteListener);
      if (this.inputElement && this.inputElement !== this.container) {
        this.inputElement.removeEventListener('paste', this.pasteListener);
      }
      this.pasteListener = null;
    }

    if (this.beforeInputListener && this.inputElement) {
      this.inputElement.removeEventListener('beforeinput', this.beforeInputListener);
      this.beforeInputListener = null;
    }

    if (this.compositionStartListener) {
      this.container.removeEventListener('compositionstart', this.compositionStartListener);
      this.compositionStartListener = null;
    }

    if (this.compositionUpdateListener) {
      this.container.removeEventListener('compositionupdate', this.compositionUpdateListener);
      this.compositionUpdateListener = null;
    }

    if (this.compositionEndListener) {
      this.container.removeEventListener('compositionend', this.compositionEndListener);
      this.compositionEndListener = null;
    }

    if (this.mousedownListener) {
      this.container.removeEventListener('mousedown', this.mousedownListener);
      this.mousedownListener = null;
    }

    if (this.mouseupListener) {
      this.container.removeEventListener('mouseup', this.mouseupListener);
      this.mouseupListener = null;
    }

    if (this.mousemoveListener) {
      this.container.removeEventListener('mousemove', this.mousemoveListener);
      this.mousemoveListener = null;
    }

    if (this.wheelListener) {
      this.container.removeEventListener('wheel', this.wheelListener);
      this.wheelListener = null;
    }

    this.mouseButtonsPressed = 0;
    this.locallyOwnedMouseButtons = 0;

    this.encoder.dispose();
  }

  /**
   * Check if handler is disposed
   */
  isActive(): boolean {
    return !this.isDisposed;
  }
}
