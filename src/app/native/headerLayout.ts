/** F2: ヘッダーは 1 段 52px 固定。幅がこの値未満なら右側を段階的に縮める（ブランド名を隠す・「AI の作業」はアイコンだけ・自動保存はスイッチだけ）。
 *  モードが 4 つ（サムネを追加）になったぶん、1200 から 1280 に上げた。 */
export const HEADER_COMPACT_BELOW=1280;
export function headerCompact(width:number):boolean{
  return Number.isFinite(width)&&width>0&&width<HEADER_COMPACT_BELOW;
}
