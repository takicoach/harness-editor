import {expect,it} from 'vitest';
import {applySequenceCommand as apply,previewCutRestoration} from './commands';
import {clipEnd,effectFrameAt,sourceTimeAt,type SequenceDocument} from './model';
import {rational as r} from './time';
import {resolveCutBoundary} from './cutArchive';
import {parseSequence,serializeSequence,sequenceContentBytes} from './validate';
import {SequenceSession} from './session';
function fixture():SequenceDocument{return {schemaVersion:2,id:'cut-test',name:'cut',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:120,background:'#000',assets:[{id:'media',kind:'media',file:'media/a.mp4',name:'a',fingerprint:'a',streams:[{kind:'video',index:0,codec:'h264',duration:r(10),width:320,height:180,frameRate:r(30)},{kind:'audio',index:1,codec:'aac',duration:r(10),sampleRate:48000,channels:2}]}],tracks:[{id:'v',kind:'visual',name:'v',enabled:true},{id:'a',kind:'audio',name:'a',enabled:true},{id:'t',kind:'visual',name:'t',enabled:true}],transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'},clips:[
{id:'v1',trackId:'v',name:'映像',startFrame:0,durationFrames:120,linkGroupId:'av',clock:{offset:r(7),rate:r(2),duration:r(250)},content:{kind:'video',assetId:'media',streamIndex:0,sourceIn:r(0),rate:r(2)}},
{id:'a1',trackId:'a',name:'原音',startFrame:0,durationFrames:120,linkGroupId:'av',clock:{offset:r(3),rate:r(3),duration:r(400)},content:{kind:'audio',assetId:'media',streamIndex:1,sourceIn:r(0),rate:r(2),role:'speech',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}},
{id:'t1',trackId:'t',name:'字幕',startFrame:0,durationFrames:120,clock:{offset:r(0),rate:r(1),duration:r(120)},content:{kind:'telop',data:{text:'元の本文'}},anchor:{kind:'source',role:'speech',sourceAssetId:'media',clipOccurrenceId:'a1',sourceStart:r(0),sourceEnd:r(8)}}]};}

function fixed(){const d=fixture();delete d.clips[2]!.anchor;return d;}
function register(d:SequenceDocument){return apply(d,{type:'register-native-speed',groupId:'g',mainClipIds:['v1'],mainAudioBindings:[{audioClipId:'a1',providerId:'v1'}]});}
const speed=(d:SequenceDocument)=>apply(d,{type:'set-native-global-speed',rate:r(4)});
const cut=(d:SequenceDocument,startFrame=30,endFrame=60)=>apply(d,{type:'ripple-delete',startFrame,endFrame});
const restore=(d:SequenceDocument,range?:{startFrame:number;endFrame:number},atFrame?:number)=>apply(d,{type:'restore-cut',entryId:d.cutArchive!.entries[0]!.id,...(range?{range}:{}),...(atFrame===undefined?{}:{atFrame})});
function sparseFixedGap(){
 const input=fixed();input.clips[2]!.durationFrames=10;
 input.clips.push({...structuredClone(input.clips[2]!),id:'t2',startFrame:100});
 const d=cut(register(input));
 // Persisted projects can retain older offsets after another edit moves a distant effect.
 d.clips.find(c=>c.id==='t2')!.startFrame-=5;
 return d;
}
it('restores inside a proven sparse fixed-track gap when persisted offset witnesses disagree',()=>{
 const d=sparseFixedGap();
 const saved=parseSequence(serializeSequence(d)),before=sequenceContentBytes(saved);
 expect(resolveCutBoundary(saved,saved.cutArchive!.entries[0]!).frame).toBe(30);
 for(const command of [
  {type:'restore-cut' as const,entryId:saved.cutArchive!.entries[0]!.id,range:{startFrame:10,endFrame:20}},
  {type:'resize-cut-boundary' as const,cut:{kind:'entry' as const,id:saved.cutArchive!.entries[0]!.id},edge:'start' as const,target:{kind:'archived' as const,entryId:saved.cutArchive!.entries[0]!.id,localFrame:10}},
  {type:'resize-cut-boundary' as const,cut:{kind:'entry' as const,id:saved.cutArchive!.entries[0]!.id},edge:'end' as const,target:{kind:'archived' as const,entryId:saved.cutArchive!.entries[0]!.id,localFrame:20}},
 ]){
  const next=apply(saved,command);expect(next.sequenceEndFrame).toBe(100);
  expect(next.clips.find(c=>c.id==='t1')!.startFrame).toBe(0);
  expect(next.clips.find(c=>c.id==='t2')!.startFrame).toBe(75);
 }
 expect(sequenceContentBytes(saved)).toBe(before);
});
for(const change of ['missing','other-track','occupied','reversed','ambiguous'])it(`does not guess sparse fixed placement when ${change}`,()=>{
 const d=sparseFixedGap(),right=d.clips.find(c=>c.id==='t2')!;
 if(change==='missing')d.clips=d.clips.filter(c=>c.trackId!=='t');
 if(change==='other-track'){d.tracks.push({id:'other',kind:'visual',name:'other',enabled:true});right.trackId='other';}
 if(change==='occupied')d.clips.push({...structuredClone(d.clips.find(c=>c.id==='t1')!),id:'new',startFrame:25,durationFrames:10});
 if(change==='reversed')right.startFrame=15;
 if(change==='ambiguous')d.cutArchive!.entries[0]!.trackBoundaries!.find(t=>t.trackId==='t')!.boundary.ambiguous=true;
 const before=sequenceContentBytes(d);expect(()=>restore(d)).toThrow();expect(sequenceContentBytes(d)).toBe(before);
});
function av(d:SequenceDocument,f:number){return d.clips.filter(c=>(c.content.kind==='video'||c.content.kind==='audio')&&c.startFrame<=f&&f<clipEnd(c)).map(c=>({kind:c.content.kind,source:sourceTimeAt(c,f,d.fps),clock:effectFrameAt(c,f)}));}
it('inserts the AV span without adding a hole for the longer fixed caption',()=>{
 const original=register(fixed()),d=speed(cut(original)),expected=speed(original),next=restore(d);
 expect(previewCutRestoration(d,d.cutArchive!.entries[0]!.id)).toEqual({durationFrames:15});
 for(let f=0;f<60;f++)expect(av(next,f),'frame '+f).toEqual(av(expected,f));
 const saved=d.cutArchive!.entries[0]!.clips.find(c=>c.content.kind==='telop')!;
 expect(next.clips.find(c=>c.content.kind==='telop'&&c.startFrame===30)).toMatchObject({durationFrames:30,clock:saved.clock,content:saved.content});
});
it('keeps fixed insertion at its proven track boundary after a speed change',()=>{
 const input=fixed();input.clips[2]!.startFrame=23;input.clips[2]!.durationFrames=48;
 let d=cut(register(input));d=restore(d,{startFrame:10,endFrame:20});d=speed(d);
 const before=d.clips.filter(c=>c.content.kind==='telop'),next=restore(d);
 expect(next.clips.find(c=>c.content.kind==='video'&&c.startFrame===20)).toBeDefined();
 expect(before.map(c=>[c.startFrame,c.durationFrames])).toEqual([[23,7],[40,11],[30,10]]);
 expect(next.clips.filter(c=>c.trackId==='t').map(c=>[c.startFrame,c.durationFrames])).toEqual([[23,7],[50,11],[40,10],[30,10]]);
 // The saved fixed insertion point stays30 while the AV seam moves15. Preserve the left live caption at23.
 expect(resolveCutBoundary(next,next.cutArchive!.entries[0]!).frame).toBe(25);
});
it('keeps adjacent fixed text, clocks and source audio while splitting at the insertion seam',()=>{
 const input=fixed();input.clips[2]!.durationFrames=30;input.clips.push({...structuredClone(input.clips[2]!),id:'t2',startFrame:30,durationFrames:90,content:{kind:'telop',data:{text:'隣の本文'}}});
 const d=speed(cut(register(input))),next=restore(d);
 for(let f=0;f<60;f++)expect(av(next,f)).toHaveLength(2);
 expect(next.clips.filter(c=>c.content.kind==='telop').map(c=>c.content.kind==='telop'&&c.content.data.text)).toContain('隣の本文');
 parseSequence(serializeSequence(next));
});
it('relocates only restored fixed exposure above a track now occupied by live main video',()=>{
 let d=speed(cut(register(fixed())));d=apply(d,{type:'delete',clipIds:d.clips.filter(c=>c.content.kind==='telop').map(c=>c.id),linked:false});const right=d.clips.find(c=>c.speed?.kind==='main'&&c.startFrame===15)!;
 d=apply(d,{type:'move',clipIds:[right.id],deltaFrames:0,trackId:'t',linked:true});const next=restore(d,undefined,15);
 for(let f=0;f<60;f++)expect(av(next,f)).toHaveLength(2);
 expect(next.clips.find(c=>c.id===right.id)?.trackId).toBe('t');const caption=next.clips.find(c=>c.content.kind==='telop')!;
 expect(caption.trackId).not.toBe('t');expect(next.tracks.findIndex(t=>t.id===caption.trackId)).toBe(next.tracks.findIndex(t=>t.id==='t')+1);
 expect(caption.durationFrames).toBe(30);parseSequence(serializeSequence(next));
});
it('keeps a visible fixed tail but does not expose a previously out-of-completion clip',()=>{
 const input=fixed();input.clips.push({...structuredClone(input.clips[2]!),id:'outside',trackId:'outside-track',startFrame:150,durationFrames:50});input.tracks.push({id:'outside-track',kind:'visual',name:'外側',enabled:true});
 const d=speed(cut(register(input))),next=restore(d);expect(next.sequenceEndFrame).toBe(75);expect(next.sequenceEndFrame).toBeLessThan(next.clips.find(c=>c.id==='outside')!.startFrame);
 for(let f=0;f<60;f++)expect(av(next,f)).toHaveLength(2);expect(av(next,65)).toHaveLength(0);
});
it('supports partial restore, later cut, full restore and one Undo with stable save bytes',()=>{
 const d=speed(cut(register(fixed()))),session=new SequenceSession('fixed-exposure',d),bytes=sequenceContentBytes(d);
 session.execute({sessionId:session.id,expectedRevision:d.revision,executionId:'restore',command:{type:'restore-cut',entryId:d.cutArchive!.entries[0]!.id,range:{startFrame:10,endFrame:20}}});let next=parseSequence(serializeSequence(session.document));
 expect(next.cutArchive!.entries.map(e=>e.durationFrames)).toEqual([10,10]);expect(next.cutArchive!.entries.every(e=>resolveCutBoundary(next,e).frame!==null)).toBe(true);
 next=cut(next,5,10);while(next.cutArchive?.entries.length)next=restore(next);
 const expected=speed(register(fixed()));for(let f=0;f<60;f++)expect(av(next,f)).toEqual(av(expected,f));
 session.execute({sessionId:session.id,expectedRevision:session.document.revision,executionId:'undo',command:{type:'undo'}});expect(sequenceContentBytes(session.document)).toBe(bytes);
});
it('rebinds an unrelated later cut to the known AV insertion while fixed tracks use more room',()=>{
 const d=speed(cut(cut(register(fixed())),60,70)),next=restore(d);
 expect(resolveCutBoundary(d,d.cutArchive!.entries[1]!).frame).toBe(30);
 expect(resolveCutBoundary(next,next.cutArchive!.entries[0]!).frame).toBe(45);
 const complete=restore(parseSequence(serializeSequence(next)));for(let f=0;f<60;f++)expect(av(complete,f)).toHaveLength(2);
});
it('preserves a fixed BGM clock on its own track without padding the main AV',()=>{
 const input=fixed();input.tracks.push({id:'m',kind:'audio',name:'音楽',enabled:true});const music=structuredClone(input.clips[1]!);music.id='music';music.trackId='m';delete music.linkGroupId;if(music.content.kind==='audio')music.content.role='music';input.clips.push(music);
 const d=speed(cut(register(input))),next=restore(d);for(let f=0;f<60;f++)expect(next.clips.filter(c=>(c.trackId==='v'||c.trackId==='a')&&c.startFrame<=f&&f<clipEnd(c))).toHaveLength(2);
 const saved=d.cutArchive!.entries[0]!.clips.find(c=>c.trackId==='m')!;expect(next.clips.find(c=>c.trackId==='m'&&c.startFrame===30)).toMatchObject({clock:saved.clock,content:saved.content,durationFrames:saved.durationFrames});
});
it('keeps fixed-only bands and their exposure when no archived main contributes an insertion clock',()=>{
 const input=fixed();input.sequenceEndFrame=180;input.clips[2]!.durationFrames=180;const d=speed(cut(register(input),125,145));
 expect(previewCutRestoration(d,d.cutArchive!.entries[0]!.id)).toEqual({durationFrames:20});const next=restore(d,undefined,65);expect(next.clips.some(c=>c.content.kind==='telop'&&c.startFrame===65&&c.durationFrames===20)).toBe(true);parseSequence(serializeSequence(next));
});
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {SequenceStore} from '../../server/sequence/store';
it('persists fixed exposure and AV continuity through actual Store partial/full saves',()=>{
 const dir=mkdtempSync(join(tmpdir(),'cut-fixed-exposure-'));try{
  const store=new SequenceStore(dir),original=speed(cut(register(fixed()))),saved=store.save({document:original,expectedSavedRevision:null,executionId:'initial'}),before=readFileSync(store.file);
  const partial=restore(store.load()!.document,{startFrame:10,endFrame:20});expect(readFileSync(store.file)).toEqual(before);
  const savedPartial=store.save({document:partial,expectedSavedRevision:saved.savedRevision,executionId:'partial'});let d=new SequenceStore(dir).load()!.document;
  while(d.cutArchive?.entries.length)d=restore(d);const expected=speed(register(fixed()));for(let f=0;f<60;f++)expect(av(d,f)).toEqual(av(expected,f));
  store.save({document:d,expectedSavedRevision:savedPartial.savedRevision,executionId:'full'});expect(sequenceContentBytes(new SequenceStore(dir).load()!.document)).toBe(sequenceContentBytes(d));
 }finally{rmSync(dir,{recursive:true,force:true});}
});

it('keeps ordinary fixed tail separate from an existing insert-own completion floor',()=>{
 let input=fixed();input.tracks.push({id:'insert',kind:'visual',name:'挿入',enabled:true});const c=structuredClone(input.clips[0]!);c.id='insert';c.trackId='insert';c.durationFrames=10;delete c.linkGroupId;input.clips.push(c);
 input=apply(input,{type:'register-native-insert-own-speed',clipId:'insert',linked:false});
 const next=restore(speed(cut(register(input))));expect(next.sequenceEndFrame).toBe(75);expect(next.insertOwnSpeed?.endFloor).toBe(75);parseSequence(serializeSequence(next));
});
for(const side of ['left-first','right-first'] as const)it(`preserves fixed caption and BGM chronological source/clock after interior then ${side}`,()=>{
 const input=fixed();input.clips[2]!.startFrame=30;input.clips[2]!.durationFrames=30;input.clips[2]!.clock.offset=r(30);
 input.tracks.push({id:'m',kind:'audio',name:'音楽',enabled:true});const music=structuredClone(input.clips[1]!);music.id='music';music.trackId='m';music.startFrame=30;music.durationFrames=30;music.clock={offset:r(30),rate:r(1),duration:r(120)};delete music.linkGroupId;if(music.content.kind==='audio'){music.content.role='music';music.content.sourceIn=r(1);music.content.rate=r(1);}input.clips.push(music);
 let d=speed(cut(register(input)));d=restore(d,{startFrame:10,endFrame:20});
 while(d.cutArchive?.entries.length){const entries=[...d.cutArchive.entries].sort((a,b)=>a.origin.startFrame-b.origin.startFrame);const e=side==='left-first'?entries[0]!:entries.at(-1)!;d=apply(d,{type:'restore-cut',entryId:e.id});}
 for(const track of ['t','m']){const clips=d.clips.filter(c=>c.trackId===track).sort((a,b)=>a.startFrame-b.startFrame);const samples=clips.flatMap(c=>Array.from({length:c.durationFrames},(_,i)=>({clock:effectFrameAt(c,c.startFrame+i),...(c.content.kind==='audio'?{source:sourceTimeAt(c,c.startFrame+i,d.fps)}:{})})));expect(samples.map(s=>s.clock)).toEqual(Array.from({length:30},(_,i)=>r(30+i)));if(track==='m')expect(samples.map(s=>s.source)).toEqual(Array.from({length:30},(_,i)=>r(30+i,30)));}
});
it('keeps a previously resolved fixed-only band with witnesses on differently shifted tracks',()=>{
 const input=fixed();input.sequenceEndFrame=180;input.clips[2]!.durationFrames=180;input.clips[2]!.clock.duration=r(180);
 input.tracks.push({id:'m',kind:'audio',name:'音楽',enabled:true});const music=structuredClone(input.clips[1]!);music.id='music';music.trackId='m';music.startFrame=100;music.durationFrames=80;delete music.linkGroupId;if(music.content.kind==='audio'){music.content.role='music';music.content.rate=r(1);}input.clips.push(music);
 const d=cut(speed(cut(register(input))),95,100),e=d.cutArchive!.entries[1]!;expect(resolveCutBoundary(d,e).frame).toBe(95);
 const next=restore(d);expect(resolveCutBoundary(next,next.cutArchive!.entries[0]!).frame).toBe(110);
});

function withFixedMusic(){const d=fixed();d.tracks.push({id:'m',kind:'audio',name:'音楽',enabled:true});const m=structuredClone(d.clips[1]!);m.id='music';m.trackId='m';delete m.linkGroupId;m.clock={offset:r(0),rate:r(1),duration:r(120)};if(m.content.kind==='audio'){m.content.role='music';m.content.rate=r(1);}d.clips.push(m);return d;}
function fixedOrder(d:SequenceDocument,track:string,count=120){const clips=d.clips.filter(c=>c.trackId===track).sort((a,b)=>a.startFrame-b.startFrame);const clocks=clips.flatMap(c=>Array.from({length:c.durationFrames},(_,i)=>effectFrameAt(c,c.startFrame+i)));expect(clocks).toEqual(Array.from({length:count},(_,i)=>r(i)));if(track==='m')expect(clips.flatMap(c=>Array.from({length:c.durationFrames},(_,i)=>sourceTimeAt(c,c.startFrame+i,d.fps)))).toEqual(Array.from({length:count},(_,i)=>r(i,30)));}
for(const order of ['full','middle-left-right','middle-right-left','left-middle-right','right-middle-left'] as const)it(`keeps all fixed live and archived clocks in source order: ${order}`,()=>{
 let d=speed(cut(register(withFixedMusic())));if(order.startsWith('middle'))d=restore(d,{startFrame:10,endFrame:20});else if(order.startsWith('left'))d=restore(d,{startFrame:0,endFrame:10});else if(order.startsWith('right'))d=restore(d,{startFrame:20,endFrame:30});
 d=parseSequence(serializeSequence(d));while(d.cutArchive?.entries.length){const e=[...d.cutArchive.entries].sort((a,b)=>a.origin.startFrame-b.origin.startFrame)[order==='middle-right-left'?d.cutArchive.entries.length-1:0]!;d=apply(d,{type:'restore-cut',entryId:e.id});}
 fixedOrder(d,'t');fixedOrder(d,'m');
});
for(const edge of ['start','end'] as const)it(`preserves fixed source order for ${edge} handle and grouped remainder restoration`,()=>{
 let d=speed(cut(cut(register(withFixedMusic())),30,40));const group=d.cutArchive!.groups![0]!,entry=d.cutArchive!.entries.find(e=>e.id===(edge==='start'?group.entryIds[0]:group.entryIds.at(-1)))!;
 const before=sequenceContentBytes(d),session=new SequenceSession('group-fixed',d),command={type:'resize-cut-boundary' as const,cut:{kind:'group' as const,id:group.id},edge,target:{kind:'archived' as const,entryId:entry.id,localFrame:edge==='start'?10:entry.durationFrames-4}};
 session.execute({sessionId:session.id,expectedRevision:d.revision,executionId:'edge',command});d=parseSequence(serializeSequence(session.document));
 while(d.cutArchive?.entries.length)d=restore(d);fixedOrder(d,'t');fixedOrder(d,'m');
 session.execute({sessionId:session.id,expectedRevision:session.document.revision,executionId:'undo',command:{type:'undo'}});expect(sequenceContentBytes(session.document)).toBe(before);
});
it('retains fixed boundary witnesses across split and rejects deleted owner without consuming the saved band',()=>{
 let d=restore(speed(cut(register(withFixedMusic()))),{startFrame:10,endFrame:20});
 const c=d.clips.find(c=>c.trackId==='t'&&c.startFrame===30)!;d=apply(d,{type:'split',clipIds:[c.id],frame:c.startFrame+4,linked:false});
 const saved=parseSequence(serializeSequence(d)),full=restore(saved);expect(full.cutArchive?.entries.length).toBe(1);
 const id=saved.cutArchive!.entries[0]!.trackBoundaries!.find(t=>t.trackId==='t')!.boundary.references[0]!.clipId;
 const deleted=apply(saved,{type:'delete',clipIds:[id],linked:false}),bytes=sequenceContentBytes(deleted);
 expect(()=>restore(deleted)).toThrow();expect(sequenceContentBytes(deleted)).toBe(bytes);
});
it('accepts legacy entries without track witnesses and rejects malformed new witness metadata',()=>{
 const d=speed(cut(register(fixed())));delete d.cutArchive!.entries[0]!.trackBoundaries;expect(()=>restore(parseSequence(serializeSequence(d)))).not.toThrow();
 for(const trackBoundaries of [[{trackId:'t',boundary:{hintFrame:-1,ambiguous:false,references:[]}}],[{trackId:'t',boundary:{hintFrame:0,ambiguous:false,references:[]},unknown:1}]])expect(()=>parseSequence(JSON.stringify({...d,cutArchive:{...d.cutArchive,entries:[{...d.cutArchive!.entries[0],trackBoundaries}]}}))).toThrow();
});
it('does not expose a hidden clip that begins just past the previous completion',()=>{
 const input=fixed();input.tracks.push({id:'outside',kind:'visual',name:'非表示',enabled:true});input.clips.push({...structuredClone(input.clips[2]!),id:'hidden',trackId:'outside',startFrame:76,durationFrames:5});
 const d=speed(cut(register(input))),next=restore(d);expect(d.clips.find(c=>c.id==='hidden')!.startFrame).toBe(d.sequenceEndFrame+1);expect(next.clips.find(c=>c.id==='hidden')!.startFrame).toBeGreaterThanOrEqual(next.sequenceEndFrame);
});
it('uses the same explicit adjacent destination for partial fixed restoration beside a live main',()=>{
 let d=speed(cut(register(fixed())));d=apply(d,{type:'delete',clipIds:d.clips.filter(c=>c.content.kind==='telop').map(c=>c.id),linked:false});const right=d.clips.find(c=>c.speed?.kind==='main'&&c.startFrame===15)!;
 d=apply(d,{type:'move',clipIds:[right.id],deltaFrames:0,trackId:'t',linked:true});d=restore(d,{startFrame:10,endFrame:20},15);
 while(d.cutArchive?.entries.length)d=restore(d);const cs=d.clips.filter(c=>c.content.kind==='telop').sort((a,b)=>a.startFrame-b.startFrame);
 expect(new Set(cs.map(c=>c.trackId)).size).toBe(1);expect(cs.flatMap(c=>Array.from({length:c.durationFrames},(_,i)=>effectFrameAt(c,c.startFrame+i)))).toEqual(Array.from({length:30},(_,i)=>r(30+i)));
});
it('keeps two uses of the same music source distinct while restoring saved fragments',()=>{
 const input=withFixedMusic();input.tracks.push({id:'m2',kind:'audio',name:'同素材の別使用',enabled:true});const peer=structuredClone(input.clips.at(-1)!);peer.id='music-again';peer.trackId='m2';peer.startFrame=70;peer.durationFrames=20;peer.name='別の使用箇所';if(peer.content.kind==='audio')peer.content.settings.gainDb=-12;input.clips.push(peer);
 let d=speed(cut(register(input))),saved=d.clips.find(c=>c.id==='music-again')!;expect(saved.content.kind).toBe('audio');
 d=restore(d,{startFrame:10,endFrame:20});d=parseSequence(serializeSequence(d));while(d.cutArchive?.entries.length)d=restore(d);
 fixedOrder(d,'m');const others=d.clips.filter(c=>c.name==='別の使用箇所');expect(others.reduce((n,c)=>n+c.durationFrames,0)).toBe(20);expect(others.every(c=>c.trackId==='m2'&&c.content.kind==='audio'&&c.content.settings.gainDb===-12)).toBe(true);expect(others.sort((a,b)=>a.startFrame-b.startFrame).flatMap(c=>Array.from({length:c.durationFrames},(_,i)=>({clock:effectFrameAt(c,c.startFrame+i),source:sourceTimeAt(c,c.startFrame+i,d.fps)})))).toEqual(Array.from({length:20},(_,i)=>({clock:r(i),source:r(i,30)}))); // a formerly hidden suffix may be split, but every original sample appears once with its own gain.
});
it('keeps track witnesses across another explicit global speed change after interior restore',()=>{
 let d=restore(speed(cut(register(withFixedMusic()))),{startFrame:10,endFrame:20});d=apply(d,{type:'set-native-global-speed',rate:r(2)});d=parseSequence(serializeSequence(d));while(d.cutArchive?.entries.length)d=restore(d);fixedOrder(d,'t');fixedOrder(d,'m');
 const expected=register(fixed());for(let frame=0;frame<120;frame++)expect(d.clips.filter(c=>['v','a'].includes(c.trackId)&&c.startFrame<=frame&&frame<clipEnd(c)).map(c=>sourceTimeAt(c,frame,d.fps))).toEqual(expected.clips.filter(c=>['v','a'].includes(c.trackId)&&c.startFrame<=frame&&frame<clipEnd(c)).map(c=>sourceTimeAt(c,frame,expected.fps)));
});
it('keeps registered source-anchored captions on the AV axis while fixed captions retain their track order',()=>{
 const input=withFixedMusic(),follow=structuredClone(fixture().clips[2]!);follow.id='follow';follow.trackId='follow-track';input.tracks.push({id:'follow-track',kind:'visual',name:'原音に連動',enabled:true});input.clips.push(follow);
 const expected=speed(register(input));let d=restore(speed(cut(register(input))),{startFrame:10,endFrame:20});while(d.cutArchive?.entries.length)d=restore(d);
 fixedOrder(d,'t');fixedOrder(d,'m');for(let f=0;f<60;f++){const actual=d.clips.filter(c=>c.trackId==='follow-track'&&c.startFrame<=f&&f<clipEnd(c)),wanted=expected.clips.filter(c=>c.trackId==='follow-track'&&c.startFrame<=f&&f<clipEnd(c));expect(actual.map(c=>effectFrameAt(c,f))).toEqual(wanted.map(c=>effectFrameAt(c,f)));for(const c of actual){expect(c.anchor?.kind).toBe('source');if(c.anchor?.kind==='source'){const id=c.anchor.clipOccurrenceId,p=d.clips.find(c=>c.id===id)!;expect(p.startFrame<=f&&f<clipEnd(p)).toBe(true);expect(p.speed?.kind).toBe('main-audio');}}}
});
for(const reverse of [false,true])it(`keeps hidden fixed witnesses in clock order through two separated cuts: reverse=${reverse}`,()=>{
 let d=speed(cut(cut(register(withFixedMusic())),60,70));if(reverse)d=apply(d,{type:'restore-cut',entryId:d.cutArchive!.entries[1]!.id});while(d.cutArchive?.entries.length)d=restore(d);fixedOrder(d,'t');fixedOrder(d,'m');
 d=apply(d,{type:'set-native-global-speed',rate:r(1)});fixedOrder(d,'t');fixedOrder(d,'m');
});
for(const edit of ['trim','move'] as const)it(`restores at the explicit fixed gap after a later caption ${edit}`,()=>{
 let d=restore(speed(cut(register(fixed()))),{startFrame:10,endFrame:20});d=apply(d,{type:'trim',clipId:'t1',edge:'end',frame:25,linked:false});if(edit==='move')d=apply(d,{type:'move',clipIds:['t1'],deltaFrames:1,linked:false});
 expect(resolveCutBoundary(d,d.cutArchive!.entries[0]!).frame).toBe(15);
 const restored=restore(d),newIds=new Set(d.clips.map(c=>c.id));expect(restored.clips.find(c=>!newIds.has(c.id)&&c.trackId==='t')!.startFrame).toBe(30);
 const e=d.cutArchive!.entries[0]!;expect(()=>apply(d,{type:'resize-cut-boundary',cut:{kind:'entry',id:e.id},edge:'start',target:{kind:'archived',entryId:e.id,localFrame:5}})).not.toThrow();
 const explicit=restore(d,undefined,15);expect(explicit.clips.find(c=>!newIds.has(c.id)&&c.trackId==='t'&&effectFrameAt(c,c.startFrame).num===30)!.startFrame).toBe(15);
});
it('retains adjacent destination when another group member has no fixed material',()=>{
 let d=speed(cut(register(fixed())));d=apply(d,{type:'delete',clipIds:d.clips.filter(c=>c.content.kind==='telop').map(c=>c.id),linked:false});const right=d.clips.find(c=>c.speed?.kind==='main'&&c.startFrame===15)!;d=apply(d,{type:'move',clipIds:[right.id],deltaFrames:0,trackId:'t',linked:true});d=restore(d,{startFrame:10,endFrame:20},15);
 d=cut(d,10,15);d=apply(d,{type:'restore-cut',entryId:d.cutArchive!.entries.at(-1)!.id});while(d.cutArchive?.entries.length)d=restore(d);
 const cs=d.clips.filter(c=>c.content.kind==='telop').sort((a,b)=>a.startFrame-b.startFrame);expect(new Set(cs.map(c=>c.trackId)).size).toBe(1);expect(cs.flatMap(c=>Array.from({length:c.durationFrames},(_,i)=>effectFrameAt(c,c.startFrame+i)))).toEqual(Array.from({length:30},(_,i)=>r(30+i)));
});

it('keeps newly restored linked B-roll aligned after one live side moved',()=>{
 const input=fixed();for(const [index,id,track] of [[0,'bv','bv-track'],[1,'ba','ba-track']] as const){const c=structuredClone(input.clips[index]!);c.id=id;c.trackId=track;c.linkGroupId='b-roll';input.clips.push(c);input.tracks.push({id:track,kind:index===0?'visual':'audio',name:id,enabled:true});}
 let d=restore(speed(cut(register(input))),{startFrame:10,endFrame:20});
 d=apply(d,{type:'move',clipIds:d.clips.filter(c=>c.trackId==='bv-track').map(c=>c.id),deltaFrames:5,linked:false});
 const before=new Set(d.clips.map(c=>c.id)),n=restore(d);const video=n.clips.find(c=>!before.has(c.id)&&c.trackId==='bv-track'&&effectFrameAt(c,c.startFrame).num===67)!,audio=n.clips.find(c=>!before.has(c.id)&&c.trackId==='ba-track'&&effectFrameAt(c,c.startFrame).num===93)!;
 expect(video).toBeDefined();expect(audio).toBeDefined();expect(video.linkGroupId).toBe(audio.linkGroupId);expect(video.startFrame).toBe(audio.startFrame);
 const order=(doc:SequenceDocument,track:string)=>doc.clips.filter(c=>c.trackId===track).sort((a,b)=>a.startFrame-b.startFrame).flatMap(c=>Array.from({length:c.durationFrames},(_,i)=>effectFrameAt(c,c.startFrame+i).num));
 const beforeComplete=order(n,'ba-track');expect(beforeComplete).toEqual([...beforeComplete].sort((a,b)=>a-b));let complete=n;while(complete.cutArchive?.entries.length)complete=restore(complete);expect(order(complete,'ba-track')).toEqual(Array.from({length:120},(_,i)=>3+i*3));expect(order(complete,'bv-track')).toEqual(Array.from({length:120},(_,i)=>7+i*2));
});
it('retains adjacent destination through a partial interval with no fixed clip',()=>{
 const input=fixed();input.clips[2]!.startFrame=30;input.clips[2]!.durationFrames=10;input.clips[2]!.clock.offset=r(30);
 let d=speed(cut(register(input)));const right=d.clips.find(c=>c.speed?.kind==='main'&&c.startFrame===15)!;d=apply(d,{type:'move',clipIds:[right.id],deltaFrames:0,trackId:'t',linked:true});d=restore(d,{startFrame:0,endFrame:5},15);
 d=restore(d,{startFrame:5,endFrame:10});while(d.cutArchive?.entries.length)d=restore(d);
 const cs=d.clips.filter(c=>c.content.kind==='telop').sort((a,b)=>a.startFrame-b.startFrame);expect(new Set(cs.map(c=>c.trackId)).size).toBe(1);expect(cs.flatMap(c=>Array.from({length:c.durationFrames},(_,i)=>effectFrameAt(c,c.startFrame+i)))).toEqual(Array.from({length:10},(_,i)=>r(30+i)));
});
it('keeps the global all-witness guard after a fixed owner trim but permits explicitly chosen placement',()=>{
 let d=speed(cut(register(fixed())));d=apply(d,{type:'trim',clipId:'t1',edge:'end',frame:25,linked:false});expect(resolveCutBoundary(d,d.cutArchive!.entries[0]!).frame).toBeNull();const before=sequenceContentBytes(d);expect(()=>restore(d)).toThrow();expect(sequenceContentBytes(d)).toBe(before);expect(()=>restore(d,undefined,15)).not.toThrow();
});
it('does not replace a reversed fixed gap with a guessed main position',()=>{
 let d=restore(speed(cut(register(fixed()))),{startFrame:10,endFrame:20});d=apply(d,{type:'move',clipIds:['t1'],deltaFrames:120,linked:false});expect(resolveCutBoundary(d,d.cutArchive!.entries[0]!).frame).toBe(15);const before=sequenceContentBytes(d);expect(()=>restore(d)).toThrow();expect(sequenceContentBytes(d)).toBe(before);expect(()=>restore(d,undefined,15)).not.toThrow();
});
it('keeps hidden fixed order with an insert-own floor and restores exact document bytes on Undo',()=>{
 let input=withFixedMusic();input.tracks.push({id:'insert',kind:'visual',name:'挿入',enabled:true});const c=structuredClone(input.clips[0]!);c.id='insert';c.trackId='insert';c.durationFrames=10;delete c.linkGroupId;input.clips.push(c);input=apply(input,{type:'register-native-insert-own-speed',clipId:'insert',linked:false});
 const initial=speed(cut(cut(register(input)),60,70)),session=new SequenceSession('hidden-own',initial);let d=initial;
 while(d.cutArchive?.entries.length){const before=sequenceContentBytes(d),id=d.cutArchive.entries[0]!.id;session.execute({sessionId:session.id,expectedRevision:d.revision,executionId:'restore-'+d.revision,command:{type:'restore-cut',entryId:id}});const next=session.document;session.execute({sessionId:session.id,expectedRevision:next.revision,executionId:'undo-'+next.revision,command:{type:'undo'}});expect(sequenceContentBytes(session.document)).toBe(before);session.execute({sessionId:session.id,expectedRevision:session.document.revision,executionId:'redo-'+session.document.revision,command:{type:'redo'}});d=session.document;parseSequence(serializeSequence(d));}
 fixedOrder(d,'t');fixedOrder(d,'m');expect(d.insertOwnSpeed!.endFloor).toBe(d.sequenceEndFrame);
});
it('does not guess between different saved video owners in one link component; an explicit position aligns them',()=>{
 const input=fixed();for(const [index,id,track] of [[0,'bv','bv-track'],[0,'bv2','bv2-track'],[1,'ba','ba-track']] as const){const c=structuredClone(input.clips[index]!);c.id=id;c.trackId=track;c.linkGroupId='multi-video';input.clips.push(c);input.tracks.push({id:track,kind:index===0?'visual':'audio',name:id,enabled:true});}
 let d=restore(speed(cut(register(input))),{startFrame:10,endFrame:20});d=apply(d,{type:'move',clipIds:d.clips.filter(c=>c.trackId==='bv-track').map(c=>c.id),deltaFrames:5,linked:false});const before=sequenceContentBytes(d);expect(()=>restore(d)).toThrow('連動映像の復元位置が複数');expect(sequenceContentBytes(d)).toBe(before);const n=restore(d,undefined,15);for(const track of ['bv-track','bv2-track','ba-track'])expect(n.clips.some(c=>c.trackId===track&&c.startFrame===15&&c.durationFrames===10)).toBe(true);
});
for(const movedTrack of ['bv-track','ba-track'])for(const delta of [5,40])it(`preserves source order with separate live boundaries for ${movedTrack}+${delta}`,()=>{
 const input=fixed();for(const [index,id,track] of [[0,'bv','bv-track'],[1,'ba','ba-track']] as const){const c=structuredClone(input.clips[index]!);c.id=id;c.trackId=track;c.linkGroupId='b-roll';input.clips.push(c);input.tracks.push({id:track,kind:index===0?'visual':'audio',name:id,enabled:true});}
 let d=restore(speed(cut(register(input))),{startFrame:10,endFrame:20});d=apply(d,{type:'move',clipIds:d.clips.filter(c=>c.trackId===movedTrack).map(c=>c.id),deltaFrames:delta,linked:false});
 const session=new SequenceSession('linked-source',d);while(d.cutArchive?.entries.length){const before=sequenceContentBytes(d);session.execute({sessionId:session.id,expectedRevision:d.revision,executionId:'restore-'+d.revision,command:{type:'restore-cut',entryId:d.cutArchive.entries[0]!.id}});let after=session.document;for(const track of ['bv-track','ba-track']){const clips=after.clips.filter(c=>c.trackId===track).sort((a,b)=>a.startFrame-b.startFrame);const clocks=clips.flatMap(c=>Array.from({length:c.durationFrames},(_,i)=>effectFrameAt(c,c.startFrame+i).num));expect(clocks).toEqual([...clocks].sort((a,b)=>a-b));}session.execute({sessionId:session.id,expectedRevision:after.revision,executionId:'undo-'+after.revision,command:{type:'undo'}});expect(sequenceContentBytes(session.document)).toBe(before);session.execute({sessionId:session.id,expectedRevision:session.document.revision,executionId:'redo-'+session.document.revision,command:{type:'redo'}});d=session.document;parseSequence(serializeSequence(d));}
 for(const track of ['bv-track','ba-track']){const clips=d.clips.filter(c=>c.trackId===track).sort((a,b)=>a.startFrame-b.startFrame);expect(clips.flatMap(c=>Array.from({length:c.durationFrames},(_,i)=>sourceTimeAt(c,c.startFrame+i,d.fps)))).toEqual(Array.from({length:120},(_,i)=>r(i,15)));}
});
it('does not move an unrelated saved music use to a video point through a different live link',()=>{
 const input=withFixedMusic();for(const [index,id,track] of [[0,'bv','bv-track'],[1,'ba','ba-track']] as const){const c=structuredClone(input.clips[index]!);c.id=id;c.trackId=track;c.linkGroupId='b-roll';input.clips.push(c);input.tracks.push({id:track,kind:index===0?'visual':'audio',name:id,enabled:true});}
 for(const [index,id,track] of [[0,'other-video','bv-track'],[1,'other-audio','m']] as const){const c=structuredClone(input.clips[index]!);c.id=id;c.trackId=track;c.linkGroupId='other-live-use';c.startFrame=200;c.durationFrames=10;input.clips.push(c);}
 let d=restore(speed(cut(register(input))),{startFrame:10,endFrame:20});d=apply(d,{type:'move',clipIds:d.clips.filter(c=>c.trackId==='bv-track'&&c.id!=='other-video').map(c=>c.id),deltaFrames:5,linked:false});const before=new Set(d.clips.map(c=>c.id)),next=restore(d);const restoredMusic=next.clips.find(c=>!before.has(c.id)&&c.trackId==='m'&&effectFrameAt(c,c.startFrame).num===30)!;expect(restoredMusic.startFrame).toBe(30);
});

for(const initialStart of [0,10,20])for(const suffixTrack of ['ba-track','bv-track'])for(const order of ['left-first','right-first'])it(`keeps a non-overlapping suffix after restored source at separated ${suffixTrack} boundaries: first${initialStart}, ${order}`,()=>{
 const input=fixed();for(const [index,id,track] of [[0,'bv','bv-track'],[1,'ba','ba-track']] as const){const c=structuredClone(input.clips[index]!);c.id=id;c.trackId=track;c.linkGroupId='b-roll';input.clips.push(c);input.tracks.push({id:track,kind:index===0?'visual':'audio',name:id,enabled:true});}
 let d=restore(speed(cut(register(input))),{startFrame:initialStart,endFrame:initialStart+10});
 const other=suffixTrack==='ba-track'?'bv-track':'ba-track';
 const tail=d.clips.filter(c=>c.trackId===suffixTrack).sort((a,b)=>a.startFrame-b.startFrame).at(-1)!;
 d=apply(d,{type:'move',clipIds:[tail.id],deltaFrames:10,linked:false});
 d=apply(d,{type:'move',clipIds:d.clips.filter(c=>c.trackId===other).map(c=>c.id),deltaFrames:20,linked:false});
 const initial=d,session=new SequenceSession('separate-source-order',d);
 let first=true;
 while(d.cutArchive?.entries.length){const bytes=sequenceContentBytes(d);const entryId=first&&order==='right-first'?d.cutArchive.entries.at(-1)!.id:d.cutArchive.entries[0]!.id;session.execute({sessionId:session.id,expectedRevision:d.revision,executionId:'restore-'+d.revision,command:{type:'restore-cut',entryId}});const next=session.document;
  for(const track of ['bv-track','ba-track']){
   const before=d.clips.filter(c=>c.trackId===track).sort((a,b)=>a.startFrame-b.startFrame);
   const after=next.clips.filter(c=>c.trackId===track).sort((a,b)=>a.startFrame-b.startFrame);
   expect(after.filter(c=>before.some(p=>p.id===c.id)).map(c=>c.id)).toEqual(before.map(c=>c.id));
   const clocks=after.flatMap(c=>Array.from({length:c.durationFrames},(_,i)=>effectFrameAt(c,c.startFrame+i).num));expect(clocks).toEqual([...clocks].sort((a,b)=>a-b));
  }
  if(first&&initialStart===10&&order==='left-first'){expect(next.clips.filter(c=>c.trackId===suffixTrack).sort((a,b)=>a.startFrame-b.startFrame).map(c=>[c.startFrame,c.durationFrames])).toEqual([[0,30],[50,10],[60,10],[80,60]]);}first=false;
  session.execute({sessionId:session.id,expectedRevision:next.revision,executionId:'undo-'+next.revision,command:{type:'undo'}});expect(sequenceContentBytes(session.document)).toBe(bytes);
  session.execute({sessionId:session.id,expectedRevision:session.document.revision,executionId:'redo-'+session.document.revision,command:{type:'redo'}});d=parseSequence(serializeSequence(session.document));
 }
 for(const track of ['bv-track','ba-track']){const clips=d.clips.filter(c=>c.trackId===track).sort((a,b)=>a.startFrame-b.startFrame);expect(clips.flatMap(c=>Array.from({length:c.durationFrames},(_,i)=>sourceTimeAt(c,c.startFrame+i,d.fps)))).toEqual(Array.from({length:120},(_,i)=>r(i,15)));}
 expect(d.cutArchive).toBeUndefined();
 expect(sequenceContentBytes(initial)).not.toBe(sequenceContentBytes(d));
});

function linkedVisibilityFixture(duration=120){
 const input=fixed();input.sequenceEndFrame=1200;
 for(const c of input.clips.slice(0,2)){c.durationFrames=1200;if(c.content.kind==='video'||c.content.kind==='audio')c.content.rate=r(1);c.clock.duration=r(4000);}
 const asset=input.assets[0]!;if(asset.kind==='media')for(const stream of asset.streams)stream.duration=r(40);
 for(const [index,id,track] of [[0,'bv','bv-track'],[1,'ba','ba-track']] as const){const c=structuredClone(fixed().clips[index]!);c.id=id;c.trackId=track;c.durationFrames=duration;c.linkGroupId='b-roll';input.clips.push(c);input.tracks.push({id:track,kind:index===0?'visual':'audio',name:id,enabled:true});}
 return input;
}
function mixedVisibilityCut(duration=120,partial=true){
 let d=apply(cut(register(linkedVisibilityFixture(duration))),{type:'set-native-global-speed',rate:r(2)});
 if(partial)d=restore(d,{startFrame:10,endFrame:20});
 else if(duration===60)d=restore(d,{startFrame:0,endFrame:10});
 d=apply(d,{type:'move',clipIds:d.clips.filter(c=>c.trackId==='ba-track').map(c=>c.id),deltaFrames:100,linked:false});
 return apply(d,{type:'set-native-global-speed',rate:r(10)});
}
it('rejects only the cyclic hidden-prefix visible-suffix linked placement without consuming the cut',()=>{
 const d=mixedVisibilityCut(),before=sequenceContentBytes(d);
 expect(d.sequenceEndFrame).toBe(118);
 const saved=d.cutArchive!.entries[0]!,main=resolveCutBoundary(d,saved).frame;expect(main).toBe(3);
 expect(()=>restore(d)).toThrow('連動素材の配置が復元範囲と両立しないため、先に配置を調整してください');expect(sequenceContentBytes(d)).toBe(before);
 expect(sequenceContentBytes(parseSequence(serializeSequence(d)))).toBe(before);
 // A deliberate user move can resolve the cycle; restoration never performs
 // this adjustment itself and the failed input remains byte-identical.
 const adjusted=apply(d,{type:'move',clipIds:d.clips.filter(c=>c.trackId==='ba-track').map(c=>c.id),deltaFrames:-100,linked:false});
 const next=restore(adjusted);for(const track of ['bv-track','ba-track']){const cs=next.clips.filter(c=>c.trackId===track).sort((a,b)=>a.startFrame-b.startFrame);const clocks=cs.flatMap(c=>Array.from({length:c.durationFrames},(_,i)=>effectFrameAt(c,c.startFrame+i).num));expect(clocks).toEqual([...clocks].sort((a,b)=>a-b));}
 expect(sequenceContentBytes(d)).toBe(before);
});
it('restores mixed visible/hidden owner boundaries when there is no visible suffix cycle',()=>{
 const d=mixedVisibilityCut(60,false),next=restore(d);
 expect(next.cutArchive).toBeUndefined();
 for(const track of ['bv-track','ba-track']){const cs=next.clips.filter(c=>c.trackId===track).sort((a,b)=>a.startFrame-b.startFrame);const values=cs.flatMap(c=>Array.from({length:c.durationFrames},(_,i)=>sourceTimeAt(c,c.startFrame+i,next.fps)));expect(values).toEqual(Array.from({length:60},(_,i)=>r(i,15)));}
 const beforeIds=new Set(d.clips.map(c=>c.id));const newVideo=next.clips.find(c=>!beforeIds.has(c.id)&&c.trackId==='bv-track')!,newAudio=next.clips.find(c=>!beforeIds.has(c.id)&&c.trackId==='ba-track'&&c.linkGroupId===newVideo.linkGroupId)!;
 expect(newVideo.startFrame).toBe(newAudio.startFrame);expect(newVideo.startFrame).toBeGreaterThan(next.sequenceEndFrame);
 expect(next.clips.find(c=>c.id==='bv')!.startFrame).toBe(0);parseSequence(serializeSequence(next));
});
it('restores all-hidden linked owner boundaries with unchanged source order',()=>{
 let d=mixedVisibilityCut();d=apply(d,{type:'move',clipIds:d.clips.filter(c=>c.trackId==='bv-track').map(c=>c.id),deltaFrames:200,linked:false});
 const next=restore(d);
 for(const track of ['bv-track','ba-track']){const cs=next.clips.filter(c=>c.trackId===track).sort((a,b)=>a.startFrame-b.startFrame);const clocks=cs.flatMap(c=>Array.from({length:c.durationFrames},(_,i)=>effectFrameAt(c,c.startFrame+i).num));expect(clocks).toEqual([...clocks].sort((a,b)=>a-b));}
 parseSequence(serializeSequence(next));
});

it('keeps a later hidden occurrence after a mixed-owner restoration',()=>{
 const input=linkedVisibilityFixture(60),later=structuredClone(input.clips.find(c=>c.id==='bv')!);later.id='other-use';later.startFrame=145;later.durationFrames=10;delete later.linkGroupId;input.clips.push(later);
 let d=apply(cut(register(input)),{type:'set-native-global-speed',rate:r(2)});d=restore(d,{startFrame:0,endFrame:10});d=apply(d,{type:'move',clipIds:d.clips.filter(c=>c.trackId==='ba-track').map(c=>c.id),deltaFrames:100,linked:false});d=apply(d,{type:'set-native-global-speed',rate:r(10)});
 const next=restore(d),restored=next.clips.find(c=>c.trackId==='bv-track'&&c.content.kind==='video'&&c.content.sourceIn.num===8&&c.content.sourceIn.den===3)!;
 expect(next.clips.find(c=>c.id==='other-use')!.startFrame).toBeGreaterThanOrEqual(clipEnd(restored));parseSequence(serializeSequence(next));
});

for(const trimEnd of [118,119,120])it(`protects a saved hidden boundary after prefix trim to ${trimEnd} even without a hidden live prefix`,()=>{
 let d=apply(cut(register(linkedVisibilityFixture())),{type:'set-native-global-speed',rate:r(2)});d=restore(d,{startFrame:10,endFrame:20});d=apply(d,{type:'move',clipIds:d.clips.filter(c=>c.trackId==='ba-track').map(c=>c.id),deltaFrames:100,linked:false});d=apply(d,{type:'restore-cut',entryId:d.cutArchive!.entries[1]!.id});d=apply(d,{type:'trim',clipId:'ba',edge:'end',frame:trimEnd,linked:false});d=apply(d,{type:'set-native-global-speed',rate:r(10)});
 expect(d.sequenceEndFrame).toBe(119);expect(d.cutArchive!.entries[0]!.trackBoundaries!.find(b=>b.trackId==='ba-track')!.boundary.hintFrame).toBe(130);
 const before=sequenceContentBytes(d);expect(()=>restore(d)).toThrow('連動素材の配置が復元範囲と両立しないため、先に配置を調整してください');expect(sequenceContentBytes(d)).toBe(before);expect(sequenceContentBytes(parseSequence(serializeSequence(d)))).toBe(before);
});
