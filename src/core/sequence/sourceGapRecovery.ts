import {clipEnd,effectFrameAt,isMediaContent,sourceTimeAt,type SequenceClip,type SequenceDocument} from './model';
import {addTime,ceilTime,compareTime,divideTime,multiplyTime,rational,subtractTime,type Rational} from './time';

/** Half-open interval. Source fields are seconds; clock fields are original effect frames. */
export interface SourceGapInterval {start:Rational;end:Rational}
export interface SourceGapClock extends SourceGapInterval {duration:Rational}
export interface SourceGapMedia {
  kind:'video'|'audio';continuationGroupId:string;assetId:string;streamIndex:number;
  source:SourceGapInterval;clock:SourceGapClock;leftOwnerIds:string[];rightOwnerIds:string[];
}
export interface SourceGapOwnerChoice {
  /** Current owner settings/rate, not the lost historical settings. Ceil duration includes every sample below source.end. */
  ownerClipId:string;mediaOwnerIds:string[];side:'left'|'right';durationFrames:number|null;exactDuration:Rational;reason?:string;
}
export interface NativeSourceGapCandidate {
  id:string;kind:'raw-av';documentId:string;revision:number;continuationGroupId:string;
  source:SourceGapInterval;clock:SourceGapClock;durationFrames:number|null;media:SourceGapMedia[];
  leftOwnerIds:string[];rightOwnerIds:string[];ownerChoices:SourceGapOwnerChoice[];requiresOwnerChoice:boolean;
  placement:{frame:number|null;reason:'unique-seam'|'outer-edge'|'boundary-mismatch'|'archived-boundary'};
  reason:string;
}
export interface NativeSourceGapIssue {continuationGroupId:string;reason:string}
export interface NativeSourceGapInspection {
  documentId:string;revision:number;candidates:NativeSourceGapCandidate[];issues:NativeSourceGapIssue[];
}
type MediaClip=SequenceClip&{content:Extract<SequenceClip['content'],{kind:'video'|'audio'}>};
interface Piece {clip:MediaClip;source:SourceGapInterval;effect:SourceGapInterval;a:Rational;b:Rational}
interface Group {id:string;pieces:Piece[];a:Rational;b:Rational;duration:Rational;domain:SourceGapInterval}
const zero=rational(0),eq=(a:Rational,b:Rational)=>compareTime(a,b)===0;
const positive=(t:Rational)=>compareTime(t,zero)>0;
const media=(clip:SequenceClip):clip is MediaClip=>isMediaContent(clip.content);
const key=(t:Rational)=>`${t.num}/${t.den}`;
const reject=(reason:string):never=>{throw new Error(reason);};

function piece(doc:SequenceDocument,clip:MediaClip):Piece {
 if(clip.speed||clip.insertOwnSpeed)reject('registered-timing-needs-projection');
 if(clip.content.kind==='audio'&&(clip.content.loop||clip.content.role!=='speech'))reject('not-finite-original-audio');
 if(!positive(clip.clock.rate)||!positive(clip.content.rate)||!positive(clip.clock.duration))reject('invalid-clock');
 const source={start:clip.content.sourceIn,end:sourceTimeAt(clip,clipEnd(clip),doc.fps)};
 const effect={start:clip.clock.offset,end:effectFrameAt(clip,clipEnd(clip))};
 const a=divideTime(clip.content.rate,multiplyTime(doc.fps,clip.clock.rate));
 return {clip,source,effect,a,b:subtractTime(source.start,multiplyTime(a,effect.start))};
}
function group(doc:SequenceDocument,id:string,clips:MediaClip[]):Group {
 if(!clips.length)reject('missing-lineage-pieces');
 if(doc.clips.some(c=>c.continuationGroupId===id&&!media(c)))reject('mixed-lineage-kind');
 const pieces=clips.map(c=>piece(doc,c)).sort((a,b)=>compareTime(a.source.start,b.source.start)||a.clip.id.localeCompare(b.clip.id));
 const first=pieces[0]!,content=first.clip.content,duration=first.clip.clock.duration;
 if(pieces.some(p=>p.clip.content.kind!==content.kind||p.clip.content.assetId!==content.assetId||p.clip.content.streamIndex!==content.streamIndex))reject('mixed-lineage-source');
 if(pieces.some(p=>!eq(p.a,first.a)||!eq(p.b,first.b)||!eq(p.clip.clock.duration,duration)))reject('source-effect-affine-mismatch');
 const asset=doc.assets.find(a=>a.id===content.assetId),stream=asset?.streams.find(s=>s.kind===content.kind&&s.index===content.streamIndex);
 if(!asset||asset.kind!=='media'||!stream)reject('missing-source-stream');
 const domain={start:first.b,end:addTime(first.b,multiplyTime(first.a,duration))};
 // The effect domain declares an original occurrence window, not necessarily the whole asset.
 if(compareTime(domain.start,zero)<0||compareTime(domain.start,stream!.duration)>=0)reject('source-domain-outside-media');
 if(compareTime(domain.end,stream!.duration)>0){
  // Native import ceils the finite source duration to original effect frames. Admit only
  // that final fractional effect frame, never an unbounded/extended hold interval.
  if(compareTime(subtractTime(domain.end,stream!.duration),first.a)>=0)reject('source-domain-outside-media');
  domain.end=stream!.duration;
 }
 if(pieces.some(p=>compareTime(p.source.start,zero)<0||compareTime(sourceTimeAt(p.clip,clipEnd(p.clip)-1,doc.fps),stream!.duration)>=0))reject('live-sample-outside-media');
 if(pieces.some((p,i)=>compareTime(p.effect.start,zero)<0||compareTime(p.effect.end,duration)>0
   ||i>0&&compareTime(p.source.start,pieces[i-1]!.source.end)<0))reject('overlapping-or-outside-source-windows');
 return {id,pieces,a:first.a,b:first.b,duration,domain};
}
function clock(g:Group,source:SourceGapInterval):SourceGapClock {
 return {start:divideTime(subtractTime(source.start,g.b),g.a),end:divideTime(subtractTime(source.end,g.b),g.a),duration:g.duration};
}
function union(intervals:SourceGapInterval[]):SourceGapInterval[]{
 const sorted=[...intervals].sort((a,b)=>compareTime(a.start,b.start)),out:SourceGapInterval[]=[];
 for(const v of sorted){const last=out.at(-1);if(last&&compareTime(v.start,last.end)<=0){if(compareTime(v.end,last.end)>0)last.end=v.end;}else out.push({...v});}
 return out;
}
function subtract(source:SourceGapInterval,covered:SourceGapInterval[]):SourceGapInterval[]{
 let start=source.start;const out:SourceGapInterval[]=[];
 for(const cut of covered){
  if(compareTime(cut.end,start)<=0)continue;if(compareTime(cut.start,source.end)>=0)break;
  if(compareTime(cut.start,start)>0)out.push({start,end:cut.start});
  if(compareTime(cut.end,start)>0)start=cut.end;
 }
 if(compareTime(start,source.end)<0)out.push({start,end:source.end});return out;
}
function archived(doc:SequenceDocument,g:Group):SourceGapInterval[]{
 const first=g.pieces[0]!.clip.content,result:SourceGapInterval[]=[];
 for(const entry of doc.cutArchive?.entries??[])for(const clip of entry.clips){
  // The first archive slice can retain the original clip ID before live rebuild
  // creates continuationGroupId. That explicit ancestor ID is the same usage.
  if((clip.continuationGroupId??clip.id)!==g.id)continue;
  if(!media(clip))throw new Error('archive-lineage-source-mismatch');
  if(clip.content.kind!==first.kind||clip.content.assetId!==first.assetId||clip.content.streamIndex!==first.streamIndex)reject('archive-lineage-source-mismatch');
  const p=piece(doc,clip);
  if(!eq(p.a,g.a)||!eq(p.b,g.b)||!eq(clip.clock.duration,g.duration))reject('archive-lineage-affine-mismatch');
  result.push(p.source);
 }
 return union(result);
}
function sameIntervals(a:SourceGapInterval[],b:SourceGapInterval[]):boolean{return a.length===b.length&&a.every((v,i)=>eq(v.start,b[i]!.start)&&eq(v.end,b[i]!.end));}
function settings(clip:MediaClip):string {
 const {sourceIn:_,rate:__,assetId:___,streamIndex:____,...content}=clip.content;
 return JSON.stringify({content,visual:clip.visual??null,trackId:clip.trackId,anchor:clip.anchor??null});
}

/** Inspect declared source continuation, not historical delete operations. Never writes or repairs the document. */
export function inspectNativeSourceGaps(doc:SequenceDocument):NativeSourceGapInspection {
 const result:NativeSourceGapInspection={documentId:doc.id,revision:doc.revision,candidates:[],issues:[]};
 const clipsByGroup=new Map<string,MediaClip[]>();
 for(const c of doc.clips)if(media(c)&&c.continuationGroupId){const list=clipsByGroup.get(c.continuationGroupId)??[];list.push(c);clipsByGroup.set(c.continuationGroupId,list);}
 const consumed=new Set<string>();
 const groups=[...clipsByGroup].sort((a,b)=>Number(b[1].some(c=>c.content.kind==='video'))-Number(a[1].some(c=>c.content.kind==='video'))||a[0].localeCompare(b[0]));
 for(const [id,clips] of groups){
  if(consumed.has(id))continue;consumed.add(id);
  try{
   const main=group(doc,id,clips),all=[main];
   if(main.pieces[0]!.clip.content.kind==='video'){
    const partners=main.pieces.map(p=>{
     const links=p.clip.linkGroupId?doc.clips.filter(c=>c.id!==p.clip.id&&c.linkGroupId===p.clip.linkGroupId):[];
     if(!links.length)return null;
     for(const c of links)if(c.continuationGroupId)consumed.add(c.continuationGroupId);
     if(links.length!==1||!media(links[0]!)||links[0]!.content.kind!=='audio'||!links[0]!.continuationGroupId)reject('ambiguous-av-link');
     return links[0] as MediaClip;
    });
    if(partners.some(Boolean)){
     if(partners.some(p=>!p))reject('incomplete-av-link');
     const audioId=partners[0]!.continuationGroupId!;
     if(partners.some(p=>p!.continuationGroupId!==audioId))reject('mixed-av-lineage');
     const audio=group(doc,audioId,clipsByGroup.get(audioId)??[]);
     if(audio.pieces.length!==main.pieces.length)reject('incomplete-av-lineage');
     for(let i=0;i<main.pieces.length;i++){
      const v=main.pieces[i]!,a=audio.pieces[i]!;
      if(v.clip.linkGroupId!==a.clip.linkGroupId||v.clip.content.assetId!==a.clip.content.assetId
       ||!eq(v.source.start,a.source.start)||!eq(v.source.end,a.source.end)||v.clip.startFrame!==a.clip.startFrame||clipEnd(v.clip)!==clipEnd(a.clip))reject('av-window-mismatch');
     }
     if(!eq(main.domain.start,audio.domain.start)||!eq(main.domain.end,audio.domain.end))reject('av-domain-mismatch');
     all.push(audio);
    }
   }else if(main.pieces.some(p=>p.clip.linkGroupId&&doc.clips.some(c=>c.id!==p.clip.id&&c.linkGroupId===p.clip.linkGroupId)))reject('audio-link-needs-video-owner');
   const covered=all.map(g=>archived(doc,g));
   if(covered.some(v=>!sameIntervals(v,covered[0]!)))reject('partial-av-archive');
   const boundaries=[main.domain.start,...main.pieces.flatMap(p=>[p.source.start,p.source.end]),main.domain.end];
   for(let i=0;i<boundaries.length-1;i+=2){
    const source={start:boundaries[i]!,end:boundaries[i+1]!};if(compareTime(source.start,source.end)>=0)continue;
    const left=i===0?undefined:main.pieces[i/2-1],right=main.pieces[i/2];
    for(const part of subtract(source,covered[0]!)){
     const leftOwners=all.flatMap(g=>left?[g.pieces[i/2-1]!.clip]:[]),rightOwners=all.flatMap(g=>right?[g.pieces[i/2]!.clip]:[]);
     const choices:SourceGapOwnerChoice[]=[];
     for(const [side,owners] of [['left',leftOwners],['right',rightOwners]] as const)if(owners.length){
      const durations=owners.map(c=>divideTime(multiplyTime(subtractTime(part.end,part.start),doc.fps),c.content.rate));
      const valid=durations.every(d=>eq(d,durations[0]!)&&positive(d));
      choices.push({ownerClipId:owners[0]!.id,mediaOwnerIds:owners.map(c=>c.id),side,exactDuration:durations[0]!,durationFrames:valid?ceilTime(durations[0]!):null,...(!valid?{reason:'av-duration-mismatch'}:{})});
     }
     if(!choices.some(c=>c.durationFrames!==null)){result.issues.push({continuationGroupId:id,reason:'no-compatible-owner-duration'});continue;}
     const intact=eq(part.start,source.start)&&eq(part.end,source.end);
     const seam=left&&right&&clipEnd(left.clip)===right.clip.startFrame;
     const ordered=main.pieces.every((p,j)=>j===0||p.clip.startFrame>=clipEnd(main.pieces[j-1]!.clip));
     const why=!intact?'archived-boundary':!left||!right?'outer-edge':!seam||!ordered?'boundary-mismatch':'unique-seam';
     const duration=choices.every(c=>c.durationFrames===choices[0]!.durationFrames)?choices[0]!.durationFrames:null;
     const mediaInfo=all.map((g,n)=>({kind:g.pieces[0]!.clip.content.kind,continuationGroupId:g.id,assetId:g.pieces[0]!.clip.content.assetId,streamIndex:g.pieces[0]!.clip.content.streamIndex,
       source:part,clock:clock(g,part),leftOwnerIds:leftOwners[n]?[leftOwners[n]!.id]:[],rightOwnerIds:rightOwners[n]?[rightOwners[n]!.id]:[]}));
     result.candidates.push({id:JSON.stringify(['raw-av',id,key(part.start),key(part.end)]),kind:'raw-av',documentId:doc.id,revision:doc.revision,continuationGroupId:id,
      source:part,clock:clock(main,part),durationFrames:duration,media:mediaInfo,leftOwnerIds:leftOwners.map(c=>c.id),rightOwnerIds:rightOwners.map(c=>c.id),ownerChoices:choices,
      requiresOwnerChoice:choices.some(c=>c.durationFrames===null||!eq(c.exactDuration,choices[0]!.exactDuration))||duration===null||leftOwners.length>0&&rightOwners.some((c,n)=>settings(c)!==settings(leftOwners[n]!)),
      placement:{frame:why==='unique-seam'?clipEnd(left!.clip):null,reason:why},reason:'元映像・原音の未使用範囲です。過去のカットや削除時の設定を示す記録ではありません。'});
    }
   }
  }catch(error){result.issues.push({continuationGroupId:id,reason:error instanceof Error?error.message:'invalid-source-metadata'});}
 }
 // No output object aliases the caller's asset/clip clocks.
 return structuredClone(result);
}
