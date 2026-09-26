import {nativeEditorEditSchema,type NativeEditorCommand} from '../../shared/nativeEditorCommands';
import {applySequenceCommand,type SequenceCommand} from './commands';
import {archiveReservedIds} from './cutArchive';
import {speedReservedIds} from './speedCaptionLedger';
import {sceneFadeInsertionIndex} from './sceneFadeEdits';
import {DEFAULT_TEXT_APPEARANCE,type SequenceDocument,type SequenceClip,type MediaStream} from './model';
import {ceilTime,multiplyTime,divideTime,subtractTime,compareTime,rational} from './time';
import {validateSequenceDocument} from './validate';
import {SequenceError} from './errors';
import {DEFAULT_MAIN_LAYOUT} from '../mainLayout';
import {DEFAULT_MAIN_AUDIO} from '../mainAudio';
import {DEFAULT_COLOR_GRADE} from '../colorGrade';

const fail=(message:string):never=>{throw new SequenceError('INVALID_RANGE',message);};
function clip(doc:SequenceDocument,id:string):SequenceClip {
 const value=doc.clips.find(c=>c.id===id);if(!value)throw new SequenceError('MISSING_TARGET','編集対象の使用箇所がありません',[id]);return value;
}
function track(doc:SequenceDocument,id:string,kind:'visual'|'audio'):void {
 const t=doc.tracks.find(t=>t.id===id);if(!t||t.kind!==kind)fail('素材と配置先トラックの種類が一致しません');
 if(doc.clips.some(c=>c.trackId===id&&c.content.kind==='scene-fade'))fail('場面フェード専用トラックには素材を配置できません');
}
/** Same explicit reserved namespaces as normal structural editing; no random IDs in a dryrun. */
function reservedIds(doc:SequenceDocument):string[] {
 return [...archiveReservedIds(doc),...speedReservedIds(doc),...doc.clips.flatMap(c=>[c.id,c.linkGroupId,c.continuationGroupId]),...doc.tracks.map(t=>t.id),...doc.assets.map(a=>a.id),...doc.transitions.map(t=>t.id)].filter((id):id is string=>id!==undefined);
}
function allocator(doc:SequenceDocument,claimed:Set<string>):(prefix:string)=>string {
 const used=new Set([...claimed,...reservedIds(doc)]);
 let i=0;return prefix=>{let id:string;do{id=`native-ai-${prefix}-${++i}`;}while(used.has(id));used.add(id);claimed.add(id);return id;};
}
function stream(streams:MediaStream[],kind:'video'|'audio',index?:number):MediaStream {
 const found=streams.filter(s=>s.kind===kind&&(index===undefined||s.index===index));
 if(found.length!==1)fail(index===undefined?'複数のストリームがある場合は番号を明示してください':'指定したストリームがありません');return found[0]!;
}
function insertMedia(doc:SequenceDocument,c:Extract<NativeEditorCommand,{type:'insert-media'}>,fresh:(prefix:string)=>string):SequenceCommand {
 const asset=doc.assets.find(a=>a.id===c.assetId);if(!asset||!['media','image'].includes(asset.kind))fail('配置できる登録済み素材がありません');
 track(doc,c.trackId,c.kind==='audio'?'audio':'visual');
 if(c.kind==='image'){
  if(asset!.kind!=='image')fail('画像素材ではありません');
  if([c.sourceIn,c.rate,c.videoStreamIndex,c.audioStreamIndex,c.withAudio,c.audioTrackId,c.role,c.loop].some(v=>v!==undefined))fail('画像に映像・音声用の指定は使えません');
  const duration=c.durationFrames??ceilTime(multiplyTime(rational(5),doc.fps));
  return {type:'insert',clips:[{id:fresh('image'),name:asset!.name,trackId:c.trackId,startFrame:c.startFrame,durationFrames:duration,clock:{offset:rational(0),rate:rational(1),duration:rational(duration)},visual:{layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[]},content:{kind:'image',assetId:asset!.id,style:'plain'}}]};
 }
 if(asset!.kind!=='media')fail('映像・音声素材ではありません');
 if(c.kind==='video'&&(c.role!==undefined||c.loop!==undefined))fail('連動原音はspeech・非loopです。別の音声素材配置を指定してください');
 if(c.kind==='audio'&&[c.videoStreamIndex,c.withAudio,c.audioTrackId].some(v=>v!==undefined))fail('音声のみの配置に映像用の指定は使えません');
 if(c.kind==='video'&&c.withAudio===false&&(c.audioStreamIndex!==undefined||c.audioTrackId!==undefined))fail('原音なしの配置に原音設定は使えません');
 const selected=stream(asset!.streams,c.kind,c.kind==='video'?c.videoStreamIndex:c.audioStreamIndex);
 const sourceIn=c.sourceIn??rational(0),rate=c.rate??rational(1);
 if(compareTime(sourceIn,selected.duration)>=0)fail('素材の開始位置が終端を越えています');
 const duration=c.durationFrames??ceilTime(divideTime(multiplyTime(subtractTime(selected.duration,sourceIn),doc.fps),rate));
 const clock={offset:rational(0),rate:rational(1),duration:rational(duration)};
 const visual={layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[]};
 const audio=c.kind==='audio'?selected:(c.withAudio!==false&&asset!.streams.some(s=>s.kind==='audio')?stream(asset!.streams,'audio',c.audioStreamIndex):undefined);
 if(c.kind==='video'&&!audio&&(c.audioTrackId!==undefined||c.audioStreamIndex!==undefined))fail('指定された原音ストリームがありません');
 if(c.kind==='video'&&audio){if(!c.audioTrackId)fail('連動原音の配置先トラックを明示してください');track(doc,c.audioTrackId!,'audio');}
 const link=c.kind==='video'&&audio?fresh('link'):undefined;
 const clips:SequenceClip[]=[];
 if(c.kind==='video')clips.push({id:fresh('video'),name:asset!.name,trackId:c.trackId,startFrame:c.startFrame,durationFrames:duration,clock:structuredClone(clock),visual,
  ...(link?{linkGroupId:link}:{}),content:{kind:'video',assetId:asset!.id,streamIndex:selected.index,sourceIn,rate}});
 if(audio){
  if(compareTime(sourceIn,audio.duration)>=0)fail('原音の開始位置が終端を越えています');
  const role=c.kind==='video'?'speech':c.role??'music',loop=c.kind==='video'?false:c.loop??role==='music';
  if(role==='speech'&&loop)fail('発話原音をloopさせることはできません');
  const sourceEnd=ceilTime(divideTime(multiplyTime(subtractTime(audio.duration,sourceIn),doc.fps),rate));
  clips.push({id:fresh('audio'),name:c.kind==='video'?`${asset!.name} 原音`:asset!.name,trackId:c.kind==='video'?c.audioTrackId!:c.trackId,
   startFrame:c.startFrame,durationFrames:duration,clock:structuredClone(clock),...(link?{linkGroupId:link}:{}),
   content:{kind:'audio',assetId:asset!.id,streamIndex:audio.index,sourceIn:structuredClone(sourceIn),rate:structuredClone(rate),role,loop,
    settings:{...DEFAULT_MAIN_AUDIO,...(role==='music'?{gainDb:-18}:{})},...(c.kind==='video'&&sourceEnd<duration?{endBehavior:'silence' as const}:{})}});
 }
 return {type:'insert',clips};
}

function translate(doc:SequenceDocument,c:NativeEditorCommand,fresh:(prefix:string)=>string):SequenceCommand {
 switch(c.type){
  case 'insert-media':return insertMedia(doc,c,fresh);
  case 'insert-caption':{
   track(doc,c.trackId,'visual');return {type:'insert',clips:[{id:fresh('caption'),name:'テキスト',trackId:c.trackId,startFrame:c.startFrame,durationFrames:c.durationFrames,
    clock:{offset:rational(0),rate:rational(1),duration:rational(c.durationFrames)},anchor:{kind:'timeline'},
    content:{kind:'telop',data:{text:c.text,animation:'none',manual:true,position:{x:0,y:-.5}},textMode:'free',appearance:{...DEFAULT_TEXT_APPEARANCE,...c.appearance}}}]};
  }
  case 'set-caption-text':{
   const target=clip(doc,c.clipId);if(target.content.kind!=='telop')return fail('字幕本文の対象ではありません');
   return {type:'update-clip',clipId:c.clipId,patch:{content:{...target.content,data:{...target.content.data,text:c.text}}}};
  }
  case 'update-clip-audio':{
   const target=clip(doc,c.clipId);if(target.content.kind!=='audio')return fail('音声設定の対象ではありません');
   return {type:'update-clip',clipId:c.clipId,patch:{content:{...target.content,settings:{...target.content.settings,...c.settings}}}};
  }
  case 'update-clip-visual':{
   const target=clip(doc,c.clipId);if(target.content.kind==='audio'||target.content.kind==='scene-fade')return fail('配置・色調整の対象ではありません');
   const visual=structuredClone(target.visual??{layout:DEFAULT_MAIN_LAYOUT,opacity:1,keyframes:[]});
   if(c.patch.layout)visual.layout={...visual.layout,...c.patch.layout};
   if(c.patch.opacity!==undefined)visual.opacity=c.patch.opacity;
   if(c.patch.colorGrade)visual.colorGrade={...DEFAULT_COLOR_GRADE,...visual.colorGrade,...c.patch.colorGrade};
   if(c.patch.lut===null)delete visual.lut;else if(c.patch.lut)visual.lut=structuredClone(c.patch.lut);
   return {type:'update-clip',clipId:c.clipId,patch:{visual}};
  }
  case 'add-track':return {...c,index:c.index??(c.track.kind==='visual'?sceneFadeInsertionIndex(doc):doc.tracks.length)};
  case 'split':
   if(c.clipIds.some(id=>clip(doc,id).content.kind==='telop'))return fail('字幕は本文を指定するsplit-captionを使ってください');
   return c;
  default:return c;
 }
}

/** Validate and compile deterministically against the current graph, never mutate it.
 * The returned batch is one existing native Undo operation. Unavailable timing/
 * speed/transition states fail through existing core guards; no ledger is dropped. */
export function buildNativeAgentCommand(doc:SequenceDocument,input:unknown):SequenceCommand {
 const request=nativeEditorEditSchema.parse(input);validateSequenceDocument(doc);
 if(request.documentId!==doc.id)throw new SequenceError('REVISION_CONFLICT','対象の編集文書が異なります');
 // Preserve original IDs even after deletion; future explicit track IDs also own their namespace.
 const commands:SequenceCommand[]=[],claimed=new Set([...reservedIds(doc),...request.commands.flatMap(c=>c.type==='add-track'?[c.track.id]:[])]);let draft=doc;
 for(const c of request.commands){const command=translate(draft,c,allocator(draft,claimed));draft=applySequenceCommand(draft,command);commands.push(command);}
 return {type:'batch',commands};
}
export function applyNativeAgentEdit(doc:SequenceDocument,input:unknown):SequenceDocument {
 return applySequenceCommand(doc,buildNativeAgentCommand(doc,input));
}
