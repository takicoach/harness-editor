import {useState} from 'react';
import {MAX_COPY_ITEMS,ceilGigabytes,formatMinutes,type SlowMediaAdvice} from '../../shared/mediaCopy';
import './native-media-copy.css';

/**
 * 案内の本文（2026-10-06 決定。開いた時の案内と追加時の束で同じ文）。複数本の時は本数と合計の大きさ
 * （コピー先の選択の「コピーする量」と同じ切り上げ）を添える。見込みは照合の秒の合計を分に切り上げる。
 */
export const slowMediaMessage=(count:number,totalBytes:number,totalSeconds:number)=>
  `この素材${count>1?`（${count}本・合計 ${ceilGigabytes(totalBytes)} GB）`:''}は読み込みに時間がかかる場所にあります（確認に約${formatMinutes(totalSeconds)}分の見込み）。速いドライブへコピーしてから使うと、起動と再生が速くなります。`;
/** ［このまま使う］の横の「今後この場所では出さない」（押した時に選んでいれば keep-always、何も選ばなければ今回だけ）。 */
export const KEEP_ALWAYS_LABEL='今後この場所では出さない';
/** 「今後この場所では出さない」を選んだ時だけ添える（ドライブを識別できない素材は記録できない）。開いた時と追加時で同じ文。 */
export const unknownDriveNote=(names:readonly string[])=>`ドライブを識別できない素材（${names.join('、')}）は、今回だけこのまま使います。`;
/** 一覧の1行: 複数本の時だけ1本ずつの見込みを添える（1本なら本文の見込みと同じ）。開いた時と追加時で同じ書き方。 */
export const slowItemLabel=(name:string,seconds:number|undefined,several:boolean)=>several&&seconds!==undefined?`${name}（約${formatMinutes(seconds)}分）`:name;
/** 1回のコピーの上限を超えて並べなかった素材の本数（2026-10-06 決定）。 */
export const moreSlowNote=(more:number)=>`ほかに ${more} 本あります（この${MAX_COPY_ITEMS}本の後に案内します）`;

/**
 * 開いた時の案内（設計 §1・§2）。ボタンは［コピーして使う］［このまま使う］の2つ。
 * 「今後この場所では出さない」は、ドライブを識別できる素材が1本も無ければ出さない（記録できない。混じる時は、選んだ時だけ識別できない素材が今回だけになると添える）。
 * 記録の送信中（onKeepAlways の Promise が終わるまで）は［このまま使う］とその選択を押せない。失敗したら押し直せる。手でコピーする入口は素材行にも常にある。
 */
export function NativeSlowMediaAdvice({advice,disabled,onCopy,onKeepOnce,onKeepAlways}:{advice:SlowMediaAdvice;disabled:boolean;onCopy(ids:string[]):void;onKeepOnce(ids:string[]):void;onKeepAlways(ids:string[]):void|Promise<unknown>}){
  const [always,setAlways]=useState(false),[saving,setSaving]=useState(false);
  if(!advice.targets.length)return null;
  const ids=advice.targets.map(target=>target.assetId),unknown=advice.targets.filter(target=>target.canRemember===false),rememberable=unknown.length<advice.targets.length,several=advice.targets.length>1;
  return <div className="native-slow-media" role="status" data-slow-media-advice="">
    <p>{slowMediaMessage(advice.targets.length,advice.totalBytes,advice.totalSeconds)}</p>
    {advice.unmeasured>0&&<p className="native-subtle">{`まだ読み取りの速さを測れていない素材が ${advice.unmeasured} 本あります。`}</p>}
    <ul>{advice.targets.map(target=><li key={target.assetId}>{slowItemLabel(target.name,target.seconds,several)}</li>)}</ul>
    {(advice.more??0)>0&&<p className="native-subtle">{moreSlowNote(advice.more!)}</p>}
    {rememberable&&always&&unknown.length>0&&<p className="native-subtle">{unknownDriveNote(unknown.map(target=>target.name))}</p>}
    <div className="native-import-actions">
      <button type="button" className="btn-tonal" disabled={disabled} onClick={()=>onCopy(ids)}>コピーして使う</button>
      <button type="button" className="btn-ghost" disabled={saving} onClick={()=>{
        if(!(rememberable&&always)){onKeepOnce(ids);return;}
        setSaving(true);void Promise.resolve(onKeepAlways(ids)).catch(()=>undefined).finally(()=>setSaving(false));
      }}>このまま使う</button>
      {rememberable&&<label className="native-slow-keep"><input type="checkbox" disabled={saving} checked={always} onChange={event=>setAlways(event.target.checked)}/>{KEEP_ALWAYS_LABEL}</label>}
    </div>
  </div>;
}
