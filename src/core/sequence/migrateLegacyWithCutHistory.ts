import {legacyCaptionPolicy} from './legacyCaptionContinuity';
import {migrateLegacySequence,type LegacyMigrationInput,type LegacyMigrationResult} from './migrateLegacy';
import {buildLegacyMainTimeline} from './legacyMainTimeline';
import {clipEnd,sourceTimeAt,type CutArchiveEntry,type SequenceClip} from './model';
import {rationalFromDecimal} from './time';
import {validateSequenceDocument} from './validate';
import {extractSequenceWindow} from './commands';

/** Saved migration boundary. The draft-only projection remains unchanged. */
export function migrateLegacyWithCutHistory(input:LegacyMigrationInput):LegacyMigrationResult {
  const result=migrateLegacySequence(input),doc=result.document,project=input.project;
  if(!project.cutRegions.length){
    if(doc.legacy)doc.legacy.cutHistoryImport={version:1,sourceFingerprint:input.sourceFingerprint};
    validateSequenceDocument(doc);return result;
  }
  const timeline=buildLegacyMainTimeline(project),entries:CutArchiveEntry[]=[];
  const captionPolicies=new Map(project.telops.filter(c=>!c.manual&&!c.timelinePlacement).map(c=>{const owner=`legacy-telop-${c.id}`;return [owner,legacyCaptionPolicy(doc,owner)] as const;}));
  for(const [index,range] of project.cutRegions.entries()){
    // A removed old segment has no surviving per-segment identity. Reconstruct
    // it using the old global settings and original source-anchored elements.
    // Never attach a newly numbered segment to a surviving segment's override.
    const bandProject=structuredClone(project);
    bandProject.cutRegions=[...(range.start>0?[{start:0,end:range.start}]:[]),...(range.end<project.videoConfig.durationFrames?[{start:range.end,end:project.videoConfig.durationFrames}]:[])];
    bandProject.cutOrder=undefined;bandProject.segmentSpeeds={};bandProject.segmentLayouts={};bandProject.sceneTransitions=[];
    bandProject.telops=bandProject.telops.filter(c=>!c.timelinePlacement&&!c.manual);
    for(const kind of ['titles','images','videoInserts','se','bgm','shapes'] as const){
      const items=bandProject[kind];if(items)(bandProject as unknown as Record<string,unknown>)[kind]=items.filter(c=>!('timelinePlacement' in c&&c.timelinePlacement));
    }
    const duration=buildLegacyMainTimeline(bandProject).model.durationInFrames;
    // A trailing legacy cut maps an exclusive element end to end-1. Project
    // the suffix with no trailing cut, then reuse the exact native window slicer.
    bandProject.cutRegions=range.start>0?[{start:0,end:range.start}]:[];
    const graph=extractSequenceWindow(migrateLegacySequence({...input,project:bandProject}).document,0,duration);
    if(!graph.clips.length)continue;
    const id=`legacy-cut-${index+1}`,prefix=id+'-';
    const identities=new Map(graph.clips.map(c=>[c.id,prefix+c.id]));
    const bandMains=new Set(buildLegacyMainTimeline(bandProject).entries.map(e=>`legacy-video-${e.segment.id}`));
    const clips:SequenceClip[]=graph.clips.map(c=>{
      const next=structuredClone(c);next.id=identities.get(c.id)!;
      if(next.content.kind==='audio'&&(next.content.role==='music'||next.content.role==='effect')){
        const live=doc.clips.find(x=>x.id===c.id);
        const right=timeline.entries.find(e=>e.segment.originalStart===range.end);
        const mainSeam=right?doc.clips.find(x=>x.id===`legacy-video-${right.segment.id}`)?.startFrame:undefined;
        // Legacy exclusive-end fallback may leave one frame absent at the left
        // soundtrack edge. Record only the actual projection's witnessed case.
        const left=timeline.entries.find(e=>e.segment.originalEnd===range.start);
        const leftClip=left?doc.clips.find(x=>x.id===`legacy-video-${left.segment.id}`):undefined;
        const seam=leftClip?clipEnd(leftClip):mainSeam;
        next.legacyAudioContinuity={version:1,sourceFingerprint:input.sourceFingerprint,ownerClipId:c.id,
          ...(live&&seam!==undefined&&clipEnd(live)===seam-1&&c.startFrame===0?{leftClampBridge:true as const}:{})};
      }
      if(next.content.kind==='telop'){const policy=captionPolicies.get(`legacy-telop-${next.content.legacyId}`);if(policy)next.legacyCaptionContinuity=structuredClone(policy);}
      if(next.linkGroupId)next.linkGroupId=prefix+next.linkGroupId;
      if(next.continuationGroupId)next.continuationGroupId=prefix+next.continuationGroupId;
      if(next.anchor?.kind==='source')next.anchor.clipOccurrenceId=identities.get(next.anchor.clipOccurrenceId)??next.anchor.clipOccurrenceId;
      if(next.content.kind==='telop'&&graph.rendering?.telopComponentAssetId)next.content.componentAssetId=graph.rendering.telopComponentAssetId;
      return next;
    });
    const references:CutArchiveEntry['boundary']['references']=[];
    for(const entry of timeline.entries){
      const edge=entry.segment.originalEnd===range.start?'end':entry.segment.originalStart===range.end?'start':null;
      if(!edge)continue;
      for(const clipId of [`legacy-video-${entry.segment.id}`,`legacy-audio-${entry.segment.id}`])if(doc.clips.some(c=>c.id===clipId))references.push({clipId,edge,offsetFrames:0});
    }
    const frames=references.map(ref=>{const c=doc.clips.find(c=>c.id===ref.clipId)!;return ref.edge==='start'?c.startFrame:clipEnd(c);});
    const witnesses:NonNullable<SequenceClip['legacyMainRole']>['witnesses']=references.flatMap(ref=>{
      const c=doc.clips.find(c=>c.id===ref.clipId)!;
      if(c.content.kind!=='video'&&c.content.kind!=='audio')return [];
      const provider=c.content.kind==='audio'?doc.clips.find(v=>v.content.kind==='video'&&v.linkGroupId&&v.linkGroupId===c.linkGroupId):undefined;
      return [{clipId:c.id,edge:ref.edge,kind:c.content.kind==='video'?'main' as const:'main-audio' as const,
        ...(provider?{providerId:provider.id}:{}),assetId:c.content.assetId,streamIndex:c.content.streamIndex,
        sourceTime:sourceTimeAt(c,ref.edge==='start'?c.startFrame:clipEnd(c),doc.fps),rate:c.content.rate}];
    });
    for(const c of clips){const original=graph.clips.find(x=>identities.get(x.id)===c.id)!;
      const provider=original.content.kind==='audio'?graph.clips.find(v=>bandMains.has(v.id)&&v.linkGroupId&&v.linkGroupId===original.linkGroupId):undefined;
      if(bandMains.has(original.id)||provider)c.legacyMainRole={version:1,sourceFingerprint:input.sourceFingerprint,
        kind:provider?'main-audio':'main',...(provider?{providerId:identities.get(provider.id)!}:{}),witnesses:structuredClone(witnesses)};
    }
    const whole=range.start===0&&range.end===project.videoConfig.durationFrames;
    const known=frames.length>0&&frames.every(f=>f===frames[0])||whole&&timeline.entries.length===0;
    entries.push({id,durationFrames:graph.sequenceEndFrame,completionFloorFrames:graph.sequenceEndFrame,origin:{cutId:id,startFrame:0,endFrame:graph.sequenceEndFrame},
      boundary:{hintFrame:frames[0]??0,ambiguous:!known,references},clips,tracks:graph.tracks,
      legacyRecovery:{version:1,sourceFingerprint:input.sourceFingerprint,originalStart:range.start,originalEnd:range.end,fps:doc.fps,mainRate:rationalFromDecimal(project.mainSpeed)}});
    if(graph.rendering)doc.rendering={...graph.rendering,...doc.rendering};
  }
  if(entries.length){
    if(!doc.clips.length&&timeline.entries.length===0)doc.sequenceEndFrame=0;
    doc.cutArchive={version:1,entries};
    if(doc.legacy)doc.legacy.cutHistoryImport={version:1,sourceFingerprint:input.sourceFingerprint};
    result.notices.push('旧カットの範囲を元の編集データから引き継ぎました。削除部分は旧データの全体設定で復元します。');
  }
  validateSequenceDocument(doc);return result;
}
