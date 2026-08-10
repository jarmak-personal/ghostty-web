import { describe, expect, test } from 'bun:test';

import { KeyEncoder } from './ghostty';
import { type GhosttyWasmExports, Key, KeyAction, Mods } from './types';

interface FakeExportsOptions {
  encodeResult?: number;
  failOutputFree?: boolean;
  growDuringEncode?: boolean;
}

function createFakeExports(options: FakeExportsOptions = {}): {
  exports: GhosttyWasmExports;
  cleanups: string[];
} {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
  const cleanups: string[] = [];
  let opaqueAllocation = 0;
  let nextArrayPointer = 64;
  let outputBufferPointer: number | undefined;

  const fake = {
    memory,
    ghostty_wasm_alloc_opaque: () => (opaqueAllocation++ === 0 ? 8 : 16),
    ghostty_wasm_free_opaque: (ptr: number) => {
      cleanups.push(`opaque:${ptr}`);
    },
    ghostty_wasm_alloc_u8_array: (length: number) => {
      const ptr = nextArrayPointer;
      nextArrayPointer += Math.max(length, 64);
      return ptr;
    },
    ghostty_wasm_free_u8_array: (ptr: number, length: number) => {
      cleanups.push(`array:${ptr}:${length}`);
      if (options.failOutputFree && ptr === outputBufferPointer) {
        throw new Error('output cleanup failed');
      }
    },
    ghostty_wasm_alloc_usize: () => 256,
    ghostty_wasm_free_usize: (ptr: number) => {
      cleanups.push(`usize:${ptr}`);
    },
    ghostty_key_encoder_new: (_allocator: number, encoderPtrPtr: number) => {
      new DataView(memory.buffer).setUint32(encoderPtrPtr, 101, true);
      return 0;
    },
    ghostty_key_encoder_free: (encoder: number) => {
      cleanups.push(`encoder:${encoder}`);
    },
    ghostty_key_event_new: (_allocator: number, eventPtrPtr: number) => {
      new DataView(memory.buffer).setUint32(eventPtrPtr, 202, true);
      return 0;
    },
    ghostty_key_event_free: (event: number) => {
      cleanups.push(`event:${event}`);
    },
    ghostty_key_event_set_action: () => {},
    ghostty_key_event_set_key: () => {},
    ghostty_key_event_set_mods: () => {},
    ghostty_key_event_set_unshifted_codepoint: () => {},
    ghostty_key_event_set_utf8: () => {},
    ghostty_key_encoder_encode: (
      _encoder: number,
      _event: number,
      bufPtr: number,
      _bufLen: number,
      writtenPtr: number
    ) => {
      outputBufferPointer = bufPtr;
      if (options.growDuringEncode) memory.grow(1);
      if (options.encodeResult) return options.encodeResult;

      const bytes = Uint8Array.of(0x1b, 0x5b, 0x41);
      new Uint8Array(memory.buffer).set(bytes, bufPtr);
      new DataView(memory.buffer).setUint32(writtenPtr, bytes.length, true);
      return 0;
    },
  };

  return { exports: fake as unknown as GhosttyWasmExports, cleanups };
}

const keyEvent = {
  action: KeyAction.PRESS,
  key: Key.A,
  mods: Mods.NONE,
  utf8: 'a',
};

describe('KeyEncoder', () => {
  test('refreshes WASM views after encoding grows memory and frees every temporary', () => {
    const { exports, cleanups } = createFakeExports({ growDuringEncode: true });
    const encoder = new KeyEncoder(exports);

    try {
      expect(cleanups).toEqual(['opaque:8']);
      cleanups.length = 0;
      expect(encoder.encode(keyEvent)).toEqual(Uint8Array.of(0x1b, 0x5b, 0x41));
      expect(cleanups).toEqual([
        'usize:256',
        'array:128:32',
        'array:64:1',
        'event:202',
        'opaque:16',
      ]);
    } finally {
      encoder.dispose();
    }
  });

  test('preserves an encoding error while continuing cleanup after a free fails', () => {
    const { exports, cleanups } = createFakeExports({ encodeResult: 7, failOutputFree: true });
    const encoder = new KeyEncoder(exports);

    try {
      expect(cleanups).toEqual(['opaque:8']);
      cleanups.length = 0;
      expect(() => encoder.encode(keyEvent)).toThrow('Failed to encode key: 7');
      expect(cleanups).toEqual([
        'usize:256',
        'array:128:32',
        'array:64:1',
        'event:202',
        'opaque:16',
      ]);
    } finally {
      encoder.dispose();
    }
  });

  test('reports a cleanup failure after a successful encode and still frees the rest', () => {
    const { exports, cleanups } = createFakeExports({ failOutputFree: true });
    const encoder = new KeyEncoder(exports);

    try {
      expect(cleanups).toEqual(['opaque:8']);
      cleanups.length = 0;
      expect(() => encoder.encode(keyEvent)).toThrow('output cleanup failed');
      expect(cleanups).toEqual([
        'usize:256',
        'array:128:32',
        'array:64:1',
        'event:202',
        'opaque:16',
      ]);
    } finally {
      encoder.dispose();
    }
  });
});
