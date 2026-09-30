import { afterEach, expect, test } from 'bun:test';
import type { Terminal } from '../terminal';
import { createIsolatedTerminal } from '../test-helpers';
import { FitAddon } from './fit';

const terminals: Terminal[] = [];
const hosts: HTMLElement[] = [];
afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
  for (const host of hosts.splice(0)) host.remove();
});

test('terminal font changes refit through the addon and defer hidden grid changes', async () => {
  const terminal = await createIsolatedTerminal({ cols: 80, rows: 24 });
  terminals.push(terminal);
  const host = document.createElement('div');
  hosts.push(host);
  document.body.append(host);
  Object.defineProperties(host, {
    clientWidth: { configurable: true, value: 800 },
    clientHeight: { configurable: true, value: 400 },
  });
  const addon = new FitAddon({ resizeDebounceMs: 0 });
  terminal.loadAddon(addon);
  terminal.open(host);
  await new Promise<void>((resolve) => addon.resume(resolve));
  const sizes: { cols: number; rows: number }[] = [];
  terminal.onResize((size) => sizes.push(size));
  await new Promise<void>((resolve) => {
    addon.resume(resolve);
    terminal.options.fontSize = 24;
  });
  expect(terminal.rows).toBe(Math.floor(400 / terminal.renderer!.getMetrics().height));
  expect(sizes).toHaveLength(1);
  const hiddenGrid = { cols: terminal.cols, rows: terminal.rows };
  addon.suspend();
  terminal.options.fontSize = 30;
  terminal.write('parsed while hidden');
  expect({ cols: terminal.cols, rows: terminal.rows }).toEqual(hiddenGrid);
  expect(terminal.buffer.active.getLine(0)?.translateToString()).toContain('parsed while hidden');
  await new Promise<void>((resolve) => addon.resume(resolve));
  expect(terminal.rows).toBe(Math.floor(400 / terminal.renderer!.getMetrics().height));
  expect(sizes).toHaveLength(2);
});
