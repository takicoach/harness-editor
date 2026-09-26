/**
 * 撮影フレームの run 圧縮（同じ内容が続くフレームを1枚の代表 PNG にまとめる）。
 *
 * 契約: run 圧縮の比較対象は「正規化済み RGBA」である。呼び出し側が事前に normalizeRgba を
 * 通したバッファを渡すこと。これは PNG バイト列同士の比較ではなく、decode 済み RGBA の
 * 内容比較であることを明確にするため。
 *
 * I-1（正本統一）: run 圧縮の実装は captureDriver.ts の runCapture() 内にある逐次実装が
 * 正本（フレームを1本ずつ撮りながら直前フレームと比較し、run が切り替わった時点で即座に
 * 代表 PNG を書き出して手放す — captureDriver.ts 冒頭のメモリ設計コメント参照）。
 * かつて本ファイルには全フレームを配列で受け取ってから一括圧縮する compressRuns()
 * （バッチ版）があったが、production 経路のどこからも呼ばれておらず（captureDriver.ts は
 * 独自の逐次比較ロジックを直接持つ）、2実装が並存していた。バッチ版は撮影スケール
 * （数百〜数千フレームの正規化バッファ）を配列で保持する設計であり、captureDriver.ts の
 * メモリ設計（保持量をフレーム1枚分に抑える）と根本的に相容れないため、統合ではなく削除で
 * 正本を1つにした。本ファイルに残るのは、両方の実装が共有していた normalizeRgba のみ。
 */

export interface RgbaFrame {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * 完全透明画素（A=0）の RGB を 0 に正規化する。透明色成分の違いによる誤った run 分断を防ぐ。
 * A>0 の画素は無変換。入力バッファは破壊しない（新規 Uint8Array を返す）。
 */
export function normalizeRgba(frame: RgbaFrame): Uint8Array {
  const src = frame.data;
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3] ?? 0;
    if (a === 0) {
      out[i] = 0;
      out[i + 1] = 0;
      out[i + 2] = 0;
      out[i + 3] = 0;
    } else {
      out[i] = src[i] ?? 0;
      out[i + 1] = src[i + 1] ?? 0;
      out[i + 2] = src[i + 2] ?? 0;
      out[i + 3] = a;
    }
  }
  return out;
}

