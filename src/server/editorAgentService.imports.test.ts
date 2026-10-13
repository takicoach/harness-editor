// src/server/editorAgentService.imports.test.ts
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {EditorAgentService} from './editorAgentService';
import {EditorOperationStore} from './editorOperationStore';
import type {EditorImportAdapter,EditorImportInput} from './sequence/importAgent';
import type {ImportBatchView} from '../shared/importBatches';

const directories:string[]=[];afterEach(()=>{for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
const heartbeat=(snapshot:Record<string,unknown>)=>({sessionId:'window',sessionKey:'w'.repeat(32),sequence:1,snapshot:{status:'ready',projectId:'case',revision:'r',documentFormat:'sequence-v2',dirty:false,saving:false,humanBusy:false,elements:[],...snapshot}});
function service(snapshot:Record<string,unknown>={}){
  const directory=mkdtempSync(join(tmpdir(),'agent-imports-'));directories.push(directory);
  const imports:EditorImportAdapter={find:vi.fn((_projectId:string,_operationId:string):ImportBatchView|undefined=>undefined),
    start:vi.fn((input:EditorImportInput)=>({batchId:'imp-aaaaaaaaaaaaaaaaaaaa',...input}) as unknown as ImportBatchView),runs:vi.fn(()=>[]),cancel:vi.fn()};
  const s=new EditorAgentService(new EditorOperationStore(join(directory,'runs.json'),'a'),()=>{},Date.now,15000,undefined,undefined,undefined,imports);
  s.heartbeat(heartbeat(snapshot));return {s,imports};
}
const input={projectId:'case',operationId:'op',paths:['/Volumes/m/take2.mp4'],placement:'append-main' as const};
it('starts an import for the ready native session of the same project',()=>{
  const {s,imports}=service();s.importMedia('window',input);expect(imports.start).toHaveBeenCalledWith(input);
});
it.each([
  [{dirty:true},'UNSAVED_CHANGES'],[{saving:true},'SAVE_IN_PROGRESS'],[{humanBusy:true},'HUMAN_BUSY'],[{documentFormat:undefined},'NATIVE_EDITOR_REQUIRED'],[{projectId:'other'},'PROJECT_MISMATCH'],
])('refuses %o with %s like the other editing tools',(snapshot,code)=>{
  const {s,imports}=service(snapshot);expect(()=>s.importMedia('window',input)).toThrow(new RegExp(`^${code}: `));expect(imports.start).not.toHaveBeenCalled();
});
it('replays an existing operation even after the human started editing',()=>{
  const {s,imports}=service({dirty:true});vi.mocked(imports.find).mockReturnValue({batchId:'imp-aaaaaaaaaaaaaaaaaaaa'} as never);
  s.importMedia('window',input);expect(imports.start).toHaveBeenCalledWith(input);
});
