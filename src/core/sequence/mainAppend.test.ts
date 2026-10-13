// src/core/sequence/mainAppend.test.ts
import {describe,expect,it} from 'vitest';
import type {SequenceAsset,SequenceDocument} from './model';
import {fixture} from './fixtures';
import {rational as r} from './time';
import {applySequenceCommand} from './commands';
import {SEQUENCE_COMMAND_TYPES_NOT_OVER_HTTP} from './commandTypes';
import {validateSequenceDocument} from './validate';
import {buildAppendToMain,isUninitializedSequence,MAIN_SPEED_REFUSAL,MAIN_VIDEO_REQUIRED,videoSequenceFormat,type AppendMainPlan} from './mainAppend';
import {mainEnd} from './mainTrack';

const ids=()=>{let n=0;return ()=>`n${++n}`;};
const video=(id:string,o:{fps?:[number,number];width?:number;height?:number;seconds?:number;audio?:boolean;rotation?:number}={}):SequenceAsset=>({id,kind:'media',file:`.harness/assets/${id}.mp4`,name:`${id}.mp4`,fingerprint:id.padEnd(64,'0'),streams:[
  {index:0,kind:'video',codec:'h264',duration:r(o.seconds??1),frameRate:r(...(o.fps??[30,1])),width:o.width??320,height:o.height??180,...(o.rotation!==undefined?{rotation:o.rotation}:{})},
  ...(o.audio===false?[]:[{index:1,kind:'audio' as const,codec:'aac',duration:r(o.seconds??1),sampleRate:48000,channels:2}])]});
const withMainIds=():SequenceDocument=>{const d=fixture();
  d.tracks=d.tracks.map(t=>t.id==='v1'?{...t,id:'v-main'}:t.id==='a1'?{...t,id:'a-main'}:t);
  d.clips=d.clips.map(c=>c.trackId==='v1'?{...c,trackId:'v-main'}:c.trackId==='a1'?{...c,trackId:'a-main'}:c);return d;};
const mainOnly=():SequenceDocument=>{const d=withMainIds();d.clips=d.clips.filter(c=>c.id==='video'||c.id==='audio');d.tracks=d.tracks.filter(t=>t.id==='v-main'||t.id==='a-main');return d;};
const emptyDoc=():SequenceDocument=>({...fixture(),assets:[],clips:[],transcripts:[],transitions:[],sequenceEndFrame:0,
  tracks:[{id:'v-main',kind:'visual',name:'映像1',enabled:true},{id:'a-main',kind:'audio',name:'原音1',enabled:true}],main:{videoTrackId:'v-main',audioTrackId:'a-main'}});
const apply=(doc:SequenceDocument,plan:AppendMainPlan)=>{if('error' in plan)throw new Error(plan.error);return applySequenceCommand(doc,plan.command);};
const placed=(doc:SequenceDocument,trackId:string)=>doc.clips.filter(c=>c.trackId===trackId).sort((a,b)=>a.startFrame-b.startFrame)
  .map(c=>[c.startFrame,c.durationFrames,c.content.kind==='video'||c.content.kind==='audio'?c.content.assetId:'']);

describe('buildAppendToMain',()=>{
  it('appends videos consecutively after the main end on the main tracks as one linked edit',()=>{
    const doc=withMainIds(),plan=buildAppendToMain(doc,[video('clipA'),video('clipB',{seconds:2})],ids()),next=apply(doc,plan);
    expect(plan).toMatchObject({startFrame:300,endFrame:390});
    expect(placed(next,'v-main')).toEqual([[0,300,'source'],[300,30,'clipA'],[330,60,'clipB']]);
    expect(placed(next,'a-main')).toEqual([[0,300,'source'],[300,30,'clipA'],[330,60,'clipB']]);
    const added=next.clips.filter(c=>c.startFrame>=300&&(c.trackId==='v-main'||c.trackId==='a-main'));
    expect(added.filter(c=>c.content.kind==='audio').every(c=>c.content.kind==='audio'&&c.content.role==='speech'&&c.content.endBehavior==='silence')).toBe(true);
    expect(added.filter(c=>c.content.kind==='video').every(c=>c.content.kind==='video'&&c.content.endBehavior==='hold')).toBe(true);
    expect(new Set(added.map(c=>c.linkGroupId)).size).toBe(2);
    expect(next.revision).toBe(doc.revision+1);expect(next.main).toEqual({videoTrackId:'v-main',audioTrackId:'a-main'});expect(mainEnd(next)).toBe(390);
  });
  it('keeps the given order (the caller fixes it at acceptance)',()=>{
    const next=apply(withMainIds(),buildAppendToMain(withMainIds(),[video('clipB'),video('clipA')],ids()));
    expect(placed(next,'v-main').slice(1).map(x=>x[2])).toEqual(['clipB','clipA']);
  });
  it('keeps the document format and converts each length to the document fps',()=>{
    const plan=buildAppendToMain(withMainIds(),[video('f60',{fps:[60,1]}),video('f25',{fps:[25,1]})],ids());
    if('error' in plan)throw new Error(plan.error);
    expect(plan.command.commands.some(c=>c.type==='set-sequence-format')).toBe(false);
    expect(placed(apply(withMainIds(),plan),'v-main').slice(1)).toEqual([[300,30,'f60'],[330,30,'f25']]);
  });
  it('decides the format from the first video only for an uninitialized project, inside the same edit',()=>{
    const doc=emptyDoc();expect(isUninitializedSequence(doc)).toBe(true);
    const plan=buildAppendToMain(doc,[video('first',{fps:[60,1],width:640,height:360}),video('second',{fps:[25,1]})],ids());
    if('error' in plan)throw new Error(plan.error);
    expect(plan.command.commands[0]).toEqual({type:'set-sequence-format',fps:r(60),width:640,height:360});
    const next=applySequenceCommand(doc,plan.command);
    expect(next.fps).toEqual(r(60));expect(next.resolution).toEqual({width:640,height:360});expect(next.revision).toBe(doc.revision+1);
    expect(placed(next,'v-main')).toEqual([[0,60,'first'],[60,60,'second']]);
  });
  it('uses the displayed size of a rotated first video',()=>{
    expect(videoSequenceFormat(video('rot',{width:640,height:360,rotation:-90}))).toEqual({fps:r(30),width:360,height:640});
    const next=apply(emptyDoc(),buildAppendToMain(emptyDoc(),[video('rot',{width:640,height:360,rotation:90})],ids()));
    expect(next.resolution).toEqual({width:360,height:640});
  });
  it('does not change the format after everything was cut, and the cut can still be restored',()=>{
    const cut=applySequenceCommand(mainOnly(),{type:'ripple-delete',startFrame:0,endFrame:300});
    expect(cut.clips).toEqual([]);expect(isUninitializedSequence(cut)).toBe(false);
    const plan=buildAppendToMain(cut,[video('f60',{fps:[60,1]})],ids());
    if('error' in plan)throw new Error(plan.error);
    expect(plan.command.commands.some(c=>c.type==='set-sequence-format')).toBe(false);
    const appended=applySequenceCommand(cut,plan.command);expect(appended.fps).toEqual(r(30));
    const restored=applySequenceCommand(appended,{type:'restore-cut',entryId:appended.cutArchive!.entries[0]!.id,atFrame:0});
    validateSequenceDocument(restored);expect(restored.clips.filter(c=>c.trackId==='v-main').map(c=>c.durationFrames).sort((a,b)=>a-b)).toEqual([30,300]);
  });
  it('refuses a speed-registered project with the design wording',()=>{
    const doc={...withMainIds(),speed:{} as NonNullable<SequenceDocument['speed']>};
    expect(buildAppendToMain(doc,[video('x')],ids())).toEqual({error:MAIN_SPEED_REFUSAL,code:'SPEED_REGISTERED'});
    expect(MAIN_SPEED_REFUSAL).toBe('速度を設定した案件では、まだメインに素材を足せません。素材をすべて並べてから速度を設定してください（速度を設定する前に戻すには「元に戻す」を使います）');
  });
  it('refuses audio-only media and an empty list',()=>{
    const audioOnly:SequenceAsset={...video('a'),streams:[{index:0,kind:'audio',codec:'aac',duration:r(1),sampleRate:48000,channels:2}]};
    expect(buildAppendToMain(withMainIds(),[audioOnly],ids())).toEqual({error:MAIN_VIDEO_REQUIRED,code:'NOT_VIDEO'});
    expect(buildAppendToMain(withMainIds(),[],ids())).toMatchObject({code:'EMPTY'});
  });
  it('creates missing main tracks and records them instead of guessing from speech, starting after the whole sequence',()=>{
    const doc={...fixture(),sequenceEndFrame:330},plan=buildAppendToMain(doc,[video('clipA')],ids()),next=apply(doc,plan);
    expect(plan).toMatchObject({startFrame:330,endFrame:360});
    expect(next.main).toEqual({videoTrackId:'n1',audioTrackId:'n2'});
    expect(next.tracks[0]).toEqual({id:'n1',kind:'visual',name:'映像1',enabled:true});
    // 既存の映像（v1 の 0〜300）と重ねず、全体の長さの後ろに続ける。
    expect(placed(next,'n1')).toEqual([[330,30,'clipA']]);expect(placed(next,'n2')).toEqual([[330,30,'clipA']]);
    expect(next.clips.find(c=>c.id==='video')!.trackId).toBe('v1');
  });
  it('rounds each converted length up to whole frames and continues from the rounded end',()=>{
    const odd=video('odd');odd.streams=odd.streams.map(s=>({...s,duration:r(1001,1000)}));
    const plan=buildAppendToMain(withMainIds(),[odd,video('clipB')],ids()),next=apply(withMainIds(),plan);
    expect(plan).toMatchObject({startFrame:300,endFrame:361});
    expect(placed(next,'v-main').slice(1)).toEqual([[300,31,'odd'],[331,30,'clipB']]);
    expect(placed(next,'a-main').slice(1)).toEqual([[300,31,'odd'],[331,30,'clipB']]);
  });
  it('starts after the later of the main video and main audio ends',()=>{
    const longer=(frames:number)=>{const d=withMainIds(),a=d.clips.find(c=>c.id==='audio')!;a.durationFrames=frames;a.clock.duration=r(frames);return d;};
    const audioLater=longer(330),videoLater=longer(270);
    expect(buildAppendToMain(audioLater,[video('clipA')],ids())).toMatchObject({startFrame:330,endFrame:360});
    expect(placed(apply(audioLater,buildAppendToMain(audioLater,[video('clipA')],ids())),'v-main').slice(1)).toEqual([[330,30,'clipA']]);
    expect(buildAppendToMain(videoLater,[video('clipA')],ids())).toMatchObject({startFrame:300,endFrame:330});
  });
  it('starts at the main end, not the whole length, when inserts or captions run past the main',()=>{
    const doc=withMainIds(),telop=doc.clips.find(c=>c.id==='telop')!,{anchor:_anchor,...late}=telop;
    doc.clips.push({...structuredClone(late),id:'late',startFrame:300,durationFrames:120,clock:{offset:r(0),rate:r(1),duration:r(120)}});doc.sequenceEndFrame=420;
    const plan=buildAppendToMain(doc,[video('clipA')],ids()),next=apply(doc,plan);
    expect(plan).toMatchObject({startFrame:300,endFrame:330});
    expect(placed(next,'v-main').slice(1)).toEqual([[300,30,'clipA']]);
    expect(next.sequenceEndFrame).toBe(420);expect(next.clips.find(c=>c.id==='late')!.startFrame).toBe(300);
  });
  it('adds only the video for a silent video without creating an audio track',()=>{
    const doc:SequenceDocument={...emptyDoc(),tracks:[{id:'v-main',kind:'visual',name:'映像1',enabled:true}],main:undefined};
    const next=apply(doc,buildAppendToMain(doc,[video('mute',{audio:false})],ids()));
    expect(next.tracks.map(t=>t.id)).toEqual(['v-main']);expect(next.main).toEqual({videoTrackId:'v-main'});
    expect(next.clips.map(c=>c.content.kind)).toEqual(['video']);
  });
});
describe('set-sequence-format',()=>{
  it('is refused once the project has editing records, and is not accepted over HTTP',()=>{
    expect(()=>applySequenceCommand(withMainIds(),{type:'set-sequence-format',fps:r(60),width:640,height:360})).toThrow('素材や編集の記録がある案件では、fps・解像度を変えられません');
    expect(applySequenceCommand(emptyDoc(),{type:'set-sequence-format',fps:r(60),width:640,height:360}).fps).toEqual(r(60));
    expect(SEQUENCE_COMMAND_TYPES_NOT_OVER_HTTP).toContain('set-sequence-format');
  });
});
