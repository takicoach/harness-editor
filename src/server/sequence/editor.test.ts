import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SequenceDocument } from '../../core/sequence/model';
import { rational as r } from '../../core/sequence/time';
import { sequenceEditorCommand, sequenceEditorRevision, sequenceEditorTargets } from '../../core/sequence/editorCommands';
import { SequenceStore } from './store';
import { SequenceService } from './service';
import { editorChangeSetSchema } from '../../shared/editorCommands';
import { createNativeEditorBridge } from '../../app/native/nativeEditorBridge';
import { executeEditorDelivery } from '../../app/edit/editorDelivery';
import { EditorAgentService } from '../editorAgentService';
import { EditorOperationStore } from '../editorOperationStore';
import { assertEditorDeliveryMayApply, assertEditorDeliveryMaySave } from '../editorSaveGuard';

const directories:string[]=[];
afterEach(()=>{for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
function document():SequenceDocument {
  return {schemaVersion:2,id:'case',name:'AI検証',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:90,background:'#000000',
    ducking:{enabled:false,strength:'mid'},assets:[{id:'media',kind:'media',name:'動画',file:'.harness/assets/media.mp4',fingerprint:'fixture',streams:[
      {index:0,kind:'video',codec:'h264',duration:r(10),frameRate:r(30),width:320,height:180},
      {index:1,kind:'audio',codec:'aac',duration:r(10),sampleRate:48000,channels:2}]}],
    tracks:[{id:'v',name:'映像',kind:'visual',enabled:true},{id:'t',name:'字幕',kind:'visual',enabled:true},{id:'a',name:'原音',kind:'audio',enabled:true}],
    clips:[
      {id:'video',trackId:'v',name:'映像',startFrame:0,durationFrames:90,clock:{offset:r(0),rate:r(1),duration:r(90)},content:{kind:'video',assetId:'media',streamIndex:0,sourceIn:r(0),rate:r(1)}},
      {id:'audio',trackId:'a',name:'原音',startFrame:0,durationFrames:90,clock:{offset:r(0),rate:r(1),duration:r(90)},content:{kind:'audio',assetId:'media',streamIndex:1,sourceIn:r(0),rate:r(1),role:'speech',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}},
      {id:'caption',trackId:'t',name:'字幕',startFrame:0,durationFrames:30,clock:{offset:r(0),rate:r(1),duration:r(30)},content:{kind:'telop',data:{text:'変更前'}},anchor:{kind:'source',role:'speech',sourceAssetId:'media',clipOccurrenceId:'audio',sourceStart:r(0),sourceEnd:r(1)}},
      {id:'manual',trackId:'t',name:'手動字幕',startFrame:30,durationFrames:30,clock:{offset:r(0),rate:r(1),duration:r(30)},content:{kind:'telop',data:{text:'手動の文字'}}},
    ],transitions:[],transcripts:[]};
}
function request(doc:SequenceDocument,sessionId='session',elementId='caption') {
  const target=sequenceEditorTargets(doc).find(item=>item.id===elementId)!;
  return editorChangeSetSchema.parse({schemaVersion:1,projectId:'case',operationId:'edit-one',baseRevision:sequenceEditorRevision(sessionId,doc.revision),
    changes:[{type:'set_telop_text',elementId,before:target.text,after:'AIで校正した本文',sourceFrameRange:target.sourceFrameRange,reference:target.reference}]});
}
function fixture() {
  const directory=mkdtempSync(join(tmpdir(),'native-ai-'));directories.push(directory);
  const store=new SequenceStore(directory);store.save({document:document(),executionId:'initial',expectedSavedRevision:null});
  const service=new SequenceService(),state=service.open(directory);
  return {directory,store,service,state};
}
it('new captions require exact source occurrence or timeline reference; legacy single speech resolves past the video ID',()=>{
  const doc=document(),input=request(doc);delete input.changes[0]!.reference;
  expect(()=>sequenceEditorCommand(doc,'case','session',input)).toThrow(/SOURCE_REFERENCE_REQUIRED/);
  doc.legacy={primaryAssetId:'media',sourceFingerprint:'legacy',originalEndFrame:90};
  expect(sequenceEditorCommand(doc,'case','session',input).type).toBe('batch');
  const repeated=structuredClone(doc.clips[1]!);repeated.id='audio-again';repeated.startFrame=90;doc.clips.push(repeated);doc.sequenceEndFrame=180;
  expect(()=>sequenceEditorCommand(doc,'case','session',input)).toThrow(/SOURCE_REFERENCE_REQUIRED/);
  expect(sequenceEditorCommand(doc,'case','session',request(doc)).type).toBe('batch');
  const wrong=request(doc);wrong.changes[0]!.reference={kind:'source',assetId:'media',occurrenceId:'audio-again',start:r(0),end:r(1)};
  expect(()=>sequenceEditorCommand(doc,'case','session',wrong)).toThrow(/SOURCE_REFERENCE_CONFLICT/);
  const audio=doc.clips[1]!.content;if(audio.kind==='audio')audio.settings.muted=true;
  expect(()=>sequenceEditorCommand(doc,'case','session',request(doc))).toThrow(/SOURCE_OCCURRENCE_UNAVAILABLE/);
  expect(sequenceEditorCommand(doc,'case','session',request(doc,'session','manual')).type).toBe('batch');
});
it('AI batches are atomic, share human Undo and do not reapply an acknowledged operation after Undo',()=>{
  const {directory,service,state}=fixture(),input=request(state.document,state.sessionId);
  const invalid=structuredClone(input);invalid.changes.push({...invalid.changes[0]!,elementId:'manual',before:'別の本文'});
  expect(()=>service.applyEditor(directory,'case',state.sessionId,invalid)).toThrow();expect(service.open(directory).document).toEqual(state.document);
  const applied=service.applyEditor(directory,'case',state.sessionId,input);expect(applied.document.revision).toBe(1);
  service.execute(directory,{sessionId:state.sessionId,expectedRevision:1,executionId:'human-undo',command:{type:'undo'}});
  const replay=service.applyEditor(directory,'case',state.sessionId,input);
  expect(replay.replayed).toBe(true);expect(replay.appliedRevision).toBe(1);expect(replay.document.revision).toBe(2);
  expect(replay.document.clips).toEqual(state.document.clips);
  service.save(directory,{sessionId:state.sessionId,expectedRevision:2,expectedSavedRevision:0,executionId:'save-undo'});
  expect(()=>service.applyEditor(directory,'case',state.sessionId,{...input,operationId:'stale'})).toThrow(/REVISION_CONFLICT/);
});

function deliveryFixture(lose:'none'|'apply'|'save'='none') {
  const f=fixture();let current=f.state,busy=false,calls=0;
  const broker=new EditorAgentService(new EditorOperationStore(join(f.directory,'operations.json'),'server'),()=>undefined);
  const bridge=createNativeEditorBridge({projectId:'case',sessionId:'browser',read:()=>current,humanBusy:()=>false,saving:()=>false,busy:value=>{busy=value;},
    accept:value=>{current=value;},request:async<T>(route:string,body:unknown,headers:Record<string,string>)=>{
      const lowered=Object.fromEntries(Object.entries(headers).map(([key,value])=>[key.toLowerCase(),value]));
      if(route==='/agent') {
        const input=body as {sessionId:string;request:ReturnType<typeof request>};assertEditorDeliveryMayApply(lowered,'case',input.request,broker);
        calls++;const next=f.service.applyEditor(f.directory,'case',input.sessionId,input.request);
        if(lose==='apply')throw new Error('応答喪失');return next as T;
      }
      const save=body as Parameters<SequenceService['save']>[1];
      assertEditorDeliveryMaySave(lowered,'case',broker,sequenceEditorRevision(save.sessionId,save.expectedRevision));
      const next=f.service.save(f.directory,save);
      if(lose==='save')throw new Error('応答喪失');return next as T;
    }});
  const credentials={sessionId:'browser',sessionKey:'browser-key'.repeat(5)};
  const start=async()=>{
    broker.heartbeat({...credentials,sequence:1,snapshot:await bridge.presence('case',false)});
    const input=request(current.document,current.sessionId),operation=broker.enqueue('browser',input);
    const delivery=broker.delivery(credentials.sessionId,credentials.sessionKey,operation.runId),guard={runId:delivery.runId,token:delivery.claim!.token};
    const deps={read:async()=>broker.delivery(credentials.sessionId,credentials.sessionKey,delivery.runId),
      acknowledge:async(result:Parameters<EditorAgentService['acknowledge']>[4])=>broker.acknowledge(credentials.sessionId,credentials.sessionKey,delivery.runId,guard.token,result),
      apply:(value:typeof input)=>bridge.apply(value,guard),save:(value:typeof input)=>bridge.save(value,guard)};
    return {input,delivery,guard,deps};
  };
  return {...f,broker,bridge,start,read:()=>current,calls:()=>calls,busy:()=>busy};
}
it('existing durable delivery saves native content once and records its revision; cancellation fences later save',async()=>{
  const f=deliveryFixture(),{delivery,deps,input,guard}=await f.start();
  const outcome=await executeEditorDelivery(delivery,deps);expect(outcome.kind).toBe('finished');
  expect(f.broker.get(delivery.runId)).toMatchObject({phase:'saved',confirmed:{applied:true,saved:true}});
  expect(sequenceEditorTargets(f.store.load()!.document)[0]!.text).toBe(input.changes[0]!.after);
  await f.bridge.apply(input,guard);expect(f.calls()).toBe(1);expect(f.busy()).toBe(false);
  const c=deliveryFixture(),started=await c.start();const applied=await started.deps.apply(started.input);await started.deps.acknowledge(applied);
  expect(()=>assertEditorDeliveryMaySave({'x-harness-editor-run':started.guard.runId,'x-harness-editor-token':started.guard.token},'case',c.broker,
    sequenceEditorRevision(c.state.sessionId,2))).toThrow(/DELIVERY_FENCED/);
  c.broker.cancel(started.delivery.runId);
  await expect(started.deps.save(started.input)).rejects.toThrow(/DELIVERY_FENCED/);
  expect(c.store.load()!.savedRevision).toBe(0);
});
it.each(['apply','save'] as const)('lost %s response stays unknown and never claims no effect',async lost=>{
  const f=deliveryFixture(lost),{delivery,deps}=await f.start();
  expect((await executeEditorDelivery(delivery,deps)).kind).toBe('unknown');
  expect(f.service.open(f.directory).document.revision).toBe(1);
  expect(f.store.load()!.savedRevision).toBe(lost==='save'?1:0);
  expect(f.calls()).toBe(1);
});
