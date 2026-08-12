import { afterEach, describe, expect, test } from 'bun:test';
import { createIsolatedTerminal } from './test-helpers';
import type { ILinkProvider } from './types';

interface AnimationFrameHarness {
  runAll(): void;
  restore(): void;
}

function installAnimationFrameHarness(): AnimationFrameHarness {
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  const originalDateNow = Date.now;
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  let now = originalDateNow();

  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    const id = nextFrame++;
    callbacks.set(id, callback);
    return id;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) =>
    callbacks.delete(id)) as typeof cancelAnimationFrame;
  Date.now = () => now;

  return {
    runAll: () => {
      let count = 0;
      while (callbacks.size > 0) {
        if (count++ > 100) throw new Error('Accessibility test exceeded frame limit');
        const [id, callback] = callbacks.entries().next().value!;
        callbacks.delete(id);
        now += 16;
        callback(now);
      }
    },
    restore: () => {
      globalThis.requestAnimationFrame = originalRequest;
      globalThis.cancelAnimationFrame = originalCancel;
      Date.now = originalDateNow;
    },
  };
}

async function settleLinks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function rows(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[data-ghostty-accessibility-row]')];
}

function plainRowText(row: HTMLElement): string {
  const clone = row.cloneNode(true) as HTMLElement;
  for (const marker of clone.querySelectorAll('[data-ghostty-accessibility-marker]')) {
    marker.remove();
  }
  return clone.textContent?.replace(/\u00a0/g, '') ?? '';
}

describe('screen-reader viewport model', () => {
  const hosts: HTMLElement[] = [];
  const frames: AnimationFrameHarness[] = [];

  afterEach(() => {
    for (const frame of frames.splice(0)) frame.restore();
    for (const host of hosts.splice(0)) host.remove();
  });

  async function openTerminal(options: { cols?: number; rows?: number } = {}) {
    const frame = installAnimationFrameHarness();
    frames.push(frame);
    const host = document.createElement('div');
    document.body.appendChild(host);
    hosts.push(host);
    const terminal = await createIsolatedTerminal({
      cols: options.cols ?? 12,
      rows: options.rows ?? 4,
      focusOnOpen: false,
      smoothScrollDuration: 0,
    });
    terminal.open(host);
    frame.runAll();
    await settleLinks();
    return { terminal, host, frame };
  }

  test('associates one canonical input with a bounded persistent row list', async () => {
    const { terminal, host } = await openTerminal({ rows: 3 });
    try {
      const input = terminal.textarea!;
      const rowList = host.querySelector<HTMLElement>('[data-ghostty-accessibility-rows]')!;
      const cursorContext = host.querySelector<HTMLElement>('[data-ghostty-accessibility-cursor]')!;
      const selectionContext = host.querySelector<HTMLElement>(
        '[data-ghostty-accessibility-selection]'
      )!;

      expect(host.querySelector('canvas')?.getAttribute('aria-hidden')).toBe('true');
      expect(rowList.getAttribute('role')).toBe('list');
      expect(rows(host)).toHaveLength(3);
      expect(rows(host).every((row) => row.getAttribute('role') === 'listitem')).toBe(true);
      expect(rows(host).every((row) => row.tabIndex === -1)).toBe(true);
      expect(input.getAttribute('aria-controls')?.split(/\s+/)).toContain(rowList.id);
      expect(input.getAttribute('aria-describedby')?.split(/\s+/)).toEqual(
        expect.arrayContaining([cursorContext.id, selectionContext.id])
      );
      expect(host.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
      expect(host.querySelector('[tabindex="0"]')).toBe(input);
    } finally {
      terminal.dispose();
    }

    expect(host.querySelector('[data-ghostty-accessibility]')).toBeNull();
  });

  test('extracts graphemes and wide cells while preserving unchanged row children', async () => {
    const { terminal, host, frame } = await openTerminal({ cols: 16, rows: 5 });
    try {
      const initialRows = rows(host);
      const untouchedChild = initialRows[4].firstChild;

      terminal.write(`\x1b[?25hA🙂e\u0301`);
      frame.runAll();
      await settleLinks();

      const updatedRows = rows(host);
      expect(updatedRows).toEqual(initialRows);
      expect(plainRowText(updatedRows[0])).toBe(`A🙂e\u0301`);
      expect(updatedRows[4].firstChild).toBe(untouchedChild);
      expect(updatedRows[0].textContent?.length).toBeLessThan(30);

      // Column 2 is the continuation cell of the width-2 emoji. The accessible
      // selection boundaries normalize to the authoritative head cell.
      terminal.select(2, 0, 1);
      frame.runAll();
      const markers = [
        ...updatedRows[0].querySelectorAll<HTMLElement>('[data-ghostty-accessibility-marker]'),
      ];
      expect(markers.map((marker) => marker.dataset.ghosttyAccessibilityMarker)).toEqual(
        expect.arrayContaining(['selection-start', 'selection-end', 'cursor'])
      );
      expect(host.querySelector('[data-ghostty-accessibility-selection]')?.textContent).toContain(
        'Selection from row 1, column 3'
      );
    } finally {
      terminal.dispose();
    }
  });

  test('keeps physical row nodes bounded across scroll, resize, alternate screen, and reset', async () => {
    const { terminal, host, frame } = await openTerminal({ cols: 10, rows: 3 });
    try {
      terminal.write('normal\r\nline2\r\nline3\r\nline4');
      frame.runAll();
      const physicalRows = rows(host);
      const bottomPosition = physicalRows[0].getAttribute('aria-posinset');

      terminal.scrollLines(-1);
      frame.runAll();
      expect(rows(host)).toEqual(physicalRows);
      expect(rows(host)[0].getAttribute('aria-posinset')).not.toBe(bottomPosition);

      terminal.scrollToBottom();
      frame.runAll();
      terminal.write('\x1b[?1049hALT');
      frame.runAll();
      expect(rows(host).some((row) => plainRowText(row).includes('ALT'))).toBe(true);
      expect(host.querySelector('[data-ghostty-accessibility-live]')?.textContent).toContain(
        'Alternate screen'
      );

      terminal.write('\x1b[?1049l');
      frame.runAll();
      expect(rows(host)).toEqual(physicalRows);
      expect(rows(host).some((row) => plainRowText(row).includes('line4'))).toBe(true);

      terminal.write('\x1b[?1049hTRANSIENT\x1b[?1049l');
      frame.runAll();
      expect(rows(host)).toEqual(physicalRows);
      expect(rows(host).some((row) => plainRowText(row).includes('TRANSIENT'))).toBe(false);

      terminal.resize(10, 5);
      frame.runAll();
      expect(rows(host)).toHaveLength(5);
      terminal.resize(10, 2);
      frame.runAll();
      expect(rows(host)).toHaveLength(2);

      terminal.reset();
      frame.runAll();
      expect(rows(host).every((row) => plainRowText(row) === '')).toBe(true);
    } finally {
      terminal.dispose();
    }
  });

  test('follows presentation pause and resumes with one current viewport', async () => {
    const { terminal, host, frame } = await openTerminal({ rows: 3 });
    try {
      terminal.write('before');
      frame.runAll();
      expect(plainRowText(rows(host)[0])).toBe('before');

      terminal.setRenderPaused(true);
      terminal.write('\rhidden');
      frame.runAll();
      expect(plainRowText(rows(host)[0])).toBe('before');

      terminal.setRenderPaused(false);
      frame.runAll();
      expect(plainRowText(rows(host)[0])).toBe('hidden');
    } finally {
      terminal.dispose();
    }
  });

  test('exposes safe links outside sequential tab order and activates keyboard clicks', async () => {
    const activations: string[] = [];
    const frame = installAnimationFrameHarness();
    frames.push(frame);
    const host = document.createElement('div');
    document.body.appendChild(host);
    hosts.push(host);
    const terminal = await createIsolatedTerminal({
      cols: 30,
      rows: 2,
      focusOnOpen: false,
      linkHandler: {
        activate: (_event, text) => activations.push(text),
      },
    });
    terminal.open(host);
    terminal.write('https://example.com');
    terminal.write('\r');
    frame.runAll();
    await settleLinks();

    try {
      const link = host.querySelector<HTMLElement>('[data-ghostty-accessibility-link]')!;
      expect(link).not.toBeNull();
      expect(link.getAttribute('role')).toBe('link');
      expect(link.getAttribute('aria-label')).toBe('https://example.com');
      expect(link.textContent).toContain('Cursor');
      expect(link.tabIndex).toBe(-1);
      expect(host.querySelectorAll('[tabindex="0"]')).toHaveLength(1);

      link.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(activations).toEqual(['https://example.com']);
    } finally {
      terminal.dispose();
    }
  });

  test('rejects stale asynchronous link rows after content changes and disposal', async () => {
    const callbacks: Array<Parameters<ILinkProvider['provideLinks']>[1]> = [];
    const provider: ILinkProvider = {
      provideLinks: (row, callback) => {
        if (row === 0) callbacks.push(callback);
        else callback(undefined);
      },
    };
    const { terminal, host, frame } = await openTerminal({ cols: 12, rows: 2 });
    terminal.registerLinkProvider(provider);

    terminal.write('old');
    frame.runAll();
    expect(callbacks).toHaveLength(1);

    terminal.write('\rnew');
    frame.runAll();
    expect(callbacks).toHaveLength(2);

    callbacks[0]([
      {
        text: 'stale',
        range: { start: { x: 0, y: 0 }, end: { x: 2, y: 0 } },
        activate: () => {},
      },
    ]);
    callbacks[1](undefined);
    await settleLinks();
    expect(host.querySelector('[data-ghostty-accessibility-link="stale"]')).toBeNull();

    terminal.write('\rfresh');
    frame.runAll();
    expect(callbacks).toHaveLength(3);
    terminal.dispose();
    callbacks[2]([
      {
        text: 'late',
        range: { start: { x: 0, y: 0 }, end: { x: 4, y: 0 } },
        activate: () => {},
      },
    ]);
    await settleLinks();
    expect(host.querySelector('[data-ghostty-accessibility]')).toBeNull();
  });

  test('refreshes links for provider generations without rescanning unchanged frames', async () => {
    const { terminal, host, frame } = await openTerminal({ cols: 12, rows: 2 });
    try {
      terminal.write('ticket');
      frame.runAll();

      const calls: number[] = [];
      terminal.registerLinkProvider({
        provideLinks: (row, callback) => {
          calls.push(row);
          callback(
            row === 0
              ? [
                  {
                    text: 'ticket',
                    range: { start: { x: 0, y: 0 }, end: { x: 5, y: 0 } },
                    activate: () => {},
                  },
                ]
              : undefined
          );
        },
      });
      frame.runAll();
      await settleLinks();

      expect(host.querySelector('[data-ghostty-accessibility-link="ticket"]')).not.toBeNull();
      const callsAfterRegistration = calls.length;
      expect(callsAfterRegistration).toBe(2);

      terminal.requestRender(true);
      frame.runAll();
      await settleLinks();
      expect(calls).toHaveLength(callsAfterRegistration);
    } finally {
      terminal.dispose();
    }
  });

  test('batches completed normal output and does not live-announce cursor-only edits', async () => {
    const { terminal, host, frame } = await openTerminal({ cols: 12, rows: 3 });
    try {
      const live = host.querySelector<HTMLElement>('[data-ghostty-accessibility-live]')!;
      terminal.write('ready');
      frame.runAll();
      expect(live.textContent).toBe('');

      terminal.write('\r\nnext');
      frame.runAll();
      expect(live.textContent).toContain('ready');
      const completed = live.firstChild;

      terminal.write('\x1b[D');
      frame.runAll();
      expect(live.firstChild).toBe(completed);
    } finally {
      terminal.dispose();
    }
  });

  test('does not announce existing lines when the cursor moves up then back down', async () => {
    const { terminal, host, frame } = await openTerminal({ cols: 12, rows: 3 });
    try {
      const live = host.querySelector<HTMLElement>('[data-ghostty-accessibility-live]')!;
      terminal.write('first\r\nsecond');
      frame.runAll();
      const announcement = live.firstChild;

      terminal.write('\x1b[A');
      frame.runAll();
      expect(live.firstChild).toBe(announcement);

      terminal.write('\x1b[B');
      frame.runAll();
      expect(live.firstChild).toBe(announcement);
    } finally {
      terminal.dispose();
    }
  });

  test('bounds selection context and marks viewport continuation', async () => {
    const { terminal, host, frame } = await openTerminal({ cols: 8, rows: 3 });
    try {
      terminal.write('value\r\n'.repeat(30));
      frame.runAll();
      terminal.selectLines(0, terminal.buffer.active.length - 1);
      frame.runAll();

      const context = host.querySelector<HTMLElement>('[data-ghostty-accessibility-selection]')!;
      expect(context.textContent!.length).toBeLessThan(700);
      expect(
        rows(host)[0].querySelector(
          '[data-ghostty-accessibility-marker="selection-continues-above"]'
        )
      ).not.toBeNull();
    } finally {
      terminal.dispose();
    }
  });
});
