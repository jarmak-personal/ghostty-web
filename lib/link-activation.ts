import type { IBufferRange, ILinkHandler } from './interfaces';

const DEFAULT_PROTOCOLS = new Set(['http:', 'https:']);
const BLOCKED_PROTOCOLS = new Set(['blob:', 'data:', 'filesystem:', 'javascript:', 'vbscript:']);
const RAW_WHITESPACE_OR_CONTROL = /[\u0000-\u0020\u007f]/;

export function isLinkUriAllowed(uri: string, handler: ILinkHandler | null = null): boolean {
  if (typeof uri !== 'string' || uri.length === 0 || RAW_WHITESPACE_OR_CONTROL.test(uri)) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch (_error) {
    return false;
  }

  if (BLOCKED_PROTOCOLS.has(parsed.protocol)) {
    return false;
  }

  return DEFAULT_PROTOCOLS.has(parsed.protocol) || handler?.allowNonHttpProtocols === true;
}

export function activateBuiltInLink(
  event: MouseEvent,
  uri: string,
  range: IBufferRange,
  handler: ILinkHandler | null = null
): void {
  if ((!event.ctrlKey && !event.metaKey) || !isLinkUriAllowed(uri, handler)) {
    return;
  }

  if (handler) {
    handler.activate(event, uri, range);
    return;
  }

  window.open(uri, '_blank', 'noopener,noreferrer');
}
