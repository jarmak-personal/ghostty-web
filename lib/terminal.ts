/**
 * Terminal - Main terminal emulator class
 *
 * Provides an xterm.js-compatible API wrapping Ghostty's WASM terminal emulator.
 *
 * Usage:
 * ```typescript
 * import { init, Terminal } from 'ghostty-web';
 *
 * await init();
 * const term = new Terminal();
 * term.open(document.getElementById('container'));
 * term.write('Hello, World!\n');
 * term.onData(data => console.log('User typed:', data));
 * ```
 */

import { AccessibilityManager } from './accessibility-manager';
import { BufferNamespace } from './buffer';
import { EventEmitter } from './event-emitter';
import type { Ghostty, GhosttyCell, GhosttyTerminal, GhosttyTerminalConfig } from './ghostty';
import { getGhostty } from './index';
import { InputHandler, type MouseTrackingConfig } from './input-handler';
import type {
  IBufferNamespace,
  IBufferRange,
  IDisposable,
  IEvent,
  IKeyEvent,
  ILinkHandler,
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
import { LinkDetector } from './link-detector';
import { DEFAULT_THEME, normalizeTheme, themeToTerminalConfig } from './palette';
import { encodePaste } from './paste';
import { OSC8LinkProvider } from './providers/osc8-link-provider';
import { UrlRegexProvider } from './providers/url-regex-provider';
import { CanvasRenderer, type IScrollbackProvider, type RendererFrameStats } from './renderer';
import {
  RetainedBufferExtractionError,
  RetainedBufferExtractionManager,
} from './retained-buffer-extraction';
import { RetainedBufferSearchManager } from './retained-buffer-search';
import { SelectionManager } from './selection-manager';
import type { DecodedTerminalEvent } from './terminal-events';
import type {
  ILink,
  ILinkProvider,
  TerminalEvent,
  TerminalEventProvenance,
  TerminalEventScreen,
} from './types';

// ============================================================================
// Terminal Class
// ============================================================================

export interface TerminalRenderStats {
  parsedWrites: number;
  renderRequests: number;
  renderFrames: number;
  fullRenderFrames: number;
  paused: boolean;
  pendingFrame: boolean;
  cursorVisible: boolean;
  synchronizedOutput: boolean;
  synchronizedOutputRecoveries: number;
  lastFrame: RendererFrameStats;
}

/** Keep the web scheduler aligned with Ghostty Termio's bounded recovery. */
const SYNCHRONIZED_OUTPUT_TIMEOUT_MS = 1000;
const DEFAULT_SMOOTH_SCROLL_DURATION_MS = 100;

function normalizeSmoothScrollDuration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SMOOTH_SCROLL_DURATION_MS;
  }
  return Math.max(0, value);
}

export class Terminal implements ITerminalCore {
  // Public properties (xterm.js compatibility)
  public cols: number;
  public rows: number;
  public element?: HTMLElement;
  public textarea?: HTMLTextAreaElement;

  // Buffer API (xterm.js compatibility)
  public readonly buffer: IBufferNamespace;

  // Unicode API (xterm.js compatibility)
  public readonly unicode: IUnicodeVersionProvider = {
    get activeVersion(): string {
      return '15.1'; // Ghostty supports Unicode 15.1
    },
  };

  // Options (public for xterm.js compatibility)
  public readonly options!: Required<ITerminalOptions>;

  // Components (created on open())
  private ghostty?: Ghostty;
  public wasmTerm?: GhosttyTerminal; // Made public for link providers
  public renderer?: CanvasRenderer; // Made public for FitAddon
  private inputHandler?: InputHandler;
  private selectionManager?: SelectionManager;
  private retainedBufferSearch?: RetainedBufferSearchManager;
  private retainedBufferExtraction?: RetainedBufferExtractionManager;
  private accessibilityManager?: AccessibilityManager;
  private canvas?: HTMLCanvasElement;
  private selectionChangeDisposable?: IDisposable;

  // Listener references and host state owned by open(). Keeping these explicit
  // makes both successful disposal and partial-open rollback symmetric.
  private hostFocusListener?: () => void;
  private inputFocusListener?: () => void;
  private inputBlurListener?: () => void;
  private canvasMouseDownListener?: (event: MouseEvent) => void;
  private canvasTouchEndListener?: (event: TouchEvent) => void;
  private hostMouseDownListenerAttached = false;
  private hostMouseMoveListenerAttached = false;
  private hostMouseLeaveListenerAttached = false;
  private hostClickListenerAttached = false;
  private hostWheelListenerAttached = false;
  private documentMouseUpListenerAttached = false;
  private focusTimeout?: number;
  private hostState?: {
    element: HTMLElement;
    attributes: Map<string, string | null>;
    outline: string;
    outlineOffset: string;
    cursor: string;
  };

  // Link detection system
  private linkDetector?: LinkDetector;
  private currentHoveredLink?: ILink;
  private observedLinkHandler: ILinkHandler | null;
  private observedAllowNonHttpProtocols: boolean;
  private mouseMoveThrottleTimeout?: number;
  private pendingMouseMove?: { event: MouseEvent; requestSerial: number };
  private linkHoverRequestSerial = 0;
  private currentLinkHoverRequest?: { requestSerial: number; col: number; row: number };

  // Event emitters
  private dataEmitter = new EventEmitter<string>();
  private resizeEmitter = new EventEmitter<{ cols: number; rows: number }>();
  private bellEmitter = new EventEmitter<void>();
  private selectionChangeEmitter = new EventEmitter<void>();
  private keyEmitter = new EventEmitter<IKeyEvent>();
  private titleChangeEmitter = new EventEmitter<string>();
  private scrollEmitter = new EventEmitter<number>();
  private renderEmitter = new EventEmitter<{ start: number; end: number }>();
  private cursorMoveEmitter = new EventEmitter<void>();
  private terminalEventEmitter = new EventEmitter<TerminalEvent>();
  // Public event accessors (xterm.js compatibility)
  public readonly onData: IEvent<string> = this.dataEmitter.event;
  public readonly onResize: IEvent<{ cols: number; rows: number }> = this.resizeEmitter.event;
  public readonly onBell: IEvent<void> = this.bellEmitter.event;
  public readonly onSelectionChange: IEvent<void> = this.selectionChangeEmitter.event;
  public readonly onKey: IEvent<IKeyEvent> = this.keyEmitter.event;
  public readonly onTitleChange: IEvent<string> = this.titleChangeEmitter.event;
  public readonly onScroll: IEvent<number> = this.scrollEmitter.event;
  /** Fires once per contiguous viewport-row range painted; one frame may emit several ranges. */
  public readonly onRender: IEvent<{ start: number; end: number }> = this.renderEmitter.event;
  public readonly onCursorMove: IEvent<void> = this.cursorMoveEmitter.event;
  /** Typed host-facing events sourced directly from Ghostty parser actions. */
  public readonly onTerminalEvent: IEvent<TerminalEvent> = this.terminalEventEmitter.event;

  // Lifecycle state
  private isOpen = false;
  private isDisposed = false;
  private animationFrameId?: number;
  private renderPaused = false;
  private forceFullRender = false;
  private parsedWrites = 0;
  private renderRequests = 0;
  private renderFrames = 0;
  private fullRenderFrames = 0;
  private devicePixelRatioChanged = false;
  private writeQueue: Uint8Array[] = [];
  private synchronizedOutputActive = false;
  private synchronizedOutputGeneration = 0;
  private synchronizedOutputTimeout?: number;
  private synchronizedOutputRecoveries = 0;
  private readonly rendererScrollbackProvider: IScrollbackProvider = {
    getScrollbackLine: (offset) => this.getScrollbackLine(offset),
    getScrollbackLength: () => this.getScrollbackLength(),
    getScrollbackGeneration: () => this.wasmTerm?.getScrollbackGeneration() ?? 0,
    getScrollbackGraphemeString: (offset, col) =>
      this.wasmTerm?.getScrollbackGraphemeString(offset, col) ?? ' ',
    getScrollbackViewport: (start, rows) =>
      this.wasmTerm?.getScrollbackViewport(start, rows) ?? null,
  };

  // Addons
  private addons: ITerminalAddon[] = [];

  // Phase 1: Custom event handlers
  private customKeyEventHandler?: (event: KeyboardEvent) => boolean;

  // Phase 1: Title tracking
  private currentTitle: string = '';

  // Phase 2: Viewport and scrolling state
  public viewportY: number = 0; // Top line of viewport in scrollback buffer (0 = at bottom, can be fractional during smooth scroll)
  private targetViewportY: number = 0; // Target viewport position for smooth scrolling
  private scrollAnimationStartTime?: number;
  private scrollAnimationStartViewportY: number = 0;
  private scrollAnimationFrame?: number;
  private scrollAnimationGeneration: number = 0;
  private customWheelEventHandler?: (event: WheelEvent) => boolean;
  // Cursor events are presentation events: multiple writes coalesce into one
  // notification, while every intervening screen switch remains observable.
  private lastCursorX: number = 0;
  private lastCursorY: number = 0;
  private lastCursorAlternateScreen = false;
  private cursorScreenGeneration = 0;
  private lastPresentedCursorScreenGeneration = 0;

  // Scrollbar interaction state
  private isDraggingScrollbar: boolean = false;
  private scrollbarDragStart: number | null = null;
  private scrollbarDragStartViewportY: number = 0;

  // Scrollbar visibility/auto-hide state
  private scrollbarVisible: boolean = false;
  private scrollbarOpacity: number = 0;
  private scrollbarHideTimeout?: number;
  private readonly SCROLLBAR_HIDE_DELAY_MS = 1500; // Hide after 1.5 seconds
  private readonly SCROLLBAR_FADE_DURATION_MS = 200; // 200ms fade animation

  constructor(options: ITerminalOptions = {}) {
    if (options.scrollback !== undefined && options.scrollbackBytes !== undefined) {
      throw new TypeError('scrollback and scrollbackBytes are mutually exclusive');
    }

    // Use provided Ghostty instance (for test isolation) or get module-level instance
    this.ghostty = options.ghostty ?? getGhostty();

    // Create base options object with all defaults (excluding ghostty)
    const baseOptions = {
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      cursorBlink: options.cursorBlink ?? false,
      cursorStyle: options.cursorStyle ?? 'block',
      theme: normalizeTheme(options.theme),
      scrollback: options.scrollback ?? (options.scrollbackBytes === undefined ? 10000 : undefined),
      scrollbackBytes: options.scrollbackBytes,
      fontSize: options.fontSize ?? 15,
      fontFamily: options.fontFamily ?? 'monospace',
      fontLigatures: options.fontLigatures !== false,
      allowTransparency: options.allowTransparency ?? false,
      convertEol: options.convertEol ?? false,
      disableStdin: options.disableStdin ?? false,
      focusOnOpen: options.focusOnOpen ?? true,
      disableContextMenu: options.disableContextMenu ?? false,
      resolveClipboardFilePaste: options.resolveClipboardFilePaste,
      linkHandler: options.linkHandler ?? null,
      smoothScrollDuration: normalizeSmoothScrollDuration(options.smoothScrollDuration),
    };

    // Wrap in Proxy to intercept runtime changes (xterm.js compatibility)
    (this.options as any) = new Proxy(baseOptions, {
      set: (target: any, prop: string, value: any) => {
        const oldValue = target[prop];

        if (
          (prop === 'scrollback' && value !== undefined && target.scrollbackBytes !== undefined) ||
          (prop === 'scrollbackBytes' && value !== undefined && target.scrollback !== undefined)
        ) {
          throw new TypeError('scrollback and scrollbackBytes are mutually exclusive');
        }

        if (prop === 'theme') {
          const theme = normalizeTheme(value);
          if (this.isOpen) this.applyTheme(theme);
          target[prop] = theme;
          return true;
        }

        if (prop === 'fontLigatures') {
          const enabled = value !== false;
          target[prop] = enabled;
          if (this.isOpen) this.handleOptionChange(prop, enabled, oldValue);
          return true;
        }

        if (prop === 'smoothScrollDuration') {
          const duration = normalizeSmoothScrollDuration(value);
          target[prop] = duration;
          if (this.isOpen) this.handleOptionChange(prop, duration, oldValue);
          return true;
        }

        target[prop] = value;

        // Apply runtime changes if terminal is open
        if (this.isOpen) {
          this.handleOptionChange(prop, value, oldValue);
        }

        return true;
      },
    });

    this.cols = this.options.cols;
    this.rows = this.options.rows;
    this.observedLinkHandler = this.options.linkHandler;
    this.observedAllowNonHttpProtocols = this.options.linkHandler?.allowNonHttpProtocols === true;

    // Initialize buffer API
    this.buffer = new BufferNamespace(this);
  }

  // ==========================================================================
  // Option Change Handling (for mutable options)
  // ==========================================================================

  /**
   * Handle runtime option changes (called when options are modified after terminal is open)
   * This enables xterm.js compatibility where options can be changed at runtime
   */
  private handleOptionChange(key: string, newValue: any, oldValue: any): void {
    if (newValue === oldValue) return;

    switch (key) {
      case 'disableStdin':
        // Input handler already checks this.options.disableStdin dynamically
        // No action needed
        break;

      case 'cursorBlink':
      case 'cursorStyle':
        this.applyCursorDefaults();
        break;

      case 'fontSize':
        if (this.renderer) {
          this.renderer.setFontSize(this.options.fontSize);
          this.handleFontChange();
        }
        break;

      case 'fontFamily':
        if (this.renderer) {
          this.renderer.setFontFamily(this.options.fontFamily);
          this.handleFontChange();
        }
        break;

      case 'fontLigatures':
        this.renderer?.setFontLigatures(this.options.fontLigatures);
        break;

      case 'linkHandler':
        this.synchronizeLinkHandlerPolicy();
        break;

      case 'smoothScrollDuration':
        if (this.scrollAnimationStartTime !== undefined) {
          if (newValue === 0) {
            this.finishSmoothScroll();
          } else {
            this.scrollAnimationStartViewportY = this.viewportY;
            this.scrollAnimationStartTime = performance.now();
          }
        }
        break;

      case 'cols':
      case 'rows':
        // Redirect to resize method
        this.resize(this.options.cols, this.options.rows);
        break;
    }
  }

  /** Keep cached hit-testing aligned with both handler replacement and policy mutation. */
  private synchronizeLinkHandlerPolicy(): void {
    const handler = this.options.linkHandler;
    const allowNonHttpProtocols = handler?.allowNonHttpProtocols === true;
    if (
      handler === this.observedLinkHandler &&
      allowNonHttpProtocols === this.observedAllowNonHttpProtocols
    ) {
      return;
    }

    this.observedLinkHandler = handler;
    this.observedAllowNonHttpProtocols = allowNonHttpProtocols;
    this.linkDetector?.invalidateCache();
    this.requestRender(true);
  }

  /**
   * Handle font changes (fontSize or fontFamily)
   * Updates canvas size to match new font metrics and forces a full re-render
   */
  private handleFontChange(): void {
    if (!this.renderer || !this.wasmTerm || !this.canvas) return;

    // Clear any active selection since pixel positions have changed
    if (this.selectionManager) {
      this.selectionManager.clearSelection();
    }

    // CanvasRenderer owns the DPI-aware backing store. It will resize and
    // fully paint in the same presentation frame.
    this.requestRender(true);
  }

  /** Apply one already-validated theme across native and Canvas ownership. */
  private applyTheme(theme: Required<ITheme>): void {
    if (!this.wasmTerm || !this.renderer) return;
    if (!this.wasmTerm.setColorConfig(themeToTerminalConfig(theme))) {
      throw new Error('Failed to apply terminal palette');
    }
    this.renderer.setTheme(theme);
    this.updateFocusAppearance(theme);
    this.requestRender(true);
  }

  /**
   * Reflect the canonical input's native :focus-visible semantics on the
   * visible host. Browsers intentionally treat a focused text-entry control as
   * focus-visible after keyboard, pointer, and touch activation because each
   * interaction can lead to typing.
   */
  private updateFocusAppearance(theme: ITheme = this.options.theme): void {
    if (!this.hostState || !this.textarea) return;

    const root = this.textarea.getRootNode();
    const activeElement = (root as Document | ShadowRoot).activeElement ?? document.activeElement;
    const focusVisible = activeElement === this.textarea;

    if (focusVisible) {
      this.hostState.element.style.outline = `2px solid ${theme.foreground ?? DEFAULT_THEME.foreground}`;
      this.hostState.element.style.outlineOffset = '2px';
    } else {
      this.restoreHostOutline();
    }
  }

  private restoreHostOutline(): void {
    if (!this.hostState) return;
    this.hostState.element.style.outline = this.hostState.outline;
    this.hostState.element.style.outlineOffset = this.hostState.outlineOffset;
  }

  /**
   * Focus the sole browser input target. Keeping this path centralized lets
   * future touch gesture and assistive-input layers decide when to request the
   * mobile keyboard without creating another focus owner.
   */
  private focusInputTarget(): void {
    if (!this.isOpen) return;
    this.textarea?.focus({ preventScroll: true });
    // Some DOM implementations update a shadow root's activeElement after the
    // focus event itself; reconcile once more after focus() returns.
    this.updateFocusAppearance();
  }

  /**
   * Convert terminal options to WASM terminal config.
   */
  private buildWasmConfig(): GhosttyTerminalConfig {
    const scrollbackConfig: GhosttyTerminalConfig =
      this.options.scrollbackBytes === undefined
        ? { scrollbackLimit: this.options.scrollback }
        : { scrollbackBytes: this.options.scrollbackBytes };
    return {
      ...themeToTerminalConfig(normalizeTheme(this.options.theme)),
      ...scrollbackConfig,
      cursorStyle: this.options.cursorStyle,
      cursorBlink: this.options.cursorBlink,
    };
  }

  /** Apply parser-owned cursor defaults without replacing terminal or Canvas state. */
  private applyCursorDefaults(): void {
    if (!this.wasmTerm) return;
    if (
      !this.wasmTerm.setCursorConfig({
        cursorStyle: this.options.cursorStyle,
        cursorBlink: this.options.cursorBlink,
      })
    ) {
      throw new Error('Failed to apply terminal cursor defaults');
    }
    this.requestRender();
  }

  // ==========================================================================
  // Lifecycle Methods
  // ==========================================================================

  /**
   * Open terminal in a parent element
   *
   * Initializes all components and starts rendering.
   * Requires a pre-loaded Ghostty instance passed to the constructor.
   */
  open(parent: HTMLElement): void {
    if (this.isOpen) {
      throw new Error('Terminal is already open');
    }
    if (this.isDisposed) {
      throw new Error('Terminal has been disposed');
    }

    // Store parent element and the state that open() temporarily owns.
    this.element = parent;
    this.isOpen = true;
    this.hostState = {
      element: parent,
      attributes: new Map(
        [
          'tabindex',
          'contenteditable',
          'role',
          'aria-label',
          'aria-labelledby',
          'aria-multiline',
        ].map((name) => [name, parent.getAttribute(name)])
      ),
      outline: parent.style.outline,
      outlineOffset: parent.style.outlineOffset,
      cursor: parent.style.cursor,
    };

    try {
      // The hidden textarea is the sole sequential and semantic input target.
      // Keep the visible host programmatically addressable for compatibility,
      // while removing it from tab order and native editing.
      parent.setAttribute('tabindex', '-1');
      parent.setAttribute('contenteditable', 'false');

      // Avoid exposing a second labelled textbox. The canonical textarea owns
      // these semantics and remains the extension point for richer screen-reader
      // support without changing focus ownership.
      parent.removeAttribute('role');
      parent.removeAttribute('aria-label');
      parent.removeAttribute('aria-labelledby');
      parent.removeAttribute('aria-multiline');

      // Create WASM terminal with current dimensions and config
      const config = this.buildWasmConfig();
      this.wasmTerm = this.ghostty!.createTerminal(this.cols, this.rows, config);

      // Create canvas element
      this.canvas = document.createElement('canvas');
      this.canvas.style.display = 'block';
      this.canvas.style.cursor = 'text';
      this.canvas.setAttribute('aria-hidden', 'true');

      parent.appendChild(this.canvas);

      // Create hidden textarea for keyboard input (must be inside parent for event bubbling)
      this.textarea = document.createElement('textarea');
      this.textarea.setAttribute('autocorrect', 'off');
      this.textarea.setAttribute('autocapitalize', 'off');
      this.textarea.setAttribute('spellcheck', 'false');
      this.textarea.setAttribute('tabindex', '0');
      const hostLabelledBy = this.hostState.attributes.get('aria-labelledby');
      if (hostLabelledBy) {
        this.textarea.setAttribute('aria-labelledby', hostLabelledBy);
      } else {
        this.textarea.setAttribute(
          'aria-label',
          this.hostState.attributes.get('aria-label') ?? 'Terminal input'
        );
      }
      // Use clip-path to completely hide the textarea and its caret
      this.textarea.style.position = 'absolute';
      this.textarea.style.left = '0';
      this.textarea.style.top = '0';
      this.textarea.style.width = '1px';
      this.textarea.style.height = '1px';
      this.textarea.style.padding = '0';
      this.textarea.style.border = 'none';
      this.textarea.style.margin = '0';
      this.textarea.style.opacity = '0';
      this.textarea.style.clipPath = 'inset(50%)'; // Clip everything including caret
      this.textarea.style.overflow = 'hidden';
      this.textarea.style.whiteSpace = 'nowrap';
      this.textarea.style.resize = 'none';
      this.textarea.style.pointerEvents = 'none';
      this.textarea.style.zIndex = '-10';
      parent.appendChild(this.textarea);

      // Redirect compatibility callers that focus `element` directly to the
      // actual keyboard/IME receiver rather than leaving a second focus owner.
      const hostFocusListener = () => this.focusInputTarget();
      parent.addEventListener('focus', hostFocusListener);
      this.hostFocusListener = hostFocusListener;

      const inputFocusListener = () => this.updateFocusAppearance();
      const inputBlurListener = () => this.restoreHostOutline();
      this.textarea.addEventListener('focus', inputFocusListener);
      this.textarea.addEventListener('blur', inputBlurListener);
      this.inputFocusListener = inputFocusListener;
      this.inputBlurListener = inputBlurListener;

      // Focus textarea on interaction - preventDefault before focus
      // Desktop: mousedown
      const canvasMouseDownListener = (ev: MouseEvent) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        this.focusInputTarget();
      };
      this.canvas.addEventListener('mousedown', canvasMouseDownListener);
      this.canvasMouseDownListener = canvasMouseDownListener;
      // Mobile: touchend with preventDefault to suppress iOS caret
      const canvasTouchEndListener = (ev: TouchEvent) => {
        ev.preventDefault();
        this.focusInputTarget();
      };
      this.canvas.addEventListener('touchend', canvasTouchEndListener);
      this.canvasTouchEndListener = canvasTouchEndListener;

      // Create renderer
      this.renderer = new CanvasRenderer(this.canvas, {
        fontSize: this.options.fontSize,
        fontFamily: this.options.fontFamily,
        fontLigatures: this.options.fontLigatures,
        theme: this.options.theme,
        requestRender: (forceAll = false) => this.requestRender(forceAll),
        onDevicePixelRatioChange: () => {
          this.devicePixelRatioChanged = true;
        },
      });
      this.renderer.setRenderPaused(this.renderPaused);

      // Size canvas to terminal dimensions (use renderer.resize for proper DPI scaling)
      this.renderer.resize(this.cols, this.rows);

      // Create mouse tracking configuration
      const canvas = this.canvas;
      const renderer = this.renderer;
      const disableContextMenu = this.options.disableContextMenu;
      const mouseConfig: MouseTrackingConfig = {
        hasMouseTracking: () => this.wasmTerm?.hasMouseTracking() ?? false,
        // Shift reserves the complete pointer gesture for local selection/scroll.
        shouldReportEvent: (event) => !event.shiftKey,
        shouldReportButton: (button) => !(disableContextMenu && button === 2),
        hasSgrMouseMode: () => this.wasmTerm?.getMode(1006, false) ?? true, // SGR extended mode
        getCellDimensions: () => ({
          width: renderer.charWidth,
          height: renderer.charHeight,
        }),
        getCanvasOffset: () => {
          const rect = canvas.getBoundingClientRect();
          return { left: rect.left, top: rect.top };
        },
      };

      // Create input handler
      this.inputHandler = new InputHandler(
        this.ghostty!,
        parent,
        (data: string) => {
          // Check if stdin is disabled
          if (this.options.disableStdin) {
            return;
          }
          // Clear selection when user types
          this.selectionManager?.clearSelection();
          // Input handler fires data events
          this.dataEmitter.fire(data);
        },
        () => {
          // Input handler can also fire bell
          this.bellEmitter.fire();
        },
        (keyEvent: IKeyEvent) => {
          // Forward key events
          this.keyEmitter.fire(keyEvent);
        },
        this.customKeyEventHandler,
        (mode: number) => {
          // Query terminal mode state (e.g., mode 1 for application cursor mode)
          return this.wasmTerm?.getMode(mode, false) ?? false;
        },
        () => {
          // Handle Cmd+C copy - returns true if there was a selection to copy
          return this.copySelection();
        },
        this.textarea,
        mouseConfig,
        () => ({
          kittyFlags: this.wasmTerm?.getKittyKeyboardFlags() ?? 0,
          modifyOtherKeysState2: this.wasmTerm?.hasModifyOtherKeysState2() ?? false,
        }),
        this.options.resolveClipboardFilePaste
      );

      // Create selection manager (pass textarea for context menu positioning)
      this.selectionManager = new SelectionManager(
        this,
        this.renderer,
        this.wasmTerm,
        this.textarea,
        !disableContextMenu,
        (event) => !(this.wasmTerm?.hasMouseTracking() ?? false) || event.shiftKey,
        () => this.focusInputTarget()
      );

      // Connect selection manager to renderer
      this.renderer.setSelectionManager(this.selectionManager);

      // Forward selection change events
      this.selectionChangeDisposable = this.selectionManager.onSelectionChange(() => {
        this.selectionChangeEmitter.fire();
      });

      // Initialize link detection system
      this.linkDetector = new LinkDetector(this, () => this.clearLinkHoverState());

      // Register built-ins in fallback order. Public custom providers are
      // intentionally prepended so applications can override both built-ins.
      this.linkDetector.registerProvider(
        new OSC8LinkProvider(this, () => this.options.linkHandler)
      );
      this.linkDetector.registerProvider(
        new UrlRegexProvider(this, () => this.options.linkHandler)
      );

      // Mirror exactly the presented viewport for assistive technology. This
      // is created after the canonical input and link providers, and before
      // the initial frame, so open rollback can release it symmetrically.
      this.accessibilityManager = new AccessibilityManager(
        this,
        this.textarea,
        this.linkDetector,
        parent
      );

      // Setup mouse event handling for links and scrollbar
      // Use capture phase to intercept scrollbar clicks before SelectionManager
      parent.addEventListener('mousedown', this.handleMouseDown, { capture: true });
      this.hostMouseDownListenerAttached = true;
      parent.addEventListener('mousemove', this.handleMouseMove);
      this.hostMouseMoveListenerAttached = true;
      parent.addEventListener('mouseleave', this.handleMouseLeave);
      this.hostMouseLeaveListenerAttached = true;
      parent.addEventListener('click', this.handleClick);
      this.hostClickListenerAttached = true;

      // Setup document-level mouseup for scrollbar drag (so drag works even outside canvas)
      document.addEventListener('mouseup', this.handleMouseUp);
      this.documentMouseUpListenerAttached = true;

      // Setup wheel event handling for scrolling (Phase 2)
      // Use capture phase to ensure we get the event before browser scrolling
      parent.addEventListener('wheel', this.handleWheel, { passive: false, capture: true });
      this.hostWheelListenerAttached = true;

      // Present the initial screen on one coalesced frame.
      this.requestRender(true);

      // Preserve the historical auto-focus default while allowing embedders
      // to prewarm a terminal without taking focus from another control.
      if (this.options.focusOnOpen !== false) this.focus();
    } catch (error) {
      // Unwind everything that was created before the failing step. Keep the
      // Ghostty module reference so callers can retry open() on the same object.
      this.isOpen = false;
      this.resetSynchronizedOutputTracking();
      this.stopPresentationWork(false);
      this.writeQueue.length = 0;
      this.cleanupComponents();
      throw new Error(`Failed to open terminal: ${error}`);
    }
  }

  /**
   * Write data to terminal
   */
  write(data: string | Uint8Array, callback?: () => void): void {
    this.assertOpen();

    // Handle convertEol option
    if (this.options.convertEol && typeof data === 'string') {
      data = data.replace(/\n/g, '\r\n');
    }

    this.writeInternal(data, callback);
  }

  /**
   * Internal write implementation (extracted from write())
   */
  private writeInternal(data: string | Uint8Array, callback?: () => void): void {
    // Note: We intentionally do NOT clear selection on write - most modern terminals
    // preserve selection when new data arrives. Selection is cleared by user actions
    // like clicking or typing, not by incoming data.

    const viewportBefore = this.viewportY;
    const wasAlternateScreen = this.wasmTerm!.isAlternateScreen();
    const selectionAnchors = this.selectionManager?.captureWriteAnchors() ?? null;
    const preserveViewport = viewportBefore > 0 && !wasAlternateScreen;
    const scrollbackBefore = preserveViewport ? this.getScrollbackLength() : 0;
    const smoothScrollWasActive =
      this.scrollAnimationFrame !== undefined || this.scrollAnimationStartTime !== undefined;
    const targetViewportBefore = this.targetViewportY;

    this.parsedWrites++;

    // Write directly to WASM terminal (handles VT parsing internally)
    const synchronizationCompleted = this.writeToWasm(data);
    const isAlternateScreen = this.wasmTerm!.isAlternateScreen();
    const screenChanged = isAlternateScreen !== wasAlternateScreen;

    // Native tracked pins follow retained rows when history is trimmed. If a
    // selected boundary was evicted, fail closed instead of silently selecting
    // unrelated content at the old numeric row. Reconcile before parser-event
    // listeners run: they may reenter write(), and must never observe or replace
    // unresolved anchors. Selection rows are absolute, so later viewport
    // preservation does not alter the reconciled public coordinates.
    this.selectionManager?.reconcileWriteAnchors(selectionAnchors, screenChanged);

    // A screen switch owns the live viewport. Revoke the old screen's
    // animation before listeners can observe or reenter with stale state.
    if (screenChanged) {
      this.resetViewport();
    }

    // Drain a snapshot before firing listeners so reentrant writes cannot
    // reorder records for later listeners.
    this.processTerminalEvents(this.wasmTerm!.readEvents());

    // Process any responses generated by the terminal (e.g., DSR cursor position)
    // These need to be sent back to the PTY via onData
    this.processTerminalResponses();

    // Invalidate link cache (content changed)
    this.linkDetector?.invalidateCache();

    if (preserveViewport && !isAlternateScreen) {
      // Keep the same retained text under the user's eyes. As active rows move
      // into history, the distance from the live bottom grows by the same amount.
      const scrollbackAfter = this.getScrollbackLength();
      const scrollbackGrowth = Math.max(0, scrollbackAfter - scrollbackBefore);
      const restoredViewport = Math.max(
        0,
        Math.min(scrollbackAfter, viewportBefore + scrollbackGrowth)
      );
      if (restoredViewport !== this.viewportY) {
        this.viewportY = restoredViewport;
        this.scrollEmitter.fire(this.viewportY);
      }
      if (smoothScrollWasActive) {
        // A target at zero is an explicit intent to catch the live bottom. It
        // is not a retained-history coordinate, so output growth must not move
        // it away. Scale the origin so the existing easing curve still passes
        // through the restored viewport at its current progress without
        // extending the animation's original time window.
        this.targetViewportY =
          targetViewportBefore === 0
            ? 0
            : Math.max(0, Math.min(scrollbackAfter, targetViewportBefore + scrollbackGrowth));
        this.scrollAnimationStartViewportY =
          targetViewportBefore === 0 && this.scrollAnimationStartViewportY > 0
            ? this.scrollAnimationStartViewportY * (restoredViewport / viewportBefore)
            : Math.max(
                0,
                Math.min(scrollbackAfter, this.scrollAnimationStartViewportY + scrollbackGrowth)
              );
      }
    } else if (this.viewportY !== 0) {
      // Alternate-screen applications always own the live viewport.
      this.scrollToBottom();
    }

    this.requestRender(synchronizationCompleted);

    // Call callback if provided
    if (callback) {
      // Queue callback after next render
      requestAnimationFrame(callback);
    }

    // Render will happen on next animation frame
  }

  /**
   * Write data with newline
   */
  writeln(data: string | Uint8Array, callback?: () => void): void {
    if (typeof data === 'string') {
      this.write(data + '\r\n', callback);
    } else {
      // Append \r\n to Uint8Array
      const newData = new Uint8Array(data.length + 2);
      newData.set(data);
      newData[data.length] = 0x0d; // \r
      newData[data.length + 1] = 0x0a; // \n
      this.write(newData, callback);
    }
  }

  /**
   * Paste text into terminal (triggers bracketed paste if supported)
   */
  paste(data: string): void {
    this.assertOpen();

    // Don't paste if stdin is disabled
    if (this.options.disableStdin) {
      return;
    }

    this.dataEmitter.fire(encodePaste(data, this.wasmTerm!.hasBracketedPaste()));
  }

  /**
   * Input data into terminal (as if typed by user)
   *
   * @param data - Data to input
   * @param wasUserInput - If true, triggers onData event (default: false for compat with some apps)
   */
  input(data: string, wasUserInput: boolean = false): void {
    this.assertOpen();

    // Don't input if stdin is disabled
    if (this.options.disableStdin) {
      return;
    }

    if (wasUserInput) {
      // Trigger onData event as if user typed it
      this.dataEmitter.fire(data);
    } else {
      // Just write to terminal without triggering onData
      this.write(data);
    }
  }

  /**
   * Resize terminal
   */
  resize(cols: number, rows: number): void {
    this.assertOpen();

    if (cols === this.cols && rows === this.rows) {
      return; // No change
    }

    // Ghostty reflows retained rows during width changes and may move active
    // rows during height changes. Until the native bridge exposes a complete
    // selection mapping for both operations, clearing is safer than returning
    // text from obsolete row/column endpoints.
    this.selectionManager?.clearSelection();

    // Cancel render loop before resize to prevent accessing detached TypedArray
    // views while WASM reallocates buffers. We restart it after resize completes.
    // This avoids the background-tab regression of using an isResizing flag
    // cleared via requestAnimationFrame (rAF is throttled/paused in background tabs).
    this.cancelRenderLoop();
    this.retainedBufferSearch?.invalidateAll();
    this.retainedBufferExtraction?.invalidateAll();

    try {
      // Update dimensions
      this.cols = cols;
      this.rows = rows;

      // Resize WASM terminal (may reallocate buffers, invalidating TypedArray views)
      this.wasmTerm!.resize(cols, rows);
      this.reconcileSynchronizedOutput();

      // Fire resize event
      this.resizeEmitter.fire({ cols, rows });
    } catch (e) {
      console.error('Terminal resize failed:', e);
    } finally {
      // CanvasRenderer detects the new WASM dimensions and performs its
      // DPI-aware backing-store resize immediately before the full paint.
      // Keeping both operations inside one presentation callback prevents a
      // cleared canvas from being exposed between animation frames. Schedule
      // it even if WASM resize, resize listeners, or queued writes fail.
      try {
        this.flushWriteQueue();
      } finally {
        this.requestRender(true);
      }
    }
  }

  /**
   * Clear terminal screen
   */
  clear(): void {
    this.assertOpen();
    this.selectionManager?.clearSelection();
    this.resetViewport();
    this.linkDetector?.invalidateCache();

    // Erase retained history, visible cells, and home the cursor locally.
    // This is parser input only and is never emitted through onData to the PTY.
    const synchronizationCompleted = this.writeToWasm('\x1b[3J\x1b[2J\x1b[H');
    this.requestRender(synchronizationCompleted);
  }

  /**
   * Reset terminal state
   */
  reset(): void {
    this.assertOpen();

    // Create the replacement before mutating the live parser lifecycle. A
    // construction failure therefore leaves this Terminal fully usable.
    const oldWasmTerm = this.wasmTerm!;
    const config = this.buildWasmConfig();
    const newWasmTerm = this.ghostty!.createTerminal(this.cols, this.rows, config);

    this.cancelRenderLoop();
    this.retainedBufferSearch?.dispose();
    this.retainedBufferSearch = undefined;
    this.retainedBufferExtraction?.dispose();
    this.retainedBufferExtraction = undefined;
    this.resetSynchronizedOutputTracking();
    this.selectionManager?.clearSelection();
    this.resetViewport();
    this.linkDetector?.invalidateCache();

    // Parser carry and queued records belong to oldWasmTerm and are discarded
    // with it. Public event subscriptions belong to this retained Terminal.

    this.wasmTerm = newWasmTerm;
    this.selectionManager?.replaceTerminal(newWasmTerm);
    oldWasmTerm.free();

    // Preserve the existing Canvas while presentation is paused. Resume owns
    // the first complete paint of the replacement terminal.
    if (!this.renderPaused) this.renderer!.clear();

    // Reset title
    this.currentTitle = '';
    this.requestRender(true);
  }

  /**
   * Focus terminal input
   */
  focus(): void {
    if (this.isOpen && this.textarea) {
      // Focus immediately for immediate keyboard/wheel event handling
      this.focusInputTarget();

      // Also schedule a delayed focus as backup to ensure it sticks
      // (some browsers may need this if DOM isn't fully settled)
      if (this.focusTimeout !== undefined) window.clearTimeout(this.focusTimeout);
      const textarea = this.textarea;
      this.focusTimeout = window.setTimeout(() => {
        this.focusTimeout = undefined;
        if (this.isOpen && this.textarea === textarea) this.focusInputTarget();
      }, 0);
    }
  }

  /**
   * Blur terminal (remove focus)
   */
  blur(): void {
    if (this.focusTimeout !== undefined) {
      window.clearTimeout(this.focusTimeout);
      this.focusTimeout = undefined;
    }
    if (this.isOpen) this.textarea?.blur();
  }

  /**
   * Load an addon
   */
  loadAddon(addon: ITerminalAddon): void {
    addon.activate(this);
    this.addons.push(addon);
  }

  // ==========================================================================
  // Selection API (xterm.js compatible)
  // ==========================================================================

  /**
   * Get the selected text as a string
   */
  public getSelection(): string {
    return this.selectionManager?.getSelection() || '';
  }

  /**
   * Check if there's an active selection
   */
  public hasSelection(): boolean {
    return this.selectionManager?.hasSelection() || false;
  }

  /**
   * Clear the current selection
   */
  public clearSelection(): void {
    this.selectionManager?.clearSelection();
  }

  /**
   * Copy the current selection to clipboard
   * @returns true if there was text to copy, false otherwise
   */
  public copySelection(): boolean {
    return this.selectionManager?.copySelection() || false;
  }

  /**
   * Select all text in the terminal
   */
  public selectAll(): void {
    this.selectionManager?.selectAll();
  }

  /**
   * Select text at specific column and row with length
   */
  public select(column: number, row: number, length: number): void {
    this.selectionManager?.select(column, row, length);
  }

  /**
   * Select entire lines from start to end
   */
  public selectLines(start: number, end: number): void {
    this.selectionManager?.selectLines(start, end);
  }

  /**
   * Get selection position as buffer range
   */
  /**
   * Get the current viewport Y position.
   *
   * This is the number of lines scrolled back from the bottom of the
   * scrollback buffer. It may be fractional during smooth scrolling.
   */
  public getViewportY(): number {
    return this.viewportY;
  }

  public getSelectionPosition(): IBufferRange | undefined {
    return this.selectionManager?.getSelectionPosition();
  }

  /**
   * Search literal text in this terminal's retained normal buffer.
   * Queries larger than 64 KiB of UTF-8 are rejected.
   */
  public searchRetainedBuffer(
    query: string,
    options: IRetainedBufferSearchOptions
  ): Promise<IRetainedBufferSearchResult> {
    this.assertOpen();
    if (!this.retainedBufferSearch) {
      this.retainedBufferSearch = new RetainedBufferSearchManager(() => this.wasmTerm);
    }
    return this.retainedBufferSearch.search(query, options);
  }

  /** Cancel the current retained-buffer query and release its result state. */
  public cancelRetainedBufferSearch(): void {
    this.retainedBufferSearch?.cancel();
  }

  /** Extract a current, same-terminal search range as exact plain text. */
  public extractRetainedBufferText(range: IRetainedBufferRange): string | undefined {
    return this.retainedBufferSearch?.extractCurrent(range);
  }

  /** Capture an opaque, parser-owned boundary at the active cursor. */
  public captureRetainedBufferBoundary(): TerminalEventProvenance {
    this.assertOpen();
    const boundary = this.wasmTerm!.captureRetainedBufferBoundary();
    if (!boundary) {
      throw new RetainedBufferExtractionError(
        'failed',
        'Unable to capture retained-buffer boundary'
      );
    }
    return boundary;
  }

  /** Extract exact plain text for the half-open same-screen range [start,end). */
  public extractRetainedBufferRange(
    start: TerminalEventProvenance,
    end: TerminalEventProvenance,
    options: IRetainedBufferExtractionOptions = {}
  ): Promise<string> {
    this.assertOpen();
    if (!this.retainedBufferExtraction) {
      this.retainedBufferExtraction = new RetainedBufferExtractionManager(() => this.wasmTerm);
    }
    return this.retainedBufferExtraction.extract(start, end, options);
  }

  /** Cancel the current exact retained-range extraction. */
  public cancelRetainedBufferExtraction(): void {
    this.retainedBufferExtraction?.cancel();
  }

  // ==========================================================================
  // Phase 1: Custom Event Handlers
  // ==========================================================================

  /**
   * Attach a custom keyboard event handler
   * Returns true to prevent default handling
   */
  public attachCustomKeyEventHandler(
    customKeyEventHandler: (event: KeyboardEvent) => boolean
  ): void {
    this.customKeyEventHandler = customKeyEventHandler;
    // Update input handler if already created
    if (this.inputHandler) {
      this.inputHandler.setCustomKeyEventHandler(customKeyEventHandler);
    }
  }

  /**
   * Attach a custom wheel event handler (Phase 2)
   * Returns true to prevent default handling
   */
  public attachCustomWheelEventHandler(
    customWheelEventHandler?: (event: WheelEvent) => boolean
  ): void {
    this.customWheelEventHandler = customWheelEventHandler;
  }

  // ==========================================================================
  // Link Detection Methods
  // ==========================================================================

  /**
   * Register a custom link provider
   * Custom providers take precedence over built-ins. When multiple custom
   * providers are registered, the most recently registered provider runs first.
   *
   * @example
   * ```typescript
   * term.registerLinkProvider({
   *   provideLinks(y, callback) {
   *     // Detect URLs, file paths, etc.
   *     callback(detectedLinks);
   *   }
   * });
   * ```
   */
  public registerLinkProvider(provider: ILinkProvider): void {
    if (!this.linkDetector) {
      throw new Error('Terminal must be opened before registering link providers');
    }
    this.linkDetector.registerProvider(provider, true);
    this.requestRender(true);
  }

  // ==========================================================================
  // Phase 2: Scrolling Methods
  // ==========================================================================

  /**
   * Scroll viewport by a number of lines
   * @param amount Number of lines to scroll (positive = down, negative = up)
   */
  public scrollLines(amount: number): void {
    if (!this.wasmTerm) {
      throw new Error('Terminal not open');
    }

    this.cancelSmoothScroll();

    const scrollbackLength = this.getScrollbackLength();
    const maxScroll = scrollbackLength;

    // Calculate new viewport position
    // viewportY = 0 means at bottom (no scroll)
    // viewportY > 0 means scrolled up into history
    // amount < 0 (scroll up) should INCREASE viewportY
    // amount > 0 (scroll down) should DECREASE viewportY
    // So we SUBTRACT amount (negative amount becomes positive change)
    const newViewportY = Math.max(0, Math.min(maxScroll, this.viewportY - amount));

    if (newViewportY !== this.viewportY) {
      this.viewportY = newViewportY;
      this.scrollAnimationStartViewportY = newViewportY;
      this.targetViewportY = newViewportY;
      this.scrollEmitter.fire(this.viewportY);

      // Show scrollbar when scrolling (with auto-hide)
      if (scrollbackLength > 0) {
        this.showScrollbar();
      }
      this.requestRender();
    }
  }

  /**
   * Scroll viewport by a number of pages
   * @param amount Number of pages to scroll (positive = down, negative = up)
   */
  public scrollPages(amount: number): void {
    this.scrollLines(amount * this.rows);
  }

  /**
   * Scroll viewport to the top of the scrollback buffer
   */
  public scrollToTop(): void {
    this.cancelSmoothScroll();
    const scrollbackLength = this.getScrollbackLength();
    if (scrollbackLength > 0 && this.viewportY !== scrollbackLength) {
      this.viewportY = scrollbackLength;
      this.scrollAnimationStartViewportY = scrollbackLength;
      this.targetViewportY = scrollbackLength;
      this.scrollEmitter.fire(this.viewportY);
      this.showScrollbar();
      this.requestRender();
    }
  }

  /**
   * Scroll viewport to the bottom (current output)
   */
  public scrollToBottom(): void {
    this.cancelSmoothScroll();
    if (this.viewportY !== 0) {
      this.viewportY = 0;
      this.scrollAnimationStartViewportY = 0;
      this.targetViewportY = 0;
      this.scrollEmitter.fire(this.viewportY);
      // Show scrollbar briefly when scrolling to bottom
      if (this.getScrollbackLength() > 0) {
        this.showScrollbar();
      }
      this.requestRender();
    }
  }

  /**
   * Scroll viewport to a specific line in the buffer
   * @param line Line number (0 = top of scrollback, scrollbackLength = bottom)
   */
  public scrollToLine(line: number): void {
    this.cancelSmoothScroll();
    const scrollbackLength = this.getScrollbackLength();
    const newViewportY = Math.max(0, Math.min(scrollbackLength, line));

    if (newViewportY !== this.viewportY) {
      this.viewportY = newViewportY;
      this.scrollAnimationStartViewportY = newViewportY;
      this.targetViewportY = newViewportY;
      this.scrollEmitter.fire(this.viewportY);

      // Show scrollbar when scrolling to specific line
      if (scrollbackLength > 0) {
        this.showScrollbar();
      }
      this.requestRender();
    }
  }

  /**
   * Smoothly scroll to a target viewport position
   * @param targetY Target viewport Y position (in lines, can be fractional)
   */
  private smoothScrollTo(targetY: number): void {
    if (!this.wasmTerm || !Number.isFinite(targetY)) return;

    const scrollbackLength = this.getScrollbackLength();
    const maxScroll = scrollbackLength;

    // Clamp target to valid range
    const newTarget = Math.max(0, Math.min(maxScroll, targetY));

    // If smooth scrolling is disabled (duration = 0), jump immediately
    const duration = this.options.smoothScrollDuration;
    if (duration === 0) {
      const viewportChanged = this.viewportY !== newTarget;
      this.cancelSmoothScroll();
      this.viewportY = newTarget;
      this.targetViewportY = newTarget;
      this.scrollAnimationStartViewportY = newTarget;
      if (!viewportChanged) return;

      this.scrollEmitter.fire(Math.floor(newTarget));

      if (scrollbackLength > 0) {
        this.showScrollbar();
      }
      this.requestRender();
      return;
    }

    if (newTarget === this.viewportY) {
      this.cancelSmoothScroll();
      return;
    }

    // An active segment keeps its original time window so high-frequency
    // trackpad events cannot continually reset progress before the next frame.
    this.targetViewportY = newTarget;
    if (this.scrollAnimationFrame !== undefined) {
      return;
    }

    this.scrollAnimationStartViewportY = this.viewportY;
    this.scrollAnimationStartTime = performance.now();

    // Preserve the existing responsive wheel behavior by presenting the first
    // millisecond of progress synchronously. Subsequent progress is derived
    // exclusively from rAF timestamps.
    this.animateScroll(
      this.scrollAnimationStartTime + Math.min(1, duration),
      this.scrollAnimationGeneration
    );
  }

  /**
   * Animation loop for smooth scrolling
   * Uses elapsed time so every finite duration reaches its target exactly.
   */
  private animateScroll(timestamp: DOMHighResTimeStamp, generation: number): void {
    if (generation !== this.scrollAnimationGeneration) return;
    this.scrollAnimationFrame = undefined;
    if (!this.wasmTerm || this.scrollAnimationStartTime === undefined) return;

    const duration = this.options.smoothScrollDuration;
    const elapsed = Math.max(0, timestamp - this.scrollAnimationStartTime);
    const completed = duration === 0 || timestamp >= this.scrollAnimationStartTime + duration;
    const progress = completed ? 1 : Math.min(1, elapsed / duration);
    const easedProgress = 1 - (1 - progress) ** 3;
    this.viewportY =
      this.scrollAnimationStartViewportY +
      (this.targetViewportY - this.scrollAnimationStartViewportY) * easedProgress;

    if (completed) {
      this.finishSmoothScroll();
      return;
    }

    // Fire scroll event (use floor to convert fractional to integer for API)
    const intViewportY = Math.floor(this.viewportY);
    this.scrollEmitter.fire(intViewportY);

    // Show scrollbar during animation
    const scrollbackLength = this.getScrollbackLength();
    if (scrollbackLength > 0) {
      this.showScrollbar();
    }

    this.requestRender();

    // Scroll listeners may cancel or replace the animation reentrantly. Do not
    // let the old callback schedule over the newer owner.
    if (
      generation !== this.scrollAnimationGeneration ||
      this.scrollAnimationStartTime === undefined
    ) {
      return;
    }

    this.scheduleScrollAnimationFrame();
  }

  private scheduleScrollAnimationFrame(): void {
    const generation = this.scrollAnimationGeneration;
    this.scrollAnimationFrame = requestAnimationFrame((timestamp) =>
      this.animateScroll(timestamp, generation)
    );
  }

  /** Snap an active animation to its exact destination. */
  private finishSmoothScroll(): void {
    this.scrollAnimationGeneration++;
    if (this.scrollAnimationFrame !== undefined) {
      cancelAnimationFrame(this.scrollAnimationFrame);
      this.scrollAnimationFrame = undefined;
    }
    this.viewportY = this.targetViewportY;
    this.scrollAnimationStartViewportY = this.viewportY;
    this.scrollAnimationStartTime = undefined;
    this.scrollEmitter.fire(Math.floor(this.viewportY));

    if (this.getScrollbackLength() > 0) {
      this.showScrollbar();
    }
    this.requestRender();
  }

  /** Revoke animation callbacks and synchronize their target to the viewport. */
  private cancelSmoothScroll(): void {
    this.scrollAnimationGeneration++;
    if (this.scrollAnimationFrame !== undefined) {
      cancelAnimationFrame(this.scrollAnimationFrame);
      this.scrollAnimationFrame = undefined;
    }
    this.scrollAnimationStartTime = undefined;
    this.scrollAnimationStartViewportY = this.viewportY;
    this.targetViewportY = this.viewportY;
  }

  /** Return the viewport to current output and revoke any in-flight scrolling. */
  private resetViewport(): void {
    const wasScrolled = this.viewportY !== 0 || this.targetViewportY !== 0;
    this.cancelSmoothScroll();
    this.viewportY = 0;
    this.scrollAnimationStartViewportY = 0;
    this.targetViewportY = 0;

    if (this.scrollbarHideTimeout !== undefined) {
      window.clearTimeout(this.scrollbarHideTimeout);
      this.scrollbarHideTimeout = undefined;
    }
    this.scrollbarVisible = false;
    this.scrollbarOpacity = 0;
    if (wasScrolled) this.scrollEmitter.fire(0);
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Dispose terminal and clean up resources
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this.isDisposed = true;
    this.isOpen = false;

    this.resetSynchronizedOutputTracking();
    this.stopPresentationWork(false);
    this.writeQueue.length = 0;
    this.retainedBufferSearch?.dispose();
    this.retainedBufferSearch = undefined;
    this.retainedBufferExtraction?.dispose();
    this.retainedBufferExtraction = undefined;

    // Dispose addons
    for (const addon of this.addons) {
      addon.dispose();
    }
    this.addons = [];

    // Clean up components
    this.cleanupComponents();
    this.ghostty = undefined;

    // Dispose event emitters
    this.dataEmitter.dispose();
    this.resizeEmitter.dispose();
    this.bellEmitter.dispose();
    this.selectionChangeEmitter.dispose();
    this.keyEmitter.dispose();
    this.titleChangeEmitter.dispose();
    this.scrollEmitter.dispose();
    this.renderEmitter.dispose();
    this.cursorMoveEmitter.dispose();
    this.terminalEventEmitter.dispose();
    (this.buffer as BufferNamespace | undefined)?._dispose();
  }

  /** Request one coalesced presentation frame. */
  public requestRender(forceAll: boolean = false): void {
    if (this.isDisposed) return;

    this.renderRequests++;
    if (forceAll) this.forceFullRender = true;

    if (this.synchronizedOutputActive) return;

    if (!this.renderPaused && this.isOpen && this.animationFrameId === undefined) {
      this.startRenderLoop();
    }
  }

  /** Pause or resume presentation without pausing terminal parsing. */
  public setRenderPaused(paused: boolean): void {
    if (this.isDisposed || this.renderPaused === paused) return;

    this.renderPaused = paused;
    if (!paused) {
      this.renderer?.setRenderPaused(false);
      this.requestRender(true);
      return;
    }

    this.stopPresentationWork(true);
  }

  /** Make a blinking cursor visible now and restart its idle cadence. */
  public resetCursorBlink(): void {
    if (!this.isDisposed) this.renderer?.resetCursorBlink();
  }

  /** Inspect parser and presentation activity for diagnostics. */
  public getRenderStats(): TerminalRenderStats {
    const lastFrame = this.renderer?.getFrameStats?.() ?? {
      renderedRows: 0,
      materializedRows: 0,
      materializedCells: 0,
      textRuns: 0,
      textMeasurements: 0,
      shapedRuns: 0,
      shapedCells: 0,
      maxRunCells: 0,
    };
    return {
      parsedWrites: this.parsedWrites,
      renderRequests: this.renderRequests,
      renderFrames: this.renderFrames,
      fullRenderFrames: this.fullRenderFrames,
      paused: this.renderPaused,
      pendingFrame: this.animationFrameId !== undefined,
      cursorVisible: this.renderer?.getCursorVisible() ?? false,
      synchronizedOutput: this.synchronizedOutputActive,
      synchronizedOutputRecoveries: this.synchronizedOutputRecoveries,
      lastFrame,
    };
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Reconcile the Canvas scheduler with Ghostty's parser-owned mode.
   *
   * The generation distinguishes repeated DECSET 2026 actions so each one
   * restarts the same one-second safety timer as native Ghostty. A generation
   * that begins and ends within one write still forces one complete frame.
   */
  private reconcileSynchronizedOutput(): boolean {
    if (!this.wasmTerm) return false;

    const active = this.wasmTerm.isSynchronizedOutput();
    const generation = this.wasmTerm.getSynchronizedOutputGeneration();
    const sawEnable = generation !== this.synchronizedOutputGeneration;
    this.synchronizedOutputGeneration = generation;

    if (active) {
      if (!this.synchronizedOutputActive) {
        this.synchronizedOutputActive = true;
        this.cancelRenderLoop();
      }
      if (sawEnable) this.armSynchronizedOutputTimeout(generation);
      return false;
    }

    const completed = this.synchronizedOutputActive || sawEnable;
    this.synchronizedOutputActive = false;
    this.clearSynchronizedOutputTimeout();
    return completed;
  }

  /** Parse once in Ghostty, then immediately reconcile its presentation mode. */
  private writeToWasm(data: string | Uint8Array): boolean {
    const primaryGeneration = this.wasmTerm!.getPrimaryScreenGeneration();
    const alternateGeneration = this.wasmTerm!.getAlternateScreenGeneration();
    this.wasmTerm!.write(data);
    if (this.wasmTerm!.getPrimaryScreenGeneration() !== primaryGeneration) {
      this.retainedBufferSearch?.noteWrite();
      this.retainedBufferExtraction?.noteWrite('normal');
    }
    if (this.wasmTerm!.getAlternateScreenGeneration() !== alternateGeneration) {
      this.retainedBufferExtraction?.noteWrite('alternate');
    }
    // Snapshot before firing listeners. A listener may write reentrantly, and
    // each write must reconcile against its own core state.
    return this.reconcileSynchronizedOutput();
  }

  /** Restart the native-compatible abandonment timeout for one enable action. */
  private armSynchronizedOutputTimeout(generation: number): void {
    this.clearSynchronizedOutputTimeout();
    this.synchronizedOutputTimeout = window.setTimeout(() => {
      this.synchronizedOutputTimeout = undefined;
      if (this.isDisposed || !this.isOpen || !this.wasmTerm) return;
      if (
        this.wasmTerm.getSynchronizedOutputGeneration() !== generation ||
        !this.wasmTerm.isSynchronizedOutput()
      ) {
        return;
      }

      this.wasmTerm.resetSynchronizedOutput();
      this.synchronizedOutputActive = false;
      this.synchronizedOutputRecoveries++;
      this.requestRender(true);
    }, SYNCHRONIZED_OUTPUT_TIMEOUT_MS);
  }

  private clearSynchronizedOutputTimeout(): void {
    if (this.synchronizedOutputTimeout === undefined) return;
    window.clearTimeout(this.synchronizedOutputTimeout);
    this.synchronizedOutputTimeout = undefined;
  }

  /** Release lifecycle state without carrying a timer across terminal owners. */
  private resetSynchronizedOutputTracking(): void {
    this.clearSynchronizedOutputTimeout();
    this.synchronizedOutputActive = false;
    this.synchronizedOutputGeneration = 0;
  }

  /**
   * Cancel the render loop
   */
  private cancelRenderLoop(): void {
    if (this.animationFrameId !== undefined) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = undefined;
    }
  }

  /** Stop transient presentation work owned by both pause and disposal. */
  private stopPresentationWork(normalizeSmoothScroll: boolean): void {
    this.cancelRenderLoop();
    this.renderer?.setRenderPaused(true);

    const smoothScrollWasActive =
      this.scrollAnimationFrame !== undefined || this.scrollAnimationStartTime !== undefined;
    const smoothScrollTarget = this.targetViewportY;
    this.cancelSmoothScroll();
    if (normalizeSmoothScroll && smoothScrollWasActive) {
      const normalizedViewportY = Math.max(0, Math.floor(smoothScrollTarget));
      this.viewportY = normalizedViewportY;
      this.scrollAnimationStartViewportY = normalizedViewportY;
      this.targetViewportY = normalizedViewportY;
      this.scrollEmitter.fire(normalizedViewportY);
    }

    if (this.scrollbarHideTimeout !== undefined) {
      window.clearTimeout(this.scrollbarHideTimeout);
      this.scrollbarHideTimeout = undefined;
    }
    if (this.mouseMoveThrottleTimeout !== undefined) {
      window.clearTimeout(this.mouseMoveThrottleTimeout);
      this.mouseMoveThrottleTimeout = undefined;
    }
    this.pendingMouseMove = undefined;
    this.selectionManager?.stopAutoScroll();
    this.scrollbarVisible = false;
    this.scrollbarOpacity = 0;
  }

  /**
   * Flush any writes that were queued during resize
   */
  private flushWriteQueue(): void {
    while (this.writeQueue.length > 0) {
      const data = this.writeQueue.shift()!;
      this.writeToWasm(data);
    }
  }

  /** Schedule one coalesced presentation frame. */
  private startRenderLoop(): void {
    if (
      this.animationFrameId !== undefined ||
      this.renderPaused ||
      this.synchronizedOutputActive ||
      this.isDisposed ||
      !this.isOpen
    ) {
      return;
    }

    this.animationFrameId = requestAnimationFrame(() => {
      this.animationFrameId = undefined;
      if (this.isDisposed || !this.isOpen || this.renderPaused || this.synchronizedOutputActive) {
        return;
      }

      const forceAll = this.forceFullRender;
      this.forceFullRender = false;
      const cursor = this.renderer!.render(
        this.wasmTerm!,
        forceAll,
        this.viewportY,
        this.rendererScrollbackProvider,
        this.scrollbarOpacity
      );
      this.renderFrames++;
      if (forceAll) this.fullRenderFrames++;

      const renderedRanges = this.renderer!.getRenderedRowRanges();
      const alternateScreen = this.wasmTerm!.isAlternateScreen();
      const cursorMoved =
        cursor.x !== this.lastCursorX ||
        cursor.y !== this.lastCursorY ||
        alternateScreen !== this.lastCursorAlternateScreen ||
        this.cursorScreenGeneration !== this.lastPresentedCursorScreenGeneration;

      // Commit the observation before firing user code. A listener may reenter
      // write(), schedule another frame, or dispose the terminal.
      this.lastCursorX = cursor.x;
      this.lastCursorY = cursor.y;
      this.lastCursorAlternateScreen = alternateScreen;
      this.lastPresentedCursorScreenGeneration = this.cursorScreenGeneration;

      // Keep the non-visual viewport on the same presentation boundary as the
      // Canvas. The manager compares snapshots so adjacent overflow rows and
      // repeated fractional smooth-scroll frames do not replay unchanged DOM.
      this.accessibilityManager?.updateFrame(renderedRanges, cursor);

      if (cursorMoved) {
        this.cursorMoveEmitter.fire();
      }
      for (const range of renderedRanges) {
        this.renderEmitter.fire(range);
      }
      if (this.devicePixelRatioChanged) {
        this.devicePixelRatioChanged = false;
        for (const addon of [...this.addons]) {
          if (this.isDisposed || !this.isOpen) break;
          try {
            addon.onDevicePixelRatioChange?.();
          } catch (error) {
            console.error('Addon DPR-change handler failed:', error);
          }
        }
      }
    });
  }

  /**
   * Get a line from native WASM scrollback buffer
   * Implements IScrollbackProvider
   */
  public getScrollbackLine(offset: number): GhosttyCell[] | null {
    if (!this.wasmTerm) return null;
    return this.wasmTerm.getScrollbackLine(offset);
  }

  /**
   * Get scrollback length from native WASM
   * Implements IScrollbackProvider
   */
  public getScrollbackLength(): number {
    if (!this.wasmTerm) return 0;
    return this.wasmTerm.getScrollbackLength();
  }

  /**
   * Get the effective byte limit configured on Ghostty's native page list.
   * Returns 0 for unlimited scrollback. The terminal must be open.
   */
  public getScrollbackByteLimit(): number {
    this.assertOpen();
    return this.wasmTerm!.getScrollbackByteLimit();
  }

  /**
   * Clean up components (called on dispose or error)
   */
  private cleanupComponents(): void {
    this.accessibilityManager?.dispose();
    this.accessibilityManager = undefined;

    this.selectionChangeDisposable?.dispose();
    this.selectionChangeDisposable = undefined;

    // Dispose selection manager
    if (this.selectionManager) {
      this.selectionManager.dispose();
      this.selectionManager = undefined;
    }

    // Dispose input handler
    if (this.inputHandler) {
      this.inputHandler.dispose();
      this.inputHandler = undefined;
    }

    if (this.canvas && this.canvasMouseDownListener) {
      this.canvas.removeEventListener('mousedown', this.canvasMouseDownListener);
    }
    this.canvasMouseDownListener = undefined;
    if (this.canvas && this.canvasTouchEndListener) {
      this.canvas.removeEventListener('touchend', this.canvasTouchEndListener);
    }
    this.canvasTouchEndListener = undefined;

    if (this.textarea && this.inputFocusListener) {
      this.textarea.removeEventListener('focus', this.inputFocusListener);
    }
    this.inputFocusListener = undefined;
    if (this.textarea && this.inputBlurListener) {
      this.textarea.removeEventListener('blur', this.inputBlurListener);
    }
    this.inputBlurListener = undefined;

    // Dispose renderer
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = undefined;
    }

    // Remove canvas from DOM
    if (this.canvas) {
      this.canvas.remove();
      this.canvas = undefined;
    }

    // Remove textarea from DOM
    if (this.textarea) {
      this.textarea.remove();
      this.textarea = undefined;
    }

    // Remove event listeners
    if (this.element) {
      if (this.hostFocusListener) {
        this.element.removeEventListener('focus', this.hostFocusListener);
      }
      if (this.hostWheelListenerAttached) {
        this.element.removeEventListener('wheel', this.handleWheel, { capture: true });
      }
      if (this.hostMouseDownListenerAttached) {
        this.element.removeEventListener('mousedown', this.handleMouseDown, { capture: true });
      }
      if (this.hostMouseMoveListenerAttached) {
        this.element.removeEventListener('mousemove', this.handleMouseMove);
      }
      if (this.hostMouseLeaveListenerAttached) {
        this.element.removeEventListener('mouseleave', this.handleMouseLeave);
      }
      if (this.hostClickListenerAttached) {
        this.element.removeEventListener('click', this.handleClick);
      }
    }
    this.hostFocusListener = undefined;
    this.hostWheelListenerAttached = false;
    this.hostMouseDownListenerAttached = false;
    this.hostMouseMoveListenerAttached = false;
    this.hostMouseLeaveListenerAttached = false;
    this.hostClickListenerAttached = false;

    if (this.documentMouseUpListenerAttached && typeof document !== 'undefined') {
      document.removeEventListener('mouseup', this.handleMouseUp);
    }
    this.documentMouseUpListenerAttached = false;

    if (this.focusTimeout !== undefined) {
      window.clearTimeout(this.focusTimeout);
      this.focusTimeout = undefined;
    }

    // Clean up scrollbar timers
    if (this.scrollbarHideTimeout) {
      window.clearTimeout(this.scrollbarHideTimeout);
      this.scrollbarHideTimeout = undefined;
    }

    // Dispose link detector
    if (this.linkDetector) {
      this.linkDetector.dispose();
      this.linkDetector = undefined;
    }

    // Free WASM terminal
    if (this.wasmTerm) {
      this.wasmTerm.free();
      this.wasmTerm = undefined;
    }

    // Restore attributes and styles that belonged to the host before open().
    if (this.hostState) {
      for (const [name, value] of this.hostState.attributes) {
        if (value === null) this.hostState.element.removeAttribute(name);
        else this.hostState.element.setAttribute(name, value);
      }
      this.restoreHostOutline();
      this.hostState.element.style.cursor = this.hostState.cursor;
      this.hostState = undefined;
    }

    // Clear references
    this.element = undefined;
    this.textarea = undefined;
  }

  /**
   * Assert terminal is open (throw if not)
   */
  private assertOpen(): void {
    if (this.isDisposed) {
      throw new Error('Terminal has been disposed');
    }
    if (!this.isOpen) {
      throw new Error('Terminal must be opened before use. Call terminal.open(parent) first.');
    }
  }

  /**
   * Handle mouse move for link hover detection and scrollbar dragging
   * Throttled to avoid blocking scroll events (except when dragging scrollbar)
   */
  private handleMouseMove = (e: MouseEvent): void => {
    if (!this.canvas || !this.renderer || !this.wasmTerm) return;

    // If dragging scrollbar, handle immediately without throttling
    if (this.isDraggingScrollbar) {
      this.processScrollbarDrag(e);
      return;
    }

    if (!this.linkDetector) return;
    this.synchronizeLinkHandlerPolicy();
    const requestSerial = ++this.linkHoverRequestSerial;

    // Throttle to ~60fps (16ms) to avoid blocking scroll/other events
    if (this.mouseMoveThrottleTimeout !== undefined) {
      this.pendingMouseMove = { event: e, requestSerial };
      return;
    }

    this.processMouseMove(e, requestSerial);

    this.mouseMoveThrottleTimeout = window.setTimeout(() => {
      this.mouseMoveThrottleTimeout = undefined;
      if (this.pendingMouseMove) {
        const pending = this.pendingMouseMove;
        this.pendingMouseMove = undefined;
        this.processMouseMove(pending.event, pending.requestSerial);
      }
    }, 16);
  };

  /**
   * Process mouse move for link detection (internal, called by throttled handler)
   */
  private processMouseMove(e: MouseEvent, requestSerial?: number): void {
    if (!this.canvas || !this.renderer || !this.linkDetector || !this.wasmTerm) return;
    if (requestSerial === undefined) {
      this.synchronizeLinkHandlerPolicy();
      requestSerial = ++this.linkHoverRequestSerial;
    } else if (requestSerial !== this.linkHoverRequestSerial) {
      return;
    }

    const position = this.getLinkBufferPosition(e);
    if (!position) return;
    const { col: x, viewportRow, bufferRow } = position;
    this.currentLinkHoverRequest = { requestSerial, col: x, row: bufferRow };

    // Get hyperlink_id directly from the cell at this position
    // Must account for viewportY (scrollback position)
    let hyperlinkId = 0;

    // When scrolled, fetch from scrollback or screen based on position
    // NOTE: viewportY may be fractional during smooth scrolling. The renderer
    // uses Math.floor(viewportY) when mapping viewport rows to scrollback vs
    // screen; we mirror that logic here so link hit-testing matches what the
    // user sees on screen.
    let line: GhosttyCell[] | null = null;
    const rawViewportY = this.getViewportY();
    const viewportY = Math.max(0, Math.floor(rawViewportY));
    if (viewportY > 0) {
      const scrollbackLength = this.wasmTerm.getScrollbackLength();
      if (viewportRow < viewportY) {
        // Mouse is over scrollback content
        const scrollbackOffset = scrollbackLength - viewportY + viewportRow;
        line = this.wasmTerm.getScrollbackLine(scrollbackOffset);
      } else {
        // Mouse is over screen content (bottom part of viewport)
        const screenRow = viewportRow - viewportY;
        line = this.wasmTerm.getLine(screenRow);
      }
    } else {
      // At bottom - just use screen buffer
      line = this.wasmTerm.getLine(viewportRow);
    }

    if (line && x >= 0 && x < line.length) {
      hyperlinkId = line[x].hyperlink_id;
    }

    // Update renderer for underline rendering
    const previousHyperlinkId = (this.renderer as any).hoveredHyperlinkId || 0;
    if (hyperlinkId !== previousHyperlinkId) {
      this.renderer.setHoveredHyperlinkId(hyperlinkId);

      // The 60fps render loop will pick up the change automatically
      // No need to force a render - this keeps performance smooth
    }

    const detector = this.linkDetector;
    const contentGeneration = detector.getGeneration();

    // Make async call non-blocking - don't await
    detector
      .getLinkAt(x, bufferRow)
      .then((link) => {
        const currentPosition = this.getLinkBufferPosition(e);
        const currentRequest = this.currentLinkHoverRequest;
        if (
          this.isDisposed ||
          !this.isOpen ||
          this.linkDetector !== detector ||
          !detector.isGenerationCurrent(contentGeneration) ||
          requestSerial !== this.linkHoverRequestSerial ||
          currentRequest?.requestSerial !== requestSerial ||
          currentRequest.col !== x ||
          currentRequest.row !== bufferRow ||
          currentPosition?.col !== x ||
          currentPosition?.bufferRow !== bufferRow
        ) {
          return;
        }

        // Update hover state for cursor changes and click handling
        if (link !== this.currentHoveredLink) {
          // Notify old link we're leaving
          this.currentHoveredLink?.hover?.(false);

          // Update current link
          this.currentHoveredLink = link;

          // Notify new link we're entering
          link?.hover?.(true);

          // Update cursor style on both container and canvas
          const cursorStyle = link ? 'pointer' : 'text';
          if (this.element) {
            this.element.style.cursor = cursorStyle;
          }
          if (this.canvas) {
            this.canvas.style.cursor = cursorStyle;
          }

          // Update renderer for underline (for regex URLs without hyperlink_id)
          if (this.renderer) {
            if (link) {
              // Convert buffer coordinates to viewport coordinates
              const scrollbackLength = this.wasmTerm?.getScrollbackLength() || 0;

              // Calculate viewport Y for start and end positions
              // Use floored viewportY so overlay rows match renderer & selection
              const rawViewportYForLinks = this.getViewportY();
              const viewportYForLinks = Math.max(0, Math.floor(rawViewportYForLinks));
              const startViewportY = link.range.start.y - scrollbackLength + viewportYForLinks;
              const endViewportY = link.range.end.y - scrollbackLength + viewportYForLinks;

              // Only show underline if link is visible in viewport
              if (startViewportY < this.rows && endViewportY >= 0) {
                this.renderer.setHoveredLinkRange({
                  startX: link.range.start.x,
                  startY: Math.max(0, startViewportY),
                  endX: link.range.end.x,
                  endY: Math.min(this.rows - 1, endViewportY),
                });
              } else {
                this.renderer.setHoveredLinkRange(null);
              }
            } else {
              this.renderer.setHoveredLinkRange(null);
            }
          }
        }
      })
      .catch((err) => {
        console.warn('Link detection error:', err);
      });
  }

  /** Map a pointer event to the absolute buffer cell currently under it. */
  private getLinkBufferPosition(
    e: MouseEvent
  ): { col: number; viewportRow: number; bufferRow: number } | undefined {
    if (!this.canvas || !this.renderer || !this.wasmTerm) return undefined;

    const rect = this.canvas.getBoundingClientRect();
    const col = Math.floor((e.clientX - rect.left) / this.renderer.charWidth);
    const viewportRow = Math.floor((e.clientY - rect.top) / this.renderer.charHeight);
    const scrollbackLength = this.wasmTerm.getScrollbackLength();
    const viewportY = Math.max(0, Math.floor(this.getViewportY()));

    let bufferRow: number;
    if (viewportY > 0 && viewportRow < viewportY) {
      bufferRow = scrollbackLength - viewportY + viewportRow;
    } else if (viewportY > 0) {
      bufferRow = scrollbackLength + viewportRow - viewportY;
    } else {
      bufferRow = scrollbackLength + viewportRow;
    }

    return { col, viewportRow, bufferRow };
  }

  /** Revoke pending hover work and remove every link-owned visual state. */
  private clearLinkHoverState(): void {
    this.linkHoverRequestSerial++;
    this.currentLinkHoverRequest = undefined;
    this.pendingMouseMove = undefined;

    this.renderer?.setHoveredHyperlinkId(0);
    this.renderer?.setHoveredLinkRange(null);

    const hoveredLink = this.currentHoveredLink;
    this.currentHoveredLink = undefined;
    try {
      hoveredLink?.hover?.(false);
    } catch (err) {
      console.warn('Link hover cleanup error:', err);
    }

    if (this.element) this.element.style.cursor = 'text';
    if (this.canvas) this.canvas.style.cursor = 'text';
  }

  /**
   * Handle mouse leave to clear link hover
   */
  private handleMouseLeave = (): void => {
    this.clearLinkHoverState();
  };

  /**
   * Handle mouse click for link activation
   */
  private handleClick = async (e: MouseEvent): Promise<void> => {
    // For more reliable clicking, detect the link at click time
    // rather than relying on cached hover state (avoids async races)
    if (!this.canvas || !this.renderer || !this.linkDetector || !this.wasmTerm) return;
    this.synchronizeLinkHandlerPolicy();

    const position = this.getLinkBufferPosition(e);
    if (!position) return;
    const { col, bufferRow } = position;
    const detector = this.linkDetector;
    const contentGeneration = detector.getGeneration();

    // Get the link at this position
    const link = await detector.getLinkAt(col, bufferRow);
    const currentPosition = this.getLinkBufferPosition(e);

    if (
      link &&
      !this.isDisposed &&
      this.isOpen &&
      this.linkDetector === detector &&
      detector.isGenerationCurrent(contentGeneration) &&
      currentPosition?.col === col &&
      currentPosition.bufferRow === bufferRow
    ) {
      // Activate link
      link.activate(e);

      // Prevent default action if modifier key held
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
      }
    }
  };

  /**
   * Handle wheel events for scrolling (Phase 2)
   */
  private handleWheel = (e: WheelEvent): void => {
    // Always prevent default browser scrolling
    e.preventDefault();

    // Allow custom handler to override
    if (this.customWheelEventHandler && this.customWheelEventHandler(e)) {
      e.stopPropagation();
      return;
    }

    // In mouse-reporting modes, the bubbling InputHandler owns unmodified
    // wheel events. Returning here keeps this capture listener from hiding
    // real canvas events before they reach the protocol encoder.
    if ((this.wasmTerm?.hasMouseTracking() ?? false) && !e.shiftKey) return;

    // Shift is the documented local override while mouse tracking is active.
    e.stopPropagation();

    // Check if in alternate screen mode (vim, less, htop, etc.)
    const isAltScreen = this.wasmTerm?.isAlternateScreen() ?? false;

    if (isAltScreen) {
      // Alternate screen: send arrow keys to the application
      // Applications like vim handle scrolling internally
      // Standard: ~3 arrow presses per wheel "click"
      const direction = e.deltaY > 0 ? 'down' : 'up';
      const count = Math.min(Math.abs(Math.round(e.deltaY / 33)), 5); // Cap at 5

      this.inputHandler?.sendArrowKeys(direction, count);
    } else {
      // Normal screen: scroll viewport through history with smooth scrolling
      // Handle different deltaMode values for better trackpad/mouse support
      let deltaLines: number;

      if (e.deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
        // Pixel mode (trackpads): convert pixels to lines
        // Use actual line height from renderer for accurate conversion
        const lineHeight = this.renderer?.getMetrics()?.height ?? 20;
        deltaLines = e.deltaY / lineHeight;
      } else if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
        // Line mode (some mice): use directly
        deltaLines = e.deltaY;
      } else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
        // Page mode (rare): convert pages to lines
        deltaLines = e.deltaY * this.rows;
      } else {
        // Fallback: assume pixel mode with legacy divisor
        deltaLines = e.deltaY / 33;
      }

      // Use smooth scrolling for any amount (no rounding needed)
      if (deltaLines !== 0) {
        // Calculate target position
        // deltaY > 0 = scroll down (decrease viewportY)
        // deltaY < 0 = scroll up (increase viewportY)
        const targetY = this.viewportY - deltaLines;
        this.smoothScrollTo(targetY);
      }
    }
  };

  /**
   * Handle mouse down for scrollbar interaction
   */
  private handleMouseDown = (e: MouseEvent): void => {
    if (!this.canvas || !this.renderer || !this.wasmTerm) return;

    const scrollbackLength = this.wasmTerm.getScrollbackLength();
    if (scrollbackLength === 0) return; // No scrollbar if no scrollback

    const rect = this.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Calculate scrollbar dimensions (match renderer's logic)
    // Use rect dimensions which are already in CSS pixels
    const canvasWidth = rect.width;
    const canvasHeight = rect.height;
    const scrollbarWidth = 8;
    const scrollbarX = canvasWidth - scrollbarWidth - 4;
    const scrollbarPadding = 4;

    // Check if click is in scrollbar area
    if (mouseX >= scrollbarX && mouseX <= scrollbarX + scrollbarWidth) {
      // Prevent default and stop propagation to prevent text selection
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation(); // Stop SelectionManager from seeing this event

      // Calculate scrollbar thumb position and size
      const scrollbarTrackHeight = canvasHeight - scrollbarPadding * 2;
      const visibleRows = this.rows;
      const totalLines = scrollbackLength + visibleRows;
      const thumbHeight = Math.max(20, (visibleRows / totalLines) * scrollbarTrackHeight);
      const scrollPosition = this.viewportY / scrollbackLength;
      const thumbY = scrollbarPadding + (scrollbarTrackHeight - thumbHeight) * (1 - scrollPosition);

      // Check if click is on thumb
      if (mouseY >= thumbY && mouseY <= thumbY + thumbHeight) {
        // Start dragging thumb
        this.isDraggingScrollbar = true;
        this.scrollbarDragStart = mouseY;
        this.scrollbarDragStartViewportY = this.viewportY;

        // Prevent text selection during drag
        if (this.canvas) {
          this.canvas.style.userSelect = 'none';
          this.canvas.style.webkitUserSelect = 'none';
        }
      } else {
        // Click on track - jump to position
        const relativeY = mouseY - scrollbarPadding;
        const scrollFraction = 1 - relativeY / scrollbarTrackHeight; // Inverted: top = 1, bottom = 0
        const targetViewportY = Math.round(scrollFraction * scrollbackLength);
        this.scrollToLine(Math.max(0, Math.min(scrollbackLength, targetViewportY)));
      }
    }
  };

  /**
   * Handle mouse up for scrollbar drag
   */
  private handleMouseUp = (): void => {
    if (this.isDraggingScrollbar) {
      this.isDraggingScrollbar = false;
      this.scrollbarDragStart = null;

      // Restore text selection
      if (this.canvas) {
        this.canvas.style.userSelect = '';
        this.canvas.style.webkitUserSelect = '';
      }

      // Schedule auto-hide after drag ends
      if (this.scrollbarVisible && this.getScrollbackLength() > 0) {
        this.showScrollbar(); // Reset the hide timer
      }
    }
  };

  /**
   * Process scrollbar drag movement
   */
  private processScrollbarDrag(e: MouseEvent): void {
    if (!this.canvas || !this.renderer || !this.wasmTerm || this.scrollbarDragStart === null)
      return;

    const scrollbackLength = this.wasmTerm.getScrollbackLength();
    if (scrollbackLength === 0) return;

    const rect = this.canvas.getBoundingClientRect();
    const mouseY = e.clientY - rect.top;

    // Calculate how much the mouse moved
    const deltaY = mouseY - this.scrollbarDragStart;

    // Convert mouse delta to viewport delta
    // Use rect height which is already in CSS pixels
    const canvasHeight = rect.height;
    const scrollbarPadding = 4;
    const scrollbarTrackHeight = canvasHeight - scrollbarPadding * 2;
    const visibleRows = this.rows;
    const totalLines = scrollbackLength + visibleRows;
    const thumbHeight = Math.max(20, (visibleRows / totalLines) * scrollbarTrackHeight);

    // Calculate scroll fraction from thumb movement
    // Note: thumb moves in opposite direction to viewport (thumb down = scroll down = viewportY decreases)
    const scrollFraction = -deltaY / (scrollbarTrackHeight - thumbHeight);
    const viewportDelta = Math.round(scrollFraction * scrollbackLength);

    const newViewportY = this.scrollbarDragStartViewportY + viewportDelta;
    this.scrollToLine(Math.max(0, Math.min(scrollbackLength, newViewportY)));
  }

  /**
   * Show scrollbar with fade-in and schedule auto-hide
   */
  private showScrollbar(): void {
    if (this.renderPaused) return;

    // Clear any existing hide timeout
    if (this.scrollbarHideTimeout) {
      window.clearTimeout(this.scrollbarHideTimeout);
      this.scrollbarHideTimeout = undefined;
    }

    // If not visible, start fade-in
    if (!this.scrollbarVisible) {
      this.scrollbarVisible = true;
      this.scrollbarOpacity = 0;
      this.fadeInScrollbar();
    } else {
      // Already visible, just ensure it's fully opaque
      this.scrollbarOpacity = 1;
    }

    // Schedule auto-hide (unless dragging)
    if (!this.isDraggingScrollbar) {
      this.scrollbarHideTimeout = window.setTimeout(() => {
        this.hideScrollbar();
      }, this.SCROLLBAR_HIDE_DELAY_MS);
    }
  }

  /**
   * Hide scrollbar with fade-out
   */
  private hideScrollbar(): void {
    if (this.scrollbarHideTimeout) {
      window.clearTimeout(this.scrollbarHideTimeout);
      this.scrollbarHideTimeout = undefined;
    }

    if (this.scrollbarVisible) {
      this.fadeOutScrollbar();
    }
  }

  /**
   * Fade in scrollbar
   */
  private fadeInScrollbar(): void {
    const startTime = Date.now();
    const animate = () => {
      if (this.isDisposed || this.renderPaused) return;

      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / this.SCROLLBAR_FADE_DURATION_MS, 1);
      this.scrollbarOpacity = progress;

      this.requestRender();

      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };
    animate();
  }

  /**
   * Fade out scrollbar
   */
  private fadeOutScrollbar(): void {
    const startTime = Date.now();
    const startOpacity = this.scrollbarOpacity;
    const animate = () => {
      if (this.isDisposed || this.renderPaused) return;

      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / this.SCROLLBAR_FADE_DURATION_MS, 1);
      this.scrollbarOpacity = startOpacity * (1 - progress);

      const finished = progress >= 1;
      if (finished) {
        this.scrollbarVisible = false;
        this.scrollbarOpacity = 0;
      }

      // The final frame must restore every row under the disappearing overlay.
      this.requestRender(finished);

      if (!finished) {
        requestAnimationFrame(animate);
      }
    };
    animate();
  }

  /**
   * Process any pending terminal responses and emit them via onData.
   *
   * This handles escape sequences that require the terminal to send a response
   * back to the PTY, such as:
   * - DSR 6 (cursor position): Shell sends \x1b[6n, terminal responds with \x1b[row;colR
   * - DSR 5 (operating status): Shell sends \x1b[5n, terminal responds with \x1b[0n
   *
   * Without this, shells like nushell that rely on cursor position queries
   * will hang waiting for a response that never comes.
   *
   * Note: We loop to read all pending responses, not just one. This is important
   * when multiple queries are processed in a single write() call (e.g., when
   * buffered data is written all at once during terminal initialization).
   */
  private processTerminalResponses(): void {
    if (!this.wasmTerm) return;

    // Read all pending responses from the WASM terminal
    // Multiple responses can be queued if a single write() contained multiple queries
    while (true) {
      const response = this.wasmTerm.readResponse();
      if (response === null) break;
      // Send response back to the PTY via onData
      // This is the same path as user keyboard input
      this.dataEmitter.fire(response);
    }
  }

  /**
   * Emit typed parser events and derive legacy title/bell compatibility events.
   */
  private processTerminalEvents(events: DecodedTerminalEvent[]): void {
    let bell = false;
    for (const event of events) {
      if (event.type === 'buffer-change') {
        this.cursorScreenGeneration++;
        const buffer = event.active === 'alternate' ? this.buffer.alternate : this.buffer.normal;
        (this.buffer as BufferNamespace)._fireBufferChange(buffer);
        continue;
      }
      this.terminalEventEmitter.fire(event);
      if (event.type === 'bell') {
        // Preserve the legacy event's once-per-write behavior.
        bell = true;
      } else if (event.type === 'title' && event.title !== this.currentTitle) {
        this.currentTitle = event.title;
        this.titleChangeEmitter.fire(event.title);
      }
    }
    if (bell) this.bellEmitter.fire();
  }

  /** Resolve semantic provenance against the current retained Ghostty screen. */
  resolveEventProvenance(
    provenance: TerminalEventProvenance
  ): { screen: TerminalEventScreen; row: number; column: number } | null {
    if (this.isDisposed || !this.wasmTerm) return null;
    const boundary = this.wasmTerm.resolveEventBoundary(provenance);
    return boundary === null ? null : { screen: provenance.screen, ...boundary };
  }

  // ============================================================================
  // Terminal Modes
  // ============================================================================

  /**
   * Query terminal mode state
   *
   * @param mode Mode number (e.g., 2004 for bracketed paste)
   * @param isAnsi True for ANSI modes, false for DEC modes (default: false)
   * @returns true if mode is enabled
   */
  public getMode(mode: number, isAnsi: boolean = false): boolean {
    this.assertOpen();
    return this.wasmTerm!.getMode(mode, isAnsi);
  }

  /**
   * Check if bracketed paste mode is enabled
   */
  public hasBracketedPaste(): boolean {
    this.assertOpen();
    return this.wasmTerm!.hasBracketedPaste();
  }

  /**
   * Check if focus event reporting is enabled
   */
  public hasFocusEvents(): boolean {
    this.assertOpen();
    return this.wasmTerm!.hasFocusEvents();
  }

  /**
   * Check if mouse tracking is enabled
   */
  public hasMouseTracking(): boolean {
    this.assertOpen();
    return this.wasmTerm!.hasMouseTracking();
  }
}
