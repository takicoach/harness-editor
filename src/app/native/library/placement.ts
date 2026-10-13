import type {SequenceAsset,SequenceClip,SequenceDocument,SequenceTrack} from '../../../core/sequence/model';
import {clipEnd} from '../../../core/sequence/model';
import type {SequenceCommand} from '../../../core/sequence/commands';
import {ceilTime,multiplyTime,rational,timeNumber} from '../../../core/sequence/time';
import {DEFAULT_MAIN_LAYOUT} from '../../../core/mainLayout';
import {DEFAULT_MAIN_AUDIO} from '../../../core/mainAudio';
import {hasSceneFade,sceneFadeInsertionIndex} from '../../../core/sequence/sceneFadeEdits';
import type {LibraryCatalog,LibraryMedia,LibraryTemplate} from './libraryApi';

export type LibraryTarget={kind:'template';item:LibraryTemplate}|{kind:'media';item:LibraryMedia};
export type PlacementResult={commands:SequenceCommand[];selectId:string}|{error:string};
export const MOTION_TRACK_NAME='素材置場（モーション）';
const defaultId=()=>crypto.randomUUID();

export function findLibraryTarget(catalog:LibraryCatalog,key:string):LibraryTarget|null{
  const t=catalog.templates.find(x=>x.key===key);if(t)return {kind:'template',item:t};
  const m=catalog.media.find(x=>x.key===key);return m?{kind:'media',item:m}:null;
}

/** 媒体・画像を置く共通部分。NativeWorkspace.insertAsset の段選びとクリップ形そのもの（挙動不変）。 */
export function buildMediaPlacement(doc:SequenceDocument,asset:SequenceAsset,at:number,targetTrackId?:string,
  options:{role?:'music'|'effect';gainDb?:number;loop?:boolean}={},newId:()=>string=defaultId):PlacementResult{
  const {role}=options;
  const video=asset.streams.find(s=>s.kind==='video'),audio=asset.streams.find(s=>s.kind==='audio');
  const target=doc.tracks.find(t=>t.id===targetTrackId),audioOnly=!video&&asset.kind!=='image'||target?.kind==='audio';
  if(target&&hasSceneFade(doc,target.id))return {error:'場面フェードのトラックです。映像または音声のトラックを選んでください。'};
  if(audioOnly&&!audio)return {error:'音声がない素材です。映像トラックへ配置してください。'};
  const source=audioOnly?audio:video,duration=source?ceilTime(multiplyTime(source.duration,doc.fps)):Math.round(timeNumber(doc.fps)*5);
  const operations:SequenceCommand[]=[],occupied=(track:SequenceTrack)=>doc.clips.some(c=>c.trackId===track.id&&c.startFrame<at+duration&&clipEnd(c)>at);
  const getTrack=(kind:'visual'|'audio',preferred?:SequenceTrack)=>{
    if(preferred&&preferred.kind===kind)return preferred.id;
    const available=doc.tracks.find((t,i)=>t.kind===kind&&!occupied(t)&&(kind==='audio'||!hasSceneFade(doc,t.id)&&i<sceneFadeInsertionIndex(doc)));if(available)return available.id;
    const track:SequenceTrack={id:newId(),kind,enabled:true,name:`${kind==='visual'?'映像':'音声'}${doc.tracks.filter(t=>t.kind===kind).length+1}`};
    operations.push({type:'add-track',track,...(kind==='visual'?{index:sceneFadeInsertionIndex(doc)}:{})});return track.id;
  };
  const clock={offset:rational(0),rate:rational(1),duration:rational(duration)},clips:SequenceClip[]=[];
  const link=video&&audio&&!audioOnly?newId():undefined,assetId=asset.id;
  if(!audioOnly)clips.push({id:newId(),name:asset.name,trackId:getTrack('visual',target),startFrame:at,durationFrames:duration,clock,linkGroupId:link,
    visual:{layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[]},content:video
      ?{kind:'video',assetId,streamIndex:video.index,sourceIn:rational(0),rate:rational(1)}:{kind:'image',assetId,style:'plain'}});
  if(audio)clips.push({id:newId(),name:video?`${asset.name} 原音`:asset.name,trackId:getTrack('audio',audioOnly?target:undefined),startFrame:at,durationFrames:duration,clock,linkGroupId:link,
    content:{kind:'audio',assetId,streamIndex:audio.index,sourceIn:rational(0),rate:rational(1),role:role??(video?'speech':'music'),loop:options.loop??(role==='effect'?false:!video),
      settings:{...DEFAULT_MAIN_AUDIO,...(options.gainDb!==undefined?{gainDb:options.gainDb}:role==='music'?{gainDb:-18}:{})},
      ...(timeNumber(audio.duration)<duration/timeNumber(doc.fps)?{endBehavior:'silence' as const}:{})}});
  operations.push({type:'insert',clips});
  return {commands:operations,selectId:clips[0]!.id};
}

const free=(doc:SequenceDocument,trackId:string,at:number,duration:number)=>!doc.clips.some(c=>c.trackId===trackId&&c.startFrame<at+duration&&clipEnd(c)>at);
const visualOk=(doc:SequenceDocument,t:SequenceTrack,at:number,d:number)=>
  t.kind==='visual'&&t.enabled&&!hasSceneFade(doc,t.id)&&doc.tracks.indexOf(t)<sceneFadeInsertionIndex(doc)&&free(doc,t.id,at,d);

/** 素材置場の項目を置く編集操作を組み立てる。文書は変えない。media の asset は同じ batch で登録されるため引数で受ける。 */
export function buildLibraryPlacement(doc:SequenceDocument,asset:SequenceAsset,target:LibraryTarget,at:number,trackId?:string,newId:()=>string=defaultId):PlacementResult{
  if(target.kind==='template'){
    const item=target.item;
    if(asset.kind!=='component'||!asset.textStyleCatalog?.entries.some(e=>e.id===item.template))return {error:'このモーションは部品の一覧にありません'};
    const duration=Math.max(1,Math.round(item.durationSec*timeNumber(doc.fps))),commands:SequenceCommand[]=[];
    const dropped=doc.tracks.find(t=>t.id===trackId);
    let track=dropped&&visualOk(doc,dropped,at,duration)?dropped.id
      :doc.tracks.find(t=>t.name===MOTION_TRACK_NAME&&visualOk(doc,t,at,duration))?.id;
    if(!track){const t:SequenceTrack={id:newId(),kind:'visual',enabled:true,name:MOTION_TRACK_NAME};commands.push({type:'add-track',track:t,index:sceneFadeInsertionIndex(doc)});track=t.id;}
    const id=newId();
    commands.push({type:'insert',clips:[{id,trackId:track,name:item.name,startFrame:at,durationFrames:duration,
      clock:{offset:rational(0),rate:rational(1),duration:rational(duration)},anchor:{kind:'timeline'},
      content:{kind:'telop',textMode:'component',componentAssetId:asset.id,data:{animation:'none',template:item.template,text:item.sample}},
      visual:{layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[],enter:{kind:'none',frames:0},exit:{kind:'none',frames:0}}}]});
    return {commands,selectId:id};
  }
  const kind=target.item.kind,role=kind==='se'?'effect' as const:kind==='bgm'?'music' as const:undefined;
  const gainDb=target.item.gainDb??(role==='effect'?-10:role==='music'?-15:undefined);
  return buildMediaPlacement(doc,asset,at,trackId,{...(role?{role,loop:role==='music'}:{}),...(gainDb!==undefined?{gainDb}:{})},newId);
}
