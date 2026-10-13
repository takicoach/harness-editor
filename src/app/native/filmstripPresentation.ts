import {sourceTimeAt,type SequenceClip,type SequenceDocument} from '../../core/sequence/model';
import type {Rational} from '../../core/sequence/time';
import {MAX_THUMBS,STRIP_THUMB_PX} from '../timeline/useFilmstrip';
import {FRAME_REQUEST_MAX_TIMES} from '../../shared/filmstripHeight';

export interface NativeFilmstripInput {
  document:SequenceDocument;projectId:string;clip:SequenceClip;
  /** Piece origin in the owning clip's completion-frame units. */
  sourceOffsetFrames:number;
  /** Piece placement on the finish display axis, including inserted cut bands. */
  displayStartFrame:number;displayDuration:number;
  pixelsPerFrame:number;scrollLeft:number;viewportWidth:number;
}
export type FilmstripPresentation =
 | {ok:false;reason:'not-video'|'missing-source'|'invalid-time'}
 | {ok:true;source:{assetId:string;streamIndex:number;fingerprint:string};ownerKey:string;
    cells:{left:number;width:number;time:Rational;sourceSeconds:number}[]};

/** 選んだ使用箇所の、明示したストリームだけを読む（設計 §2-1）。各セルは正確な素材時刻（有理数）で、どのフレームを出すかはサーバが決める。
 * 素材の終端を越える時刻も送る（サーバは最終フレームを返す）。軽量版や別の素材で代えない。 */
export function filmstripPresentation(input:NativeFilmstripInput):FilmstripPresentation {
 const {document:doc,clip,sourceOffsetFrames,displayStartFrame,displayDuration,pixelsPerFrame:pixels,scrollLeft,viewportWidth}=input;
 if(clip.content.kind!=='video')return {ok:false,reason:'not-video'};
 const content=clip.content,asset=doc.assets.find(a=>a.id===content.assetId);
 const stream=asset?.streams.find(s=>s.index===content.streamIndex&&s.kind==='video');
 if(!asset||asset.kind!=='media'||!stream)return {ok:false,reason:'missing-source'};
 if(![sourceOffsetFrames,displayStartFrame,displayDuration,pixels,scrollLeft,viewportWidth].every(Number.isFinite)
  ||!Number.isSafeInteger(sourceOffsetFrames)||!Number.isSafeInteger(displayDuration)||displayDuration<=0||pixels<=0)return {ok:false,reason:'invalid-time'};
 const ownerKey=JSON.stringify([doc.id,clip.id,asset.id,asset.fingerprint,stream.index]);
 const result:Extract<FilmstripPresentation,{ok:true}>={ok:true,source:{assetId:asset.id,streamIndex:stream.index,fingerprint:asset.fingerprint},ownerKey,cells:[]};
 if(viewportWidth<=132)return result;
 // The sticky 132px label masks that portion of the scroll viewport.
 const from=Math.max(0,(scrollLeft-displayStartFrame*pixels)/pixels);
 const to=Math.min(displayDuration,(scrollLeft+viewportWidth-132-displayStartFrame*pixels)/pixels);
 if(to<=from)return result;
 const count=Math.min(MAX_THUMBS,FRAME_REQUEST_MAX_TIMES,Math.max(1,Math.ceil((to-from)*pixels/STRIP_THUMB_PX)));
 try{
  for(let i=0;i<count;i++){
   const start=from+(to-from)*i/count,end=from+(to-from)*(i+1)/count;
   const local=Math.min(displayDuration-1,Math.floor((start+end)/2));
   const time=sourceTimeAt(clip,clip.startFrame+sourceOffsetFrames+local,doc.fps),seconds=time.num/time.den;
   if(seconds<0)continue;
   result.cells.push({left:start*pixels,width:(end-start)*pixels,time,sourceSeconds:seconds});
  }
 }catch{return {ok:false,reason:'invalid-time'};}
 return result;
}
