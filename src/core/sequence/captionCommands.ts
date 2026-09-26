import {applySequenceCommand,type SequenceCommand} from './commands';
import {SequenceError} from './errors';
import {clipEnd,type SequenceClip,type SequenceDocument,type SpeedCaptionLedger,type SpeedCaptionPart} from './model';
import {addTime,compareTime,divideTime} from './time';
import {captionLedgers,captionPartWindow,materializeSpeedCaptions,refreshCaptionBaselines,speedProjectionForDocument,speedReservedIds,upgradeNativeSpeedMetadata} from './speedCaptionLedger';
import {independentAudioMap} from './speedTopologyProjection';
import {rebindCutArchiveFragments,type CutFragment} from './cutArchive';

export type CaptionCommand=
  |{type:'split-caption';clipId:string;frame:number;leftText:string;rightText:string}
  |{type:'merge-captions';firstClipId:string;secondClipId:string};
const fail=(message:string):never=>{throw new SequenceError('INVALID_RANGE',message);};
function textClip(document:SequenceDocument,id:string){
  const clip=document.clips.find(c=>c.id===id);
  if(!clip||(clip.content.kind!=='telop'&&clip.content.kind!=='title'))return fail('対象の字幕がありません');
  return clip;
}
function textCommand(clip:SequenceClip,text:string):SequenceCommand{
  if(clip.content.kind!=='telop'&&clip.content.kind!=='title')return fail('本文を編集できない素材です');
  return {type:'update-clip',clipId:clip.id,patch:{name:text,content:{...clip.content,data:{...clip.content.data,text}}}};
}
function presentation(ledger:SpeedCaptionLedger,part:SpeedCaptionPart,text:string){
  const template=structuredClone(part.presentation?.template??ledger.template);
  if(template.content.kind!=='telop')return fail('登録字幕の本文がありません');
  template.name=text;template.content.data.text=text;return {template};
}
function registeredPart(document:SequenceDocument,id:string){
  for(const ledger of captionLedgers(document)){const part=ledger.parts.find(p=>p.reservedRenderId===id);if(part)return {ledger,part};}
  return null;
}
function materialize(document:SequenceDocument,insertAfter?:{left:string;right:string}):SequenceDocument{
  refreshCaptionBaselines(document);
  const projected=new Map(materializeSpeedCaptions(document).map(c=>[c.id,c]));
  const next:SequenceClip[]=[];
  for(const old of document.clips){const current=projected.get(old.id);next.push(current??old);projected.delete(old.id);
    if(insertAfter?.left===old.id){const right=projected.get(insertAfter.right);if(right){next.push(right);projected.delete(right.id);}}}
  document.clips=next.concat([...projected.values()]);return document;
}

/** A caption's own split edits its source intent, without splitting the AV provider. */
export function applyCaptionCommand(document:SequenceDocument,command:CaptionCommand,fresh:(prefix:string)=>string):SequenceDocument{
  if(command.type==='split-caption'){
    const clip=textClip(document,command.clipId);
    if(!Number.isSafeInteger(command.frame)||command.frame<=clip.startFrame||command.frame>=clipEnd(clip))return fail('字幕の途中へ再生位置を移動してください');
    if(typeof command.leftText!=='string'||typeof command.rightText!=='string')return fail('字幕本文が不正です');
    const next=document.speed?structuredClone(upgradeNativeSpeedMetadata(document)):null,owned=next&&registeredPart(next,clip.id);
    if(next&&owned){
      const reserved=new Set(speedReservedIds(next));
      const allocate=(prefix:string)=>{let id:string;do{id=fresh(prefix);}while(reserved.has(id));reserved.add(id);return id;};
      const {ledger,part}=owned,provider=next.clips.find(c=>c.id===part.providerId)!,basis=provider.speed!;
      const projection=speedProjectionForDocument(next);
      let source;
      if(basis.kind==='independent-audio')source=addTime(basis.evaluationSourceStart,divideTime(independentAudioMap(next,provider).inverse(command.frame),next.speed!.fpsBasis));
      else {
        const main=basis.kind==='main'?provider:next.clips.find(c=>c.id===basis.providerId)!;
        source=addTime(main.speed!.source.sourceStart,divideTime(projection.inverse(main.id,command.frame),next.speed!.fpsBasis));
      }
      if(compareTime(source,part.intentStart)<=0||compareTime(source,part.intentEnd)>=0)return fail('字幕の元の発話範囲を保って分割できません');
      const right:SpeedCaptionPart={...structuredClone(part),partId:allocate('caption-part'),reservedRenderId:allocate('clip'),intentStart:source,presentation:presentation(ledger,part,command.rightText)};
      part.intentEnd=source;part.presentation=presentation(ledger,part,command.leftText);
      part.continuationGroupId??=clip.continuationGroupId??clip.id;right.continuationGroupId=part.continuationGroupId;
      ledger.parts.splice(ledger.parts.indexOf(part)+1,0,right);
      const leftWindow=captionPartWindow(next,part,projection),rightWindow=captionPartWindow(next,right,projection);
      if(leftWindow.endFrame!==command.frame||rightWindow.startFrame!==command.frame||leftWindow.startFrame!==clip.startFrame||rightWindow.endFrame!==clipEnd(clip))return fail('字幕の分割位置が元の表示範囲と一致しません');
      const result=materialize(next,{left:clip.id,right:right.reservedRenderId});
      const fragments:CutFragment[]=[
        {original:clip,slice:{from:clip.startFrame,to:command.frame,start:clip.startFrame},clip:result.clips.find(c=>c.id===clip.id)!},
        {original:clip,slice:{from:command.frame,to:clipEnd(clip),start:command.frame},clip:result.clips.find(c=>c.id===right.reservedRenderId)!},
      ];
      rebindCutArchiveFragments(document,result,new Map([[clip.id,fragments]]));
      return result;
    }
    const split:SequenceCommand={type:'split',clipIds:[clip.id],frame:command.frame,linked:false},candidate=applySequenceCommand(document,split);
    const oldIds=new Set(document.clips.map(c=>c.id)),right=candidate.clips.find(c=>!oldIds.has(c.id)&&c.trackId===clip.trackId&&c.startFrame===command.frame);
    if(!right)return fail('字幕の分割先がありません');
    return applySequenceCommand(candidate,{type:'batch',commands:[textCommand(candidate.clips.find(c=>c.id===clip.id)!,command.leftText),textCommand(right,command.rightText)]});
  }
  const first=textClip(document,command.firstClipId),second=textClip(document,command.secondClipId);
  if(first.id===second.id||first.trackId!==second.trackId||first.content.kind!==second.content.kind||second.startFrame<clipEnd(first))return fail('同じトラックの後に続く字幕を選択してください');
  if(first.content.kind==='telop'&&second.content.kind==='telop'&&(first.content.data.manual===true)!==(second.content.data.manual===true))return fail('字幕と装飾テロップは分けて結合してください');
  const between=document.clips.some(c=>c.id!==first.id&&c.id!==second.id&&c.trackId===first.trackId&&c.startFrame>=clipEnd(first)&&c.startFrame<second.startFrame);
  if(between)return fail('間の字幕を飛ばして結合できません');
  const a=first.anchor,b=second.anchor;
  if((a?.kind==='source'||b?.kind==='source')&&!(a?.kind==='source'&&b?.kind==='source'&&a.clipOccurrenceId===b.clipOccurrenceId))return fail('別の使用箇所に連動する字幕の結合には対応していません');
  const left=first.content,right=second.content;
  if((left.kind!=='telop'&&left.kind!=='title')||(right.kind!=='telop'&&right.kind!=='title'))return fail('字幕本文がありません');
  const text=left.data.text+right.data.text;
  const next=document.speed?structuredClone(upgradeNativeSpeedMetadata(document)):null,one=next&&registeredPart(next,first.id),two=next&&registeredPart(next,second.id);
  if(next&&(one||two)){
    if(!one||!two||one.part.providerId!==two.part.providerId)return fail('字幕の連動先を保って結合できません');
    const beforeWindow=captionPartWindow(next,one.part),afterWindow=captionPartWindow(next,two.part);
    one.part.intentEnd=two.part.intentEnd;one.part.presentation=presentation(one.ledger,one.part,text);
    two.ledger.parts=two.ledger.parts.filter(p=>p!==two.part);
    for(const clip of next.clips)if(clip.speed?.captions)clip.speed.captions=clip.speed.captions.filter(l=>l.parts.length>0||!!l.detachedContinuations?.length);
    next.clips=next.clips.filter(c=>c.id!==second.id);
    const merged=captionPartWindow(next,one.part);
    if(merged.startFrame!==beforeWindow.startFrame||merged.endFrame!==afterWindow.endFrame)return fail('字幕の表示範囲を保って結合できません');
    return materialize(next);
  }
  return applySequenceCommand(document,{type:'batch',commands:[{type:'delete',clipIds:[second.id],linked:false},{type:'trim',clipId:first.id,edge:'end',frame:clipEnd(second),linked:false},textCommand(first,text)]});
}
