import {useEffect,useState} from 'react';
import type {SequenceAsset,SequenceDocument} from '../../core/sequence/model';
import {timeNumber} from '../../core/sequence/time';
import {trialCandidates,trialSwapKind,trialUsage,type TrialEndMode,type TrialSwapNote} from '../../core/sequence/trialSwap';
import type {TrialSwapError,TrialSwapState} from './useTrialSwap';
import {materialTabOf,MATERIAL_TAB_EMPTY} from './materialTab';

export interface TrialSwapControls {trial:TrialSwapState|null;error:TrialSwapError|null;disabled:boolean;onStart(assetId:string):void;onChoose(assetId:string):void;onEndMode(mode:TrialEndMode):void}
interface Props extends TrialSwapControls {document:SequenceDocument;clipId:string;projectId:string}

const NOTE_TEXT:Record<Exclude<TrialSwapNote,'rate'>,string>={'from-start':'曲の頭から再生します','from-cut-head':'カットした部分を含めて曲の頭から数えるため、途中から再生します',muted:'ミュート中です',short:'曲が途中で終わります','short-if-restored':'カットを戻すと曲が途中で終わります'};
const ASPECT_NOTE='縦横比が違うため、見える大きさや切り抜きが変わります';
const assetUrl=(projectId:string,assetId:string)=>`/api/sequence/asset?${new URLSearchParams({id:projectId,asset:assetId})}`;
const clock=(asset:SequenceAsset)=>{
  const stream=asset.streams.filter(s=>s.kind==='audio').sort((a,b)=>a.index-b.index)[0];
  if(!stream)return '';
  const sec=Math.floor(timeNumber(stream.duration));return `${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`;
};
/** 読み込めた2枚の縦横比が1%を超えて違うか。読み込み失敗は false（案内を出さない）。 */
function useAspectDiffers(projectId:string,candidate:string|null,base:string|null){
  const [differs,setDiffers]=useState(false);
  useEffect(()=>{
    setDiffers(false);
    if(!candidate||!base||candidate===base)return;
    let live=true;const sizes:Record<string,number>={};
    const load=(key:string,assetId:string)=>{
      const img=new Image();
      img.onload=()=>{
        if(!live)return;
        const w=img.naturalWidth||img.width,h=img.naturalHeight||img.height;
        if(!w||!h)return;
        sizes[key]=w/h;
        if(sizes.candidate&&sizes.base)setDiffers(Math.abs(sizes.candidate/sizes.base-1)>.01);
      };
      img.src=assetUrl(projectId,assetId);
    };
    load('candidate',candidate);load('base',base);
    return ()=>{live=false;};
  },[projectId,candidate,base]);
  return differs;
}

export function NativeTrialSwapSection({document:doc,clipId,projectId,trial,error,disabled,onStart,onChoose,onEndMode}:Props){
  const clip=doc.clips.find(c=>c.id===clipId),kind=clip?trialSwapKind(clip):null;
  // 同じ使用箇所（カットで分かれた2片目など）を選んでいても同じ試しとして扱い、候補は切替にする（始め直さない）。
  const active=trial&&trial.result.clipIds.includes(clipId)?trial:null;
  const baseClip=active?.base.document.clips.find(c=>c.id===clipId);
  const baseAssetId=kind&&baseClip&&(baseClip.content.kind==='image'||baseClip.content.kind==='audio')?baseClip.content.assetId:null;
  const currentId=clip&&(clip.content.kind==='image'||clip.content.kind==='audio')?clip.content.assetId:null;
  const aspectDiffers=useAspectDiffers(projectId,kind==='image'&&active?active.assetId:null,kind==='image'?baseAssetId:null);
  if(!clip||!kind)return null;
  const candidates=trialCandidates(doc,clipId).filter(a=>kind==='image'||materialTabOf(doc,a)==='bgm');
  const off=disabled||!!active?.adopting;
  const result=active?.result;
  const notes=active&&result?result.notes.map(n=>n==='rate'?`速度 ×${result.rate} を引き継ぎます`:NOTE_TEXT[n]):[];
  const short=!!result?.notes.some(n=>n==='short'||n==='short-if-restored');
  // 理由は、このクリップの使用箇所で出たものだけ出す（BGM の理由を画像の節に出さない）。
  const reason=error&&trialUsage(doc,clipId).some(c=>c.id===error.clipId)?error.message:'';
  return <section data-setting="trial-swap" data-trial-kind={kind}><h3>素材を試す</h3>
    {candidates.length===0?<p className="native-subtle">{MATERIAL_TAB_EMPTY[kind==='image'?'image':'bgm']}</p>
      :<div className="native-trial-candidates">{candidates.map(asset=>{
        const current=asset.id===currentId;
        return <button key={asset.id} type="button" className="native-text-button" aria-pressed={active?.assetId===asset.id} disabled={off||current}
          onClick={()=>active?onChoose(asset.id):onStart(asset.id)}>{asset.name}{current&&'（使用中）'}{active?.assetId===asset.id&&'（試し中）'}{kind==='music'&&clock(asset)&&` ${clock(asset)}`}</button>;})}</div>}
    {notes.map(text=><p key={text} className="native-subtle">{text}</p>)}
    {active&&short&&<div role="radiogroup" className="native-trial-end">
      <label className="native-check"><input type="radio" name={`trial-end-${clipId}`} checked={active.endMode==='loop'} disabled={off} onChange={()=>onEndMode('loop')}/>ループ（既定）</label>
      {result?.silenceAllowed&&<label className="native-check"><input type="radio" name={`trial-end-${clipId}`} checked={active.endMode==='silence'} disabled={off} onChange={()=>onEndMode('silence')}/>無音で終わる（フェードアウトはかかりません）</label>}
    </div>}
    {kind==='image'&&aspectDiffers&&<p className="native-subtle">{ASPECT_NOTE}</p>}
    {reason&&<p role="alert" className="native-error">{reason}</p>}
  </section>;
}
