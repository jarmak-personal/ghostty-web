import { describe, expect, test } from 'bun:test';
import { type ITerminalForLinkDetector, LinkDetector } from './link-detector';
import type { ILink, ILinkProvider } from './types';

function terminalWithRows(rows: number = 4): ITerminalForLinkDetector {
  return {
    buffer: {
      active: {
        getLine(row) {
          if (row < 0 || row >= rows) return undefined;
          return {
            length: 80,
            getCell(col) {
              return col >= 0 && col < 80 ? { getHyperlinkId: () => 0 } : undefined;
            },
          };
        },
      },
    },
  };
}

function linkAt(row: number, text: string): ILink {
  return {
    text,
    range: { start: { x: 0, y: row }, end: { x: 3, y: row } },
    activate: () => {},
  };
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

describe('LinkDetector asynchronous scans', () => {
  test('deduplicates concurrent scans for the same row', async () => {
    const detector = new LinkDetector(terminalWithRows());
    const provider = deferredProvider();
    detector.registerProvider(provider);

    const first = detector.getLinkAt(1, 0);
    const second = detector.getLinkAt(2, 0);
    expect(provider.requests).toHaveLength(1);

    const link = linkAt(0, 'shared');
    provider.requests[0].resolve([link]);
    expect(await first).toBe(link);
    expect(await second).toBe(link);

    expect(await detector.getLinkAt(3, 0)).toBe(link);
    expect(provider.requests).toHaveLength(1);
  });

  test('revokes an in-flight scan on full cache invalidation without waiting for its provider', async () => {
    let invalidations = 0;
    const detector = new LinkDetector(terminalWithRows(), () => invalidations++);
    const provider = deferredProvider();
    detector.registerProvider(provider);

    const staleLookup = detector.getLinkAt(1, 0);
    const staleRequest = provider.requests[0];
    detector.invalidateCache();

    expect(await staleLookup).toBeUndefined();
    expect(invalidations).toBe(2);

    staleRequest.resolve([linkAt(0, 'stale')]);
    await Promise.resolve();
    expect((detector as unknown as { linkCache: Map<string, ILink> }).linkCache.size).toBe(0);

    const currentLookup = detector.getLinkAt(1, 0);
    expect(provider.requests).toHaveLength(2);
    const current = linkAt(0, 'current');
    provider.requests[1].resolve([current]);
    expect(await currentLookup).toBe(current);
  });

  test('revokes stale work when rows are invalidated', async () => {
    const detector = new LinkDetector(terminalWithRows());
    const provider = deferredProvider();
    detector.registerProvider(provider);

    const staleLookup = detector.getLinkAt(1, 2);
    const staleRequest = provider.requests[0];
    detector.invalidateRows(2, 2);

    expect(await staleLookup).toBeUndefined();
    staleRequest.resolve([linkAt(2, 'stale')]);
    await Promise.resolve();
    expect((detector as unknown as { linkCache: Map<string, ILink> }).linkCache.size).toBe(0);
  });

  test('revokes a scan after one provider resolves while a later provider is pending', async () => {
    const detector = new LinkDetector(terminalWithRows());
    const first = deferredProvider();
    const second = deferredProvider();
    detector.registerProvider(first);
    detector.registerProvider(second);

    const staleLookup = detector.getLinkAt(1, 0);
    first.requests[0].resolve([linkAt(0, 'first-provider')]);
    await Promise.resolve();
    await Promise.resolve();
    expect(second.requests).toHaveLength(1);

    detector.invalidateCache();
    expect(await staleLookup).toBeUndefined();
    second.requests[0].resolve([linkAt(0, 'second-provider')]);
    await Promise.resolve();
    expect((detector as unknown as { linkCache: Map<string, ILink> }).linkCache.size).toBe(0);
  });

  test('discards a scan from the provider set replaced by a new registration', async () => {
    const detector = new LinkDetector(terminalWithRows());
    const oldRequests: Array<(links: ILink[] | undefined) => void> = [];
    let oldCalls = 0;
    detector.registerProvider({
      provideLinks(_row, callback) {
        oldCalls++;
        if (oldCalls === 1) oldRequests.push(callback);
        else callback(undefined);
      },
    });

    const staleLookup = detector.getLinkAt(1, 0);
    expect(oldRequests).toHaveLength(1);

    const replacement = linkAt(0, 'replacement');
    detector.registerProvider(
      {
        provideLinks(_row, callback) {
          callback([replacement]);
        },
      },
      true
    );
    expect(await staleLookup).toBeUndefined();

    oldRequests[0]([linkAt(0, 'stale')]);
    expect(await detector.getLinkAt(1, 0)).toBe(replacement);
  });

  test('revokes pending scans and providers on disposal', async () => {
    const detector = new LinkDetector(terminalWithRows());
    const provider = deferredProvider();
    detector.registerProvider(provider);

    const staleLookup = detector.getLinkAt(1, 0);
    const staleRequest = provider.requests[0];
    detector.dispose();

    expect(await staleLookup).toBeUndefined();
    expect(provider.disposals).toBe(1);

    staleRequest.resolve([linkAt(0, 'stale')]);
    await Promise.resolve();
    expect(await detector.getLinkAt(1, 0)).toBeUndefined();
    expect((detector as unknown as { linkCache: Map<string, ILink> }).linkCache.size).toBe(0);
  });
});
