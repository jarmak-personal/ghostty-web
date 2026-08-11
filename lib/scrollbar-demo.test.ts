import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const demoPath = join(import.meta.dir, '..', 'demo', 'scrollbar-test.html');

describe('scrollbar demo', () => {
  test('uses executable ANSI and newline escape sequences', async () => {
    const source = await readFile(demoPath, 'utf8');

    expect(source).toContain(String.raw`\x1b[`);
    expect(source).toContain(String.raw`\r\n`);
    expect(source).not.toContain(String.raw`\\x1b`);
    expect(source).not.toContain(String.raw`\\r`);
    expect(source).not.toContain(String.raw`\\n`);
  });
});
