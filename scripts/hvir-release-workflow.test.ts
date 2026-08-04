import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/release-hvir-artifact.yml', 'utf8');
const sourceExpression = '$' + '{{ steps.source.outputs.commit }}';

describe('hvir release workflow safety', () => {
  test('publishes only from a serialized no-input manual dispatch', () => {
    expect(workflow).toContain('on:\n  workflow_dispatch:\n\npermissions:');
    expect(workflow).not.toContain('\n  push:');
    expect(workflow).not.toContain('\n    inputs:');
    expect(workflow).toContain('group: hvir-artifact-release');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow.match(/^ {2}[a-z][a-z0-9_-]*:\n {4}name:/gm)).toHaveLength(1);
  });

  test('checks out the dispatch snapshot instead of a moving branch ref', () => {
    expect(workflow).toContain('if [[ "$DISPATCH_REF" != \'refs/heads/hvir-main\' ]]');
    expect(workflow).toContain(`ref: ${sourceExpression}`);
    expect(workflow).toContain(`SOURCE_COMMIT: ${sourceExpression}`);
  });

  test('runs every pre-publication gate before tag or release creation', () => {
    const orderedGates = [
      'Require immutable releases',
      'Check formatting',
      'Run linter',
      'Check types',
      'Build WASM for tests',
      'Run tests',
      'Build and pack hvir package',
      'Check WASM size',
      'Validate release payload',
      'Create or resume immutable GitHub Release',
    ];
    let previous = -1;
    for (const gate of orderedGates) {
      const index = workflow.indexOf(`- name: ${gate}`);
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
    expect(workflow.match(/scripts\/hvir-release\.ts publish/g)).toHaveLength(1);
  });
});
