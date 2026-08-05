import type { ITheme } from './interfaces';
import type { GhosttyTerminalConfig } from './types';

export const ANSI_THEME_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

export const DEFAULT_THEME: Required<ITheme> = Object.freeze({
  foreground: '#d4d4d4',
  background: '#1e1e1e',
  cursor: '#ffffff',
  cursorAccent: '#1e1e1e',
  selectionBackground: '#d4d4d4',
  selectionForeground: '#1e1e1e',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
});

const THEME_KEYS = Object.keys(DEFAULT_THEME) as (keyof ITheme)[];
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB_COLOR = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i;

/** Parse the bounded CSS color syntax supported by the native palette ABI. */
export function parsePaletteColor(value: string): number {
  if (HEX_COLOR.test(value)) {
    const hex = value.slice(1);
    const expanded =
      hex.length === 3 ? `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}` : hex;
    return Number.parseInt(expanded, 16);
  }

  const rgb = RGB_COLOR.exec(value);
  if (rgb) {
    const components = rgb.slice(1).map((component) => Number.parseInt(component, 10));
    if (components.every((component) => component <= 255)) {
      return (components[0] << 16) | (components[1] << 8) | components[2];
    }
  }

  throw new TypeError(`Unsupported terminal palette color: ${value}`);
}

function canonicalColor(value: string): string {
  return `#${parsePaletteColor(value).toString(16).padStart(6, '0')}`;
}

/** Validate a complete candidate first, then return one immutable base palette. */
export function normalizeTheme(theme: ITheme = {}): Required<ITheme> {
  const candidate = { ...DEFAULT_THEME, ...theme };
  const normalized = {} as Required<ITheme>;
  for (const key of THEME_KEYS) {
    const value = candidate[key];
    if (typeof value !== 'string') {
      throw new TypeError(`Terminal palette color ${key} must be a string`);
    }
    normalized[key] = canonicalColor(value);
  }
  return Object.freeze(normalized);
}

/** Serialize the Ghostty-owned portion of the validated bounded palette. */
export function themeToTerminalConfig(
  theme: Required<ITheme>,
  scrollbackLimit?: number
): GhosttyTerminalConfig {
  return {
    scrollbackLimit,
    fgColor: parsePaletteColor(theme.foreground),
    bgColor: parsePaletteColor(theme.background),
    cursorColor: parsePaletteColor(theme.cursor),
    palette: ANSI_THEME_KEYS.map((key) => parsePaletteColor(theme[key])),
  };
}
