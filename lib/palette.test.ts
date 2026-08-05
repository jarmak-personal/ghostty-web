import { describe, expect, test } from 'bun:test';
import { ANSI_THEME_KEYS, DEFAULT_THEME, normalizeTheme, parsePaletteColor } from './palette';

describe('terminal palette validation', () => {
  test('normalizes every supported color before publishing a complete palette', () => {
    const theme = normalizeTheme({
      foreground: '#AbC',
      background: 'rgb(0, 1, 255)',
      black: '#000000',
    });

    expect(theme.foreground).toBe('#aabbcc');
    expect(theme.background).toBe('#0001ff');
    expect(theme.black).toBe('#000000');
    expect(Object.keys(theme)).toHaveLength(Object.keys(DEFAULT_THEME).length);
    expect(Object.isFrozen(theme)).toBe(true);
    expect(ANSI_THEME_KEYS).toHaveLength(16);
  });

  test('rejects unsupported or out-of-range colors instead of silently using black', () => {
    for (const color of ['red', '#12', '#gggggg', 'rgb(256, 0, 0)', 'rgba(1, 2, 3, 1)']) {
      expect(() => parsePaletteColor(color)).toThrow(TypeError);
    }

    expect(parsePaletteColor('#000000')).toBe(0);
  });
});
