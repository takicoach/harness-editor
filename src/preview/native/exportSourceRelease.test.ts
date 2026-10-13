import {expect,it} from 'vitest';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
import {EXPORT_SOURCE_MAX_BYTES,EXPORT_SOURCES_TOTAL_BYTES,exportRendererOptions,parseRetainFrames,sourcesToRelease,videoSourceUses} from './exportSourceRelease';

/** Only what the planner reads: assets, tracks and clips. */
function documentWith(clips:Array<{asset:string;start:number;frames:number;track?:string;stream?:number;kind?:'video'|'audio'|'image'}>):SequenceDocument {
  return {
    assets:[
      {id:'a',fingerprint:'A',streams:[]},{id:'b',fingerprint:'B',streams:[]},{id:'c',fingerprint:'C',streams:[]},
      {id:'a-copy',fingerprint:'A',streams:[]},
    ],
    tracks:[{id:'v1',enabled:true},{id:'v2',enabled:true},{id:'off',enabled:false}],
    clips:clips.map((clip,i)=>({id:`clip-${i}`,trackId:clip.track??'v1',startFrame:clip.start,durationFrames:clip.frames,
      content:clip.kind==='image'?{kind:'image',assetId:clip.asset}:{kind:clip.kind??'video',assetId:clip.asset,streamIndex:clip.stream??0,sourceIn:r(0),rate:r(1)}})),
  } as unknown as SequenceDocument;
}

it('collects the frames each source (fingerprint:stream) is drawn, merged, without audio, images or disabled tracks',()=>{
  const uses=videoSourceUses(documentWith([
    {asset:'a',start:0,frames:10},{asset:'a-copy',start:10,frames:5},{asset:'a',start:40,frames:10,track:'v2'},
    {asset:'a',start:45,frames:20},{asset:'b',start:20,frames:5},{asset:'b',start:0,frames:100,kind:'audio'},
    {asset:'c',start:0,frames:100,track:'off'},{asset:'c',start:0,frames:100,kind:'image'},{asset:'a',start:70,frames:5,stream:1},
  ]));
  expect(Object.fromEntries(uses)).toEqual({'A:0':[{start:0,end:15},{start:40,end:65}],'B:0':[{start:20,end:25}],'A:1':[{start:70,end:75}]});
});
it('releases a source after its last use and keeps one that returns while all sources fit the total',()=>{
  const uses=videoSourceUses(documentWith([{asset:'a',start:0,frames:10},{asset:'b',start:5,frames:5},{asset:'a',start:30,frames:5}]));
  const open=[{key:'A:0',bytes:100},{key:'B:0',bytes:100}];
  expect(sourcesToRelease(8,open,uses,1000)).toEqual([]);
  expect(sourcesToRelease(9,open,uses,1000)).toEqual([{key:'B:0',reason:'lastUse'}]);
  // A is idle from 10 to 29 but returns at 30: kept while under the total.
  expect(sourcesToRelease(12,[{key:'A:0',bytes:100}],uses,1000)).toEqual([]);
  expect(sourcesToRelease(34,[{key:'A:0',bytes:100}],uses,1000)).toEqual([{key:'A:0',reason:'lastUse'}]);
  // A source the document never draws (or no longer draws) is released too.
  expect(sourcesToRelease(0,[{key:'Z:0',bytes:1}],uses,1000)).toEqual([{key:'Z:0',reason:'lastUse'}]);
});
it('over the total, releases sources idle at the next frame, farthest next use first, never one needed next',()=>{
  const uses=videoSourceUses(documentWith([
    {asset:'a',start:0,frames:100},{asset:'b',start:0,frames:1},{asset:'b',start:50,frames:1},{asset:'c',start:0,frames:1},{asset:'c',start:20,frames:1},
  ]));
  const open=[{key:'A:0',bytes:600},{key:'B:0',bytes:300},{key:'C:0',bytes:300}];
  expect(sourcesToRelease(5,open,uses,1000)).toEqual([{key:'B:0',reason:'overBudget'}]);
  expect(sourcesToRelease(5,open,uses,899)).toEqual([{key:'B:0',reason:'overBudget'},{key:'C:0',reason:'overBudget'}]);
  expect(sourcesToRelease(5,open,uses,1200)).toEqual([]);
  expect(sourcesToRelease(5,open,uses,1199)).toEqual([{key:'B:0',reason:'overBudget'}]);
  // A source needed at the next frame stays even when it alone is over the total.
  expect(sourcesToRelease(5,[{key:'A:0',bytes:5000}],uses,1000)).toEqual([]);
  expect(sourcesToRelease(49,[{key:'B:0',bytes:5000}],uses,1000)).toEqual([]);
  expect(sourcesToRelease(48,[{key:'B:0',bytes:5000}],uses,1000)).toEqual([{key:'B:0',reason:'overBudget'}]);
});
it('turns the explicit retain=N of the export page into retention and release options, and rejects a bad value',()=>{
  expect(parseRetainFrames(null)).toBeUndefined();
  expect(parseRetainFrames('8')).toBe(8);
  for(const bad of ['','0','65','8.5','x','-1'])expect(()=>parseRetainFrames(bad)).toThrow(/保持/);
  expect(exportRendererOptions(undefined)).toEqual({});
  expect(exportRendererOptions(8)).toEqual({retention:{minFrames:8,maxBytes:EXPORT_SOURCE_MAX_BYTES,keepDecoderOpen:true},release:{totalBytes:EXPORT_SOURCES_TOTAL_BYTES}});
});
