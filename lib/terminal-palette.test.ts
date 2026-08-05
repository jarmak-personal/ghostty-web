import { afterEach, describe, expect, test } from 'bun:test';
import type { ITheme } from './interfaces';
import { ANSI_THEME_KEYS, normalizeTheme, parsePaletteColor } from './palette';
import { createIsolatedTerminal } from './test-helpers';
import type { RGB } from './types';

function installAnimationFrameHarness(): {
  callbacks: Map<number, FrameRequestCallback>;
  runNext: () => void;
  restore: () => void;
} {
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;

  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    const id = nextFrame++;
    callbacks.set(id, callback);
    return id;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) =>
    callbacks.delete(id)) as typeof cancelAnimationFrame;

  return {
    callbacks,
    runNext: () => {
      const next = callbacks.entries().next().value as [number, FrameRequestCallback] | undefined;
      if (!next) throw new Error('Expected a pending animation frame');
      callbacks.delete(next[0]);
      next[1](0);
    },
    restore: () => {
      globalThis.requestAnimationFrame = originalRequest;
      globalThis.cancelAnimationFrame = originalCancel;
    },
  };
}

function packedToRgb(value: number): RGB {
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

function hex(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}

function ansiValues(seed: number): number[] {
  return Array.from({ length: 16 }, (_, index) => {
    if (index === 0 && seed === 0) return 0;
    return (
      (((seed + index * 13) & 0xff) << 16) |
      (((seed + index * 7) & 0xff) << 8) |
      ((seed + index * 11) & 0xff)
    );
  });
}

function themeWithAnsi(values: number[], presentation: Partial<ITheme> = {}): ITheme {
  const ansi = Object.fromEntries(
    ANSI_THEME_KEYS.map((key, index) => [key, hex(values[index])])
  ) as Pick<ITheme, (typeof ANSI_THEME_KEYS)[number]>;
  return { ...ansi, ...presentation };
}

const INITIAL_ANSI = ansiValues(0);
const INITIAL_THEME = themeWithAnsi(INITIAL_ANSI, {
  foreground: '#102030',
  background: '#000000',
  cursor: '#405060',
  cursorAccent: '#010203',
  selectionBackground: '#112233',
  selectionForeground: '#ddeeff',
});
const LATEST_ANSI = ansiValues(31);
const LATEST_THEME = themeWithAnsi(LATEST_ANSI, {
  foreground: '#213243',
  background: '#314253',
  cursor: '#415263',
  cursorAccent: '#516273',
  selectionBackground: '#617283',
  selectionForeground: '#718293',
});
const OVERRIDE_ANSI = ansiValues(91);

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
});

describe('configured and effective terminal palette', () => {
  test('configures all 16 ANSI indices, including explicit black', async () => {
    const terminal = await createIsolatedTerminal({ cols: 20, rows: 2, theme: INITIAL_THEME });
    const container = document.createElement('div');
    containers.push(container);
    document.body.appendChild(container);
    terminal.setRenderPaused(true);
    terminal.open(container);

    try {
      const colors = terminal.wasmTerm!.getColors();
      expect(colors.foreground).toEqual(packedToRgb(0x102030));
      expect(colors.background).toEqual(packedToRgb(0x000000));
      expect(colors.cursor).toEqual(packedToRgb(0x405060));
      expect(colors.palette).toEqual(INITIAL_ANSI.map(packedToRgb));

      const sgrCells = INITIAL_ANSI.map((_, index) => {
        const code = index < 8 ? 30 + index : 90 + index - 8;
        return `\x1b[${code}m${String.fromCharCode(65 + index)}`;
      }).join('');
      terminal.write(`${sgrCells}\x1b[0m`);
      const line = terminal.wasmTerm!.getLine(0)!;
      for (let index = 0; index < 16; index++) {
        expect({ r: line[index].fg_r, g: line[index].fg_g, b: line[index].fg_b }).toEqual(
          packedToRgb(INITIAL_ANSI[index])
        );
      }
    } finally {
      terminal.dispose();
    }
  });

  test('preserves identity, contents, and app overrides until reset, then paints the latest base', async () => {
    const frames = installAnimationFrameHarness();
    const terminal = await createIsolatedTerminal({ cols: 30, rows: 2, theme: INITIAL_THEME });
    const container = document.createElement('div');
    containers.push(container);
    document.body.appendChild(container);
    terminal.setRenderPaused(true);

    try {
      terminal.open(container);
      const native = terminal.wasmTerm!;
      const renderer = terminal.renderer!;
      const canvas = renderer.getCanvas();
      terminal.write('retained');
      const retained = native
        .getLine(0)!
        .slice(0, 8)
        .map((cell) => cell.codepoint);

      const override =
        '\x1b]10;#a1a2a3\x07' +
        '\x1b]11;#b1b2b3\x07' +
        '\x1b]12;#c1c2c3\x07' +
        `\x1b]4;${OVERRIDE_ANSI.map((value, index) => `${index};${hex(value)}`).join(';')}\x07`;
      terminal.write(override);
      expect(native.getColors()).toMatchObject({
        foreground: packedToRgb(0xa1a2a3),
        background: packedToRgb(0xb1b2b3),
        cursor: packedToRgb(0xc1c2c3),
      });
      expect(native.getColors().palette).toEqual(OVERRIDE_ANSI.map(packedToRgb));

      terminal.options.theme = LATEST_THEME;
      expect(terminal.wasmTerm).toBe(native);
      expect(terminal.renderer).toBe(renderer);
      expect(renderer.getCanvas()).toBe(canvas);
      expect(
        native
          .getLine(0)!
          .slice(0, 8)
          .map((cell) => cell.codepoint)
      ).toEqual(retained);
      expect(native.getColors()).toMatchObject({
        foreground: packedToRgb(0xa1a2a3),
        background: packedToRgb(0xb1b2b3),
        cursor: packedToRgb(0xc1c2c3),
      });
      expect(native.getColors().palette).toEqual(OVERRIDE_ANSI.map(packedToRgb));

      terminal.write('\x1b]110\x07\x1b]111\x07\x1b]112\x07\x1b]104\x07');
      expect(native.getColors()).toEqual({
        foreground: packedToRgb(parsePaletteColor(LATEST_THEME.foreground!)),
        background: packedToRgb(parsePaletteColor(LATEST_THEME.background!)),
        cursor: packedToRgb(parsePaletteColor(LATEST_THEME.cursor!)),
        palette: LATEST_ANSI.map(packedToRgb),
      });

      expect(terminal.getRenderStats()).toMatchObject({
        parsedWrites: 3,
        renderFrames: 0,
        paused: true,
        pendingFrame: false,
      });
      expect(frames.callbacks.size).toBe(0);

      terminal.select(0, 0, 1);
      const context = (renderer as unknown as { ctx: CanvasRenderingContext2D }).ctx;
      const fillRects: string[] = [];
      const fillTexts: string[] = [];
      const originalFillRect = context.fillRect;
      const originalFillText = context.fillText;
      context.fillRect = ((...args: Parameters<CanvasRenderingContext2D['fillRect']>) => {
        fillRects.push(String(context.fillStyle));
        originalFillRect.apply(context, args);
      }) as CanvasRenderingContext2D['fillRect'];
      context.fillText = ((...args: Parameters<CanvasRenderingContext2D['fillText']>) => {
        fillTexts.push(String(context.fillStyle));
        originalFillText.apply(context, args);
      }) as CanvasRenderingContext2D['fillText'];

      terminal.setRenderPaused(false);
      expect(frames.callbacks.size).toBe(1);
      frames.runNext();

      const normalized = normalizeTheme(LATEST_THEME);
      expect(terminal.getRenderStats()).toMatchObject({
        renderFrames: 1,
        fullRenderFrames: 1,
        paused: false,
        pendingFrame: false,
      });
      expect(fillRects).toContain('rgb(49, 66, 83)');
      expect(fillRects).toContain('rgb(65, 82, 99)');
      expect(fillRects).toContain(normalized.selectionBackground);
      expect(fillTexts).toContain(normalized.selectionForeground);
      expect(fillTexts).toContain(normalized.cursorAccent);
    } finally {
      terminal.dispose();
      frames.restore();
    }
  });

  test('rejects invalid candidates and native setter failures atomically', async () => {
    const terminal = await createIsolatedTerminal({ cols: 10, rows: 2, theme: INITIAL_THEME });
    const container = document.createElement('div');
    containers.push(container);
    terminal.setRenderPaused(true);
    terminal.open(container);

    try {
      const native = terminal.wasmTerm!;
      const renderer = terminal.renderer!;
      const previousTheme = terminal.options.theme;
      const previousRendererTheme = (renderer as unknown as { theme: Required<ITheme> }).theme;
      const previousColors = native.getColors();

      expect(() => {
        terminal.options.theme = { red: 'tomato' };
      }).toThrow(TypeError);
      expect(terminal.options.theme).toBe(previousTheme);
      expect((renderer as unknown as { theme: Required<ITheme> }).theme).toBe(
        previousRendererTheme
      );
      expect(native.getColors()).toEqual(previousColors);

      const originalSetter = native.setColorConfig;
      native.setColorConfig = () => false;
      try {
        expect(() => {
          terminal.options.theme = LATEST_THEME;
        }).toThrow('Failed to apply terminal palette');
      } finally {
        native.setColorConfig = originalSetter;
      }
      expect(terminal.options.theme).toBe(previousTheme);
      expect((renderer as unknown as { theme: Required<ITheme> }).theme).toBe(
        previousRendererTheme
      );
      expect(native.getColors()).toEqual(previousColors);
    } finally {
      terminal.dispose();
    }
  });

  test('disposal releases the native palette owner and cannot schedule a reveal paint', async () => {
    const frames = installAnimationFrameHarness();
    const terminal = await createIsolatedTerminal({ theme: INITIAL_THEME });
    const container = document.createElement('div');
    containers.push(container);
    terminal.setRenderPaused(true);

    try {
      terminal.open(container);
      const native = terminal.wasmTerm!;
      terminal.write('\x1b]10;#abcdef\x07');
      expect(native.getColors().foreground).toEqual(packedToRgb(0xabcdef));

      terminal.dispose();
      terminal.setRenderPaused(false);
      terminal.requestRender(true);

      expect(native.setColorConfig({ fgColor: 0x010203 })).toBe(false);
      expect(frames.callbacks.size).toBe(0);
      expect(terminal.getRenderStats()).toMatchObject({ renderFrames: 0, pendingFrame: false });
    } finally {
      terminal.dispose();
      frames.restore();
    }
  });
});
