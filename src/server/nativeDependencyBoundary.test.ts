import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const isLegacyPackage = (name: string): boolean => /^(?:remotion(?:\/|$)|@remotion\/)/.test(name);

/** Inspect executable module requests, including literal dynamic and type imports. */
function moduleRequests(source: string, filename: string): string[] {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const requests: string[] = [];
  const record = (node: ts.Node | undefined): void => {
    if (node && ts.isStringLiteralLike(node) && isLegacyPackage(node.text)) requests.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) record(node.moduleSpecifier);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) record(node.argument.literal);
    if (ts.isCallExpression(node)) {
      const call = node.expression;
      const imported = call.kind === ts.SyntaxKind.ImportKeyword;
      const required = ts.isIdentifier(call) && ['require', 'importOriginal'].includes(call.text);
      const resolved = ts.isPropertyAccessExpression(call) && ts.isIdentifier(call.expression) &&
        ((call.expression.text === 'require' && call.name.text === 'resolve') ||
         (call.expression.text === 'vi' && ['importActual', 'importMock'].includes(call.name.text)));
      if (imported || required || resolved) record(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return requests;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    // These are foreign project source documents, checked by their own strict program
    // and loaded through the audited native component loader in compatibility tests.
    if (relative(ROOT, path).split(sep).join('/') === 'src/server/__fixtures__') return [];
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[cm]?tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('native package boundary', () => {
  it('root package and the entire lock have no Remotion package dependency', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, unknown>;
    };
    const declared = [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies, pkg.peerDependencies]
      .flatMap(group => Object.keys(group ?? {})).filter(isLegacyPackage);
    const installed = Object.keys(lock.packages).filter(path =>
      path.split('node_modules/').some(isLegacyPackage));
    expect(declared).toEqual([]);
    expect(installed).toEqual([]);
  });

  it('product and test modules do not import the retired packages', () => {
    const files = sourceFiles(join(ROOT, 'src'));
    expect(files.length).toBeGreaterThan(0);
    const requests = files.flatMap(file => moduleRequests(readFileSync(file, 'utf8'), file)
      .map(specifier => ({ file: relative(ROOT, file), specifier })));
    expect(requests).toEqual([]);
  });

  it('the scan catches executable and type requests but keeps compatibility strings', () => {
    const bad = `import {X} from 'remotion'; export {Y} from '@remotion/player';
      type T = import('remotion').Config; import('@remotion/transitions');
      require('remotion'); require.resolve('@remotion/paths'); vi.importActual('remotion');`;
    expect(moduleRequests(bad, 'bad.ts')).toEqual([
      'remotion', '@remotion/player', 'remotion', '@remotion/transitions',
      'remotion', '@remotion/paths', 'remotion',
    ]);
    const compatibility = `const allowed = 'remotion';
      vi.mock('remotion', () => import('../captureRuntime'));
      import {useCurrentFrame} from '@harness/frame-runtime';`;
    expect(moduleRequests(compatibility, 'compatibility.ts')).toEqual([]);
  });
});
