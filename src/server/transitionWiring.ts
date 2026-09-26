import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { cutDataImport } from './cutDataImport';

export interface TransitionRootUpdate {
  path: string;
  source: string;
}

function parseTsx(source: string): ts.SourceFile {
  return ts.createSourceFile('source.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

export function isValidTsx(source: string): boolean {
  const result = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
  });
  return !(result.diagnostics ?? []).some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
}

function importModuleText(node: ts.ImportDeclaration): string | null {
  return ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
}

interface ImportedBinding {
  moduleName: string;
  importedName: string;
  typeOnly: boolean;
}

function importedLocalNames(file: ts.SourceFile): Map<string, ImportedBinding> {
  const names = new Map<string, ImportedBinding>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause === undefined) continue;
    const moduleName = importModuleText(statement);
    if (moduleName === null) continue;
    const clause = statement.importClause;
    if (clause.name !== undefined) {
      names.set(clause.name.text, { moduleName, importedName: 'default', typeOnly: clause.isTypeOnly });
    }
    const bindings = clause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      names.set(bindings.name.text, { moduleName, importedName: '*', typeOnly: clause.isTypeOnly });
      continue;
    }
    for (const element of bindings.elements) {
      names.set(element.name.text, {
        moduleName,
        importedName: element.propertyName?.text ?? element.name.text,
        typeOnly: clause.isTypeOnly || element.isTypeOnly,
      });
    }
  }
  return names;
}

function topLevelValueNames(file: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const addBinding = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else for (const element of name.elements) if (!ts.isOmittedExpression(element)) addBinding(element.name);
  };
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) addBinding(declaration.name);
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)) &&
      statement.name !== undefined &&
      ts.isIdentifier(statement.name)
    ) {
      names.add(statement.name.text);
    }
  }
  return names;
}

/** Add missing named bindings without depending on whitespace in existing imports. */
export function ensureNamedImports(source: string, moduleName: string, names: readonly string[]): string | null {
  let out = source;
  let file = parseTsx(out);
  let locals = importedLocalNames(file);
  for (const name of names) {
    const binding = locals.get(name);
    if (binding?.typeOnly === true && binding.moduleName === moduleName && binding.importedName === name) {
      out = removeNamedImports(out, moduleName, new Set([name]));
    }
  }
  file = parseTsx(out);
  locals = importedLocalNames(file);
  const declaredValues = topLevelValueNames(file);
  const missing: string[] = [];
  for (const name of names) {
    const binding = locals.get(name);
    if (
      binding !== undefined &&
      (binding.moduleName !== moduleName || binding.importedName !== name || binding.typeOnly)
    ) return null;
    if (binding === undefined) {
      if (declaredValues.has(name)) return null;
      missing.push(name);
    }
  }
  if (missing.length === 0) return out;

  const imports = file.statements.filter(ts.isImportDeclaration);
  const at = imports.at(-1)?.end ?? 0;
  const line = `import { ${missing.join(', ')} } from '${moduleName}';`;
  if (at === 0) return `${line}\n${out}`;
  const suffix = out.slice(at);
  const separator = suffix.startsWith('\n') || suffix.startsWith('\r\n') ? '' : '\n';
  return `${out.slice(0, at)}\n${line}${separator}${suffix}`;
}

/** Insert JSX at a real closing element boundary, so compact one-line JSX is not mistaken for indentation. */
export function insertBeforeJsxClosing(
  source: string,
  tagName: string,
  jsx: string,
  preferredDescendant?: string,
): string | null {
  if (!isValidTsx(source)) return null;
  const file = parseTsx(source);
  const candidates: ts.JsxElement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(file) === tagName) candidates.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  const preferred = preferredDescendant === undefined
    ? []
    : candidates.filter((candidate) => candidate.getText(file).includes(`<${preferredDescendant}`));
  const target = preferred.at(-1) ?? candidates.at(-1);
  if (target === undefined) return null;
  const at = target.closingElement.getStart(file);
  const lineStart = source.lastIndexOf('\n', at - 1) + 1;
  const beforeClosing = source.slice(lineStart, at);
  const indent = /^\s*$/.test(beforeClosing) ? beforeClosing : '';
  const out = `${source.slice(0, at)}${jsx}\n${indent}${source.slice(at)}`;
  return isValidTsx(out) ? out : null;
}

/** Remove only named import specifiers; other bindings and module syntax stay intact. */
function removeNamedImports(source: string, moduleName: string, names: ReadonlySet<string>): string {
  const file = parseTsx(source);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || importModuleText(statement) !== moduleName) continue;
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (clause === undefined || bindings === undefined || !ts.isNamedImports(bindings)) continue;
    const remaining = bindings.elements.filter((element) => !names.has(element.name.text));
    if (remaining.length === bindings.elements.length) continue;
    if (remaining.length > 0) {
      edits.push({
        start: bindings.getStart(file),
        end: bindings.end,
        text: `{ ${remaining.map((element) => element.getText(file)).join(', ')} }`,
      });
    } else if (clause.name !== undefined) {
      edits.push({ start: clause.getStart(file), end: clause.end, text: clause.name.text });
    } else {
      let end = statement.end;
      if (source.slice(end, end + 2) === '\r\n') end += 2;
      else if (source[end] === '\n') end += 1;
      edits.push({ start: statement.getStart(file), end, text: '' });
    }
  }
  let out = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

function compositionDurationInitializer(file: ts.SourceFile): ts.JsxExpression | null {
  const preferred: ts.JsxExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (node.tagName.getText(file) === 'Composition') {
        const component = node.attributes.properties.find(
          (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText(file) === 'component',
        );
        const duration = node.attributes.properties.find(
          (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText(file) === 'durationInFrames',
        );
        if (duration?.initializer !== undefined && ts.isJsxExpression(duration.initializer)) {
          if (
            component?.initializer !== undefined &&
            ts.isJsxExpression(component.initializer) &&
            component.initializer.expression !== undefined &&
            ts.isIdentifier(component.initializer.expression) &&
            component.initializer.expression.text === 'MainVideo'
          ) {
            preferred.push(duration.initializer);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (preferred.length === 1) return preferred[0] ?? null;
  return null;
}

function identifierUsedOutsideImports(source: string, name: string): boolean {
  const file = parseTsx(source);
  let used = false;
  const visit = (node: ts.Node): void => {
    if (used || ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node) && node.text === name) {
      used = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return used;
}

/** Wire Root to the exact duration of the TransitionSeries rendered by MainVideo. */
export function injectTransitionRootSource(
  source: string,
  cutImport: string,
  usesMainSpeed: boolean,
): string | null {
  if (!isValidTsx(source)) return null;
  const file = parseTsx(source);
  const initializer = compositionDurationInitializer(file);
  if (initializer === null) return null;
  const speed = usesMainSpeed ? 'MAIN_SPEED' : '1';
  let out =
    source.slice(0, initializer.getStart(file)) +
    `{transitionCompositionDuration(cutData, transitionData, ${speed})}` +
    source.slice(initializer.end);

  if (!identifierUsedOutsideImports(out, 'speedCompositionDuration')) {
    out = removeNamedImports(out, './Speed', new Set(['speedCompositionDuration']));
  }
  if (!identifierUsedOutsideImports(out, 'CUT_DURATION_FRAMES')) {
    out = removeNamedImports(out, cutImport, new Set(['CUT_DURATION_FRAMES']));
  }
  if (!identifierUsedOutsideImports(out, 'SEGMENT_SPEEDS')) {
    out = removeNamedImports(out, './speedData', new Set(['SEGMENT_SPEEDS']));
  }
  const withTransition = ensureNamedImports(out, './Transition', ['transitionCompositionDuration', 'transitionData']);
  if (withTransition === null) return null;
  const withCuts = ensureNamedImports(withTransition, cutImport, ['cutData']);
  if (withCuts === null) return null;
  out = withCuts;
  if (usesMainSpeed) {
    const withSpeed = ensureNamedImports(out, './speedData', ['MAIN_SPEED']);
    if (withSpeed === null) return null;
    out = withSpeed;
  }
  return isValidTsx(out) ? out : null;
}

/** Plan an existing installed transition pack's Root repair without writing anything. */
export function planInstalledTransitionRootUpdate(projectDir: string): TransitionRootUpdate | null {
  const mainVideoPath = join(projectDir, 'src', 'MainVideo.tsx');
  if (!existsSync(mainVideoPath)) throw new Error('src/MainVideo.tsx が見つかりません');
  const mainVideo = readFileSync(mainVideoPath, 'utf8');
  if (!mainVideo.includes('<CutPlayerWithTransitions')) return null;
  const rootPath = join(projectDir, 'src', 'Root.tsx');
  if (!existsSync(rootPath)) throw new Error('src/Root.tsx が見つかりません');
  const usesMainSpeed = /<CutPlayerWithTransitions\b[^>]*\bmainSpeed=\{MAIN_SPEED\}/.test(mainVideo);
  const source = injectTransitionRootSource(readFileSync(rootPath, 'utf8'), cutDataImport(projectDir) ?? './cutData', usesMainSpeed);
  if (source === null) throw new Error('Root.tsx の MainVideo Composition を安全に更新できません');
  return { path: rootPath, source };
}
