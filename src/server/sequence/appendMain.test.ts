import {afterAll,afterEach,beforeAll,beforeEach,expect,it} from 'vitest';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {handleApi} from '../plugin';
import {sendApiError} from '../http';
import {createEmptySequenceProject,createSequenceProject} from './create';
import {importSequenceAsset} from './assets';
import {SequenceStore} from './store';
import type {SequenceSessionState} from './service';
import {sequenceContentBytes} from '../../core/sequence/validate';
import {MAIN_SPEED_REFUSAL} from '../../core/sequence/mainAppend';
import type {SequenceDocument} from '../../core/sequence/model';
import {makeVideoSamples,type VideoSamples} from './__fixtures__/videoSamples';

let samples:VideoSamples,root:string,server:Server,origin:string;
beforeAll(async()=>{samples=makeVideoSamples(await mkdtemp(join(await realpath(tmpdir()),'append-main-media-')));},30000);
afterAll(async()=>{await rm(samples.dir,{recursive:true,force:true});});
beforeEach(async()=>{
  root=await mkdtemp(join(await realpath(tmpdir()),'append-main-'));
  server=createServer((req,res)=>{void handleApi(req,res,new URL(req.url!,'http://localhost'),root).catch(error=>sendApiError(res,error));});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await rm(root,{recursive:true,force:true});});
const post=async(id:string,route:string,body:unknown)=>{const response=await fetch(`${origin}/api/sequence${route}?id=${encodeURIComponent(id)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,json:await response.json()};};
const open=async(id:string)=>(await post(id,'/session',{})).json as SequenceSessionState;
const layout=(doc:SequenceDocument,trackId:string)=>doc.clips.filter(c=>c.trackId===trackId).sort((a,b)=>a.startFrame-b.startFrame).map(c=>[c.startFrame,c.durationFrames,c.content.kind==='video'||c.content.kind==='audio'?c.content.assetId:'']);

it('appends a registered video after the last main clip in one edit, keeps the format, and survives save and reload',async()=>{
  const {id}=await createSequenceProject(root,{name:'案件',videoName:'first.mp4',sourcePath:samples.first});
  const second=await importSequenceAsset(join(root,id),samples.second60),state=await open(id),first=state.document.assets[0]!.id;
  const appended=await post(id,'/main/append',{sessionId:state.sessionId,executionId:'append-1',assetIds:[second.id]});
  expect(appended.status).toBe(200);const doc=(appended.json as SequenceSessionState).document;
  expect(layout(doc,'v-main')).toEqual([[0,30,first],[30,60,second.id]]);expect(layout(doc,'a-main')).toEqual([[0,30,first],[30,60,second.id]]);
  expect(doc.fps).toEqual({num:30,den:1});expect(doc.main).toEqual({videoTrackId:'v-main',audioTrackId:'a-main'});expect(doc.revision).toBe(state.document.revision+1);
  const replay=await post(id,'/main/append',{sessionId:state.sessionId,executionId:'append-1',assetIds:[second.id]});
  expect(replay.json).toMatchObject({replayed:true});expect((replay.json as SequenceSessionState).document.revision).toBe(doc.revision);
  expect((await post(id,'/save',{sessionId:state.sessionId,expectedRevision:doc.revision,expectedSavedRevision:state.savedRevision,executionId:'save-1'})).status).toBe(200);
  expect(layout(new SequenceStore(join(root,id)).load()!.document,'v-main')).toEqual([[0,30,first],[30,60,second.id]]);
  expect((await post(id,'/main/append',{sessionId:state.sessionId,executionId:'append-2',assetIds:['media-unknown']})).status).toBe(404);
});
it('refuses a speed-registered project with the design wording and leaves the document unchanged',async()=>{
  const {id}=await createSequenceProject(root,{name:'速度',videoName:'first.mp4',sourcePath:samples.first});
  const second=await importSequenceAsset(join(root,id),samples.third25);let state=await open(id);
  const video=state.document.clips.find(c=>c.content.kind==='video')!,audio=state.document.clips.find(c=>c.content.kind==='audio')!;
  const registered=await post(id,'/command',{sessionId:state.sessionId,expectedRevision:state.document.revision,executionId:'speed',command:{type:'register-native-speed',groupId:'g',mainClipIds:[video.id],mainAudioBindings:[{audioClipId:audio.id,providerId:video.id}]}});
  expect(registered.status).toBe(200);state=registered.json as SequenceSessionState;
  const refused=await post(id,'/main/append',{sessionId:state.sessionId,executionId:'append-speed',assetIds:[second.id]});
  expect(refused.status).toBe(409);expect(refused.json).toEqual({error:MAIN_SPEED_REFUSAL,code:'SPEED_REGISTERED'});
  expect((await open(id)).document.revision).toBe(state.document.revision);
});
it('an empty project takes the first video format and one Undo returns to the empty project',async()=>{
  const {id}=await createEmptySequenceProject(root,{name:'空'});
  const rotated=await importSequenceAsset(join(root,id),samples.rotated),state=await open(id),before=sequenceContentBytes({...state.document,revision:0});
  const appended=await post(id,'/main/append',{sessionId:state.sessionId,executionId:'first',assetIds:[rotated.id]});
  const doc=(appended.json as SequenceSessionState).document;expect(doc.resolution).toEqual({width:90,height:160});expect(doc.fps).toEqual({num:30,den:1});
  const undone=await post(id,'/command',{sessionId:state.sessionId,expectedRevision:doc.revision,executionId:'undo',command:{type:'undo'}});
  expect(sequenceContentBytes({...(undone.json as SequenceSessionState).document,revision:0})).toBe(before);
});
