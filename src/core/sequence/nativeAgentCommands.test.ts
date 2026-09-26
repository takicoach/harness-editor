import {expect,it} from 'vitest';
import {buildNativeAgentCommand,applyNativeAgentEdit} from './nativeAgentCommands';
import {applySequenceCommand} from './commands';
import {SequenceSession} from './session';
import {parseSequence,serializeSequence} from './validate';
import {sourceTimeAt,effectFrameAt,type SequenceDocument} from './model';
import {rational as r} from './time';
import {DEFAULT_MAIN_LAYOUT} from '../mainLayout';
function fixture():SequenceDocument{return {schemaVersion:2,id:'doc',name:'private AI fixture',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:300,background:'#000',
 tracks:[{id:'v',kind:'visual',name:'映像',enabled:true},{id:'a',kind:'audio',name:'原音',enabled:true},{id:'t',kind:'visual',name:'字幕',enabled:true}],
 assets:[{id:'media',kind:'media',file:'media/a.mp4',name:'素材',fingerprint:'source',streams:[{kind:'video',index:0,codec:'h264',duration:r(10),frameRate:r(60000,1001),width:320,height:180},{kind:'audio',index:1,codec:'aac',duration:r(10),sampleRate:48000,channels:2}]},{id:'image',kind:'image',file:'image.png',name:'画像',fingerprint:'image',streams:[]}],
 ducking:{enabled:false,strength:'mid'},transcripts:[],transitions:[],clips:[
 {id:'v1',trackId:'v',name:'映像',startFrame:0,durationFrames:300,clock:{offset:r(0),rate:r(1),duration:r(300)},linkGroupId:'av',visual:{layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[{frame:r(100),value:{scale:1.2}}]},content:{kind:'video',assetId:'media',streamIndex:0,sourceIn:r(0),rate:r(1)}},
 {id:'a1',trackId:'a',name:'原音',startFrame:0,durationFrames:300,clock:{offset:r(0),rate:r(1),duration:r(300)},linkGroupId:'av',content:{kind:'audio',assetId:'media',streamIndex:1,sourceIn:r(0),rate:r(1),role:'speech',loop:false,settings:{gainDb:-4,muted:false,fadeInFrames:2,fadeOutFrames:3}}},
 {id:'caption',trackId:'t',name:'字幕',startFrame:30,durationFrames:90,clock:{offset:r(0),rate:r(1),duration:r(90)},content:{kind:'telop',data:{text:'元の本文',style:'warning'}},anchor:{kind:'source',role:'speech',sourceAssetId:'media',clipOccurrenceId:'a1',sourceStart:r(1),sourceEnd:r(4)}}]};}
const edit=(commands:unknown[])=>({documentId:'doc',commands});
it('compiles/applies deterministically, matches one native batch revision and leaves input untouched',()=>{
 const d=fixture(),before=serializeSequence(d),input=edit([{type:'set-caption-text',clipId:'caption',text:'修正した本文'},{type:'ripple-delete',startFrame:150,endFrame:180}]);
 const command=buildNativeAgentCommand(d,input),a=applyNativeAgentEdit(d,input);expect(buildNativeAgentCommand(d,input)).toEqual(command);expect(applyNativeAgentEdit(d,input)).toEqual(a);
 expect(a).toEqual(applySequenceCommand(d,command));expect(a.revision).toBe(1);expect(a.cutArchive!.entries).toHaveLength(1);expect(serializeSequence(d)).toBe(before);
});
it('keeps a mixed edit atomic and a single undo/redo through the actual native session',()=>{
 const d=fixture(),session=new SequenceSession('private',d),cmd=buildNativeAgentCommand(d,edit([{type:'move',clipIds:['v1'],deltaFrames:5},{type:'set-caption-text',clipId:'caption',text:'新本文'}]));
 session.execute({sessionId:'private',executionId:'ai-one',expectedRevision:0,command:cmd});expect(session.document.revision).toBe(1);
 session.execute({sessionId:'private',executionId:'undo',expectedRevision:1,command:{type:'undo'}});expect(session.document.clips).toEqual(d.clips);
 session.execute({sessionId:'private',executionId:'redo',expectedRevision:2,command:{type:'redo'}});expect(session.document.clips.find(c=>c.id==='v1')!.startFrame).toBe(5);
 const before=serializeSequence(d);expect(()=>applyNativeAgentEdit(d,edit([{type:'delete',clipIds:['v1']},{type:'trim',clipId:'v1',edge:'end',frame:1}]))).toThrow();expect(serializeSequence(d)).toBe(before);
});
it('retains source/effect/linked AV while trimming and splitting, without touching another use of the asset',()=>{
 const d=fixture();d.clips.push({...structuredClone(d.clips[0]!),id:'again',linkGroupId:'other',startFrame:400});d.sequenceEndFrame=700;
 const next=applyNativeAgentEdit(d,edit([{type:'trim',clipId:'v1',edge:'start',frame:10},{type:'split',clipIds:['v1'],frame:100}]));
 expect(next.clips.find(c=>c.id==='again')).toEqual(d.clips.find(c=>c.id==='again'));
 for(const frame of [10,99,100,299])for(const trackId of ['v','a']){const c=next.clips.find(c=>c.trackId===trackId&&c.startFrame<=frame&&frame<c.startFrame+c.durationFrames)!;expect(sourceTimeAt(c,frame,next.fps)).toEqual(r(frame,30));expect(effectFrameAt(c,frame)).toEqual(r(frame));}
});
it('requires intentional linked=false or unlink to separate AV edits',()=>{
 const d=fixture();expect(applyNativeAgentEdit(d,edit([{type:'move',clipIds:['v1'],deltaFrames:2}])).clips.find(c=>c.id==='a1')!.startFrame).toBe(2);
 expect(applyNativeAgentEdit(d,edit([{type:'move',clipIds:['v1'],deltaFrames:2,linked:false}])).clips.find(c=>c.id==='a1')!.startFrame).toBe(0);
 const next=applyNativeAgentEdit(d,edit([{type:'unlink',clipIds:['v1']},{type:'delete',clipIds:['v1']} ]));expect(next.clips.some(c=>c.id==='a1')).toBe(true);
});
it('preserves caption style/anchor and visual keyframes while merging only requested properties',()=>{
 const d=fixture(),next=applyNativeAgentEdit(d,edit([{type:'set-caption-text',clipId:'caption',text:'本文だけ変更'},{type:'update-clip-visual',clipId:'v1',patch:{layout:{scale:1.4},colorGrade:{brightness:10}}},{type:'update-clip-audio',clipId:'a1',settings:{gainDb:-10}}]));
 expect(next.clips[2]!.content).toEqual({...d.clips[2]!.content,data:{text:'本文だけ変更',style:'warning'}});expect(next.clips[2]!.anchor).toEqual(d.clips[2]!.anchor);
 expect(next.clips[0]!.visual!.keyframes).toEqual(d.clips[0]!.visual!.keyframes);expect(next.clips[0]!.visual!.layout.position).toEqual({x:0,y:0});
 expect(next.clips[1]!.content).toMatchObject({settings:{gainDb:-10,muted:false,fadeInFrames:2,fadeOutFrames:3},sourceIn:r(0),rate:r(1)});
});
it('uses dedicated registered-caption splitting rather than generic independent metadata slicing',()=>{
 const d=applySequenceCommand(fixture(),{type:'register-native-speed',groupId:'speed',mainClipIds:['v1'],mainAudioBindings:[{audioClipId:'a1',providerId:'v1'}]});
 const next=applyNativeAgentEdit(d,edit([{type:'split-caption',clipId:'caption',frame:60,leftText:'元の',rightText:'本文'}]));
 expect(next).toEqual(applySequenceCommand(d,{type:'split-caption',clipId:'caption',frame:60,leftText:'元の',rightText:'本文'}));expect(next.clips.filter(c=>c.content.kind!=='telop').map(({speed,...rendered})=>rendered)).toEqual(d.clips.filter(c=>c.content.kind!=='telop').map(({speed,...rendered})=>rendered));expect(next.clips.filter(c=>c.content.kind==='telop').map(c=>c.content.kind==='telop'?c.content.data.text:'')).toEqual(['元の','本文']);
 const caps=next.clips.filter(c=>c.content.kind==='telop');const merged=applyNativeAgentEdit(next,edit([{type:'merge-captions',firstClipId:caps[0]!.id,secondClipId:caps[1]!.id}]));expect(merged.clips.filter(c=>c.content.kind==='telop')).toHaveLength(1);
 expect(()=>buildNativeAgentCommand(d,edit([{type:'split',clipIds:['caption'],frame:60}]))).toThrow('split-caption');
});
it('restores a persisted archived band and preserves unrelated text via existing cut commands',()=>{
 const d=applyNativeAgentEdit(fixture(),edit([{type:'ripple-delete',startFrame:150,endFrame:180}])),saved=parseSequence(serializeSequence(d)),id=saved.cutArchive!.entries[0]!.id;
 const next=applyNativeAgentEdit(saved,edit([{type:'set-caption-text',clipId:'caption',text:'後から編集'},{type:'restore-cut',entryId:id}]));expect(next.sequenceEndFrame).toBe(300);expect(next.cutArchive).toBeUndefined();
 expect(next.clips.find(c=>c.id==='caption')!.content).toMatchObject({data:{text:'後から編集'}});
});
it('delegates cut boundary coordinates without converting saved local frames to completion frames',()=>{
 const d=applyNativeAgentEdit(fixture(),edit([{type:'ripple-delete',startFrame:150,endFrame:180}])),id=d.cutArchive!.entries[0]!.id;
 const next=applyNativeAgentEdit(d,edit([{type:'resize-cut-boundary',cut:{kind:'entry',id},edge:'start',target:{kind:'archived',entryId:id,localFrame:10}}]));expect(next.sequenceEndFrame).toBe(280);expect(next.cutArchive!.entries[0]!.durationFrames).toBe(20);
});
it('inserts exact fractional-source video plus linked original audio with deterministic IDs',()=>{
 const d=fixture(),input=edit([{type:'insert-media',kind:'video',assetId:'media',trackId:'v',audioTrackId:'a',startFrame:310,sourceIn:{num:1001,den:60000},rate:{num:3,den:2},durationFrames:60}]);
 const a=applyNativeAgentEdit(d,input),b=applyNativeAgentEdit(d,input);expect(a).toEqual(b);const inserted=a.clips.filter(c=>!d.clips.some(x=>x.id===c.id));expect(inserted).toHaveLength(2);expect(inserted[0]!.linkGroupId).toBe(inserted[1]!.linkGroupId);
 for(const c of inserted){expect(sourceTimeAt(c,310,d.fps)).toEqual(r(1001,60000));expect(sourceTimeAt(c,311,d.fps)).toEqual(r(4001,60000));expect(effectFrameAt(c,311)).toEqual(r(1));}
});
it.each([2,.5])('computes full finite media duration at rate %s',rate=>{
 const d=fixture(),next=applyNativeAgentEdit(d,edit([{type:'insert-media',kind:'video',assetId:'media',trackId:'v',withAudio:false,startFrame:310,sourceIn:{num:2,den:1},rate:rate===2?{num:2,den:1}:{num:1,den:2}}]));
 expect(next.clips.at(-1)!.durationFrames).toBe(rate===2?120:480);expect(next.clips.at(-1)!.content).toMatchObject({sourceIn:r(2),rate:rate===2?r(2):r(1,2)});
});
it('requires explicit stream selection when a registered asset has multiple same-kind streams',()=>{
 const d=fixture();d.assets[0]!.streams.push({...d.assets[0]!.streams[0]!,index:2});const command={type:'insert-media',kind:'video',assetId:'media',trackId:'v',withAudio:false,startFrame:310};
 expect(()=>applyNativeAgentEdit(d,edit([command]))).toThrow('ストリーム');expect(applyNativeAgentEdit(d,edit([{...command,videoStreamIndex:2}])).clips.at(-1)!.content).toMatchObject({streamIndex:2});
});
it('uses existing registered image and free-caption defaults, not executable component input',()=>{
 const d=fixture(),next=applyNativeAgentEdit(d,edit([{type:'insert-media',kind:'image',assetId:'image',trackId:'v',startFrame:310},{type:'insert-caption',trackId:'t',startFrame:310,durationFrames:60,text:'追加字幕',appearance:{fontSize:40}}]));
 expect(next.clips.at(-2)!.durationFrames).toBe(150);expect(next.clips.at(-1)!.content).toMatchObject({textMode:'free',data:{text:'追加字幕',manual:true},appearance:{fontSize:40}});
});
it('supports explicit track creation/order/enabling and refuses deletion of an occupied track',()=>{
 const d=fixture(),next=applyNativeAgentEdit(d,edit([{type:'add-track',track:{id:'new',kind:'audio',name:'BGM'}},{type:'move-track',trackId:'new',index:0},{type:'set-track-enabled',trackId:'new',enabled:false},{type:'remove-track',trackId:'new'}]));expect(next.tracks).toEqual(d.tracks);
 expect(()=>applyNativeAgentEdit(d,edit([{type:'remove-track',trackId:'v'}]))).toThrow();
});
it('does not reuse deleted initial IDs or future explicit track IDs inside one request',()=>{
 const d=fixture();d.clips[2]!.id='native-ai-caption-1';
 const next=applyNativeAgentEdit(d,edit([{type:'delete',clipIds:['native-ai-caption-1']},{type:'insert-caption',trackId:'t',startFrame:0,durationFrames:20,text:'新規'},{type:'add-track',track:{id:'native-ai-caption-2',kind:'visual',name:'後続'}}]));
 expect(next.clips.filter(c=>c.content.kind==='telop').map(c=>c.id)).not.toContain('native-ai-caption-1');expect(next.clips.map(c=>c.id)).not.toContain('native-ai-caption-2');
});
it.each([
 {type:'insert-media',kind:'video',assetId:'media',trackId:'v',startFrame:0},
 {type:'insert-media',kind:'audio',assetId:'media',trackId:'a',startFrame:0,sourceIn:{num:10,den:1}},
 {type:'insert-media',kind:'image',assetId:'image',trackId:'v',startFrame:0,rate:{num:2,den:1}},
 {type:'update-clip-audio',clipId:'v1',settings:{muted:true}},
 {type:'insert-media',kind:'video',assetId:'missing',trackId:'v',startFrame:0},
])('rejects unsupported or ambiguous semantic input without changing graph: $type',command=>{
 const d=fixture(),before=serializeSequence(d);expect(()=>applyNativeAgentEdit(d,edit([command]))).toThrow();expect(serializeSequence(d)).toBe(before);
});
it('rejects wrong document identity and leaves source metadata intact on structural failure',()=>{
 const d=fixture(),before=serializeSequence(d);expect(()=>applyNativeAgentEdit(d,{documentId:'other',commands:[{type:'delete',clipIds:['v1']}]})).toThrow('文書');expect(serializeSequence(d)).toBe(before);
});
it('preserves finite video bounds, explicit music looping and short original-audio silence',()=>{
 const d=fixture();
 expect(()=>applyNativeAgentEdit(d,edit([{type:'insert-media',kind:'video',assetId:'media',trackId:'v',withAudio:false,startFrame:310,sourceIn:r(9),durationFrames:31}]))).toThrow();
 const music=applyNativeAgentEdit(d,edit([{type:'insert-media',kind:'audio',assetId:'media',trackId:'a',startFrame:310,durationFrames:600,role:'music',loop:true}]));
 expect(music.clips.at(-1)!.content).toMatchObject({kind:'audio',role:'music',loop:true,settings:{gainDb:-18}});
 const shorter=fixture();shorter.assets[0]!.streams[1]!.duration=r(8);
 // The existing live audio must also remain within its now-shortened source.
 shorter.clips[1]!.durationFrames=240;shorter.clips[1]!.linkGroupId=undefined;shorter.clips[0]!.linkGroupId=undefined;
 const result=applyNativeAgentEdit(shorter,edit([{type:'insert-media',kind:'video',assetId:'media',trackId:'v',audioTrackId:'a',startFrame:310}]));
 expect(result.clips.at(-1)!.durationFrames).toBe(300);expect(result.clips.at(-1)!.content).toMatchObject({kind:'audio',role:'speech',loop:false,endBehavior:'silence'});
});
