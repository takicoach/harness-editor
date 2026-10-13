import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {SequenceDocument} from '../../core/sequence/model';
import {SequenceStore} from './store';
import {SequenceService,type SequenceSessionState,type SequenceStatusKnown} from './service';
function document(revision=0,name='編集'):SequenceDocument{return {schemaVersion:2,id:'project',name,revision,fps:{num:30,den:1},resolution:{width:1920,height:1080},sequenceEndFrame:0,background:'#000000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};}
let directory:string;
beforeEach(()=>{directory=mkdtempSync(join(tmpdir(),'harness-status-'));new SequenceStore(directory).save({expectedSavedRevision:null,executionId:'initial',document:document()});});
afterEach(()=>{vi.restoreAllMocks();rmSync(directory,{recursive:true,force:true});});
const known=(state:SequenceSessionState):SequenceStatusKnown=>({revision:state.document.revision,savedRevision:state.savedRevision,savedContentHash:state.savedContentHash,canUndo:state.canUndo,canRedo:state.canRedo,historyError:state.historyError??null});
it('answers without the document when nothing the screen shows has changed, and clones nothing',()=>{
  const service=new SequenceService(),state=service.open(directory),clone=vi.spyOn(globalThis,'structuredClone');
  expect(service.status(directory,state.sessionId,known(state))).toEqual({unchanged:true,sessionId:state.sessionId});expect(clone).not.toHaveBeenCalled();
});
it('returns the whole state after an edit, for another session id, or when the screen sends nothing',()=>{
  const service=new SequenceService(),state=service.open(directory);
  const edited=service.execute(directory,{sessionId:state.sessionId,expectedRevision:0,executionId:'ducking',command:{type:'set-ducking',patch:{enabled:true,strength:'mid'}}});
  expect(service.status(directory,state.sessionId,known(state))).toMatchObject({document:{revision:edited.document.revision}});
  expect(service.status(directory,'another-session',known(edited))).toMatchObject({sessionId:state.sessionId,document:{revision:1}});
  expect(service.status(directory,state.sessionId)).toMatchObject({sessionId:state.sessionId,document:{revision:1}});
});
it('reports an external save with the whole state, detected by the content hash as before',()=>{
  const service=new SequenceService(),state=service.open(directory);
  new SequenceStore(directory).save({expectedSavedRevision:0,executionId:'external',document:document(1,'外部')});
  expect(service.status(directory,state.sessionId,known(state))).toMatchObject({externalChange:{savedRevision:1}});
});
it('clones the document once per state (state() no longer clones twice)',()=>{
  const service=new SequenceService(),state=service.open(directory),clone=vi.spyOn(globalThis,'structuredClone');
  service.inspect(directory,state.sessionId);expect(clone).toHaveBeenCalledTimes(1);
});
it('returns the whole state when any single field the screen shows differs',()=>{
  const service=new SequenceService(),state=service.open(directory),base=known(state);
  for(const patch of [{revision:1},{savedRevision:1},{savedContentHash:'other'},{canUndo:true},{canRedo:true},{historyError:'警告'}])
    expect(service.status(directory,state.sessionId,{...base,...patch}),JSON.stringify(patch)).toMatchObject({sessionId:state.sessionId,document:{revision:0}});
});
