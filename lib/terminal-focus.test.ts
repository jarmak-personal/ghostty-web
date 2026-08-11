import { afterEach, describe, expect, test } from 'bun:test';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

const terminals: Terminal[] = [];
const fixtures: HTMLElement[] = [];

async function openTerminal(
  host: HTMLElement,
  options: { focusOnOpen?: boolean; theme?: { foreground?: string } } = {}
): Promise<Terminal> {
  if (!host.isConnected) {
    document.body.appendChild(host);
    fixtures.push(host);
  }
  const terminal = await createIsolatedTerminal(options);
  terminal.open(host);
  terminals.push(terminal);
  return terminal;
}

function canvasFor(terminal: Terminal): HTMLCanvasElement {
  const canvas = terminal.element?.querySelector('canvas');
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Expected terminal canvas');
  return canvas;
}

function sequentialFocusTargets(root: ParentNode): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]'
    )
  ).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.hasAttribute('disabled') &&
      element.getAttribute('aria-hidden') !== 'true'
  );
}

function dispatchBeforeInput(
  textarea: HTMLTextAreaElement,
  inputType: string,
  data: string,
  isComposing = false
): InputEvent {
  const event = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    data,
    inputType,
    isComposing,
  });
  textarea.dispatchEvent(event);
  return event;
}

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

describe('terminal focus ownership', () => {
  test('exposes exactly one sequential input target and keeps its accessible name unique', async () => {
    const fixture = document.createElement('section');
    const before = document.createElement('button');
    const host = document.createElement('div');
    const after = document.createElement('button');
    // Happy DOM does not supply native controls' implicit tabIndex.
    before.tabIndex = 0;
    after.tabIndex = 0;
    host.setAttribute('tabindex', '7');
    host.setAttribute('contenteditable', 'true');
    host.setAttribute('role', 'group');
    host.setAttribute('aria-label', 'Build terminal');
    fixture.append(before, host, after);
    document.body.appendChild(fixture);
    fixtures.push(fixture);

    const terminal = await openTerminal(host, { focusOnOpen: false });
    const textarea = terminal.textarea!;

    const focusTargets = sequentialFocusTargets(fixture);
    expect(focusTargets).toHaveLength(3);
    expect(focusTargets[0]).toBe(before);
    expect(focusTargets[1]).toBe(textarea);
    expect(focusTargets[2]).toBe(after);
    expect(host.tabIndex).toBe(-1);
    expect(host.getAttribute('contenteditable')).toBe('false');
    expect(host.hasAttribute('role')).toBe(false);
    expect(host.hasAttribute('aria-label')).toBe(false);
    expect(textarea.tabIndex).toBe(0);
    expect(textarea.getAttribute('aria-label')).toBe('Build terminal');
    expect(textarea.hasAttribute('aria-multiline')).toBe(false);
    expect(canvasFor(terminal).getAttribute('aria-hidden')).toBe('true');

    for (const target of sequentialFocusTargets(fixture)) {
      target.focus();
      expect(document.activeElement).toBe(target);
    }

    terminal.dispose();
    expect(host.getAttribute('tabindex')).toBe('7');
    expect(host.getAttribute('contenteditable')).toBe('true');
    expect(host.getAttribute('role')).toBe('group');
    expect(host.getAttribute('aria-label')).toBe('Build terminal');
    expect(host.childNodes).toHaveLength(0);
  });

  test('focus and blur delegate to the textarea and blur cancels delayed refocus', async () => {
    const host = document.createElement('div');
    const terminal = await openTerminal(host, { focusOnOpen: false });
    const textarea = terminal.textarea!;

    terminal.focus();
    expect(document.activeElement).toBe(textarea);

    terminal.blur();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).not.toBe(textarea);

    // Compatibility callers using `element` still converge on the real receiver.
    host.focus();
    expect(document.activeElement).toBe(textarea);
  });

  test('reflects textarea focus-visible with a theme-derived host outline', async () => {
    const host = document.createElement('div');
    host.style.outline = '1px dotted red';
    host.style.outlineOffset = '4px';
    const terminal = await openTerminal(host, {
      focusOnOpen: false,
      theme: { foreground: '#12ab34' },
    });

    terminal.textarea!.focus();
    expect(terminal.textarea!.matches(':focus-visible')).toBe(true);
    expect(host.style.outlineWidth).toBe('2px');
    expect(host.style.outlineStyle).toBe('solid');
    expect(host.style.outlineColor).toBe('#12ab34');
    expect(host.style.outlineOffset).toBe('2px');

    terminal.blur();
    expect(host.style.outlineWidth).toBe('1px');
    expect(host.style.outlineStyle).toBe('dotted');
    expect(host.style.outlineColor).toBe('red');
    expect(host.style.outlineOffset).toBe('4px');
  });

  test('uses the shadow root active element when reflecting focus', async () => {
    const mount = document.createElement('div');
    const shadowRoot = mount.attachShadow({ mode: 'open' });
    const host = document.createElement('div');
    shadowRoot.appendChild(host);
    document.body.appendChild(mount);
    fixtures.push(mount);
    const terminal = await openTerminal(host, {
      focusOnOpen: false,
      theme: { foreground: '#abcdef' },
    });

    terminal.focus();
    expect(document.activeElement).toBe(mount);
    expect(shadowRoot.activeElement).toBe(terminal.textarea);
    expect(host.style.outlineWidth).toBe('2px');
    expect(host.style.outlineColor).toBe('#abcdef');
  });

  test('mouse, touch, context menu, and keyboard input retain one focus owner', async () => {
    const terminal = await openTerminal(document.createElement('div'), { focusOnOpen: false });
    const textarea = terminal.textarea!;
    const canvas = canvasFor(terminal);
    const data: string[] = [];
    terminal.onData((value) => data.push(value));

    const mouseDown = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    canvas.dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(textarea);
    expect(textarea.matches(':focus-visible')).toBe(true);
    expect(terminal.element!.style.outlineWidth).toBe('2px');

    terminal.blur();
    const touchEnd = new TouchEvent('touchend', { bubbles: true, cancelable: true });
    canvas.dispatchEvent(touchEnd);
    expect(touchEnd.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(textarea);
    expect(textarea.matches(':focus-visible')).toBe(true);
    expect(terminal.element!.style.outlineWidth).toBe('2px');

    textarea.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'a',
        code: 'KeyA',
      })
    );
    expect(data).toEqual(['a']);

    terminal.blur();
    canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(textarea);
    expect(terminal.element!.style.outlineWidth).toBe('2px');
  });

  test('routes mobile beforeinput and IME transactions through the canonical textarea', async () => {
    const terminal = await openTerminal(document.createElement('div'), { focusOnOpen: false });
    const textarea = terminal.textarea!;
    const data: string[] = [];
    terminal.onData((value) => data.push(value));

    textarea.focus();
    const mobileInput = dispatchBeforeInput(textarea, 'insertText', 'é');
    expect(mobileInput.defaultPrevented).toBe(true);
    expect(data).toEqual(['é']);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    textarea.value = '你好';
    textarea.setSelectionRange(2, 2);
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好' }));
    dispatchBeforeInput(textarea, 'insertText', '你好');

    expect(data).toEqual(['é', '你好']);
    expect(textarea.value).toBe('你好');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(textarea.value).toBe('');
    expect(textarea.selectionStart).toBe(0);
    expect(textarea.selectionEnd).toBe(0);
  });
});
