import ts from 'typescript';

/**
 * データファイル（.ts）の export 値を「コードを実行せず」に取り出す静的リーダー。
 *
 * `evalDataModule`（vm 実行版）と同じ「export 名 → 値」のマップを返すが、こちらは
 * TypeScript の AST を歩いてリテラル/定数参照/オブジェクト/インデックスアクセスだけを
 * 評価する。関数呼び出し・任意式は一切評価しない（遭遇したら例外）。
 * 悪意あるプロジェクトの設定ファイルを一覧表示のために読む場面で、
 * 任意コード実行（`this.constructor.constructor('return process')()` 等）を根本的に防ぐ。
 *
 * サポートする式:
 * - 文字列 / 数値（負数含む）/ 真偽 / null / undefined リテラル
 * - `as const` / 型アサーション / satisfies / 括弧（中身へ素通し）
 * - 置換なしテンプレートリテラル
 * - 配列リテラル・オブジェクトリテラル（キーは識別子・文字列・数値）
 * - 同一ファイル内 const への識別子参照（前方・後方どちらも可・循環は例外）
 * - プロパティアクセス `a.b` / インデックスアクセス `MAP[KEY]`
 * それ以外（CallExpression・関数・演算など）は StaticEvalError を投げる。
 */
export class StaticEvalError extends Error {}

type Scope = Map<string, ts.Expression>;

const UNSUPPORTED = (node: ts.Node): never => {
  throw new StaticEvalError(`静的評価できない構文です（kind=${ts.SyntaxKind[node.kind]}）`);
};

/** prototype 汚染・prototype 辿りに繋がるキー（__proto__ / constructor / prototype）を拒否する。 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function assertSafeKey(key: string): void {
  if (FORBIDDEN_KEYS.has(key)) {
    throw new StaticEvalError(`禁止されたキーです: ${key}`);
  }
}

/** ソースから top-level の const 束縛（名前 → 初期化式）を集める。 */
function collectConstBindings(sourceFile: ts.SourceFile): Scope {
  const scope: Scope = new Map();
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.initializer) {
        scope.set(decl.name.text, decl.initializer);
      }
    }
  }
  return scope;
}

/** 識別子名 → 評価済み値。循環参照を検出するため resolving で経路を追う。 */
function makeEvaluator(scope: Scope, injected: Record<string, unknown>) {
  const memo = new Map<string, unknown>();
  const resolving = new Set<string>();

  const resolveIdentifier = (name: string): unknown => {
    if (memo.has(name)) return memo.get(name);
    // `in` は prototype チェーンを辿るため（'constructor' in {} が true）、own プロパティのみ見る。
    if (Object.prototype.hasOwnProperty.call(injected, name)) return injected[name];
    const init = scope.get(name);
    if (!init) throw new StaticEvalError(`未定義の識別子です: ${name}`);
    if (resolving.has(name)) throw new StaticEvalError(`循環参照です: ${name}`);
    resolving.add(name);
    const value = evalExpr(init);
    resolving.delete(name);
    memo.set(name, value);
    return value;
  };

  const propKey = (name: ts.PropertyName): string | number => {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
      if (ts.isNumericLiteral(name)) return Number(name.text);
      assertSafeKey(name.text);
      return name.text;
    }
    return UNSUPPORTED(name);
  };

  const evalExpr = (node: ts.Expression): unknown => {
    // 素通し系（型情報・括弧）
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) {
      return evalExpr(node.expression);
    }
    if (ts.isParenthesizedExpression(node)) return evalExpr(node.expression);

    // リテラル
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isIdentifier(node) && node.text === 'undefined') return undefined;

    // 負数・単項プラス
    if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
      const n = Number(node.operand.text);
      if (node.operator === ts.SyntaxKind.MinusToken) return -n;
      if (node.operator === ts.SyntaxKind.PlusToken) return n;
      return UNSUPPORTED(node);
    }

    // 識別子参照
    if (ts.isIdentifier(node)) return resolveIdentifier(node.text);

    // 配列
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.map((el) => {
        if (ts.isSpreadElement(el) || ts.isOmittedExpression(el)) return UNSUPPORTED(el);
        return evalExpr(el);
      });
    }

    // オブジェクト
    if (ts.isObjectLiteralExpression(node)) {
      const obj: Record<string, unknown> = {};
      for (const prop of node.properties) {
        if (ts.isPropertyAssignment(prop)) {
          obj[String(propKey(prop.name))] = evalExpr(prop.initializer);
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          assertSafeKey(prop.name.text);
          obj[prop.name.text] = resolveIdentifier(prop.name.text);
        } else {
          return UNSUPPORTED(prop);
        }
      }
      return obj;
    }

    // プロパティ / インデックスアクセス
    if (ts.isPropertyAccessExpression(node)) {
      const target = evalExpr(node.expression);
      return indexInto(target, node.name.text, node);
    }
    if (ts.isElementAccessExpression(node)) {
      const target = evalExpr(node.expression);
      const key = evalExpr(node.argumentExpression);
      return indexInto(target, key as string | number, node);
    }

    return UNSUPPORTED(node);
  };

  const indexInto = (target: unknown, key: string | number, node: ts.Node): unknown => {
    if (target === null || typeof target !== 'object') {
      throw new StaticEvalError(`オブジェクトでない値への参照です（${ts.SyntaxKind[node.kind]}）`);
    }
    // own プロパティのみ返す。prototype 由来（.constructor / .__proto__ 等）は
    // 関数値の生成やプロトタイプ辿りに繋がるため undefined 扱いにする。
    if (!Object.prototype.hasOwnProperty.call(target, key)) return undefined;
    return (target as Record<string | number, unknown>)[key];
  };

  return { resolveIdentifier, evalExpr };
}

/**
 * データファイルのソースから、export された束縛の「名前 → 値」マップを静的に得る。
 * @param source 評価対象の .ts ソース
 * @param injected import 相当の外部注入値（例: FPS / DURATION_FRAMES）。識別子として解決される。
 */
export function readModuleExportsStatic(
  source: string,
  injected: Record<string, unknown> = {},
): Record<string, unknown> {
  const sourceFile = ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, true);
  const scope = collectConstBindings(sourceFile);
  const { evalExpr } = makeEvaluator(scope, injected);

  const exportsMap: Record<string, unknown> = {};
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const isExported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!isExported) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.initializer) {
        // prototype を差し替えうる危険なキーは export 名としても拒否する。
        assertSafeKey(decl.name.text);
        exportsMap[decl.name.text] = evalExpr(decl.initializer);
      }
    }
  }
  return exportsMap;
}
