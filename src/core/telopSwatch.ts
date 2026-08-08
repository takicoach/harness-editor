/**
 * スウォッチ表示用にテロップ文を整える。
 * 改行（\n）は保持する — スタイルやフォントサイズで実際の改行の見え方が変わるため、
 * 選択画面でも本物と同じ行構成を確認できるようにする。各行内の連続空白は半角スペース1つへ
 * 畳み、行ごとに max 文字で切る（超過時は末尾 …）。前後の空白・空行は除去する。
 */
export function clampSampleText(text: string, max = 12): string {
  return text
    .split('\n')
    .map((line) => {
      const oneLine = line.replace(/\s+/g, ' ').trim();
      return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
    })
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

/** スウォッチに表示するサンプル文字。空（や空白・改行のみ）は「あア」へフォールバック。 */
export function swatchSampleText(text: string): string {
  const s = clampSampleText(text);
  return s === '' ? 'あア' : s;
}
