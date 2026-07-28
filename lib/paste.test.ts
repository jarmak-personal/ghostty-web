import { describe, expect, test } from 'bun:test';
import { encodePaste, sanitizePasteText } from './paste';

describe('paste encoding', () => {
  test('replaces every unsafe control character with a space', () => {
    const unsafe = String.fromCharCode(
      0x00,
      0x03,
      0x04,
      0x05,
      0x08,
      0x0f,
      0x11,
      0x12,
      0x13,
      0x15,
      0x16,
      0x17,
      0x1a,
      0x1b,
      0x1c,
      0x7f
    );

    expect(sanitizePasteText(unsafe)).toBe(' '.repeat(16));
  });

  test('preserves tabs and line endings', () => {
    expect(sanitizePasteText('one\ttwo\nthree\rfour')).toBe('one\ttwo\nthree\rfour');
  });

  test('sanitizes before adding bracketed-paste markers', () => {
    expect(encodePaste('echo safe\x03malicious\x1b[201~', true)).toBe(
      '\x1b[200~echo safe malicious [201~\x1b[201~'
    );
  });
});
