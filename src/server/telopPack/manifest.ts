/** テロップパック1件の定義。id はテロップの template 番号に対応する。 */
export interface TelopPackEntry {
  /** template 番号（1..TELOP_PACK_COUNT）。 */
  id: number;
  /** UI 表示名（日本語）。 */
  name: string;
  /** styles/ 配下のコンポーネント export 名（= ファイル名の語幹）。 */
  exportName: string;
  /** styles/ 配下のファイル名。 */
  file: string;
}

/**
 * マニフェスト（固定順・id=配列順）。id 1 は既定フォールバック。
 *
 * 同梱するのは TAKICOACH オリジナルの白黒シンプル3種のみ。
 * 番号は拡張テロップパック（30種）の 01〜03 と一致させてあるので、
 * 拡張版を導入したプロジェクトでも同じ番号が同じ見た目になる。
 */
export const TELOP_PACK: readonly TelopPackEntry[] = [
  { id: 1, name: 'クラシック白抜き', exportName: 'ClassicOutline', file: 'ClassicOutline.tsx' },
  { id: 2, name: 'ブラックバー', exportName: 'BlackBar', file: 'BlackBar.tsx' },
  { id: 3, name: 'ホワイトバー', exportName: 'WhiteBar', file: 'WhiteBar.tsx' },
];

export const TELOP_PACK_COUNT = TELOP_PACK.length;
