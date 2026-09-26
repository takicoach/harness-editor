/**
 * `renderErrorHint` の code 網羅ガード（サイクル 3 残 Minor）。
 *
 * 書き出し失敗の code はサーバ（native facade / mock）とクライアントで
 * 生まれる。ヒント文はツールバー側の 1 つの switch にしかないので、新しい code を足したのに
 * ヒントを書き忘れると、利用者には生の英語混じり message だけが出る。
 *
 * ここでは実ソースから code を機械的に集め、全部にヒントがあることを確かめる。
 * 一覧を手で書き写さない（写した一覧は必ず現物から乖離する）。
 * HTTPで届いた任意のcodeの転送はrenderHttpErrorの別契約で検査する。
 * ここで網羅するのは監視対象モジュールが自ら生成するジョブ/通信エラー。
 * オブジェクト/クラスのcode宣言・代入を調べる構文検査であり、他モジュールからのオブジェクト丸ごとの
 * 転送や反射APIのデータフローを証明しない。それらの変更時は別途読解・実動検証が必要。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderErrorHint } from './Toolbar';
import ts from 'typescript';

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(APP_DIR, rel), 'utf8');

/** Read actual object values, including both branches of conditional codes.
 * Unknown dynamic expressions fail this guard rather than silently disappearing. */
function sourceCodes(src: string): string[] {
  const codes = new Set<string>();
  const value = (node: ts.Expression): void => {
    if (ts.isStringLiteralLike(node)) { codes.add(node.text); return; }
    if (ts.isParenthesizedExpression(node)) { value(node.expression); return; }
    if (ts.isConditionalExpression(node)) { value(node.whenTrue); value(node.whenFalse); return; }
    throw new Error(`Unexamined render error code: ${node.getText()}`);
  };
  const name = (node: ts.PropertyName): string => {
    if (ts.isComputedPropertyName(node)) {
      if (ts.isStringLiteralLike(node.expression) || ts.isNumericLiteral(node.expression)) return node.expression.text;
      throw new Error(`Unexamined render error property: ${node.getText()} (dynamic keys require review, including non-error objects)`);
    }
    return node.text;
  };
  const assignedName = (node: ts.Expression): string | undefined => {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return assignedName(node.expression);
    if (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)) throw new Error(`Unexamined render error assignment: ${node.getText()} (destructuring requires review)`);
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node)) {
      if (ts.isStringLiteralLike(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression)) return node.argumentExpression.text;
      throw new Error(`Unexamined render error assignment: ${node.getText()} (dynamic indices require review, including non-error objects)`);
    }
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) && name(node.name) === 'code') {
      if (!node.initializer) throw new Error(`Unexamined render error code: ${node.getText()}`);
      value(node.initializer);
    }
    if (ts.isParameter(node) && node.modifiers?.some(modifier => [ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.ReadonlyKeyword].includes(modifier.kind))) {
      if (!ts.isIdentifier(node.name)) throw new Error(`Unexamined render error parameter: ${node.getText()}`);
      if (node.name.text === 'code') {
        // A literal default does not constrain values supplied by callers.
        throw new Error(`Unexamined render error code: ${node.getText()} (parameter properties require call-site review)`);
      }
    }
    if ((ts.isShorthandPropertyAssignment(node) || ts.isGetAccessorDeclaration(node) || ts.isMethodDeclaration(node)) && name(node.name) === 'code')
      throw new Error(`Unexamined render error code: ${node.getText()}`);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && assignedName(node.left) === 'code') {
      if (![ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken].includes(node.operatorToken.kind))
        throw new Error(`Unexamined render error assignment: ${node.getText()}`);
      value(node.right);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile('render-producer.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
  return [...codes];
}

const serverCodes = () => [...new Set([
  ...sourceCodes(read('../../server/legacyNativeRenderJobs.ts')),
  ...sourceCodes(read('../../server/mockRenderJob.ts')),
])];
const clientCodes = () => sourceCodes(read('../useRenderJob.ts'));

describe('renderErrorHint の網羅', () => {
  it('code を 1 件も取りこぼさずに集められている（抽出そのものの健全性）', () => {
    expect(serverCodes().length).toBeGreaterThanOrEqual(7);
    expect(serverCodes()).toContain('render-failed');
    expect(serverCodes()).toContain('native-render-failed');
    expect(serverCodes()).toContain('cancelled');
    expect(clientCodes()).toContain('network');
  });

  it('現在の native facade / mock が出す全 code にヒントがある', () => {
    for (const code of serverCodes()) {
      expect(renderErrorHint(code), code).not.toBeNull();
    }
  });

  it('useRenderJob が出す全 code にヒントがある', () => {
    for (const code of clientCodes()) {
      expect(renderErrorHint(code), code).not.toBeNull();
    }
  });

  it('ヒントは非エンジニア向けの日本語（英語の識別子をそのまま出さない）', () => {
    for (const code of [...serverCodes(), ...clientCodes()]) {
      const hint = renderErrorHint(code) as string;
      expect(hint, code).not.toContain(code);
      expect(hint, code).toMatch(/[ぁ-んァ-ン一-龯]/);
    }
  });

  it('未知の code は null（生の message だけを出す）', () => {
    expect(renderErrorHint('no-such-code')).toBeNull();
  });

  it('extracts conditional object values without mistaking types and comments for emitted errors', () => {
    expect(sourceCodes(`type Error = {code: 'not-emitted'}; // code: 'comment'
      const error = {code: stopped ? 'cancelled' : (failed ? "native-render-failed" : 'storage-error')};`))
      .toEqual(['cancelled', 'native-render-failed', 'storage-error']);
    expect(() => sourceCodes('const error = {code: newDynamicCode};')).toThrow('Unexamined render error code');
  });

  it('does not silently ignore computed overrides, shorthand codes or later assignments', () => {
    expect(sourceCodes(`const error = Object.assign({code:'render-failed'}, {['code']:'reviewer-unmapped'});`))
      .toEqual(['render-failed', 'reviewer-unmapped']);
    expect(sourceCodes(`error.code = 'assigned'; error['code'] ??= 'fallback';`)).toEqual(['assigned', 'fallback']);
    expect(sourceCodes(`const error = Object.assign({code:'render-failed'}, new class { code = 'reviewer-unmapped'; });`))
      .toEqual(['render-failed', 'reviewer-unmapped']);
    expect(sourceCodes(`(error.code) = 'parenthesized';`)).toEqual(['parenthesized']);
    for (const src of ['const error = {[dynamicName]: value};', 'const error = {code};',
      'error[dynamicName] = value;', 'error.code = dynamicCode;', 'error.code += suffix;',
      "const error = new class { code = dynamicCode; };", "class Error { code: string; }",
      "class Error { constructor(public code: string) {} }", "[error.code] = [dynamicCode];",
      "const error = new class { constructor(public code = 'render-failed') {} }('reviewer-unmapped');",
      "({x:error.code} = {x:'reviewer-unmapped'});"]) {
      expect(() => sourceCodes(src), src).toThrow('Unexamined render error');
    }
  });
});
