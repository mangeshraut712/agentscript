/*
 * Copyright (c) 2026, Salesforce, Inc.
 * All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 * For full license text, see the LICENSE file in the repo root or https://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from 'vitest';
import { parse } from '@agentscript/parser';
import { ActionsBlock, VariablesBlock } from '../../blocks.js';
import { requiredFieldPass } from '../../lint/required-fields.js';
import { Dialect } from '../dialect.js';
import {
  attachDiagnostic,
  DiagnosticSeverity,
  type Diagnostic,
} from '../diagnostics.js';
import { isNamedMap, type AstRoot } from '../types.js';
import {
  DependencyResolutionError,
  LintEngine,
  storeKey,
  type LintPass,
} from './lint-engine.js';
import { createSchemaContext } from './scope.js';

const schema = { actions: ActionsBlock, variables: VariablesBlock };
const context = createSchemaContext({ schema, aliases: {} });

function parseRoot(): AstRoot {
  const { rootNode } = parse(`
actions:
  Notify_Manager:
    description: "Notify the store manager"
variables:
  count: mutable number = 0
`);
  const mapping =
    rootNode.namedChildren.find(n => n.type === 'mapping') ?? rootNode;
  return new Dialect().parse(mapping, schema).value;
}

function diagnostic(source: string, code = 'custom'): Diagnostic {
  return {
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    },
    message: code,
    severity: DiagnosticSeverity.Warning,
    source,
    code,
  };
}

function missingTargets(engine: LintEngine, root: AstRoot): Diagnostic[] {
  const { diagnostics } = engine.run(root, context);
  expect(diagnostics.some(d => d.code === 'lint-pass-error')).toBe(false);
  return diagnostics.filter(d => d.code === 'missing-required-field');
}

describe('LintEngine diagnostic cleanup', () => {
  it.each([undefined, 'test', 'agentscript-lint'])(
    'refreshes built-in diagnostics with source %s',
    source => {
      const root = parseRoot();
      const pass = requiredFieldPass();
      const engine = new LintEngine({ passes: [pass], source });
      const counts = [
        missingTargets(engine, root).length,
        missingTargets(engine, root).length,
        missingTargets(engine, root).length,
      ];
      engine.disable(pass.id);
      counts.push(missingTargets(engine, root).length);
      engine.enable(pass.id);
      const diagnostics = missingTargets(engine, root);
      counts.push(diagnostics.length);
      expect(counts).toEqual([1, 1, 1, 0, 1]);
      expect(diagnostics[0].source).toBe('agentscript-lint');
    }
  );

  it('preserves diagnostics not produced by the engine, including matching rule sources', () => {
    const root = parseRoot();
    const foreign = [
      diagnostic('parser'),
      diagnostic('agentscript-schema'),
      diagnostic('agentscript-lint'),
    ];
    root.__diagnostics.push(...foreign);
    const pass = requiredFieldPass();
    const engine = new LintEngine({ passes: [pass] });
    engine.run(root, context);
    const addedLater = diagnostic('agentscript-lint', 'later');
    root.__diagnostics.push(addedLater);
    engine.disable(pass.id);
    expect(engine.run(root, context).diagnostics).toEqual([
      ...foreign,
      addedLater,
    ]);
  });

  it('remembers diagnostics when alternating between ASTs', () => {
    const first = parseRoot();
    const second = parseRoot();
    const pass = requiredFieldPass();
    const engine = new LintEngine({ passes: [pass] });
    const counts = [
      missingTargets(engine, first).length,
      missingTargets(engine, second).length,
      missingTargets(engine, first).length,
    ];
    engine.disable(pass.id);
    counts.push(
      missingTargets(engine, second).length,
      missingTargets(engine, first).length
    );
    expect(counts).toEqual([1, 1, 1, 0, 0]);
  });

  it('keeps diagnostics produced by another engine on the same AST', () => {
    const root = parseRoot();
    const firstPass = requiredFieldPass();
    const first = new LintEngine({ passes: [firstPass], source: 'first' });
    const second = new LintEngine({
      passes: [requiredFieldPass()],
      source: 'second',
    });
    expect(missingTargets(first, root)).toHaveLength(1);
    expect(missingTargets(second, root)).toHaveLength(2);
    expect(missingTargets(first, root)).toHaveLength(2);
    first.disable(firstPass.id);
    expect(missingTargets(first, root)).toHaveLength(1);
    expect(missingTargets(second, root)).toHaveLength(1);
  });

  it('continues clearing preexisting diagnostics with the configured source', () => {
    const root = parseRoot();
    root.__diagnostics.push(diagnostic('custom-source'));
    const engine = new LintEngine({ source: 'custom-source' });
    expect(engine.run(root, context).diagnostics).toEqual([]);
  });

  it.each(['init', 'finalize', 'run'] as const)(
    'refreshes diagnostics emitted during %s without changing their source',
    hook => {
      const root = parseRoot();
      const pass: LintPass = {
        id: storeKey('custom-pass'),
        description: 'Adds a diagnostic with an independent source',
        [hook]() {
          attachDiagnostic(root, diagnostic('custom-pass'));
        },
      };
      const engine = new LintEngine({ passes: [pass] });
      expect(engine.run(root, context).diagnostics).toHaveLength(1);
      expect(engine.run(root, context).diagnostics).toHaveLength(1);
      engine.disable(pass.id);
      expect(engine.run(root, context).diagnostics).toEqual([]);
    }
  );

  it('does not clear diagnostics emitted by init during the same run', () => {
    const root = parseRoot();
    const pass: LintPass = {
      id: storeKey('init-pass'),
      description: 'Adds an engine-source diagnostic before walking',
      init() {
        attachDiagnostic(root, diagnostic('lint'));
      },
    };
    const engine = new LintEngine({ passes: [pass] });
    expect(engine.run(root, context).diagnostics).toHaveLength(1);
    expect(engine.run(root, context).diagnostics).toHaveLength(1);
  });

  it('does not clear visitVariables diagnostics during the same run', () => {
    const root = parseRoot();
    const pass: LintPass = {
      id: storeKey('variables-pass'),
      description: 'Adds an engine-source diagnostic before walking variables',
      visitVariables(variables) {
        attachDiagnostic(variables, diagnostic('lint'));
      },
    };
    const engine = new LintEngine({ passes: [pass] });
    expect(engine.run(root, context).diagnostics).toHaveLength(1);
    expect(engine.run(root, context).diagnostics).toHaveLength(1);
  });

  it('does not clear diagnostics attached to children by an ancestor hook', () => {
    const root = parseRoot();
    const pass: LintPass = {
      id: storeKey('ancestor-pass'),
      description: 'Adds a diagnostic before walking an action child',
      enterNode(_key, value) {
        if (value === root && isNamedMap(root.actions)) {
          attachDiagnostic(root.actions, diagnostic('lint'));
        }
      },
    };
    const engine = new LintEngine({ passes: [pass] });
    expect(engine.run(root, context).diagnostics).toHaveLength(1);
    expect(engine.run(root, context).diagnostics).toHaveLength(1);
  });

  it('removes diagnostics from a pass that fails after emitting them', () => {
    const root = parseRoot();
    const pass: LintPass = {
      id: storeKey('failing-pass'),
      description: 'Emits a diagnostic before failing',
      init() {
        attachDiagnostic(root, diagnostic('custom-pass'));
        throw new Error('failed after adding a diagnostic');
      },
    };
    const engine = new LintEngine({ passes: [pass] });
    engine.run(root, context);
    const { diagnostics } = engine.run(root, context);
    expect(diagnostics.filter(d => d.code === 'custom')).toHaveLength(1);
    expect(diagnostics.filter(d => d.code === 'lint-pass-error')).toHaveLength(
      1
    );
    engine.disable(pass.id);
    expect(engine.run(root, context).diagnostics).toEqual([]);
  });

  it('cleans up diagnostics even when finalize dependency resolution throws', () => {
    const root = parseRoot();
    const id = storeKey('cyclic-pass');
    const pass: LintPass = {
      id,
      description: 'Emits a diagnostic before a dependency cycle is detected',
      finalizeAfter: [id],
      init() {
        attachDiagnostic(root, diagnostic('custom-pass'));
      },
      finalize() {},
    };
    const engine = new LintEngine({ passes: [pass] });
    expect(() => engine.run(root, context)).toThrow(DependencyResolutionError);
    engine.disable(pass.id);
    expect(engine.run(root, context).diagnostics).toEqual([]);
  });

  it('refreshes custom diagnostics without a source tag', () => {
    const root = parseRoot();
    const pass: LintPass = {
      id: storeKey('untagged-pass'),
      description: 'Adds an untagged diagnostic',
      run() {
        const value = diagnostic('temporary');
        delete value.source;
        attachDiagnostic(root, value);
      },
    };
    const engine = new LintEngine({ passes: [pass] });
    expect(engine.run(root, context).diagnostics).toHaveLength(1);
    expect(engine.run(root, context).diagnostics).toHaveLength(1);
    engine.disable(pass.id);
    expect(engine.run(root, context).diagnostics).toEqual([]);
  });
});
