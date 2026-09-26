import {expect,it} from 'vitest';
import {applySequenceCommand} from '../../core/sequence/commands';
import {planAudioSourceRegions} from '../../core/sequence/audioSourceRegions';
import {ScenePlan} from '../../core/sequence/scenePlan';
import {validateSequenceDocument} from '../../core/sequence/validate';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r,ceilTime,divideTime,multiplyTime,subtractTime,timeNumber} from '../../core/sequence/time';
import {mixAudioBlock,pcmReadRanges,type SourceWindowPcm} from './audioMixer';

type RegionPcmPayload=Pick<SourceWindowPcm,'sampleRate'|'sourceWindow'>&{sampleCount:number;sample(channel:number,index:number):number};

function phaseDocument(rate=r(2)):SequenceDocument {
  const leadFrames=rate.num/rate.den===16?33:3;
  let doc:SequenceDocument={schemaVersion:2,id:'phase-region',name:'phase region',revision:0,fps:r(1),resolution:{width:2,height:2},sequenceEndFrame:leadFrames+601,background:'#000',ducking:{enabled:false,strength:'mid'},transcripts:[],transitions:[],
    assets:[{id:'media',kind:'media',name:'Original',file:'source.mp4',fingerprint:'fixture',streams:[{index:0,kind:'video',duration:r(1000),codec:'h264',frameRate:r(1),width:2,height:2},{index:1,kind:'audio',duration:r(1000),codec:'pcm',sampleRate:8,channels:1}]}],
    tracks:[{id:'v',kind:'visual',name:'Video',enabled:true},{id:'a',kind:'audio',name:'Audio',enabled:true}],clips:[]};
  for(const [id,startFrame,durationFrames,sourceIn] of [['a',0,leadFrames,0],['b',leadFrames,601,10]] as const){
    const common={startFrame,durationFrames,linkGroupId:id,clock:{offset:r(0),rate:r(1),duration:r(durationFrames)}};
    doc.clips.push({...common,id,trackId:'v',name:id,content:{kind:'video',assetId:'media',streamIndex:0,sourceIn:r(sourceIn),rate:r(1)}});
    doc.clips.push({...common,id:id+'-audio',trackId:'a',name:id+' audio',content:{kind:'audio',assetId:'media',streamIndex:1,sourceIn:r(sourceIn),rate:r(1),role:'speech',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}});
  }
  doc=applySequenceCommand(doc,{type:'register-native-speed',groupId:'main',mainClipIds:['a','b'],mainAudioBindings:[{audioClipId:'a-audio',providerId:'a'},{audioClipId:'b-audio',providerId:'b'}]});
  return applySequenceCommand(doc,{type:'set-native-global-speed',rate});
}
function sources(doc:SequenceDocument,cache=new Map<string,RegionPcmPayload>()) {
  const planned=planAudioSourceRegions(doc),byRegion=new Map(planned.regions.map(region=>[region.regionKey,region]));
  return new Map(planned.clips.map(clip=>{
    const region=byRegion.get(clip.regionKey!)!;if(!region.physical||region.kind!=='finite')throw new Error('fixture requires finite physical audio');
    let prepared=cache.get(region.pcmKey);
    if(!prepared){
      const sourceWindow={...region.physical,sampleOrigin:region.physical.start};
      prepared={sampleRate:8,sourceWindow,
        sampleCount:ceilTime(multiplyTime(divideTime(subtractTime(sourceWindow.end,sourceWindow.sampleOrigin),region.rate),r(8))),sample:(_channel,index)=>index+1};
      cache.set(region.pcmKey,prepared);
    }
    // Requested intent partitions the processing union, not this clip's rounded output clock.
    const binding:SourceWindowPcm={...prepared,kind:'source-window-pcm',assetId:region.assetId,streamIndex:region.streamIndex,rate:region.rate};
    return [`@clip:${clip.clipId}`,binding];
  }));
}
class PreparationCache extends Map<string,RegionPcmPayload>{
  writes=0;
  override set(key:string,value:RegionPcmPayload){this.writes++;return super.set(key,value);}
}
it('keeps PCM and cache identity across a real split with different requested and evaluation source positions',()=>{
  const doc=phaseDocument(),split=applySequenceCommand(doc,{type:'split',clipIds:['b'],frame:3,linked:true});
  const right=split.clips.find(clip=>clip.content.kind==='audio'&&clip.startFrame===3)!;
  expect(right.content).toMatchObject({sourceIn:r(12)});expect(right.speed!.source.sourceStart).toEqual(r(13));
  const cache=new PreparationCache(),original=sources(doc,cache),parts=sources(split,cache);
  expect(cache.size).toBe(2);expect(cache.writes).toBe(2);
  const old=original.get('@clip:b-audio')!,next=parts.get(`@clip:${right.id}`)!;
  expect(next.sourceWindow).toBe(old.sourceWindow);
  expect('sample' in next&&'sample' in old&&next.sample===old.sample).toBe(true);
  const expected=mixAudioBlock(new ScenePlan(doc),original,0,48,8),actual=mixAudioBlock(new ScenePlan(split),parts,0,48,8);
  expect(expected[0][24]).toBe(9);expect(actual).toEqual(expected);
});
it.each([r(34,25),r(1,10),r(16)])('preserves samples, gain and fades across neutral split at rate %j',rate=>{
  const doc=phaseDocument(rate),owner=doc.clips.find(clip=>clip.id==='b')!;
  const fadeOutFrames=6;
  for(const clip of doc.clips)if(clip.content.kind==='audio')clip.content.settings={...clip.content.settings,gainDb:-6,fadeInFrames:2,fadeOutFrames};
  const split=applySequenceCommand(doc,{type:'split',clipIds:['b'],frame:owner.startFrame+1,linked:true});
  expect(split.clips.filter(clip=>clip.content.kind==='audio')).toHaveLength(3);
  const cache=new PreparationCache(),original=sources(doc,cache),parts=sources(split,cache);
  expect(cache.size).toBe(2);expect(cache.writes).toBe(2);
  const audioOwner=doc.clips.find(clip=>clip.id==='b-audio')!;
  const tailFrame=audioOwner.startFrame+(timeNumber(audioOwner.clock.duration)-1-fadeOutFrames/2-timeNumber(audioOwner.clock.offset))/timeNumber(audioOwner.clock.rate);
  for(const sampleRate of [8,48000]){
    const from=Math.max(0,owner.startFrame-1)*sampleRate,count=5*sampleRate;
    expect(mixAudioBlock(new ScenePlan(split),parts,from,count,sampleRate)).toEqual(mixAudioBlock(new ScenePlan(doc),original,from,count,sampleRate));
    const tail=Math.floor(tailFrame*sampleRate),originalPlan=new ScenePlan(doc),gain=originalPlan.audioGain(audioOwner,tail/sampleRate);
    expect(gain).toBeGreaterThan(0);expect(gain).toBeLessThan(10**(-6/20));
    const expected=mixAudioBlock(originalPlan,original,tail,3,sampleRate);
    expect(expected[0][0]).toBeGreaterThan(0);
    expect(mixAudioBlock(new ScenePlan(split),parts,tail,3,sampleRate)).toEqual(expected);
  }
});
it('preloads every shared-region interpolation tap through a phase split',()=>{
  const doc=applySequenceCommand(phaseDocument(),{type:'split',clipIds:['b'],frame:3,linked:true}),plan=new ScenePlan(doc),prepared=sources(doc);
  for(const [start,count] of [[15,5],[22,5],[24,1],[25,8]]){
    const ranges=pcmReadRanges(plan,prepared,start!,count!,8);
    const tracked=new Map([...prepared].map(([key,pcm])=>[key,{...pcm,sample(channel:number,index:number){
      expect(ranges.get(key)?.some(range=>range.from<=index&&index<range.to)).toBe(true);
      if(!('sample' in pcm))throw new Error('fixture');return pcm.sample(channel,index);
    }}]));
    expect(mixAudioBlock(plan,tracked,start!,count!,8)).toEqual(mixAudioBlock(plan,prepared,start!,count!,8));
  }
});
it('does not reuse deleted sibling source context at the surviving clip start',()=>{
  const split=applySequenceCommand(phaseDocument(),{type:'split',clipIds:['b'],frame:3,linked:true});
  const removed=applySequenceCommand(split,{type:'delete',clipIds:['b'],linked:true});
  const right=removed.clips.find(clip=>clip.content.kind==='audio'&&clip.startFrame===3)!;
  expect(right.content).toMatchObject({sourceIn:r(12)});
  expect(removed.clips.find(clip=>clip.content.kind==='video'&&clip.startFrame===3)!.content).toMatchObject({sourceIn:r(12)});
  expect(right.speed!.source.sourceStart).toEqual(r(13));
  const previous=mixAudioBlock(new ScenePlan(split),sources(split),24,5,8)[0];
  expect([...previous]).toEqual([9,10,11,12,13]);
  const actual=mixAudioBlock(new ScenePlan(removed),sources(removed),24,5,8)[0];
  expect([...actual]).toEqual([0,0,0,0,1]);
});
it('does not reuse deleted sibling source context at the surviving clip end',()=>{
  const doc=phaseDocument(r(34,25)),owner=doc.clips.find(clip=>clip.id==='b')!;
  const split=applySequenceCommand(doc,{type:'split',clipIds:['b'],frame:owner.startFrame+1,linked:true});
  const right=split.clips.find(clip=>clip.content.kind==='video'&&clip.id!=='b'&&clip.startFrame===owner.startFrame+1)!;
  const removed=applySequenceCommand(split,{type:'delete',clipIds:[right.id],linked:true});
  const left=removed.clips.find(clip=>clip.id==='b-audio')!;
  expect(left.content).toMatchObject({sourceIn:r(10),rate:r(34,25)});
  expect(left.speed!.source.sourceEnd).toEqual(r(277,25));
  const previous=mixAudioBlock(new ScenePlan(split),sources(split),16,8,8)[0];
  expect([...previous]).toEqual([1,2,3,4,5,6,7,8]);
  const actual=mixAudioBlock(new ScenePlan(removed),sources(removed),16,8,8)[0];
  expect([...actual]).toEqual([1,2,3,4,5,6,7,0]);
});
it('shares a PCM payload across identical content while binding each asset separately',()=>{
  const doc=phaseDocument();delete doc.speed;for(const clip of doc.clips)delete clip.speed;
  doc.assets.push({...structuredClone(doc.assets[0]!),id:'same-content-other-id'});
  const copy=structuredClone(doc.clips.find(clip=>clip.id==='b-audio')!);
  copy.id='inserted-audio';delete copy.linkGroupId;delete copy.continuationGroupId;copy.startFrame=302;
  if(copy.content.kind!=='audio')throw new Error('fixture');
  copy.content.assetId='same-content-other-id';doc.clips.push(copy);doc.sequenceEndFrame=602;
  validateSequenceDocument(doc);
  const cache=new PreparationCache(),prepared=sources(doc,cache);
  const original=prepared.get('@clip:b-audio')!,inserted=prepared.get('@clip:inserted-audio')!;
  expect(cache.writes).toBe(2);expect(cache.size).toBe(2);
  expect(original.assetId).toBe('media');expect(inserted.assetId).toBe('same-content-other-id');
  expect(inserted.sourceWindow).toBe(original.sourceWindow);
  expect('sample' in inserted&&'sample' in original&&inserted.sample===original.sample).toBe(true);
  const plan=new ScenePlan(doc),actual=mixAudioBlock(plan,prepared,302*8,8,8);
  expect(actual[0][0]).toBeGreaterThan(0);
  expect(actual).toEqual(mixAudioBlock(plan,prepared,doc.clips.find(clip=>clip.id==='b-audio')!.startFrame*8,8,8));
});
it('excludes the extra raw DSP sample in the 16001-input / 10668-output fractional-end case',()=>{
  const plan=new ScenePlan(phaseDocument(r(3,2)));
  const source:SourceWindowPcm={kind:'source-window-pcm',assetId:'media',streamIndex:1,rate:r(3,2),sampleRate:48000,
    sourceWindow:{start:r(0),end:r(80002,240000),sampleOrigin:r(0)},sampleCount:10668,
    sample(_channel,index){expect(index).toBeLessThan(10667);return 1;}};
  const prepared=new Map([['@clip:a-audio',source]]),ranges=pcmReadRanges(plan,prepared,0,12000,48000);
  expect(ranges.get('@clip:a-audio')).toEqual([{from:0,to:10667}]);
  const output=mixAudioBlock(plan,prepared,0,12000,48000)[0];
  expect(output[10666]).toBe(1);expect([...output.slice(10667)]).toEqual(new Array(1333).fill(0));
});
