import { FitAddon } from '../lib/addons/fit';
import { init, Terminal } from '../lib/index';

const container = document.getElementById('terminal-container');
const status = document.getElementById('status');

if (!container || !status) {
  throw new Error('CSP demo is missing its terminal elements.');
}

try {
  const wasmUrl = new URL('/ghostty-vt.wasm', window.location.origin);
  await init({ wasmUrl });

  const terminal = new Terminal({
    cols: 80,
    rows: 20,
    theme: { background: '#111827', foreground: '#e2e8f0' },
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  await terminal.open(container);
  fitAddon.fit();
  terminal.write('\x1b[1;32mExternal WASM loaded under strict CSP.\x1b[0m\r\n');
  terminal.write(`Loaded from ${wasmUrl}\r\n`);
  status.textContent = 'Ready — no data: URI or inline script was required.';

  window.addEventListener('resize', () => fitAddon.fit());
} catch (error) {
  status.textContent = error instanceof Error ? error.message : String(error);
  throw error;
}
