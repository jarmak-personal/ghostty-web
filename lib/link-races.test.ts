import { afterEach, describe, expect, test } from 'bun:test';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';
import type { ILink, ILinkProvider } from './types';

const terminals: Terminal[] = [];
const containers: HTMLElement[] = [];

async function openTerminal(): Promise<Terminal> {
  const terminal = await createIsolatedTerminal({ cols: 20, rows: 4 });
  const container = document.createElement('div');
  document.body.appendChild(container);
  terminal.open(container);
  terminals.push(terminal);
  containers.push(container);
  return terminal;
}

function deferredProvider(): ILinkProvider & {
  requests: Array<{ row: number; resolve(links: ILink[] | undefined): void }>;
  disposals: number;
} {
  const provider = {
    requests: [] as Array<{ row: number; resolve(links: ILink[] | undefined): void }>,
    disposals: 0,
    provideLinks(row: number, callback: (links: ILink[] | undefined) => void) {
      provider.requests.push({ row, resolve: callback });
    },
    dispose() {
      provider.disposals++;
    },
  };
  return provider;
}

function linkAt(row: number, text: string, hoverEvents: boolean[], activate = () => {}): ILink {
  return {
    text,
    range: { start: { x: 0, y: row }, end: { x: 3, y: row } },
    hover: (hovered) => hoverEvents.push(hovered),
    activate,
  };
}

function mouseAt(terminal: Terminal, col: number, row: number): MouseEvent {
  const renderer = terminal.renderer as unknown as { charWidth: number; charHeight: number };
  return new MouseEvent('mousemove', {
    bubbles: true,
    clientX: (col + 0.5) * renderer.charWidth,
    clientY: (row + 0.5) * renderer.charHeight,
  });
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
  for (const container of containers.splice(0)) container.remove();
});

describe('Terminal asynchronous link results', () => {
  test('does not restore a hover or cache entry after a write', async () => {
    const terminal = await openTerminal();
    const provider = deferredProvider();
    const hoverEvents: boolean[] = [];
    terminal.registerLinkProvider(provider);

    (terminal as unknown as { processMouseMove(event: MouseEvent): void }).processMouseMove(
      mouseAt(terminal, 1, 0)
    );
    expect(provider.requests).toHaveLength(1);
    const staleRequest = provider.requests[0];

    terminal.write('new content');
    staleRequest.resolve([linkAt(0, 'stale', hoverEvents)]);
    await flushAsyncWork();

    expect(hoverEvents).toEqual([]);
    expect(
      (terminal as unknown as { currentHoveredLink?: ILink }).currentHoveredLink
    ).toBeUndefined();
    expect(terminal.element?.style.cursor).toBe('text');
    const detector = (terminal as unknown as { linkDetector: { linkCache: Map<string, ILink> } })
      .linkDetector;
    expect(detector.linkCache.size).toBe(0);
  });

  test('revokes the first hover as soon as the pointer moves while throttled', async () => {
    const terminal = await openTerminal();
    const provider = deferredProvider();
    const firstHover: boolean[] = [];
    const secondHover: boolean[] = [];
    terminal.registerLinkProvider(provider);

    const handleMouseMove = (terminal as unknown as { handleMouseMove(event: MouseEvent): void })
      .handleMouseMove;
    handleMouseMove(mouseAt(terminal, 1, 0));
    handleMouseMove(mouseAt(terminal, 1, 1));
    expect(provider.requests).toHaveLength(1);

    provider.requests[0].resolve([linkAt(0, 'first', firstHover)]);
    await Promise.resolve();
    await Promise.resolve();
    expect(firstHover).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    // The bounded accessibility viewport may enumerate other visible rows in
    // the same presented frame. The detector still coalesces its row-1 scan
    // with the pointer request, so only that row is relevant to this race.
    const rowOneRequests = provider.requests.filter((request) => request.row === 1);
    expect(rowOneRequests).toHaveLength(1);
    const second = linkAt(1, 'second', secondHover);
    rowOneRequests[0].resolve([second]);
    await flushAsyncWork();

    expect(secondHover).toEqual([true]);
    expect((terminal as unknown as { currentHoveredLink?: ILink }).currentHoveredLink).toBe(second);
  });

  test('rejects a hover when scrolling remaps its viewport coordinate', async () => {
    const terminal = await openTerminal();
    for (let row = 0; row < 8; row++) terminal.writeln(`line-${row}`);
    const provider = deferredProvider();
    const hoverEvents: boolean[] = [];
    terminal.registerLinkProvider(provider);

    (terminal as unknown as { processMouseMove(event: MouseEvent): void }).processMouseMove(
      mouseAt(terminal, 1, 0)
    );
    expect(provider.requests).toHaveLength(1);
    const originalBufferRow = provider.requests[0].row;

    terminal.scrollToTop();
    expect(terminal.getViewportY()).toBeGreaterThan(0);
    provider.requests[0].resolve([linkAt(originalBufferRow, 'remapped', hoverEvents)]);
    await flushAsyncWork();

    expect(hoverEvents).toEqual([]);
    expect(
      (terminal as unknown as { currentHoveredLink?: ILink }).currentHoveredLink
    ).toBeUndefined();
    expect(terminal.element?.style.cursor).toBe('text');
  });

  test('does not activate a deferred link after its content changes', async () => {
    const terminal = await openTerminal();
    const provider = deferredProvider();
    let activations = 0;
    terminal.registerLinkProvider(provider);

    const event = mouseAt(terminal, 1, 0);
    const click = (
      terminal as unknown as { handleClick(event: MouseEvent): Promise<void> }
    ).handleClick(event);
    expect(provider.requests).toHaveLength(1);

    terminal.write('replacement');
    expect(await click).toBeUndefined();
    provider.requests[0].resolve([linkAt(0, 'stale', [], () => activations++)]);
    await flushAsyncWork();
    expect(activations).toBe(0);
  });

  test('ignores a provider callback after terminal disposal', async () => {
    const terminal = await openTerminal();
    const provider = deferredProvider();
    const hoverEvents: boolean[] = [];
    terminal.registerLinkProvider(provider);

    (terminal as unknown as { processMouseMove(event: MouseEvent): void }).processMouseMove(
      mouseAt(terminal, 1, 0)
    );
    expect(provider.requests).toHaveLength(1);

    terminal.dispose();
    provider.requests[0].resolve([linkAt(0, 'stale', hoverEvents)]);
    await flushAsyncWork();

    expect(provider.disposals).toBe(1);
    expect(hoverEvents).toEqual([]);
    expect(
      (terminal as unknown as { currentHoveredLink?: ILink }).currentHoveredLink
    ).toBeUndefined();
  });
});
