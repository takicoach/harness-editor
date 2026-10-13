import {clipEnd,sourceTimeAt,type SequenceDocument,type SequenceClip} from './model';
import {addTime,subtractTime,multiplyTime,divideTime,compareTime,rational as r,rationalFromDecimal,ceilTime,floorTime,type Rational} from './time';
import {silenceSettings,validateSilenceRanges,type SilenceRange,type SilenceSettings} from '../../shared/silenceCut';

export interface SilenceEnvelope {sampleRate:number;hopSamples:number;windowSamples:number;sampleCount:number;rms:Float32Array}
export interface SourceEnvelope {assetId:string;streamIndex:number;envelope:SilenceEnvelope}
type Span={start:Rational;end:Rational};
const min=(a:Rational,b:Rational)=>compareTime(a,b)<0?a:b;
const max=(a:Rational,b:Rational)=>compareTime(a,b)>0?a:b;
function merge(spans:Span[]):Span[]{
  const sorted=spans.filter(s=>compareTime(s.start,s.end)<0).sort((a,b)=>compareTime(a.start,b.start)),out:Span[]=[];
  for(const s of sorted){const last=out.at(-1);if(last&&compareTime(s.start,last.end)<=0)last.end=max(last.end,s.end);else out.push({...s});}return out;
}
function intersect(a:Span[],b:Span[]):Span[]{
  const result:Span[]=[];let i=0,j=0;
  while(i<a.length&&j<b.length){const start=max(a[i]!.start,b[j]!.start),end=min(a[i]!.end,b[j]!.end);if(compareTime(start,end)<0)result.push({start,end});if(compareTime(a[i]!.end,b[j]!.end)<0)i++;else j++;}return result;
}
function complement(spans:Span[],end:Rational):Span[]{const out:Span[]=[];let start=r(0);for(const s of merge(spans)){if(compareTime(start,s.start)<0)out.push({start,end:s.start});start=max(start,s.end);}if(compareTime(start,end)<0)out.push({start,end});return out;}

export function silenceSources(doc:SequenceDocument,trackIds:string[]):SequenceClip[]{
  if(!Array.isArray(trackIds)||!trackIds.length||trackIds.length>16||new Set(trackIds).size!==trackIds.length)throw new Error('判定する主音声トラックを選んでください');
  const clips:SequenceClip[]=[];
  for(const id of trackIds){
    if(!doc.tracks.some(t=>t.id===id&&t.kind==='audio'))throw new Error('対象の音声トラックが見つかりません');
    const items=doc.clips.filter(c=>c.trackId===id);
    if(!items.length)throw new Error('空の音声トラックは判定対象にできません');
    for(const c of items){
      if(c.content.kind!=='audio'||c.content.role!=='speech'||c.content.loop)throw new Error('主音声だけのトラックを選んでください（BGM・効果音・ループは対象外）');
      const content=c.content,asset=doc.assets.find(a=>a.id===content.assetId),stream=asset?.streams.find(s=>s.index===content.streamIndex&&s.kind==='audio');
      if(!stream||!stream.channels||stream.channels>2)throw new Error('モノラルまたはステレオの原音を選んでください');
      // Imported AV clips share a video-frame duration; AAC can end partway through
      // the last frame. A declared silent tail is valid. Only decoded source spans
      // become candidates below, so missing samples cannot be cut as detected silence.
      if(content.endBehavior!=='silence'&&compareTime(sourceTimeAt(c,clipEnd(c),doc.fps),stream.duration)>0)throw new Error('元音声の長さを超える配置があります。対象を調整してください');
      clips.push(c);
    }
  }
  return clips;
}

function sourceSilences(e:SilenceEnvelope,threshold:number):Span[]{
  const out:Span[]=[];let start=-1;
  const append=(end:number)=>{
    // Shrink by half a window: a low RMS sample is not an exact boundary witness.
    const a=start===0?0:start*e.hopSamples+e.windowSamples/2;
    const b=end===e.rms.length?e.sampleCount:end*e.hopSamples-e.windowSamples/2;
    if(b>a)out.push({start:r(a,e.sampleRate),end:r(b,e.sampleRate)});start=-1;
  };
  for(let i=0;i<e.rms.length;i++){if(e.rms[i]!<=threshold){if(start<0)start=i;}else if(start>=0)append(i);}
  if(start>=0)append(e.rms.length);return out;
}

/** All interval arithmetic remains rational until the final sequence-frame inward rounding. */
export function planSilenceRanges(doc:SequenceDocument,trackIds:string[],sources:SourceEnvelope[],settings:SilenceSettings,scope:SilenceRange={startFrame:0,endFrame:doc.sequenceEndFrame}):SilenceRange[]{
  const s=silenceSettings(settings),clips=silenceSources(doc,trackIds),limit=r(doc.sequenceEndFrame);
  if(!Number.isSafeInteger(scope.startFrame)||!Number.isSafeInteger(scope.endFrame)||scope.startFrame<0||scope.endFrame>doc.sequenceEndFrame||scope.endFrame<=scope.startFrame)throw new Error('解析する選択範囲が不正です');
  const threshold=10**(s.thresholdDb/20),lookup=new Map<string,Span[]>(),coverage:Span[]=[];
  let quiet:Span[]=[{start:r(scope.startFrame),end:r(scope.endFrame)}];
  for(const track of trackIds){
    const audible:Span[]=[];
    for(const clip of clips.filter(c=>c.trackId===track)){
      if(clip.content.kind!=='audio')continue;
      const content=clip.content,key=`${content.assetId}:${content.streamIndex}`;
      let spans=lookup.get(key);
      if(!spans){const source=sources.find(e=>e.assetId===content.assetId&&e.streamIndex===content.streamIndex);if(!source)throw new Error('未解析の音声があります');spans=sourceSilences(source.envelope,threshold);lookup.set(key,spans);}
      const window={start:r(clip.startFrame),end:r(clipEnd(clip))};coverage.push(window);
      const mapped=intersect(spans.map(span=>({start:addTime(r(clip.startFrame),multiplyTime(divideTime(subtractTime(span.start,content.sourceIn),content.rate),doc.fps)),end:addTime(r(clip.startFrame),multiplyTime(divideTime(subtractTime(span.end,content.sourceIn),content.rate),doc.fps))})),[window]);
      audible.push(...intersect(complement(mapped,limit),[window]));
    }
    quiet=intersect(quiet,complement(audible,limit));
  }
  quiet=intersect(quiet,merge(coverage));
  const minFrames=multiplyTime(rationalFromDecimal(s.minSilenceSeconds),doc.fps),after=multiplyTime(rationalFromDecimal(s.afterSeconds),doc.fps),before=multiplyTime(rationalFromDecimal(s.beforeSeconds),doc.fps);
  const ranges=quiet.filter(q=>compareTime(subtractTime(q.end,q.start),minFrames)>=0).map(q=>({startFrame:ceilTime(addTime(q.start,after)),endFrame:floorTime(subtractTime(q.end,before))})).filter(q=>q.endFrame>q.startFrame);
  validateSilenceRanges(ranges,doc.sequenceEndFrame);return ranges;
}
