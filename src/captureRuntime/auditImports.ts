// M2a: 監査済みコンポーネントAPIの機械抽出と対応表。
// 対象範囲: remotion / @harness/frame-runtime の named import。'@remotion/*' はすべて未監査扱い。
//
// 既知の限界（正規表現ベースの静的抽出のため）:
// (a) 別名のローカルバレル経由の re-export は、モジュール指定子が 'remotion' でも
//     '@remotion/*' でもないため素通りする。native部品のコンパイルでは別途
//     server/sequence/components.ts がローカル依存とフレームAPIのexport面を検査する。
// (b) 再エクスポート文（`export {X} from 'remotion'`）・動的 `import('remotion')`・
//     `require('remotion')` は検出しない（静的な named import 文のみが対象）。
// (c) 粒度はシンボル単位までで、メンバー/オプション粒度は検出できない（I-3）。
//     例: `Easing` を import して `Easing.bezier` を呼ぶ・`interpolate` に `posterize` を
//     渡す・`spring` に `durationInFrames` を渡す、といった「シンボルは監査済みだが
//     使用しているメンバー/オプションは captureRuntime 未実装」のケースは、本モジュールの
//     判定では unaudited に出ない（対象コンポーネント側の未実装オプションは spring.ts/
//     interpolate.ts の明示 throw に委ねている — unsupportedOptions.test.ts 参照）。

/** 監査済み（撮影契約で挙動を検証済み）とみなす 'remotion' シンボル */
export const AUDITED_API: readonly string[] = [
  'useCurrentFrame',
  'useVideoConfig',
  'interpolate',
  'spring',
  'Easing',
  'Sequence',
  'AbsoluteFill',
  'staticFile',
  'Img',
];

/**
 * ソース文字列から remotion / @harness/frame-runtime / @remotion/* の import 文を抽出する。
 * - named import のみ対象。type-only import（`import type {...}` および inline `type X`）は除外。
 * - default import / namespace import (`* as`) は監査不能のため symbols: ['*'] を返す。
 */
export function extractRemotionImports(
  source: string,
): { module: string; symbols: string[] }[] {
  const results: { module: string; symbols: string[] }[] = [];

  // import 文全体（複数行対応）を先頭から拾う: import ... from '...';
  const importRe = /import\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;

  while ((match = importRe.exec(source)) !== null) {
    const typeOnly = match[1];
    const clause = match[2] ?? '';
    const moduleName = match[3] ?? '';

    if (moduleName !== 'remotion' && moduleName !== '@harness/frame-runtime' && !moduleName.startsWith('@remotion/')) {
      continue;
    }

    // `import type { ... } from 'remotion'` は型のみなので除外
    if (typeOnly) {
      continue;
    }

    const trimmedClause = clause.trim();

    // namespace import: * as X
    if (/^\*\s+as\s+/.test(trimmedClause)) {
      results.push({ module: moduleName, symbols: ['*'] });
      continue;
    }

    // named import 部分 `{ A, B as C, type D }` を抽出（default + named の混在にも対応）
    const namedMatch = trimmedClause.match(/\{([\s\S]*)\}/);

    if (!namedMatch) {
      // named import が無い = default import のみ
      results.push({ module: moduleName, symbols: ['*'] });
      continue;
    }

    const beforeBrace = trimmedClause.slice(0, trimmedClause.indexOf('{')).trim();
    const hasDefaultImport = beforeBrace.replace(/,$/, '').trim().length > 0;

    if (hasDefaultImport) {
      results.push({ module: moduleName, symbols: ['*'] });
      continue;
    }

    const namedBody = namedMatch[1] ?? '';
    const symbols = namedBody
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      // inline `type X` 修飾を除外
      .filter((s) => !/^type\s+/.test(s))
      // `Foo as Bar` は現地シンボル名（元の輸入元シンボル Foo）を使う
      .map((s) => (s.split(/\s+as\s+/)[0] ?? s).trim());

    if (symbols.length > 0) {
      results.push({ module: moduleName, symbols });
    }
  }

  return results;
}

/**
 * 複数ファイルの 'remotion' / '@remotion/*' import を監査し、AUDITED_API に無いシンボルを列挙する。
 * unaudited が空のファイルは結果に含めない。
 */
export function auditOverlayImports(
  files: { path: string; source: string }[],
  auditedApi: readonly string[] = AUDITED_API,
): { path: string; unaudited: string[] }[] {
  const results: { path: string; unaudited: string[] }[] = [];

  for (const file of files) {
    const imports = extractRemotionImports(file.source);
    const unaudited: string[] = [];

    for (const imp of imports) {
      if (imp.module === 'remotion' || imp.module === '@harness/frame-runtime') {
        for (const symbol of imp.symbols) {
          if (symbol === '*' || !auditedApi.includes(symbol)) {
            unaudited.push(symbol);
          }
        }
      } else {
        // '@remotion/*' はすべて未監査
        unaudited.push(...imp.symbols);
      }
    }

    if (unaudited.length > 0) {
      results.push({ path: file.path, unaudited });
    }
  }

  return results;
}
