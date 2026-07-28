const UNSAFE_PASTE_CODE_UNITS = new Set([
  0x00, // NUL
  0x03, // VINTR (Ctrl+C)
  0x04, // EOT
  0x05, // ENQ
  0x08, // BS
  0x0f, // VDISCARD (Ctrl+O)
  0x11, // VSTART (Ctrl+Q)
  0x12, // VREPRINT (Ctrl+R)
  0x13, // VSTOP (Ctrl+S)
  0x15, // VKILL (Ctrl+U)
  0x16, // VLNEXT (Ctrl+V)
  0x17, // VWERASE (Ctrl+W)
  0x1a, // VSUSP (Ctrl+Z)
  0x1b, // ESC
  0x1c, // VQUIT (Ctrl+\)
  0x7f, // DEL
]);

/**
 * Replace control characters that can execute terminal actions when pasted.
 *
 * This mirrors Ghostty and xterm behavior regardless of bracketed-paste mode.
 * Newlines, carriage returns, and tabs remain valid paste content.
 */
export function sanitizePasteText(text: string): string {
  let sanitized = '';

  for (const character of text) {
    sanitized += UNSAFE_PASTE_CODE_UNITS.has(character.charCodeAt(0)) ? ' ' : character;
  }

  return sanitized;
}

export function encodePaste(text: string, bracketed: boolean): string {
  const sanitized = sanitizePasteText(text);
  return bracketed ? `\x1b[200~${sanitized}\x1b[201~` : sanitized;
}
