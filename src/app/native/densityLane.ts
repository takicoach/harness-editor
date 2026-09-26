/** F10: クリップ幅の中央値がこれ未満のトラックは、314 個の角丸ピルではなく 1 本の SVG（密度帯）で描く。 */
export const DENSITY_BELOW=24;
/** クリップ幅がこれ未満なら「細い」（data-narrow・密度帯の下見判定）。挙動は変えず、裸の 40 を 1 か所に出す。 */
export const NARROW_CLIP_BELOW=40;
export const DENSITY_MIN_CLIPS=8;
/**
 * クリップ幅（px）の中央値。件数が偶数のときは平均せず**上側**の値を返す（`widths[length/2]`）。
 * `pixels` が 0（未計測のズーム）なら全幅 0 なので 0 を返す = 閾値未満 = 密度帯側に倒れる。
 * クリップが 0 件なら Infinity（`laneMode` が件数で先に弾くので、ここでは「細くない」に倒す）。
 */
export function medianClipWidth(clips:ReadonlyArray<{durationFrames:number}>,pixels:number):number{
  if(!clips.length)return Infinity;
  const widths=clips.map(c=>c.durationFrames*pixels).sort((a,b)=>a-b);
  return widths[Math.floor(widths.length/2)]!;
}
/** 8 件以上 かつ 幅の中央値が 24px 未満なら密度帯。呼び手（NativeTimeline）は仕上げ表示・ゴースト・選択中を先に除く。 */
export function laneMode(clips:ReadonlyArray<{durationFrames:number}>,pixels:number):'clips'|'density'{
  if(clips.length<DENSITY_MIN_CLIPS)return 'clips';
  return medianClipWidth(clips,pixels)<DENSITY_BELOW?'density':'clips';
}
