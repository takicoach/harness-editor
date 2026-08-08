/**
 * source[openIndex] の開き括弧 '[' に対応する閉じ括弧 ']' の位置を返す。
 * 文字列リテラル（" ' `）内の括弧は無視し、バックスラッシュエスケープを扱う。
 * 行コメント（//）およびブロックコメント内の括弧も無視する。
 */
export function matchBracket(source: string, openIndex: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    // 文字列外でのコメント検出
    if (ch === '/' && i + 1 < source.length) {
      const next = source[i + 1];
      if (next === '/') {
        // 行コメント: 改行まで読み飛ばす
        i += 2;
        while (i < source.length && source[i] !== '\n') {
          i++;
        }
        continue;
      } else if (next === '*') {
        // ブロックコメント: */ まで読み飛ばす
        i += 2;
        while (i + 1 < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
          i++;
        }
        i++; // '/' をスキップ
        continue;
      }
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === '[') {
      depth++;
    } else if (ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error('対応する閉じ括弧が見つかりません');
}

/**
 * `export const <name> ... = [ ... ]` の配列リテラル部分を newLiteral へ差し替える。
 * import 文・ヘッダコメント・他の export はそのまま保持される。
 */
export function replaceExportArray(
  source: string,
  exportName: string,
  newLiteral: string,
): string {
  // 名前と代入の '=' の間には型注釈（例: `: TelopSegment[]`）が入りうる。
  // 型注釈に '=' は現れないため [^=]* で安全に走査でき、'[]' を含む型注釈も越えられる。
  const escaped = exportName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`export\\s+const\\s+${escaped}\\b[^=]*=\\s*\\[`);
  const m = re.exec(source);
  if (!m) {
    throw new Error(`export const ${exportName} の配列が見つかりません`);
  }
  const arrayStart = m.index + m[0].length - 1; // '[' の位置
  const arrayEnd = matchBracket(source, arrayStart); // 対応する ']'
  return source.slice(0, arrayStart) + newLiteral + source.slice(arrayEnd + 1);
}
