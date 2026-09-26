/**
 * e2e spec の「成果物の書き先」を静的に検査するための純関数群。
 *
 * ## 塞いだ穴の履歴
 *
 * 1. 最初の検査は `src.includes("'../docs/reports")` という**リテラル前方一致**だけを見ていた。
 *    同じディレクトリへ書く経路は他にいくらでもあり（`resolve(root, 'docs/reports/x')` /
 *    `join(root, 'docs', 'reports')` / `` `${base}/docs/reports` ``）、すべて素通りしていた。
 * 2. 次に自前の字句解析でコメントを潰し文字列リテラルを取り出したが、**正規表現リテラル**を
 *    知らなかった。`const re = /['"]/;` の `'` を文字列の開始と誤読して、その後ろの本物の
 *    リテラルを丸ごと飲み込む（実測: `trackedOutputOffenders` が本物の `'docs/reports/x'` を
 *    検出しなくなる）。**検査が黙って無力化する**＝ここで塞ぐべき fail-open そのもの。
 * 3. スクリーンショット検査が `.screenshot({ ... path: ... })` を正規表現 `\{[^}]*path\s*:`
 *    で見ており、`screenshot({ clip: { x: 0 }, path: out })` のように**入れ子のオブジェクト**が
 *    挟まると `[^}]*` が内側の `}` で止まって素通りしていた。
 *
 * 直し方: 自前の字句解析をやめ、**TypeScript の AST**（`ts.createSourceFile`）で読む。
 * 文字列リテラルもコメントも正規表現もテンプレートも、パーサが正しく分類したものだけを見る。
 * 「自前で書いた簡易パーサが言語の一部を知らない」という穴の作り方自体を断つ。
 */
import ts from 'typescript';

/** e2e が実行時に書き込んではいけない（＝コミット済み成果物が居る）ディレクトリ。 */
export const TRACKED_OUTPUT_ROOTS = ['docs'];

/** ソースを AST にする（構文エラーがあっても best-effort で読む）。 */
function parse(source: string, file = 'spec.ts'): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS);
}

/** 任意の順で AST を全走査する。 */
function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/**
 * ソース中の**文字列リテラルの中身**を取り出す。
 * 対象: `'x'` / `"x"` / `` `x` `` / テンプレート内の固定部分（`` `${base}/docs/reports` `` の
 * `/docs/reports` を拾うため）。コメント・正規表現リテラルは AST 上そもそも別物なので混ざらない。
 */
export function stringLiterals(source: string): string[] {
  const out: string[] = [];
  walk(parse(source), (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push(node.text);
      return;
    }
    // テンプレートリテラルの固定部分（head / middle / tail）。
    if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      out.push(node.text);
    }
  });
  return out;
}

/** リテラルがパスセグメントとして `root` を含むか（`docs` / `../docs/reports` / `x/docs`）。 */
export function mentionsPathSegment(literal: string, root: string): boolean {
  return new RegExp(`(^|[\\\\/])${root}([\\\\/]|$)`).test(literal);
}

export interface SpecSource {
  file: string;
  source: string;
}

/**
 * 追跡ディレクトリを出力先として組み立てている spec を挙げる。
 * 出力先は必ず tests/shotDir.ts（通常ランは .aaa-shots、証拠更新は AAA_UPDATE_EVIDENCE=1）を通す。
 */
export function trackedOutputOffenders(specs: SpecSource[]): string[] {
  const offenders: string[] = [];
  for (const { file, source } of specs) {
    for (const literal of stringLiterals(source)) {
      for (const root of TRACKED_OUTPUT_ROOTS) {
        if (mentionsPathSegment(literal, root)) offenders.push(`${file} -> ${JSON.stringify(literal)}`);
      }
    }
  }
  return offenders;
}

/** 呼び出しが `<何か>.screenshot(...)` か。 */
function isScreenshotCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'screenshot'
  );
}

/** その呼び出しの引数のどこかに `path:` プロパティがあるか（入れ子の clip 等に惑わされない）。 */
function hasPathOption(call: ts.CallExpression): boolean {
  let found = false;
  for (const arg of call.arguments) {
    walk(arg, (n) => {
      if (!ts.isPropertyAssignment(n) && !ts.isShorthandPropertyAssignment(n)) return;
      const name = n.name;
      const key = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
      if (key === 'path') found = true;
    });
  }
  return found;
}

/**
 * スクリーンショットを撮る spec が、出力先を shotDir 経由で決めているか。
 * （追跡ディレクトリ名を書かなくても、変数で組み立てて任意の場所へ書けてしまうため、
 *   「書き先の決定を1箇所に集める」という構造の側も固定する。）
 */
export function screenshotWithoutShotDir(specs: SpecSource[]): string[] {
  const offenders: string[] = [];
  for (const { file, source } of specs) {
    const sf = parse(source, file);
    let writes = false;
    let importsShotDir = false;
    walk(sf, (node) => {
      if (isScreenshotCall(node) && hasPathOption(node)) writes = true;
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === './shotDir'
      ) {
        importsShotDir = true;
      }
    });
    if (writes && !importsShotDir) offenders.push(file);
  }
  return offenders;
}
