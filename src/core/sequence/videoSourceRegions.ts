import type {SequenceDocument} from './model';
import {compareTime,rational,type Rational} from './time';

export interface VideoSourceRegion {readonly start:Rational;readonly end:Rational}

/** Requested source unions for validated registered main clips. A neutral split
 * retains its shared window; a real source hole, different rate or new insertion
 * separates it. Decoder reference frames remain a separate concern. */
export function planVideoSourceRegions(doc:SequenceDocument):ReadonlyMap<string,VideoSourceRegion> {
  const pieces=doc.clips.flatMap(clip=>{
    if(clip.content.kind!=='video'||(clip.speed?.kind!=='main'&&!clip.insertOwnSpeed))return [];
    const source=clip.insertOwnSpeed?.source??clip.speed!.source,rate=rational(clip.content.rate.num,clip.content.rate.den);
    return [{id:clip.id,group:JSON.stringify([clip.insertOwnSpeed?'insert-own':'main',clip.continuationGroupId??clip.id,source.assetId,source.streamIndex,rate.num,rate.den]),
      start:rational(source.sourceStart.num,source.sourceStart.den),end:rational(source.sourceEnd.num,source.sourceEnd.den)}];
  });
  pieces.sort((a,b)=>(a.group<b.group?-1:a.group>b.group?1:0)||compareTime(a.start,b.start)||compareTime(a.end,b.end));
  const windows=new Map<string,VideoSourceRegion>();
  let ids:string[]=[],group='',start:Rational|undefined,end:Rational|undefined;
  const flush=()=>{
    if(!ids.length)return;
    const window=Object.freeze({start:Object.freeze(start!),end:Object.freeze(end!)});
    for(const id of ids)windows.set(id,window);
    ids=[];
  };
  for(const piece of pieces){
    if(!ids.length||piece.group!==group||compareTime(piece.start,end!)>0){
      flush();group=piece.group;start=piece.start;end=piece.end;
    }else if(compareTime(piece.end,end!)>0)end=piece.end;
    ids.push(piece.id);
  }
  flush();return windows;
}
