import {describe,expect,it} from 'vitest';
import {applySequenceCommand} from './commands';
import type {SequenceDocument,SequenceClip} from './model';
import {inspectNativeSourceGaps} from './sourceGapRecovery';
import {rational as r,type Rational} from './time';
import {parseSequence,serializeSequence} from './validate';

function base():SequenceDocument {
 return {schemaVersion:2,id:'source-gaps',name:'source gaps',revision:7,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:300,background:'#000',
 assets:[{id:'media',kind:'media',file:'media/a.mp4',name:'a',fingerprint:'fixed',streams:[{kind:'video',index:0,codec:'h264',duration:r(10),width:320,height:180,frameRate:r(30)},{kind:'audio',index:1,codec:'aac',duration:r(10),sampleRate:48000,channels:2}]}],
 tracks:[{id:'v',kind:'visual',name:'video',enabled:true},{id:'a',kind:'audio',name:'audio',enabled:true}],transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'},clips:[
 {id:'video-use',continuationGroupId:'video-use',trackId:'v',name:'video',startFrame:0,durationFrames:300,linkGroupId:'av',clock:{offset:r(0),rate:r(1),duration:r(300)},content:{kind:'video',assetId:'media',streamIndex:0,sourceIn:r(0),rate:r(1)}},
 {id:'audio-use',continuationGroupId:'audio-use',trackId:'a',name:'speech',startFrame:0,durationFrames:300,linkGroupId:'av',clock:{offset:r(0),rate:r(1),duration:r(300)},content:{kind:'audio',assetId:'media',streamIndex:1,sourceIn:r(0),rate:r(1),role:'speech',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}}]};
}
// Manually specify source/effect offsets and completion positions; no production splitter used.
function pieces(rows:[sourceFrame:number,startFrame:number,durationFrames:number][],fps:Rational=r(30),domain=300):SequenceDocument {
 const d=base();d.fps=fps;d.clips=rows.flatMap(([source,start,duration],i)=>base().clips.map(c=>({...c,id:`${c.content.kind}-${i}`,linkGroupId:`link-${i}`,startFrame:start,durationFrames:duration,
 clock:{offset:r(source),rate:r(1),duration:r(domain)},content:{...c.content,sourceIn:r(source*fps.den,fps.num)} as SequenceClip['content']})));
 d.sequenceEndFrame=Math.max(0,...d.clips.map(c=>c.startFrame+c.durationFrames));
 for(const stream of d.assets[0]!.streams)stream.duration=r(domain*fps.den,fps.num);
 return d;
}
const inspect=(d:SequenceDocument)=>inspectNativeSourceGaps(d);
const middle=()=>pieces([[0,0,90],[150,90,150]]);
function keepVideo(d:SequenceDocument){d.clips=d.clips.filter(c=>c.content.kind==='video');for(const c of d.clips)delete c.linkGroupId;return d;}
function archive(d:SequenceDocument,start:number,end:number){d.cutArchive=applySequenceCommand(base(),{type:'ripple-delete',startFrame:start,endFrame:end}).cutArchive;}

describe('declared native source gaps (not historical cut attribution)',()=>{
 it('uses manually specified NTSC source/clock windows, separating 52/51 seams from 127 head and 724 misaligned gap',()=>{
  const d=pieces([[127,0,125],[304,125,106],[461,231,3886],[5071,4154,47009]],r(60000,1001),52080),before=serializeSequence(d);
  const result=inspect(parseSequence(before));expect(result.issues).toEqual([]);expect(result.documentId).toBe(d.id);expect(result.revision).toBe(7);
  expect(result.candidates.map(c=>[c.clock.start,c.clock.end,c.durationFrames,c.placement])).toEqual([
   [r(0),r(127),127,{frame:null,reason:'outer-edge'}],
   [r(252),r(304),52,{frame:125,reason:'unique-seam'}],
   [r(410),r(461),51,{frame:231,reason:'unique-seam'}],
   [r(4347),r(5071),724,{frame:null,reason:'boundary-mismatch'}],
  ]);
  expect(result.candidates[1]!.source).toEqual({start:r(21021,5000),end:r(19019,3750)});
  expect(result.candidates[1]!.media.map(m=>[m.kind,m.streamIndex,m.leftOwnerIds,m.rightOwnerIds])).toEqual([['video',0,['video-0'],['video-1']],['audio',1,['audio-0'],['audio-1']]]);
  expect(result.candidates[1]!.ownerChoices[0]).toEqual({ownerClipId:'video-0',mediaOwnerIds:['video-0','audio-0'],side:'left',exactDuration:r(52),durationFrames:52});
  expect(serializeSequence(d)).toBe(before);result.candidates[0]!.clock.duration.num=1;expect(d.clips[0]!.clock.duration).toEqual(r(52080));
 });
 it('does not infer deleted subtitles or a historical cut operation',()=>{
  const c=inspect(middle()).candidates[0]!;expect(c.kind).toBe('raw-av');expect(c.reason).toContain('過去のカット');expect(c.media.map(m=>m.kind)).toEqual(['video','audio']);
 });
 it('does not infer lineage from asset equality, duration, or a completely deleted occurrence',()=>{
  const d=middle();for(const c of d.clips)delete c.continuationGroupId;expect(inspect(d).candidates).toEqual([]);
  d.clips=[];expect(inspect(d)).toMatchObject({candidates:[],issues:[]});
 });
 it('keeps distinct declared uses of the same asset separate, including identical source ranges',()=>{
  const d=middle();d.clips.push(...structuredClone(d.clips).map(c=>({...c,id:c.id+'-again',startFrame:c.startFrame+400,continuationGroupId:c.continuationGroupId+'-again',linkGroupId:c.linkGroupId+'-again'})));
  const found=inspect(d);expect(found.issues).toEqual([]);expect(found.candidates).toHaveLength(2);expect(new Set(found.candidates.map(c=>c.id)).size).toBe(2);
  expect(found.candidates.map(c=>c.placement.frame)).toEqual([90,490]);expect(found.candidates[1]!.ownerChoices.every(c=>c.mediaOwnerIds.every(id=>id.endsWith('-again')))).toBe(true);
 });
 it('finds no gap between adjacent source fragments',()=>{expect(inspect(pieces([[0,0,150],[150,150,150]])).candidates).toEqual([]);});
 it('limits outer ranges to the declared original effect domain, not the whole source asset',()=>{
  const d=keepVideo(pieces([[30,0,120]],r(30),180));d.assets[0]!.streams[0]!.duration=r(100);
  expect(inspect(d).candidates.map(c=>c.source)).toEqual([{start:r(0),end:r(1)},{start:r(5),end:r(6)}]);
 });
 it('keeps a moved/reordered occurrence inspectable but refuses a guessed insertion seam',()=>{
  const d=pieces([[0,300,90],[150,0,150]]);expect(inspect(d).candidates[0]!.placement).toEqual({frame:null,reason:'boundary-mismatch'});
 });
 it('allows explicit owner selection after left/right rate and current settings differ',()=>{
  const d=middle();for(const c of d.clips.filter(c=>c.startFrame===90)){c.durationFrames=75;c.clock.rate=r(2);if(c.content.kind==='video'||c.content.kind==='audio')c.content.rate=r(2);}
  const c=inspect(d).candidates[0]!;expect(c.ownerChoices.map(x=>[x.durationFrames,x.exactDuration])).toEqual([[60,r(60)],[30,r(30)]]);expect(c.durationFrames).toBeNull();expect(c.requiresOwnerChoice).toBe(true);
 });
 it('requires explicit choice for different current audio settings at the same rate',()=>{
  const d=middle(),a=d.clips.find(c=>c.id==='audio-1')!;if(a.content.kind==='audio')a.content.settings.gainDb=-6;
  const c=inspect(d).candidates[0]!;expect(c.requiresOwnerChoice).toBe(true);expect(c.durationFrames).toBe(60);
 });
 it('keeps fractional exact durations and uses ceil without rounding the source interval',()=>{
  const d=keepVideo(pieces([[0,0,1],[4,1,2]],r(30),10));for(const c of d.clips){c.clock.rate=r(3);if(c.content.kind==='video')c.content.rate=r(3);}
  const c=inspect(d).candidates[0]!;expect(c.source).toEqual({start:r(1,10),end:r(2,15)});expect(c.ownerChoices.map(x=>[x.durationFrames,x.exactDuration])).toEqual([[1,r(1,3)],[1,r(1,3)]]);expect(c.requiresOwnerChoice).toBe(false);
 });
 it('requires an owner choice even if unequal exact durations ceil to the same frame',()=>{
  const d=keepVideo(pieces([[0,0,1],[4,1,3]],r(30),10));const first=d.clips[0]!,last=d.clips[1]!;first.clock.rate=r(3);last.clock.rate=r(2);
  if(first.content.kind==='video')first.content.rate=r(3);if(last.content.kind==='video')last.content.rate=r(2);
  const c=inspect(d).candidates[0]!;expect(c.durationFrames).toBe(1);expect(c.requiresOwnerChoice).toBe(true);expect(c.ownerChoices.map(x=>x.exactDuration)).toEqual([r(1,3),r(1,2)]);
 });
 it.each(['source','clock','duration'] as const)('rejects incompatible %s affine lineage',field=>{
  const d=middle(),v=d.clips.find(c=>c.id==='video-1')!;
  if(field==='source'&&v.content.kind==='video')v.content.sourceIn=r(6);else if(field==='clock')v.clock.rate=r(2);else v.clock.duration=r(301);
  expect(inspect(d).candidates).toEqual([]);expect(inspect(d).issues.some(i=>i.reason==='source-effect-affine-mismatch')).toBe(true);
 });
 it('rejects overlapping source windows rather than treating repetitions as new missing ranges',()=>{
  const d=pieces([[0,0,160],[150,160,150]]);expect(inspect(d).candidates).toEqual([]);expect(inspect(d).issues[0]!.reason).toBe('overlapping-or-outside-source-windows');
 });
 it.each(['time','source','missing','extra'] as const)('rejects inconsistent explicit AV partners: %s',variant=>{
  const d=middle(),a=d.clips.find(c=>c.id==='audio-1')!;
  if(variant==='time')a.startFrame++;if(variant==='source'&&a.content.kind==='audio'){a.content.sourceIn=r(6);a.clock.offset=r(180);a.durationFrames=120;}
  if(variant==='missing')delete a.linkGroupId;if(variant==='extra')d.clips.push({...structuredClone(a),id:'another-audio',continuationGroupId:'other'});
  expect(inspect(d).candidates).toEqual([]);expect(inspect(d).issues.length).toBeGreaterThan(0);
 });
 it('supports finite unlinked speech alone without inventing missing video',()=>{
  const d=middle();d.clips=d.clips.filter(c=>c.content.kind==='audio');for(const c of d.clips)delete c.linkGroupId;
  expect(inspect(d).candidates[0]!.media.map(m=>m.kind)).toEqual(['audio']);
 });
 it('subtracts saved archive coverage for exactly the same usage and preserves unrelated gaps',()=>{
  const d=middle();archive(d,110,130);const before=JSON.stringify(d);
  const cs=inspect(d).candidates;expect(cs.map(c=>c.source)).toEqual([{start:r(3),end:r(11,3)},{start:r(13,3),end:r(5)}]);
  expect(cs.map(c=>c.placement)).toEqual([{frame:null,reason:'archived-boundary'},{frame:null,reason:'archived-boundary'}]);expect(cs.map(c=>c.durationFrames)).toEqual([20,20]);expect(JSON.stringify(d)).toBe(before);
 });
 it('does not propose ranges already archived, including after persistence',()=>{
  const d=middle();archive(d,90,150);expect(inspect(parseSequence(serializeSequence(d))).candidates).toEqual([]);
 });
 it('recognizes the original clip ID when an archive predates the first continuation split',()=>{
  const d=base();for(const c of d.clips)delete c.continuationGroupId;
  const cut=applySequenceCommand(d,{type:'ripple-delete',startFrame:90,endFrame:150});
  expect(cut.cutArchive!.entries[0]!.clips.every(c=>!c.continuationGroupId)).toBe(true);
  expect(inspect(cut).candidates).toEqual([]);
 });
 it('does not block a lineage merely because another usage of the same asset is archived',()=>{
  const d=middle();archive(d,90,150);for(const c of d.cutArchive!.entries[0]!.clips)c.continuationGroupId+='-other';
  expect(inspect(d).candidates[0]!.durationFrames).toBe(60);
 });
 it('refuses asymmetric AV archive coverage without suppressing an independent unlinked occurrence',()=>{
  const d=middle();archive(d,110,130);d.cutArchive!.entries[0]!.clips=d.cutArchive!.entries[0]!.clips.filter(c=>c.content.kind==='video');
  d.clips.push(...keepVideo(middle()).clips.map(c=>({...c,id:c.id+'-other',continuationGroupId:'other'})));
  const found=inspect(d);expect(found.issues).toContainEqual({continuationGroupId:'video-use',reason:'partial-av-archive'});expect(found.candidates.map(c=>c.continuationGroupId)).toEqual(['other']);
 });
 it('rejects conflicting archived affine metadata instead of offering duplicate recovery',()=>{
  const d=middle();archive(d,110,130);d.cutArchive!.entries[0]!.clips[0]!.clock.offset=r(0);
  expect(inspect(d).candidates).toEqual([]);expect(inspect(d).issues[0]!.reason).toBe('archive-lineage-affine-mismatch');
 });
 it('reports registered-speed projection as explicitly unfinished rather than discarding a ledger',()=>{
  const d=applySequenceCommand(base(),{type:'register-native-speed',groupId:'speed',mainClipIds:['video-use'],mainAudioBindings:[{audioClipId:'audio-use',providerId:'video-use'}]});const before=JSON.stringify(d);
  expect(inspect(d).issues.some(i=>i.reason==='registered-timing-needs-projection')).toBe(true);expect(JSON.stringify(d)).toBe(before);
 });
 it('rejects a missing source stream and a declared domain beyond media',()=>{
  const d=middle();d.assets[0]!.streams=[];expect(inspect(d).issues[0]!.reason).toBe('missing-source-stream');
  const e=middle();e.assets[0]!.streams[0]!.duration=r(9);expect(inspect(e).issues[0]!.reason).toBe('source-domain-outside-media');
 });
 it('clips the original ceil-frame end to finite media time without inventing an end hold',()=>{
  const d=keepVideo(pieces([[0,0,90],[150,90,149]]));d.assets[0]!.streams[0]!.duration=r(599,60);
  const cs=inspect(d).candidates;expect(cs).toHaveLength(2);expect(cs[1]!.source).toEqual({start:r(299,30),end:r(599,60)});
  expect(cs[1]!.ownerChoices[0]).toMatchObject({durationFrames:1,exactDuration:r(1,2)});expect(cs[1]!.clock.end).toEqual(r(599,2));
  d.clips[1]!.durationFrames=150;expect(inspect(d).candidates).toHaveLength(1);
 });
 it('refuses live samples at or beyond media end even inside a ceiled original domain',()=>{
  const d=keepVideo(pieces([[0,0,90],[150,90,300]]));d.clips[1]!.clock.rate=r(1,2);if(d.clips[1]!.content.kind==='video')d.clips[1]!.content.rate=r(1,2);
  d.assets[0]!.streams[0]!.duration=r(599,60);expect(inspect(d).candidates).toEqual([]);expect(inspect(d).issues[0]!.reason).toBe('live-sample-outside-media');
 });
 it('requires explicit owner choice if the adjacent surviving material was moved to another track',()=>{
  const d=middle();d.clips.find(c=>c.id==='video-1')!.trackId='other-video';expect(inspect(d).candidates[0]!.requiresOwnerChoice).toBe(true);
 });
});
