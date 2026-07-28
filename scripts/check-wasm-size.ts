import { stat } from 'node:fs/promises';

const MAX_WASM_BYTES = 512 * 1024;

async function main(): Promise<void> {
  const wasmPath = process.argv[2] ?? 'ghostty-vt.wasm';
  const { size } = await stat(wasmPath);

  console.log(`WASM size: ${size} bytes`);
  if (size > MAX_WASM_BYTES) {
    throw new Error(`WASM exceeds the 512 KiB limit (${MAX_WASM_BYTES} bytes).`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
