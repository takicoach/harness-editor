import { clipEnd, type SequenceClip, type SequenceDocument } from './model';
import { ceilTime, multiplyTime, rational } from './time';
import { validateSourceSelection, validateSequenceDocument } from './validate';
import { DEFAULT_MAIN_AUDIO } from '../mainAudio';

/** A temporary source clock for auditioning the selected stream, independent of edit speed/cuts. */
export function sourceReviewDocument(document:SequenceDocument,occurrenceId:string):SequenceDocument {
  const occurrence=document.clips.find(clip=>clip.id===occurrenceId);
  if(!occurrence || occurrence.content.kind!=='audio' || occurrence.content.role!=='speech')throw new Error('原音の使用箇所を選択してください');
  validateSourceSelection(document,occurrence);
  return mediaSourceReviewDocument(document,occurrence);
}

/** Shared raw-source player document for existing speech review and saved cut review. */
export function mediaSourceReviewDocument(document:SequenceDocument,occurrence:SequenceClip):SequenceDocument {
  if(occurrence.content.kind!=='video'&&occurrence.content.kind!=='audio')throw new Error('確認する映像・音声を選択してください');
  const content=occurrence.content;
  const asset=document.assets.find(asset=>asset.id===content.assetId);
  if(!asset||asset.kind!=='media')throw new Error('元の素材が見つかりません');
  const selected=asset.streams.find(stream=>stream.index===content.streamIndex&&stream.kind===content.kind);
  if(!selected)throw new Error('元の映像・音声が見つかりません');
  const video=content.kind==='video'?selected:asset.streams.find(stream=>stream.kind==='video'),audio=content.kind==='audio'?selected:asset.streams.find(stream=>stream.kind==='audio');
  const fps=video?.frameRate??document.fps,frames=ceilTime(multiplyTime(selected.duration,fps));
  const clock={offset:rational(0),rate:rational(1),duration:rational(frames)};
  const doc:SequenceDocument={schemaVersion:2,id:'source-review',name:asset.name,revision:0,fps,
    resolution:video?.width&&video.height?{width:video.width,height:video.height}:{...document.resolution},
    sequenceEndFrame:frames,background:'#000000',assets:[structuredClone(asset)],tracks:[],clips:[],
    transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
  if(audio){
    doc.tracks.push({id:'a',kind:'audio',name:'原音',enabled:true});
    doc.clips.push({id:'source-audio',name:'原音',trackId:'a',startFrame:0,durationFrames:frames,clock:structuredClone(clock),content:{kind:'audio',assetId:asset.id,
      streamIndex:audio.index,sourceIn:rational(0),rate:rational(1),role:'speech',loop:false,endBehavior:'silence',settings:{...DEFAULT_MAIN_AUDIO}}});
  }
  if(video) {
    if(Math.abs(video.rotation??0)%180===90)doc.resolution={width:doc.resolution.height,height:doc.resolution.width};
    doc.tracks.unshift({id:'v',kind:'visual',name:'素材映像',enabled:true});
    doc.clips.unshift({id:'source-video',name:'素材映像',trackId:'v',startFrame:0,durationFrames:frames,clock,content:{kind:'video',assetId:asset.id,
      streamIndex:video.index,sourceIn:rational(0),rate:rational(1),endBehavior:'hold'}});
  }
  if(doc.clips.some(clip=>clipEnd(clip)!==frames))throw new Error('素材の確認範囲が不正です');
  validateSequenceDocument(doc);return doc;
}
