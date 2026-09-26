import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SequenceService} from './sequence/service';
import {SequenceStore} from './sequence/store';
import {EditorAgentService} from './editorAgentService';
import {EditorOperationStore} from './editorOperationStore';
import {createNativeEditorAgentAdapter} from './nativeEditorAgentAdapter';
import {sequenceEditorRevision,sequenceEditorTargets} from '../core/sequence/editorCommands';
import {editorChangeSetSchema} from '../shared/editorCommands';
import {sequenceContentBytes} from '../core/sequence/validate';
import type {SequenceDocument} from '../core/sequence/model';
import {rational as r} from '../core/sequence/time';

const folders:string[]=[];afterEach(()=>{for(const folder of folders.splice(0))rmSync(folder,{recursive:true,force:true});});
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'native-agent-'));folders.push(root);const directory=join(root,'case');mkdirSync(directory);
 const doc:SequenceDocument={schemaVersion:2,id:'document',name:'AI編集',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:120,background:'#000',
   assets:[],tracks:[{id:'text',name:'字幕',kind:'visual',enabled:true}],clips:[{id:'caption',name:'字幕',trackId:'text',startFrame:0,durationFrames:120,
     clock:{offset:r(0),rate:r(1),duration:r(120)},content:{kind:'telop',data:{text:'元の字幕'}}}],transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'}};
 const saved=new SequenceStore(directory);saved.save({document:doc,executionId:'initial',expectedSavedRevision:null});
 const service=new SequenceService(),adapter=createNativeEditorAgentAdapter(root,service),operations=new EditorOperationStore(join(root,'operations.json'),'server');
 const broker=new EditorAgentService(operations,id=>{if(id!=='case')throw new Error('PROJECT_MISMATCH');},Date.now,15000,
   ()=>{const value=saved.load()!;return {elements:sequenceEditorTargets(value.document),fingerprint:value.contentHash};},undefined,adapter);
 const credentials={sessionId:'browser',sessionKey:'secret'.repeat(8)};let heartbeatSequence=0;
 const heartbeat=()=>{const state=service.open(directory);return broker.heartbeat({...credentials,sequence:++heartbeatSequence,snapshot:{status:'ready',projectId:'case',documentFormat:'sequence-v2',
   revision:sequenceEditorRevision(state.sessionId,state.document.revision),dirty:state.dirty,saving:false,humanBusy:false,
   ...(!state.dirty?{scriptEditingHash:state.savedContentHash}:{}),elements:sequenceEditorTargets(state.document)}});};
 heartbeat();const initial=service.open(directory);
 const request=()=>editorChangeSetSchema.parse({schemaVersion:1,projectId:'case',operationId:'cut-one',baseRevision:sequenceEditorRevision(initial.sessionId,0),changes:[],
   sequence:{documentId:'document',commands:[{type:'ripple-delete',startFrame:30,endFrame:60}]}});
 return {root,directory,saved,service,adapter,operations,broker,credentials,heartbeat,initial,request};
}
it('dry-runs the same edit without changing live data, saved content, or operation history',()=>{
 const f=fixture(),input=f.request(),before=sequenceContentBytes(f.initial.document),result=f.broker.validate('browser',input);
 expect(result.nativeEvidence?.beforeHash).not.toBe(result.nativeEvidence?.afterHash);
 expect(sequenceContentBytes(f.service.open(f.directory).document)).toBe(before);expect(sequenceContentBytes(f.saved.load()!.document)).toBe(before);expect(f.operations.list()).toHaveLength(0);
 const invalid=structuredClone(input);invalid.sequence!.commands.push({type:'trim',clipId:'missing',edge:'end',frame:60,linked:true});
 expect(()=>f.broker.validate('browser',invalid)).toThrow();expect(sequenceContentBytes(f.service.open(f.directory).document)).toBe(before);
});
it('keeps AI edits in one human Undo entry, persists evidence, and does not replay after Undo',()=>{
 const f=fixture(),input=f.request(),run=f.broker.enqueue('browser',input);
 expect(run.nativeEvidence?.documentId).toBe('document');
 const applied=f.service.applyEditor(f.directory,'case',f.initial.sessionId,input);expect(applied.document.sequenceEndFrame).toBe(90);expect(applied.canUndo).toBe(true);
 f.service.save(f.directory,{sessionId:applied.sessionId,expectedRevision:1,expectedSavedRevision:0,executionId:'save'});
 f.service.execute(f.directory,{sessionId:applied.sessionId,expectedRevision:1,executionId:'undo',command:{type:'undo'}});
 expect(sequenceContentBytes(f.service.open(f.directory).document)).toBe(sequenceContentBytes(f.initial.document));
 const replay=f.service.applyEditor(f.directory,'case',f.initial.sessionId,input);expect(replay.replayed).toBe(true);expect(replay.document.sequenceEndFrame).toBe(120);
 expect(new EditorOperationStore(join(f.root,'operations.json'),'restart').get(run.runId).nativeEvidence).toEqual(run.nativeEvidence);
});
it('rejects a stale browser snapshot even when the agent repeats its old revision',()=>{
 const f=fixture();f.service.execute(f.directory,{sessionId:f.initial.sessionId,expectedRevision:0,executionId:'human',command:{type:'trim',clipId:'caption',edge:'end',frame:90}});
 expect(()=>f.broker.validate('browser',f.request())).toThrow(/REVISION_CONFLICT/);
 expect(()=>f.broker.readNative('browser',{section:'clips'})).toThrow(/REVISION_CONFLICT/);
});
it('requires the same revision for pagination and exposes editing metadata without file paths',()=>{
 const f=fixture(),page=f.broker.readNative('browser',{section:'clips',limit:1}) as {documentId:string;revision:string;items:unknown[]};
 expect(page.documentId).toBe('document');expect(page.items).toHaveLength(1);
 expect(()=>f.broker.readNative('browser',{section:'clips',offset:1})).toThrow(/REVISION_CONFLICT/);
 expect(()=>f.broker.readNative('browser',{section:'clips',offset:1,revision:page.revision})).not.toThrow();
 expect(JSON.stringify(f.broker.readNative('browser',{section:'assets'}))).not.toContain(f.directory);
});
it('reconciles an unknown delivery against the complete saved timeline, never subtitles alone',()=>{
 const f=fixture(),input=f.request(),run=f.broker.enqueue('browser',input),applied=f.service.applyEditor(f.directory,'case',f.initial.sessionId,input);
 f.service.save(f.directory,{sessionId:applied.sessionId,expectedRevision:1,expectedSavedRevision:0,executionId:'save'});
 f.broker.disconnect(f.credentials.sessionId,f.credentials.sessionKey);f.heartbeat();
 const review=f.broker.prepareReconciliation('browser',run.runId);expect(review.sequence?.savedState).toBe('proposal');
 expect(review.sequence?.contentHash).toBe(run.nativeEvidence?.afterHash);
 const result=f.broker.reconcile('browser',f.credentials.sessionKey,run.runId,'review',review.snapshotHash,'synthetic');
 expect(result.phase).toBe('unknown');expect(result.reconciliation?.sequence?.savedState).toBe('proposal');expect(result.confirmed.saved).toBe(false);
});
it('rejects mixed edit families, unverified broker evidence, and a sequence request in the legacy caption validator',()=>{
 const f=fixture(),input=f.request();expect(()=>f.operations.enqueue(input)).toThrow(/REVIEW_UNAVAILABLE/);
 expect(()=>editorChangeSetSchema.parse({...input,changes:[{type:'set_telop_text',elementId:'caption',before:'元',after:'新',sourceFrameRange:{start:0,end:120}}]})).toThrow();
 const wrong=structuredClone(input);wrong.sequence!.documentId='other';expect(()=>f.broker.validate('browser',wrong)).toThrow();
});
