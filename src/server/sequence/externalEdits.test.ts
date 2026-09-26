import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SequenceStore} from './store';
import {SequenceService} from './service';
import {applyExternalEdit,listExternalEdits,observeExternalEdits} from './externalEdits';
import type {SequenceDocument} from '../../core/sequence/model';
const folders:string[]=[];
afterEach(()=>{for(const path of folders.splice(0))rmSync(path,{recursive:true,force:true});});
function setup(){
 const path=mkdtempSync(join(tmpdir(),'external-edit-'));folders.push(path);
 const document:SequenceDocument={schemaVersion:2,id:'case',name:'before',revision:0,fps:{num:30,den:1},resolution:{width:640,height:360},sequenceEndFrame:0,background:'#000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
 const store=new SequenceStore(path),saved=store.save({document,executionId:'initial',expectedSavedRevision:null});
 const service=new SequenceService(),session=service.open(path);
 const input={metadata:{operationId:'external-codex-1',kind:'ai',source:'外部Codex',summary:'字幕・構成を修正'},
  before:{savedRevision:saved.savedRevision,contentHash:saved.contentHash},document:{...document,name:'after',revision:1}};
 return {path,store,service,session,input};
}
it('records external AI without standby or a terminal, deduplicates retry and survives reopen',()=>{
 const h=setup();const first=applyExternalEdit(h.path,h.input,()=>h.service.assertExternalWritable(h.path));
 expect(first.status).toBe('saved');expect(applyExternalEdit(h.path,h.input,()=>{})).toEqual(first);
 expect(listExternalEdits(h.path)).toHaveLength(1);expect(new SequenceStore(h.path).load()!.document.name).toBe('after');
 expect(h.service.inspect(h.path,h.session.sessionId).externalChange?.savedRevision).toBe(1);
 expect(()=>applyExternalEdit(h.path,{...h.input,metadata:{...h.input.metadata,summary:'different'}},()=>{})).toThrow(/同じ外部操作ID/);
});
it('keeps human edits and records conflict without overwriting or claiming success',()=>{
 const h=setup();h.service.execute(h.path,{sessionId:h.session.sessionId,executionId:'human',expectedRevision:0,command:{type:'set-ducking',patch:{enabled:true}}});
 expect(applyExternalEdit(h.path,h.input,()=>h.service.assertExternalWritable(h.path)).status).toBe('conflict');
 expect(h.store.load()!.document.name).toBe('before');expect(h.service.inspect(h.path,h.session.sessionId).canUndo).toBe(true);
 expect(listExternalEdits(h.path)[0]!.status).toBe('conflict');
});
it('records unknown writes during shutdown as external, never AI, and handles same revision content changes',()=>{
 const h=setup(),raw=JSON.parse(readFileSync(h.store.file,'utf8'));raw.document.name='unknown';writeFileSync(h.store.file,JSON.stringify(raw));
 new SequenceService().open(h.path);observeExternalEdits(h.path,h.store.load()!);
 const records=listExternalEdits(h.path);expect(records).toHaveLength(1);expect(records[0]).toMatchObject({kind:'external',status:'saved'});
});
it('own editor saves do not create external history',()=>{
 const h=setup();h.service.execute(h.path,{sessionId:h.session.sessionId,executionId:'human',expectedRevision:0,command:{type:'set-ducking',patch:{enabled:true}}});
 h.service.save(h.path,{sessionId:h.session.sessionId,executionId:'save',expectedRevision:1,expectedSavedRevision:0});
 new SequenceService().open(h.path);expect(listExternalEdits(h.path)).toEqual([]);
});
it('verifies an offline AI manifest and never labels an unapplied proposal as saved',()=>{
 const h=setup(),after=h.store.save({document:h.input.document,expectedSavedRevision:0,executionId:'offline'});
 const manifest={...h.input.metadata,operationId:'offline',before:h.input.before,after:{savedRevision:after.savedRevision,contentHash:after.contentHash}};
 writeFileSync(join(h.path,'.harness/external-edit.json'),JSON.stringify(manifest));
 new SequenceService().open(h.path);
 expect(listExternalEdits(h.path)).toHaveLength(1);expect(listExternalEdits(h.path)[0]).toMatchObject({kind:'ai',status:'saved'});
 writeFileSync(join(h.path,'.harness/external-edit.json'),JSON.stringify({...manifest,operationId:'proposal',before:manifest.after,after:{savedRevision:2,contentHash:'f'.repeat(64)}}));
 expect(listExternalEdits(h.path).find(record=>record.operationId==='proposal')?.status).toBe('pending');
});
