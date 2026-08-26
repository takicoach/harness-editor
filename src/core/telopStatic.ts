import ts from 'typescript';

/**
 * telopData.ts の「エントリ有無」を VM 評価なしで三値判定する静的抽出器。
 * ホーム一覧（scanProjects）は未オープンプロジェクトのコードを実行しない方針のため、
 * evalDataModule（vm 実行版 parseTelopData）はここでは使わない
 * （Codex レビュー P1「telopData VM 評価矛盾」対応）。
 * 判定は `export const telopData = [...]` の配列リテラル要素数のみ。値は評価しない。
 */
export type TelopEntriesState = 'empty' | 'nonempty' | 'invalid';

/** as const / satisfies / 型アサーション / 括弧を剥がして中身の式を返す。 */
function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isTypeAssertionExpression(e) ||
    ts.isParenthesizedExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/**
 * 構文エラーの有無。TypeScript のパーサはエラー回復するため（`[ {` は 1 要素の配列として
 * 復元される）、要素数を信じる前に構文の健全性を確かめる必要がある。
 * parseDiagnostics は公開型に無いため構造的に読み、取得できない環境では「壊れていない」扱い。
 */
function hasSyntaxError(sf: ts.SourceFile): boolean {
  const diagnostics = (sf as unknown as { parseDiagnostics?: readonly unknown[] })
    .parseDiagnostics;
  return Array.isArray(diagnostics) && diagnostics.length > 0;
}

/**
 * `export const <exportName> = [...]` の要素数を三値判定する（値は評価しない）。
 * telopData だけでなく seData / bgmData など「雛形が空配列で同梱される」データ
 * ファイル全般に使う — ファイルの**有無**で判定すると、雛形のまま 1 度も編集して
 * いない工程が「済」になるため。
 */
export function exportedArrayEntriesState(
  source: string,
  exportName: string,
): TelopEntriesState {
  // setParentNodes=false: この判定は親ノードを一切辿らないため、親リンク生成の分だけ
  // 無駄なパースコストになる（一覧走査は全プロジェクト分を毎回読む）。
  const sf = ts.createSourceFile(`${exportName}.ts`, source, ts.ScriptTarget.Latest, false);
  if (hasSyntaxError(sf)) return 'invalid';
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const exported =
      stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (!exported) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== exportName) continue;
      if (decl.initializer === undefined) return 'invalid';
      const init = unwrap(decl.initializer);
      if (!ts.isArrayLiteralExpression(init)) return 'invalid';
      // spread は件数を静的確定できないため invalid（評価はしない）。
      if (init.elements.some((el) => ts.isSpreadElement(el))) return 'invalid';
      return init.elements.length === 0 ? 'empty' : 'nonempty';
    }
  }
  return 'invalid';
}

export function telopEntriesState(source: string): TelopEntriesState {
  return exportedArrayEntriesState(source, 'telopData');
}
