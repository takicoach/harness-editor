import {afterAll,afterEach,beforeAll,beforeEach,describe,it,expect} from 'vitest';
import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {handleApi} from '../plugin';
import {HttpError} from '../http';
import {SequenceStore} from './store';
import type {SequenceSessionState} from './service';
import {type SequenceDocument,DEFAULT_TEXT_APPEARANCE} from '../../core/sequence/model';
import {sequenceContentBytes} from '../../core/sequence/validate';
import {resolveFfmpegBin} from '../resolveFfmpeg';
import {DEFAULT_MAIN_LAYOUT} from '../../core/mainLayout';
const r=(num:number,den=1)=>({num,den});
const content=(d:SequenceDocument)=>sequenceContentBytes({...d,revision:0});
function fixture():SequenceDocument {
 return {schemaVersion:2,id:'existing',name:'existing',revision:0,fps:r(1),resolution:{width:128,height:72},sequenceEndFrame:60,background:'#000',ducking:{enabled:false,strength:'mid'},transcripts:[],assets:[{id:'asset',kind:'media',file:'media/private.mp4',name:'private',fingerprint:'private',streams:[{index:0,kind:'video',codec:'h264',duration:r(1000),frameRate:r(1),width:128,height:72},{index:1,kind:'audio',codec:'aac',duration:r(1000),sampleRate:48000,channels:2}]}],tracks:[{id:'v',kind:'visual',name:'v',enabled:true},{id:'a',kind:'audio',name:'a',enabled:true},{id:'t',kind:'visual',name:'t',enabled:true}],clips:[0,1,2].flatMap(i=>[{id:`v${i}`,trackId:'v',name:`v${i}`,startFrame:i*20,durationFrames:20,linkGroupId:`l${i}`,clock:{offset:r(-2),rate:r(1),duration:r(200)},content:{kind:'video' as const,assetId:'asset',streamIndex:0,sourceIn:r(i*100),rate:r(1)}},{id:`a${i}`,trackId:'a',name:`a${i}`,startFrame:i*20,durationFrames:20,linkGroupId:`l${i}`,clock:{offset:r(-3),rate:r(2),duration:r(300)},content:{kind:'audio' as const,assetId:'asset',streamIndex:1,sourceIn:r(i*100),rate:r(1),role:'speech' as const,loop:false,settings:{gainDb:-3,muted:false,fadeInFrames:3,fadeOutFrames:4}}}]),transitions:[]};
}
const registration={type:'register-native-speed',groupId:'group',mainClipIds:['v0','v1','v2'],mainAudioBindings:[0,1,2].map(i=>({audioClipId:`a${i}`,providerId:`v${i}`}))};
it('preserves v2 caption and scene-fade history with own through HTTP, Store, Undo and failed batches',async()=>{
 let state=await edit(await open(),{type:'insert',clips:[{id:'caption-own-coexist',trackId:'t',name:'原音の字幕',startFrame:2,durationFrames:3,clock:{offset:r(0),rate:r(1),duration:r(3)},content:{kind:'telop',data:{text:'主原音の全文'},appearance:structuredClone(DEFAULT_TEXT_APPEARANCE)},anchor:{kind:'source',role:'speech',sourceAssetId:'asset',clipOccurrenceId:'a0',sourceStart:r(2),sourceEnd:r(5)}}]});
 state=await edit(state,{type:'batch',commands:[{...registration,mainClipIds:['v0'],mainAudioBindings:[{audioClipId:'a0',providerId:'v0'}]},{type:'upgrade-native-speed-operations'},{type:'register-native-insert-own-speed',clipId:'v2',linked:true},{type:'set-scene-fades',targets:[{kind:'head'}],change:{enabled:true,durationFrames:4,color:'#224466'}}]});
 const baseline=state.document;
 state=await edit(state,{type:'set-native-insert-own-speed',clipId:'v2',rate:r(3),linked:true});
 state=await edit(state,{type:'set-native-insert-own-speed',clipId:'v2',rate:r(1),linked:true});expect(content(state.document)).toBe(content(baseline));
 const prior=state.document;
 const failed=await post('/command',{sessionId:state.sessionId,expectedRevision:state.document.revision,executionId:'own-fade-bad',command:{type:'batch',commands:[{type:'set-scene-fades',targets:[{kind:'head'}],change:{color:'#662244'}},{type:'delete',clipIds:['missing'],linked:true}]}});
 expect([400,404]).toContain(failed.status);expect((await open()).document).toEqual(prior);
 expect((await post('/save',{sessionId:state.sessionId,expectedRevision:state.document.revision,expectedSavedRevision:state.savedRevision,executionId:'own-fade-save'})).status).toBe(200);
 expect(new SequenceStore(project).load()!.document).toEqual(prior);
 state=await edit(state,{type:'undo'});expect(state.document.clips.find(c=>c.id==='v2')!.durationFrames).toBe(7);
 state=await edit(state,{type:'redo'});expect(content(state.document)).toBe(content(prior));
});
let root:string,project:string,origin:string,server:Server,sequence=0,mediaDir:string,mp4:Buffer;
beforeAll(async()=>{mediaDir=await mkdtemp(join(tmpdir(),'native-speed-api-media-'));const bin=resolveFfmpegBin();if(!bin.ok)throw Error(bin.message);execFileSync(bin.bin,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=128x72:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','3','-c:v','libx264','-c:a','aac',join(mediaDir,'input.mp4')]);mp4=await readFile(join(mediaDir,'input.mp4'));},15000);
afterAll(async()=>{await rm(mediaDir,{recursive:true,force:true});});
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'native-speed-api-'));project=join(root,'existing');await mkdir(project);new SequenceStore(project).save({expectedSavedRevision:null,executionId:'seed',document:fixture()});server=createServer((req,res)=>{void handleApi(req,res,new URL(req.url!,'http://localhost'),root).catch(error=>{res.statusCode=error instanceof HttpError?error.status:500;res.end(JSON.stringify({error:String(error)}));});});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;});
afterEach(async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await rm(root,{recursive:true,force:true});});
async function post(path:string,body:unknown,projectId='existing'){return fetch(`${origin}/api/sequence${path}?id=${projectId}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}
async function open(projectId='existing'):Promise<SequenceSessionState>{const response=await post('/session',{},projectId);expect(response.status,await response.clone().text()).toBe(200);return response.json();}
async function edit(state:SequenceSessionState,command:unknown,projectId='existing',executionId=`edit-${++sequence}`){const response=await post('/command',{sessionId:state.sessionId,expectedRevision:state.document.revision,executionId,command},projectId);expect(response.status,await response.clone().text()).toBe(200);return response.json() as Promise<SequenceSessionState&{replayed:boolean}>;}
describe('explicit native speed HTTP commands',()=>{
 it('persists an own motion-clock edit with main timing, retries, Undo and atomic rejection over HTTP',async()=>{
  let state=await open();
  state=await edit(state,{type:'batch',commands:[{...registration,mainClipIds:['v0'],mainAudioBindings:[{audioClipId:'a0',providerId:'v0'}]},
   {type:'upgrade-native-speed-operations'},
   {type:'update-clip',clipId:'v2',patch:{visual:{layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[]}}},
   {type:'register-native-insert-own-speed',clipId:'v2',linked:true},
   {type:'set-scene-fades',targets:[{kind:'head'}],change:{enabled:true,durationFrames:4,color:'#224466'}}]});
  const before=state.document,clock={offset:r(-7,3),rate:r(9,2),duration:r(100)};
  const request={sessionId:state.sessionId,expectedRevision:state.document.revision,executionId:'motion-clock',command:{type:'rebase-native-insert-own-keyframe-clock',clipId:'v2',clock}};
  const response=await post('/command',request);expect(response.status,await response.clone().text()).toBe(200);state=await response.json();
  const edited=state.document;
  expect(edited.clips.find(c=>c.id==='a2')).toEqual(before.clips.find(c=>c.id==='a2'));
  expect(edited.clips.find(c=>c.id==='v2')!.visual!.keyframeClock).toEqual(clock);
  expect((await (await post('/command',request)).json()).replayed).toBe(true);
  const invalid={...request,expectedRevision:state.document.revision,executionId:'motion-clock-invalid',command:{type:'batch',commands:[{...request.command,clock:null},{...request.command,clock:{...clock,rate:r(0)}}]}};
  expect((await post('/command',invalid)).status).toBeGreaterThanOrEqual(400);expect((await open()).document).toEqual(edited);
  state=await edit(state,{type:'undo'});expect(content(state.document)).toBe(content(before));state=await edit(state,{type:'redo'});expect(content(state.document)).toBe(content(edited));
  state=await edit(state,{type:'set-native-global-speed',rate:r(2)});state=await edit(state,{type:'set-native-global-speed',rate:r(1)});expect(content(state.document)).toBe(content(edited));
  expect((await post('/save',{sessionId:state.sessionId,expectedRevision:state.document.revision,expectedSavedRevision:state.savedRevision,executionId:'motion-clock-save'})).status).toBe(200);
  expect(new SequenceStore(project).load()!.document).toEqual(state.document);
 });
 it('connects fixed insert-own registration, rate, save, replay, atomic failure and Undo/Redo over real HTTP',async()=>{
  let state=await open();const ids=['v2','a2'];
  state=await edit(state,{type:'batch',commands:state.document.clips.filter(c=>ids.includes(c.id)).map(c=>({type:'update-clip',clipId:c.id,patch:{content:{...c.content,rate:r(5)}}}))});
  const start=state.document;
  state=await edit(state,{type:'register-native-insert-own-speed',clipId:'v2',linked:true});const registered=state.document;
  const request={sessionId:state.sessionId,expectedRevision:state.document.revision,executionId:'own-speed',command:{type:'set-native-insert-own-speed',clipId:'v2',rate:r(2),linked:true}};
  const slow=await post('/command',request);expect(slow.status).toBe(200);state=await slow.json();expect(state.document.clips.filter(c=>ids.includes(c.id)).map(c=>c.durationFrames)).toEqual([50,50]);expect(state.document.sequenceEndFrame).toBe(90);
  expect((await (await post('/command',request)).json()).replayed).toBe(true);
  expect((await post('/command',{...request,executionId:'stale'})).status).toBe(409);
  const before=state.document;
  for(const command of [{type:'set-native-insert-own-speed',clipId:'v2',rate:r(2),linked:0},{type:'register-native-insert-own-speed',clipId:'v0',linked:true,extra:1},{type:'set-native-insert-own-speed',clipId:'v2',rate:{num:1,den:1,extra:true},linked:true},{type:'batch',commands:[{type:'set-native-insert-own-speed',clipId:'v2',rate:r(5),linked:true},{type:'set-native-insert-own-speed',clipId:'unknown',rate:r(2),linked:true}]}]){
   expect((await post('/command',{sessionId:state.sessionId,expectedRevision:state.document.revision,executionId:`own-bad-${++sequence}`,command})).status).toBeGreaterThanOrEqual(400);expect((await open()).document).toEqual(before);
  }
  state=await edit(state,{type:'set-native-insert-own-speed',clipId:'v2',rate:r(5),linked:true});expect(content(state.document)).toBe(content(registered));
  const save={sessionId:state.sessionId,expectedRevision:state.document.revision,expectedSavedRevision:state.savedRevision,executionId:'own-save'};expect((await post('/save',save)).status).toBe(200);expect(new SequenceStore(project).load()!.document).toEqual(state.document);
  state=await edit(state,{type:'undo'});expect(content(state.document)).toBe(content(before));state=await edit(state,{type:'redo'});expect(content(state.document)).toBe(content(registered));
  expect(start.clips.every(c=>!c.insertOwnSpeed)).toBe(true);
 });
 it('registers existing v2 without changing any canonical clip or timing',async()=>{const start=await open(),registered=await edit(start,registration);expect(registered.document.clips.map(c=>{const {speed,...rest}=c;return rest;})).toEqual(start.document.clips);expect(registered.document.speed).toMatchObject({globalRate:r(1),family:'native-exact-v1'});});
});

it('performs explicit native creation, registration, overrides, structural edits, save, replay and Undo/Redo over HTTP',async()=>{
 const originalHash=createHash('sha256').update(mp4).digest('hex');
 const created=await fetch(`${origin}/api/create-project?native=1&name=new-native&video=private.mp4`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:new Uint8Array(mp4)});expect(created.status,await created.clone().text()).toBe(200);const id=(await created.json() as {id:string}).id;
 let state=await open(id);expect(state.document.speed).toBeUndefined();const initial=state.document;
 const videos=state.document.clips.filter(c=>c.content.kind==='video'),audios=state.document.clips.filter(c=>c.content.kind==='audio');expect(videos).toHaveLength(1);expect(audios).toHaveLength(1);
 const target=videos[0]!.id;
 const register={type:'register-native-speed',groupId:'new-group',mainClipIds:[target],mainAudioBindings:[{audioClipId:audios[0]!.id,providerId:target}]};
 state=await edit(state,{type:'batch',commands:[register,{type:'upgrade-native-speed'},{type:'upgrade-native-speed-operations'},{type:'set-native-global-speed',rate:r(2)}]},id);
 expect(state.document.sequenceEndFrame).toBe(45);expect(state.document.revision).toBe(initial.revision+1);
 state=await edit(state,{type:'set-native-main-speed',clipId:target,rate:r(2)},id);expect(state.document.clips.find(c=>c.id===target)!.speed).toHaveProperty('override',r(2));
 state=await edit(state,{type:'set-native-global-speed',rate:r(1)},id);expect(state.document.sequenceEndFrame).toBe(45);
 state=await edit(state,{type:'reset-native-main-speed',clipId:target},id);expect(state.document.sequenceEndFrame).toBe(90);expect(state.document.clips.find(c=>c.id===target)!.speed).not.toHaveProperty('override');
 state=await edit(state,{type:'split',clipIds:[target],frame:30,linked:true},id);const child=state.document.clips.find(c=>c.content.kind==='video'&&c.startFrame===30)!;
 const beforeDelete=state.document;state=await edit(state,{type:'delete',clipIds:[child.id],linked:true},id);expect(state.document.clips.filter(c=>c.content.kind==='video')).toHaveLength(1);
 const save={sessionId:state.sessionId,expectedRevision:state.document.revision,expectedSavedRevision:state.savedRevision,executionId:'save'};expect((await post('/save',save,id)).status).toBe(200);expect((await post('/save',save,id)).status).toBe(200);expect(new SequenceStore(join(root,id)).load()!.document).toEqual(state.document);expect((await open(id)).document).toEqual(state.document);
 const deleted=state.document;state=await edit(state,{type:'undo'},id);expect(content(state.document)).toBe(content(beforeDelete));state=await edit(state,{type:'redo'},id);expect(content(state.document)).toBe(content(deleted));
 expect(createHash('sha256').update(await readFile(join(mediaDir,'input.mp4'))).digest('hex')).toBe(originalHash);
});

it('preserves the last-different-rate deletion result and its clocks through the API',async()=>{
 let state=await edit(await open(),{type:'batch',commands:[registration,{type:'set-native-global-speed',rate:r(3)},{type:'set-native-main-speed',clipId:'v0',rate:r(1)}]});
 state=await edit(state,{type:'delete',clipIds:['v0'],linked:true});expect(state.document.clips.filter(c=>c.content.kind==='video').map(c=>[c.id,c.startFrame,c.durationFrames])).toEqual([['v1',20,7],['v2',27,7]]);
 const before=content(state.document);state=await edit(state,{type:'set-native-global-speed',rate:r(1)});state=await edit(state,{type:'set-native-global-speed',rate:r(3)});expect(content(state.document)).toBe(before);
});

it('rejects wrong targets, old family, malformed shapes/rates and generic media rewrites without partial state',async()=>{
 let state=await open();const before=state.document;
 const bad=[null,false,[],{},'register-native-speed',{type:['register-native-speed']},...['','../group',null,0].map(groupId=>({...registration,groupId})),{...registration,extra:true},{...registration,mainClipIds:[]},{...registration,mainClipIds:['v0','v0']},{...registration,mainClipIds:['missing']},{...registration,mainClipIds:['a0']},{...registration,mainAudioBindings:[registration.mainAudioBindings[0],registration.mainAudioBindings[0]]},{...registration,mainAudioBindings:[{audioClipId:'a0',providerId:'not-selected'}]},{...registration,mainAudioBindings:[{audioClipId:'a0',providerId:'v0',extra:true}]},{...registration,family:'legacy-js-v1'},{type:'set-native-global-speed',rate:r(2)}];
 for(const command of bad){const response=await post('/command',{sessionId:state.sessionId,expectedRevision:state.document.revision,executionId:`bad-${++sequence}`,command});expect([400,404]).toContain(response.status);expect((await open()).document).toEqual(before);}
 state=await edit(state,registration);const registered=state.document;
 const rates=[null,false,0,'1',[],{},r(NaN),r(Infinity),r(0),r(-1),r(1,0),r(1,-1),r(.5),r(1,.5),r(Number.MAX_SAFE_INTEGER+1),r(17),r(9,100),{num:1,den:1,extra:true}];
 for(const command of [...rates.map(rate=>({type:'set-native-global-speed',rate})),{type:'upgrade-native-speed',extra:1},{type:'upgrade-native-speed-operations',extra:1},{type:'set-native-main-speed',clipId:'missing',rate:r(1)},{type:'set-native-main-speed',clipId:'a0',rate:r(1)},{type:'reset-native-main-speed',clipId:false},{type:'reset-native-main-speed',clipId:'v0',rate:r(1)},{type:'set-native-global-speed',rate:r(1),extra:1},registration]){
  const response=await post('/command',{sessionId:state.sessionId,expectedRevision:state.document.revision,executionId:`bad-${++sequence}`,command});expect([400,404]).toContain(response.status);expect((await open()).document).toEqual(registered);
 }
 for(const replacement of [{rate:r(2)},{sourceIn:r(1)},{assetId:'other'},{streamIndex:3}]){const c=registered.clips.find(c=>c.id==='v0')!;const response=await post('/command',{sessionId:state.sessionId,expectedRevision:state.document.revision,executionId:`generic-${++sequence}`,command:{type:'update-clip',clipId:'v0',patch:{content:{...c.content,...replacement}}}});expect(response.status).toBe(400);expect((await open()).document).toEqual(registered);}
 const json=`{"sessionId":"${state.sessionId}","expectedRevision":${state.document.revision},"executionId":"overflow-json","command":{"type":"set-native-global-speed","rate":{"num":1e999,"den":1}}}`;
 expect((await fetch(`${origin}/api/sequence/command?id=existing`,{method:'POST',headers:{'Content-Type':'application/json'},body:json})).status).toBe(400);expect((await open()).document).toEqual(registered);
});

it('keeps registration and speed batches atomic, protects stale revisions and exact execution replay',async()=>{
 const initial=await open();
 let command:unknown={type:'set-native-global-speed',rate:r(2)};for(let i=0;i<5;i++)command={type:'batch',commands:[command]};
 for(const invalid of [command,{type:'batch',commands:Array(51).fill({type:'upgrade-native-speed'})},{type:'batch',commands:[registration,{type:'set-native-global-speed',rate:r(2)},{type:'set-native-main-speed',clipId:'missing',rate:r(1)}]},{type:'batch',commands:[registration,{type:'undo'}]}]){
  const response=await post('/command',{sessionId:initial.sessionId,expectedRevision:initial.document.revision,executionId:`invalid-${++sequence}`,command:invalid});expect([400,404]).toContain(response.status);const after=await open();expect(after.document).toEqual(initial.document);expect(after.canUndo).toBe(false);
 }
 const request={sessionId:initial.sessionId,expectedRevision:initial.document.revision,executionId:'same',command:{type:'batch',commands:[registration,{type:'set-native-global-speed',rate:r(2)}]}};
 const first=await post('/command',request);expect(first.status).toBe(200);const edited=await first.json() as SequenceSessionState;
 const replay=await post('/command',request);expect(replay.status).toBe(200);expect(await replay.json()).toMatchObject({replayed:true,document:edited.document});
 expect((await post('/command',{...request,executionId:'stale'})).status).toBe(409);expect((await post('/command',{...request,command:{type:'upgrade-native-speed'}})).status).toBe(409);
 const undo=await edit(edited,{type:'undo'});expect(content(undo.document)).toBe(content(initial.document));expect(undo.canUndo).toBe(false);expect(content((await edit(undo,{type:'redo'})).document)).toBe(content(edited.document));
});


it('preserves source-caption latent IDs, color clocks and array order through HTTP speed round trips',async()=>{
 let state=await open();state=await edit(state,{type:'insert',clips:[{id:'caption',trackId:'t',name:'元字幕',startFrame:29,durationFrames:3,clock:{offset:r(-2),rate:r(1),duration:r(6)},content:{kind:'telop',data:{text:'原文保持'},appearance:{...DEFAULT_TEXT_APPEARANCE}},anchor:{kind:'source',role:'speech',sourceAssetId:'asset',clipOccurrenceId:'a1',sourceStart:r(109),sourceEnd:r(112)}}]});
 state=await edit(state,{type:'batch',commands:[registration,{type:'upgrade-native-speed'},{type:'split',clipIds:['v1'],frame:30,linked:true},{type:'set-scene-fades',targets:[{kind:'head'}],change:{enabled:true,durationFrames:8,color:'#ffffff'}},{type:'upgrade-native-speed-operations'}]});
 const before=content(state.document),texts=state.document.clips.filter(c=>c.content.kind==='telop');expect(texts).toHaveLength(2);const originalIds=state.document.clips.map(c=>c.id);
 state=await edit(state,{type:'set-native-global-speed',rate:r(2)});expect(state.document.clips.filter(c=>c.content.kind==='telop')).toHaveLength(1);expect(state.document.clips.find(c=>c.content.kind==='scene-fade')).toMatchObject({durationFrames:4,clock:{rate:r(2),duration:r(8)}});
 const save=await post('/save',{sessionId:state.sessionId,expectedRevision:state.document.revision,expectedSavedRevision:state.savedRevision,executionId:'latent-save'});expect(save.status).toBe(200);expect(new SequenceStore(project).load()!.document).toEqual(state.document);
 state=await edit(await open(),{type:'set-native-global-speed',rate:r(1)});expect(state.document.clips.map(c=>c.id)).toEqual(originalIds);expect(content(state.document)).toBe(before);
});

it('registers only explicitly named occurrences and never infers roles from a shared asset',async()=>{
 const initial=await open();const selected=await edit(initial,{type:'register-native-speed',groupId:'partial',mainClipIds:['v1'],mainAudioBindings:[{audioClipId:'a1',providerId:'v1'}]});expect(selected.document.clips.filter(c=>c.speed).map(c=>c.id)).toEqual(['v1','a1']);
 const next=await edit(selected,{type:'set-native-global-speed',rate:r(2)});expect(next.document.clips.filter(c=>!c.speed)).toEqual(initial.document.clips.filter(c=>!['v1','a1'].includes(c.id)));expect(next.document.clips.find(c=>c.id==='v1')).toMatchObject({startFrame:20,durationFrames:10});
});

it('accepts exact HTTP rate endpoints and the deepest legal batch without changing the round-trip basis',async()=>{
 let state=await edit(await open(),{type:'batch',commands:[registration,{type:'upgrade-native-speed-operations'}]});const before=content(state.document);
 state=await edit(state,{type:'set-native-global-speed',rate:r(1,10)});expect(state.document.speed?.globalRate).toEqual(r(1,10));expect(state.document.sequenceEndFrame).toBe(600);
 state=await edit(state,{type:'set-native-global-speed',rate:r(16)});expect(state.document.speed?.globalRate).toEqual(r(16));expect(state.document.sequenceEndFrame).toBe(4);
 state=await edit(state,{type:'set-native-global-speed',rate:r(34,25)});expect(state.document.speed?.globalRate).toEqual(r(34,25));expect(state.document.sequenceEndFrame).toBe(44);
 let command:unknown={type:'set-native-global-speed',rate:r(2,2)};for(let i=0;i<4;i++)command={type:'batch',commands:[command]};const revision=state.document.revision;
 state=await edit(state,command);expect(state.document.revision).toBe(revision+1);expect(state.document.speed?.globalRate).toEqual(r(1));expect(content(state.document)).toBe(before);
});

it.each([51,52])('rejects %i aggregate mixed leaves across child batches before any document, Store or history mutation',async count=>{
 const initial=await open();const state=await edit(initial,{type:'batch',commands:[registration,{type:'set-native-global-speed',rate:r(2)}]});
 const saved=await post('/save',{sessionId:state.sessionId,expectedRevision:state.document.revision,expectedSavedRevision:state.savedRevision,executionId:'aggregate-save'});expect(saved.status).toBe(200);
 const before=await open(),stored=new SequenceStore(project).load();
 const leaves=Array.from({length:count},(_,i)=>i===count-1?{type:'set-native-global-speed',rate:r(3)}:{type:'update-clip',clipId:'v0',patch:{name:`changed-${i}`}});
 const response=await post('/command',{sessionId:before.sessionId,expectedRevision:before.document.revision,executionId:'aggregate-rejected',command:{type:'batch',commands:[{type:'batch',commands:leaves.slice(0,25)},{type:'batch',commands:[]},{type:'batch',commands:leaves.slice(25)}]}});
 expect(response.status,await response.clone().text()).toBe(400);const after=await open();expect(after.document).toEqual(before.document);expect(after.canUndo).toBe(before.canUndo);expect(after.canRedo).toBe(before.canRedo);expect(after.savedRevision).toBe(before.savedRevision);expect(new SequenceStore(project).load()).toEqual(stored);
 const undone=await edit(after,{type:'undo'});expect(content(undone.document)).toBe(content(initial.document));expect(undone.canUndo).toBe(false);const redone=await edit(undone,{type:'redo'});expect(content(redone.document)).toBe(content(before.document));
});

it('counts only leaves: nested mixed 50 succeeds as one Undo while empty batches preserve the existing no-op',async()=>{
 let state=await edit(await open(),registration);const before=state.document;
 const leaves=Array.from({length:50},(_,i)=>i===49?{type:'set-native-global-speed',rate:r(3)}:{type:'update-clip',clipId:'v0',patch:{name:`changed-${i}`}});
 state=await edit(state,{type:'batch',commands:[{type:'batch',commands:leaves.slice(0,25)},{type:'batch',commands:[]},{type:'batch',commands:[{type:'batch',commands:[{type:'batch',commands:leaves.slice(25)}]}]}]});
 expect(state.document.revision).toBe(before.revision+1);expect(state.document.speed?.globalRate).toEqual(r(3));expect(state.document.clips.find(c=>c.id==='v0')!.name).toBe('changed-48');
 const undo=await edit(state,{type:'undo'});expect(content(undo.document)).toBe(content(before));state=await edit(undo,{type:'redo'});
 const empty=await edit(state,{type:'batch',commands:Array.from({length:50},()=>({type:'batch',commands:[]}))});expect(empty.document).toEqual(state.document);expect(empty.canUndo).toBe(state.canUndo);expect(empty.canRedo).toBe(state.canRedo);
});
