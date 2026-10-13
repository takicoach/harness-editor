// src/core/sequence/mainAppend.ts
import type {SequenceCommand} from './commands';
import type {SequenceAsset,SequenceClip,SequenceDocument,SequenceTrack} from './model';
import {ceilTime,compareTime,multiplyTime,rational,type Rational} from './time';
import {DEFAULT_MAIN_LAYOUT} from '../mainLayout';
import {DEFAULT_MAIN_AUDIO} from '../mainAudio';
import {mainAppendStart,mainTracks} from './mainTrack';

/** 設計 §1 の文言（そのまま画面・AI に返す）。 */
export const MAIN_SPEED_REFUSAL='速度を設定した案件では、まだメインに素材を足せません。素材をすべて並べてから速度を設定してください（速度を設定する前に戻すには「元に戻す」を使います）';
export const MAIN_VIDEO_REQUIRED='メインの末尾に足せるのは映像のある動画です';
export type AppendMainPlan=
  |{command:Extract<SequenceCommand,{type:'batch'}>;clipIds:string[];startFrame:number;endFrame:number}
  |{error:string;code:'SPEED_REGISTERED'|'NOT_VIDEO'|'EMPTY'};

/** 未初期化＝クリップ・カット保管庫・速度・旧形式の情報・文字起こしが何も無く、長さ0（設計 §1）。この時だけ書式を最初の動画に合わせる。 */
export function isUninitializedSequence(doc:SequenceDocument):boolean{
  return !doc.clips.length&&!doc.cutArchive?.entries.length&&!doc.speed&&!doc.insertOwnSpeed&&!doc.legacy&&!doc.transcripts.length&&doc.sequenceEndFrame===0;
}
/** 動画の fps と表示上の大きさ（90°/270° 回転は縦横を入れ替える。buildVideoDocument と同じ規則）。映像が無ければ null。 */
export function videoSequenceFormat(asset:SequenceAsset):{fps:Rational;width:number;height:number}|null{
  const video=asset.kind==='media'?asset.streams.find(s=>s.kind==='video'):undefined;
  if(!video?.frameRate||!video.width||!video.height)return null;
  const rotated=Math.abs(video.rotation??0)%180===90;
  return {fps:video.frameRate,width:rotated?video.height:video.width,height:rotated?video.width:video.height};
}
/**
 * メインの末尾に順に並べる1回の編集（設計 §2-2）。並び順は呼び出し側が受付時に固定したまま。
 * 書式の決定（未初期化の時だけ）・素材の登録・メインのトラックの作成と記録・配置を1つの batch にする（Undo 1回で全部戻る）。
 */
export function buildAppendToMain(doc:SequenceDocument,assets:readonly SequenceAsset[],newId:()=>string):AppendMainPlan{
  if(!assets.length)return {error:'並べる動画がありません',code:'EMPTY'};
  if(doc.speed)return {error:MAIN_SPEED_REFUSAL,code:'SPEED_REGISTERED'};
  if(assets.some(asset=>!videoSequenceFormat(asset)))return {error:MAIN_VIDEO_REQUIRED,code:'NOT_VIDEO'};
  const commands:SequenceCommand[]=[],format=isUninitializedSequence(doc)?videoSequenceFormat(assets[0]!)!:null;
  if(format&&(compareTime(format.fps,doc.fps)!==0||format.width!==doc.resolution.width||format.height!==doc.resolution.height))
    commands.push({type:'set-sequence-format',fps:format.fps,width:format.width,height:format.height});
  const fps=format?.fps??doc.fps;
  commands.push({type:'register-assets',assets:[...new Map(assets.map(asset=>[asset.id,structuredClone(asset)])).values()]});
  const main=mainTracks(doc);let videoTrackId=main.videoTrackId,audioTrackId=main.audioTrackId;
  if(!videoTrackId){const track:SequenceTrack={id:newId(),kind:'visual',name:'映像1',enabled:true};commands.push({type:'add-track',track,index:0});videoTrackId=track.id;}
  if(!audioTrackId&&assets.some(asset=>asset.streams.some(s=>s.kind==='audio'))){const track:SequenceTrack={id:newId(),kind:'audio',name:'原音1',enabled:true};commands.push({type:'add-track',track});audioTrackId=track.id;}
  if(doc.main?.videoTrackId!==videoTrackId||doc.main?.audioTrackId!==audioTrackId)commands.push({type:'set-main-tracks',main:{videoTrackId,...(audioTrackId?{audioTrackId}:{})}});
  const startFrame=mainAppendStart(doc),clips:SequenceClip[]=[],clipIds:string[]=[];let at=startFrame;
  for(const asset of assets){
    const video=asset.streams.find(s=>s.kind==='video')!,audio=asset.streams.find(s=>s.kind==='audio');
    const frames=Math.max(1,ceilTime(multiplyTime(video.duration,fps))),clock=()=>({offset:rational(0),rate:rational(1),duration:rational(frames)});
    const link=audio&&audioTrackId?newId():undefined,videoId=newId();
    clips.push({id:videoId,name:asset.name,trackId:videoTrackId,startFrame:at,durationFrames:frames,clock:clock(),...(link?{linkGroupId:link}:{}),
      visual:{layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[]},
      content:{kind:'video',assetId:asset.id,streamIndex:video.index,sourceIn:rational(0),rate:rational(1),endBehavior:'hold'}});
    if(audio&&audioTrackId)clips.push({id:newId(),name:`${asset.name} 原音`,trackId:audioTrackId,startFrame:at,durationFrames:frames,clock:clock(),linkGroupId:link,
      content:{kind:'audio',assetId:asset.id,streamIndex:audio.index,sourceIn:rational(0),rate:rational(1),role:'speech',loop:false,endBehavior:'silence',settings:structuredClone(DEFAULT_MAIN_AUDIO)}});
    clipIds.push(videoId);at+=frames;
  }
  commands.push({type:'insert',clips});
  return {command:{type:'batch',commands},clipIds,startFrame,endFrame:at};
}
