import {sourceTimeAt,type SequenceClip,type SequenceDocument} from '../../core/sequence/model';
import {MAX_THUMBS,STRIP_THUMB_PX} from '../timeline/useFilmstrip';

export interface NativeFilmstripInput {
  document:SequenceDocument;projectId:string;clip:SequenceClip;
  /** Piece origin in the owning clip's completion-frame units. */
  sourceOffsetFrames:number;
  /** Piece placement on the finish display axis, including inserted cut bands. */
  displayStartFrame:number;displayDuration:number;
  pixelsPerFrame:number;scrollLeft:number;viewportWidth:number;
}
export type FilmstripPresentation =
 | {ok:false;reason:'not-video'|'missing-source'|'multiple-video-streams'|'invalid-time'}
 | {ok:true;url:string;ownerKey:string;sourceFps:number;totalFrames:number;
    cells:{left:number;width:number;frame:number;sourceSeconds:number}[]};

/** Read only the selected occurrence. No primary-asset or proxy-asset substitution. */
export function filmstripPresentation(input:NativeFilmstripInput):FilmstripPresentation {
 const {document:doc,projectId,clip,sourceOffsetFrames,displayStartFrame,displayDuration,pixelsPerFrame:pixels,scrollLeft,viewportWidth}=input;
 if(clip.content.kind!=='video')return {ok:false,reason:'not-video'};
 const content=clip.content,asset=doc.assets.find(a=>a.id===content.assetId);
 const streams=asset?.streams.filter(s=>s.kind==='video')??[],stream=streams.find(s=>s.index===content.streamIndex);
 if(!asset||asset.kind!=='media'||!stream)return {ok:false,reason:'missing-source'};
 // HTMLVideoElement has no portable explicit stream selector. A URL cannot stand for a different stream.
 if(streams.length!==1)return {ok:false,reason:'multiple-video-streams'};
 const fps=stream.frameRate?stream.frameRate.num/stream.frameRate.den:NaN,duration=stream.duration.num/stream.duration.den;
 if(![sourceOffsetFrames,displayStartFrame,displayDuration,pixels,scrollLeft,viewportWidth,fps,duration].every(Number.isFinite)
  ||!Number.isSafeInteger(sourceOffsetFrames)||!Number.isSafeInteger(displayDuration)||displayDuration<=0||pixels<=0||fps<=0||duration<=0)return {ok:false,reason:'invalid-time'};
 const url=`/api/sequence/asset?${new URLSearchParams({id:projectId,asset:asset.id})}`;
 const ownerKey=JSON.stringify([doc.id,clip.id,asset.id,asset.fingerprint,stream.index]);
 const result:Extract<FilmstripPresentation,{ok:true}>={ok:true,url,ownerKey,sourceFps:fps,totalFrames:duration*fps,cells:[]};
 if(viewportWidth<=132)return result;
 // The sticky 132px label masks that portion of the scroll viewport.
 const from=Math.max(0,(scrollLeft-displayStartFrame*pixels)/pixels);
 const to=Math.min(displayDuration,(scrollLeft+viewportWidth-132-displayStartFrame*pixels)/pixels);
 if(to<=from)return result;
 const count=Math.min(MAX_THUMBS,Math.max(1,Math.ceil((to-from)*pixels/STRIP_THUMB_PX)));
 try{
  for(let i=0;i<count;i++){
   const start=from+(to-from)*i/count,end=from+(to-from)*(i+1)/count;
   const local=Math.min(displayDuration-1,Math.floor((start+end)/2));
   const time=sourceTimeAt(clip,clip.startFrame+sourceOffsetFrames+local,doc.fps),seconds=time.num/time.den;
   // EOF hold is a renderer policy; a thumbnail must not pretend that an out-of-range source sample exists.
   if(seconds<0||seconds>=duration)continue;
   result.cells.push({left:start*pixels,width:(end-start)*pixels,frame:seconds*fps,sourceSeconds:seconds});
  }
 }catch{return {ok:false,reason:'invalid-time'};}
 return result;
}
