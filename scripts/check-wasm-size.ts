import { stat } from 'node:fs/promises';

// Keep a small, explicit growth budget for native APIs while retaining a hard
// ceiling that catches accidental debug or dependency bloat.
const MAX_WASM_KIB = 520;
const MAX_WASM_BYTES = MAX_WASM_KIB * 1024;

async function main(): Promise<void> {
  const wasmPath = process.argv[2] ?? 'ghostty-vt.wasm';
  const { size } = await stat(wasmPath);

  console.log(`WASM size: ${size} bytes`);
  if (size > MAX_WASM_BYTES) {
    throw new Error(`WASM exceeds the ${MAX_WASM_KIB} KiB limit (${MAX_WASM_BYTES} bytes).`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
