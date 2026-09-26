import { editorChangeSetSchema, type EditorChangeSet } from '../../shared/editorCommands';
import { EDITOR_RUN_HEADER, EDITOR_TOKEN_HEADER, type EditorDeliveryGuard } from '../../shared/editorDeliveryGuard';
import type { EditorOperationResult } from '../../shared/editorOperations';
import { sequenceEditorRevision, sequenceEditorTargets } from '../../core/sequence/editorCommands';
import type { AsyncEditorBridge } from '../useEditorAgentConnection';
import type { NativeSession } from './api';

interface Dependencies {
  projectId:string; sessionId:string;
  read():NativeSession|null; humanBusy():boolean; saving():boolean; busy(value:boolean):void;
  request<T>(route:string,body:unknown,headers:Record<string,string>):Promise<T>;
  accept(state:NativeSession):void;
}
type Receipt={input:string;pending?:Promise<EditorOperationResult>;applied?:EditorOperationResult;saved?:EditorOperationResult;save?:Promise<EditorOperationResult>};
const headers=(delivery?:EditorDeliveryGuard)=>{
  if(!delivery) throw new Error('DELIVERY_FENCED: AI編集の確認情報がありません');
  return {[EDITOR_RUN_HEADER]:delivery.runId,[EDITOR_TOKEN_HEADER]:delivery.token};
};

/** Native effects happen at the server authority; durable broker claims still fence every delivery. */
export function createNativeEditorBridge(deps:Dependencies):AsyncEditorBridge {
  const receipts=new Map<string,Receipt>();
  function receipt(input:unknown):{request:EditorChangeSet;previous?:Receipt;key:string} {
    const request=editorChangeSetSchema.parse(input),key=JSON.stringify(request),previous=receipts.get(request.operationId);
    if(previous && previous.input!==key) throw new Error('OPERATION_CONFLICT: 同じ操作IDの内容が変わっています');
    return {request,previous,key};
  }
  return {
    sessionId:deps.sessionId,
    presence:(projectId,failed)=>{
      const state=deps.read();
      return state ? {status:'ready',projectId:deps.projectId,documentFormat:'sequence-v2',revision:sequenceEditorRevision(state.sessionId,state.document.revision),
        ...(!state.dirty?{scriptEditingHash:state.savedContentHash}:{}),
        dirty:state.dirty,saving:deps.saving(),humanBusy:deps.humanBusy(),elements:sequenceEditorTargets(state.document)}
        : projectId?{status:failed?'error':'loading',projectId}:{status:'home',projectId:null};
    },
    hasApplied:input=>!!receipt(input).previous?.applied,
    validateScript:async(input)=>{
      const request=editorChangeSetSchema.parse(input),current=deps.read();if(!request.script)return;
      if(!current||current.dirty||request.projectId!==deps.projectId||request.baseRevision!==sequenceEditorRevision(current.sessionId,current.document.revision))
        throw new Error('STALE_SCRIPT_EDIT: 台本案を確認した編集内容と異なります');
      const result=await deps.request<{artifact:typeof request.script.artifact}>('/script/edit-review',{sessionId:current.sessionId,
        expectedRevision:current.document.revision,artifact:request.script.artifact,modification:request.script.modification},{});
      const after=deps.read();
      if(!after||after.sessionId!==current.sessionId||after.document.revision!==current.document.revision||after.dirty||JSON.stringify(result.artifact)!==JSON.stringify(request.script.artifact))
        throw new Error('SCRIPT_INPUT_CHANGED: 台本案の確認中に編集内容が変わりました');
    },
    apply:async(input,delivery)=>{
      const {request,previous,key}=receipt(input);
      if(previous?.applied) return previous.applied;
      if(previous?.pending) return previous.pending;
      const current=deps.read();
      if(!current) throw new Error('EDITOR_UNAVAILABLE: 案件を開いてください');
      if(deps.humanBusy()) throw new Error('HUMAN_BUSY: 人が入力中です');
      if(current.dirty) throw new Error('UNSAVED_CHANGES: 人の未保存編集があります');
      if(deps.saving()) throw new Error('SAVE_IN_PROGRESS: 保存完了を待ってください');
      const guard=headers(delivery), entry:Receipt={input:key}; receipts.set(request.operationId,entry);
      deps.busy(true);
      entry.pending=(async()=>{
        try {
          const next=await deps.request<NativeSession & {appliedRevision:number}>('/agent',{sessionId:current.sessionId,request},guard);
          deps.accept(next);
          entry.applied={phase:'applied',revision:sequenceEditorRevision(next.sessionId,next.appliedRevision),code:null,applied:true,saved:false};
          return entry.applied;
        } catch(error) { deps.busy(false); throw error; }
      })();
      return entry.pending;
    },
    save:async(input,delivery)=>{
      const {request,previous}=receipt(input);
      if(!previous?.applied) throw new Error('OPERATION_NOT_APPLIED: この画面で反映していません');
      if(previous.saved) return previous.saved;
      if(previous.save) return previous.save;
      const current=deps.read(),applied=previous.applied;
      const failure=(code:string):EditorOperationResult=>{deps.busy(false);return previous.saved={...applied,phase:'failed',code};};
      if(!current || request.projectId!==deps.projectId || sequenceEditorRevision(current.sessionId,current.document.revision)!==applied.revision) return failure('EDIT_CHANGED_BEFORE_SAVE');
      if(deps.humanBusy() || deps.saving()) return failure(deps.humanBusy()?'HUMAN_BUSY':'SAVE_IN_PROGRESS');
      const guard=headers(delivery);
      previous.save=(async()=>{
        try {
          const next=await deps.request<NativeSession>('/save',{sessionId:current.sessionId,expectedRevision:current.document.revision,
            expectedSavedRevision:current.savedRevision,executionId:crypto.randomUUID()},guard);
          deps.accept(next);
          const after=deps.read();
          return previous.saved={...applied,phase:'saved',saved:true,code:after && sequenceEditorRevision(after.sessionId,after.document.revision)===applied.revision?null:'SAVED_WITH_LATER_UI_CHANGES'};
        } finally { deps.busy(false); }
      })();
      return previous.save;
    },
  };
}
