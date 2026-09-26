/**
 * 全スタイル共通で描ける 8 種（`none` ＋ パック wrapper が当てる 7 種）。
 * `charByChar` はスタイル側の実装（字形の分割配置）が要るので含めない。
 */
export const TELOP_PACK_BASE_ANIMATIONS: readonly string[] = Object.freeze([
  'none', 'slideIn', 'fadeOnly', 'slideFromLeft', 'fadeBlurFromBottom',
  'slideLeftFadeBlur', 'fadeFromRight', 'fadeFromLeft',
]);
/** 無料版の3種はどれも `charByChar` を描かない（有料のテロップパックでは 1 種が描く）。 */
export const TELOP_PACK_CHAR_BY_CHAR_STYLE_ID: number | null = null;

/** テロップパック1件の定義。id はテロップの template 番号に対応する。 */
export interface TelopPackEntry {
  /** template 番号（1..3）。 */
  id: number;
  /** UI 表示名（日本語）。 */
  name: string;
  /** styles/ 配下のコンポーネント export 名（= ファイル名の語幹）。 */
  exportName: string;
  /** styles/ 配下のファイル名。 */
  file: string;
  /** このスタイルが実際に描ける動き。名乗るだけで動かない状態を作らない（裁定 5）。 */
  animations: readonly string[];
}

/**
 * 同梱するのは TAKICOACH オリジナルの白黒シンプル3種だけ（0.3.1 と同じ）。
 * 番号は有料のテロップパックとは別の見た目。パックを導入すると 1〜3 番は有料版のスタイルに置き換わる。
 */
const TELOP_PACK_STYLES: readonly Omit<TelopPackEntry, 'animations'>[] = [
  { id: 1, name: 'クラシック白抜き', exportName: 'ClassicOutline', file: 'ClassicOutline.tsx' },
  { id: 2, name: 'ブラックバー', exportName: 'BlackBar', file: 'BlackBar.tsx' },
  { id: 3, name: 'ホワイトバー', exportName: 'WhiteBar', file: 'WhiteBar.tsx' },
];

/** マニフェスト（固定順・id=配列順）。id 1 は既定フォールバック。 */
export const TELOP_PACK: readonly TelopPackEntry[] = TELOP_PACK_STYLES.map(entry => ({
  ...entry,
  animations: entry.id === TELOP_PACK_CHAR_BY_CHAR_STYLE_ID
    ? Object.freeze([...TELOP_PACK_BASE_ANIMATIONS, 'charByChar'])
    : TELOP_PACK_BASE_ANIMATIONS,
}));

export const TELOP_PACK_COUNT = TELOP_PACK.length;
