import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { injectTransitionRootSource, ensureNamedImports } from './transitionWiring';

function importedNames(source: string): string[] {
  const file = ts.createSourceFile('Root.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return file.statements.filter(ts.isImportDeclaration).flatMap(node => {
    const bindings = node.importClause?.namedBindings;
    return bindings && ts.isNamedImports(bindings) ? bindings.elements.map(x => x.name.text) : [];
  });
}

describe('independent transition Root migration audit', () => {
  it('preserves an imported duration still used by another composition', () => {
    const source = `import {Composition} from 'remotion';
import {MainVideo} from './MainVideo';
import {Other} from './Other';
import {CUT_DURATION_FRAMES} from './cutData';
export const Root=()=> <><Composition id="MainVideo" component={MainVideo} durationInFrames={CUT_DURATION_FRAMES}/><Composition id="Other" component={Other} durationInFrames={CUT_DURATION_FRAMES}/></>;`;
    const output = injectTransitionRootSource(source, './cutData', false);
    expect(output).not.toBeNull();
    expect(importedNames(output!)).toContain('CUT_DURATION_FRAMES');
    expect(output).toContain('id="Other" component={Other} durationInFrames={CUT_DURATION_FRAMES}');
  });

  it('refuses a Root that only contains a different component', () => {
    const source = `import {Composition} from 'remotion';
import {Other} from './Other';
export const Root=()=> <Composition id="Other" component={Other} durationInFrames={90}/>;`;
    expect(injectTransitionRootSource(source, './cutData', false)).toBeNull();
  });

  it('does not mistake a type-only binding for a runtime value', () => {
    const source = `import type {transitionData} from './Transition';`;
    const output = ensureNamedImports(source, './Transition', ['transitionData']);
    // Either reject unsupported wiring or explicitly introduce a real runtime
    // binding. Silently leaving only an erased type import is unsafe.
    if (output !== null) {
      const emitted = ts.transpileModule(output + '\nconsole.log(transitionData);', { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
      expect(emitted).toMatch(/import[\s\S]*transitionData[\s\S]*from/);
    }
  });
});
