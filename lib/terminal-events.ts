import type {
  RGB,
  TerminalEvent,
  TerminalNotificationSource,
  TerminalPaletteRequest,
  TerminalPaletteTarget,
  TerminalProgressState,
  TerminalSemanticAction,
} from './types';

export const TERMINAL_EVENT_HEADER_SIZE = 36;
export const MAX_TERMINAL_EVENT_BYTES = 64 * 1024;

const semanticActions: readonly TerminalSemanticAction[] = [
  'fresh-line',
  'fresh-line-new-prompt',
  'new-command',
  'prompt-start',
  'end-prompt-start-input',
  'end-prompt-start-input-terminate-eol',
  'end-input-start-output',
  'end-command',
];

const progressStates: readonly TerminalProgressState[] = [
  'remove',
  'set',
  'error',
  'indeterminate',
  'pause',
];

const notificationSources: readonly TerminalNotificationSource[] = ['osc-9', 'osc-777'];

const specialColorNames = ['bold', 'underline', 'blink', 'reverse', 'italic'] as const;
const dynamicColorNames = new Map<number, TerminalPaletteTarget & { kind: 'dynamic' }>([
  [10, { kind: 'dynamic', name: 'foreground' }],
  [11, { kind: 'dynamic', name: 'background' }],
  [12, { kind: 'dynamic', name: 'cursor' }],
  [13, { kind: 'dynamic', name: 'pointer-foreground' }],
  [14, { kind: 'dynamic', name: 'pointer-background' }],
  [15, { kind: 'dynamic', name: 'tektronix-foreground' }],
  [16, { kind: 'dynamic', name: 'tektronix-background' }],
  [17, { kind: 'dynamic', name: 'highlight-background' }],
  [18, { kind: 'dynamic', name: 'tektronix-cursor' }],
  [19, { kind: 'dynamic', name: 'highlight-foreground' }],
]);

function paletteTarget(kind: number, value: number): TerminalPaletteTarget | null {
  if (kind === 1 && value >= 0 && value <= 255) return { kind: 'palette', index: value };
  if (kind === 2 && value >= 0 && value < specialColorNames.length) {
    return { kind: 'special', name: specialColorNames[value] };
  }
  if (kind === 3) return dynamicColorNames.get(value) ?? null;
  return null;
}

function paletteRequest(
  action: number,
  targetKind: number,
  targetValue: number,
  colorValue: number
): TerminalPaletteRequest | null {
  if (action === 3) return { type: 'reset-palette' };
  if (action === 4) return { type: 'reset-special' };

  const target = paletteTarget(targetKind, targetValue);
  if (!target) return null;
  if (action === 0) {
    const color: RGB = {
      r: (colorValue >>> 16) & 0xff,
      g: (colorValue >>> 8) & 0xff,
      b: colorValue & 0xff,
    };
    return { type: 'set', target, color };
  }
  if (action === 1) return { type: 'query', target };
  if (action === 2) return { type: 'reset', target };
  return null;
}

/** Decode one internal WASM record into the public typed event surface. */
export function decodeTerminalEventRecord(record: Uint8Array): TerminalEvent | null {
  if (
    record.byteLength < TERMINAL_EVENT_HEADER_SIZE ||
    record.byteLength > MAX_TERMINAL_EVENT_BYTES
  ) {
    return null;
  }

  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  if (view.getUint8(0) !== 1) return null;

  const tag = view.getUint8(1);
  const action = view.getUint8(2);
  const flags = view.getUint8(3);
  const row = view.getUint32(4, true);
  const provenanceId = view.getUint32(8, true);
  const column = view.getUint32(12, true);
  const value = view.getInt32(16, true);
  const target = view.getInt32(20, true);
  const colorValue = view.getUint32(24, true);
  const dataALength = view.getUint32(28, true);
  const dataBLength = view.getUint32(32, true);
  if (TERMINAL_EVENT_HEADER_SIZE + dataALength + dataBLength !== record.byteLength) return null;

  const decoder = new TextDecoder();
  const dataAStart = TERMINAL_EVENT_HEADER_SIZE;
  const dataBStart = dataAStart + dataALength;
  const dataA = decoder.decode(record.subarray(dataAStart, dataBStart));
  const dataB = decoder.decode(record.subarray(dataBStart));

  switch (tag) {
    case 1:
      return { type: 'title', title: dataA };
    case 2:
      return { type: 'working-directory', uri: dataA };
    case 3:
      return { type: 'bell' };
    case 4: {
      const source = notificationSources[action];
      return source ? { type: 'notification', source, title: dataA, body: dataB } : null;
    }
    case 5: {
      const state = progressStates[action];
      if (!state || value < -1 || value > 100) return null;
      return value < 0 ? { type: 'progress', state } : { type: 'progress', state, progress: value };
    }
    case 6: {
      const semanticAction = semanticActions[action];
      if (!semanticAction || provenanceId === 0 || flags > 1) return null;
      return {
        type: 'semantic',
        action: semanticAction,
        options: dataA,
        provenance: Object.freeze({
          id: provenanceId,
          screen: flags === 1 ? 'alternate' : 'normal',
          row,
          column,
        }),
      };
    }
    case 7: {
      const request = paletteRequest(action, flags, target, colorValue);
      return request ? { type: 'palette', operation: value, request } : null;
    }
    case 8: {
      if (value < 0 || value > 255) return null;
      const selection = String.fromCharCode(value);
      if (action === 0) return { type: 'clipboard', operation: 'read', selection };
      if (action === 1) return { type: 'clipboard', operation: 'write', selection, data: dataA };
      return null;
    }
    default:
      return null;
  }
}
