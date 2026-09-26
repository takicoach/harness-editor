/** F2: ヘッダーは 1 段 52px 固定。幅がこの値未満なら右側を段階的に縮める（ブランド名を隠す・「AI の作業」はアイコンだけ・自動保存はスイッチだけ）。 */
export const HEADER_COMPACT_BELOW=1200;
export function headerCompact(width:number):boolean{
  return Number.isFinite(width)&&width>0&&width<HEADER_COMPACT_BELOW;
}
