import { describe, expect, test } from 'bun:test';
import type { ILinkHandler } from './interfaces';
import { activateBuiltInLink, isLinkUriAllowed } from './link-activation';
import { type ITerminalForOSC8Provider, OSC8LinkProvider } from './providers/osc8-link-provider';
import type { ILink } from './types';

const range = {
  start: { x: 0, y: 0 },
  end: { x: 3, y: 0 },
};

function ctrlClick(): MouseEvent {
  return new MouseEvent('click', { ctrlKey: true });
}

function provideOsc8Link(uri: string, handler: ILinkHandler | null = null) {
  const terminal: ITerminalForOSC8Provider = {
    buffer: {
      active: {
        length: 1,
        getLine: () => ({
          length: 1,
          getCell: () => ({ getHyperlinkId: () => 1 }),
        }),
      },
    },
    wasmTerm: {
      getScrollbackLength: () => 0,
      getHyperlinkUri: () => uri,
      getScrollbackHyperlinkUri: () => null,
    },
  };
  const provider = new OSC8LinkProvider(terminal, () => handler);
  let provided: ILink[] | undefined;
  provider.provideLinks(0, (links) => {
    provided = links;
  });
  return provided;
}

describe('built-in link activation', () => {
  test('allows only absolute HTTP and HTTPS URLs by default', () => {
    expect(isLinkUriAllowed('https://example.com/path')).toBe(true);
    expect(isLinkUriAllowed('HTTP://example.com')).toBe(true);

    for (const uri of [
      'javascript:alert(1)',
      'data:text/html,test',
      'file:///tmp/test',
      'mailto:user@example.com',
      'custom:payload',
      '/relative/path',
      'not a url',
      'https://example.com/\nnext',
    ]) {
      expect(isLinkUriAllowed(uri)).toBe(false);
    }
  });

  test('lets an explicit host handler opt into valid non-HTTP protocols', () => {
    const handler: ILinkHandler = {
      allowNonHttpProtocols: true,
      activate: () => {},
    };

    expect(isLinkUriAllowed('custom:payload', handler)).toBe(true);
    expect(isLinkUriAllowed('file:///tmp/test', handler)).toBe(true);
    expect(isLinkUriAllowed('not a url', handler)).toBe(false);
    expect(isLinkUriAllowed('custom:payload\nnext', handler)).toBe(false);
  });

  test('requires a modifier and uses the host handler when configured', () => {
    const activations: string[] = [];
    const handler: ILinkHandler = {
      activate: (_event, text) => activations.push(text),
    };

    activateBuiltInLink(new MouseEvent('click'), 'https://example.com', range, handler);
    expect(activations).toEqual([]);

    activateBuiltInLink(ctrlClick(), 'https://example.com', range, handler);
    expect(activations).toEqual(['https://example.com']);
  });

  test('does not expose disallowed OSC 8 links to hit testing', () => {
    expect(provideOsc8Link('data:text/html,test')).toBeUndefined();
    expect(provideOsc8Link('https://example.com')).toHaveLength(1);
  });

  test('rechecks the current handler policy when activating a cached link', () => {
    const activations: string[] = [];
    const handler: ILinkHandler = {
      allowNonHttpProtocols: true,
      activate: (_event, text) => activations.push(text),
    };
    const links = provideOsc8Link('custom:payload', handler)!;

    handler.allowNonHttpProtocols = false;
    links[0].activate(ctrlClick());

    expect(activations).toEqual([]);
  });
});
