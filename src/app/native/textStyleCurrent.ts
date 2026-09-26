import type {SequenceAsset} from '../../core/sequence/model';
import type {TextContent} from '../../core/sequence/textStyle';

/** 現在のスタイル（F15 の 1 行に出す）。資産はスタイル一覧が選んでいるもの（textComponentId か先頭）。 */
export function currentStyleEntry(assets:readonly SequenceAsset[],content:TextContent,assetId:string|undefined):{asset:SequenceAsset;entry:{id:number;name:string}}|null{
  const asset=assets.find(a=>a.id===assetId)??assets[0];
  const entries=asset?.textStyleCatalog?.entries;
  if(!asset||!entries?.length)return null;
  const wanted=content.data.template??1;   // TextContent はテロップ専用の型（textStyle.ts:3）
  const entry=entries.find(e=>e.id===wanted)??entries[0]!;
  return {asset,entry:{id:entry.id,name:entry.name}};
}
