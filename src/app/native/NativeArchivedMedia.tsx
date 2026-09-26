import {useMemo} from 'react';
import type {SequenceDocument} from '../../core/sequence/model';
import {readArchivedCutGraph} from '../../core/sequence/cutArchive';
import {ScenePlan} from '../../core/sequence/scenePlan';
import {archivedEntrySpans,visibleArchivedSpans} from './archivedEntrySpan';
import type {FinishDisplayMap} from './finishDisplayMap';
import {NativeFilmstrip} from './NativeFilmstrip';
import {NativeWaveform} from './NativeWaveform';
import {waveformViewport} from './waveformViewport';
import {NATIVE_TIMELINE_GUTTER} from './useNativeTimelineViewport';

type ArchiveEntry=NonNullable<SequenceDocument['cutArchive']>['entries'][number];
interface RestoredCut {graph:SequenceDocument;plan:ScenePlan|null}
/** One restored graph per saved cut, shared by every track that draws it: the
 * finish timeline mounts this component once per visible track, and restoring a
 * graph costs a document clone. Keyed by the document and entry objects, so a
 * replaced document restores again and dropped ones are collected. */
const restoredCuts=new WeakMap<SequenceDocument,WeakMap<ArchiveEntry,RestoredCut>>();
function restoredCut(document:SequenceDocument,entry:ArchiveEntry):RestoredCut{
 let perDocument=restoredCuts.get(document);
 if(!perDocument){perDocument=new WeakMap();restoredCuts.set(document,perDocument);}
 let cut=perDocument.get(entry);
 if(!cut){cut={graph:readArchivedCutGraph(document,entry),plan:null};perDocument.set(entry,cut);}
 return cut;
}
/** Only a waveform needs the audio plan; a filmstrip never asks for one. */
function restoredPlan(cut:RestoredCut):ScenePlan{return cut.plan??=new ScenePlan(cut.graph);}

interface Props {document:SequenceDocument;projectId:string;map:FinishDisplayMap;trackId:string;pixels:number;scrollLeft:number;viewportWidth:number;height:number;gain:number}
/** Saved source clocks stay local to each archive; only placement uses the display axis. */
export function NativeArchivedMedia({document,projectId,map,trackId,pixels,scrollLeft,viewportWidth,height,gain}:Props){
 const entries=useMemo(()=>new Map((document.cutArchive?.entries??[]).map(entry=>[entry.id,entry])),[document]);
 return <>{map.blocks.map(block=>{
  if(block.kind!=='archived'||!waveformViewport(block.displayStart,block.localEnd,pixels,scrollLeft,viewportWidth))return null;
  const entry=entries.get(block.entryId);if(!entry)return null;
  return <ArchivedBlock key={block.entryId} {...{document,entry,projectId,trackId,pixels,scrollLeft,viewportWidth,height,gain}} start={block.displayStart} entryId={block.entryId}/>;
 })}</>;
}
function ArchivedBlock({document,entry,projectId,trackId,pixels,scrollLeft,viewportWidth,height,gain,start,entryId}:Omit<Props,'map'> & {entry:ArchiveEntry;start:number;entryId:string}){
 // 位置と尺は保存済みのクリップだけで決まる。復元グラフを作る前に判定し、画面に映らない
 // カットや、このトラックに映像・音声を持たないカットでは 1 件も復元しない。
 const spans=useMemo(()=>archivedEntrySpans(entry,trackId),[entry,trackId]);
 const visible=visibleArchivedSpans(spans,start,pixels,scrollLeft,viewportWidth);
 if(!visible.length)return null;
 const cut=restoredCut(document,entry);
 return <>{visible.map(({clip,from,duration,viewport})=>{
  const restored=cut.graph.clips.find(candidate=>candidate.id===clip.id);
  // 位置と尺を決めた span と、復元グラフの中身がずれている＝取り違え。画面では黙って 1 行欠けるだけなので
  // （「保存したカットが消えた」ように見える）、開発時だけ知らせる。表示は従来どおり描かない。
  if(!restored){if(import.meta.env.DEV)console.warn('[native-archived-media] 復元グラフに保存済みクリップがありません',{entryId,clipId:clip.id});return null;}
  return <div key={restored.id} className={`native-archived-media native-archived-${restored.content.kind}`} data-archive-entry={entryId} aria-hidden="true"
   style={{position:'absolute',pointerEvents:'none',left:NATIVE_TIMELINE_GUTTER+(start+from)*pixels,width:duration*pixels,top:5,bottom:5,overflow:'hidden',borderRadius:4}}>
   {restored.content.kind==='video'?<NativeFilmstrip document={cut.graph} projectId={projectId} clip={restored} sourceOffsetFrames={from-restored.startFrame} displayStartFrame={start+from} displayDuration={duration} pixelsPerFrame={pixels} scrollLeft={scrollLeft} viewportWidth={viewportWidth}/>
    :<NativeWaveform projectId={projectId} clip={restored} plan={restoredPlan(cut)} viewport={viewport} height={Math.max(8,height-18)} displayGain={gain} sourceOffsetFrames={from-restored.startFrame} displayStartFrame={from} displayDuration={duration}/>}
  </div>;
 })}</>;
}
