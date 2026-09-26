import {createHash} from 'node:crypto';
import type {EditorSessionSnapshot} from '../shared/editorSessions';
import type {EditorChangeSet} from '../shared/editorCommands';
import type {NativeEditorEvidence,NativeEditorReconciliation} from '../shared/nativeEditorEvidence';
import {sequenceContentBytes} from '../core/sequence/validate';
import {sequenceEditorRevision} from '../core/sequence/editorCommands';
import {applyNativeAgentEdit} from '../core/sequence/nativeAgentCommands';
import {sequenceService,type SequenceService} from './sequence/service';
import {resolveProjectDir} from './projectRoot';
import {SequenceError} from '../core/sequence/errors';

export type NativeEditorSection='clips'|'assets'|'tracks'|'cuts'|'transcripts';
export interface NativeEditorReadOptions {section:NativeEditorSection;offset?:number;limit?:number;revision?:string}
type Ready=Extract<EditorSessionSnapshot,{status:'ready'}>;
export interface NativeEditorAgentAdapter {
  read(snapshot:Ready,options:NativeEditorReadOptions):unknown;
  validate(snapshot:Ready,request:EditorChangeSet):NativeEditorEvidence;
  reconcile(snapshot:Ready,evidence:NativeEditorEvidence):NativeEditorReconciliation;
}
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');

/** Reads the same in-memory authority as human commands; heartbeat carries no second document. */
export function createNativeEditorAgentAdapter(root:string,sessions:SequenceService=sequenceService):NativeEditorAgentAdapter {
  function current(snapshot:Ready,clean=false){
    if(snapshot.documentFormat!=='sequence-v2')throw new Error('NATIVE_EDITOR_REQUIRED: 独自編集の案件を開いてください');
    const state=sessions.open(resolveProjectDir(root,snapshot.projectId));
    if(sequenceEditorRevision(state.sessionId,state.document.revision)!==snapshot.revision)
      throw new Error('REVISION_CONFLICT: 画面と編集内容の版が変わりました。現在の状態を取得してください');
    if(clean&&(state.dirty||snapshot.dirty||snapshot.saving))throw new Error('UNSAVED_CHANGES: 編集内容を保存してから実行してください');
    if(clean&&snapshot.scriptEditingHash!==state.savedContentHash)throw new Error('SAVED_STATE_MISMATCH: 画面と保存済みの編集内容が異なります');
    return state;
  }
  return {
    read(snapshot,options){
      const offset=options.offset??0,limit=options.limit??100;
      if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)
        throw new Error('INVALID_PAGE: 取得件数は1〜100件で指定してください');
      if((offset>0&&!options.revision)||(options.revision&&options.revision!==snapshot.revision))
        throw new Error('REVISION_CONFLICT: 続きの取得には最初に返された版を指定してください');
      const {document:doc}=current(snapshot);
      const sections={clips:doc.clips,tracks:doc.tracks,cuts:doc.cutArchive?.entries??[],
        transcripts:doc.transcripts.flatMap(transcript=>transcript.words.map(word=>({assetId:transcript.assetId,streamIndex:transcript.streamIndex,...word}))),
        assets:doc.assets.map(asset=>{const {file:_file,...metadata}=asset;return metadata;})};
      const items=sections[options.section];
      if(!items)throw new Error('INVALID_EDITOR_INPUT: 取得する編集情報の種類が不正です');
      return {documentFormat:'sequence-v2',projectId:snapshot.projectId,revision:snapshot.revision,documentId:doc.id,
        fps:doc.fps,resolution:doc.resolution,sequenceEndFrame:doc.sequenceEndFrame,contentHash:digest(sequenceContentBytes(doc)),
        section:options.section,items:structuredClone(items.slice(offset,offset+limit)),total:items.length,nextOffset:offset+limit<items.length?offset+limit:null};
    },
    validate(snapshot,request){
      if(request.projectId!==snapshot.projectId)throw new Error('PROJECT_MISMATCH: 対象の案件が異なります');
      if(request.baseRevision!==snapshot.revision)throw new Error('REVISION_CONFLICT: 編集状態が変わりました');
      if(!request.sequence)throw new Error('INVALID_EDITOR_INPUT: 編集操作を指定してください');
      const {document}=current(snapshot,true);
      let next;
      try{next=applyNativeAgentEdit(document,request.sequence);}catch(error){
        if(error instanceof SequenceError)throw new Error(`${error.code==='REVISION_CONFLICT'?'REVISION_CONFLICT':'INVALID_EDITOR_INPUT'}: ${error.message}`);
        throw error;
      }
      const beforeHash=digest(sequenceContentBytes(document)),afterHash=digest(sequenceContentBytes(next));
      if(beforeHash===afterHash)throw new Error('NO_CHANGE: 編集前後の内容が同じです');
      return {documentId:document.id,beforeHash,afterHash};
    },
    reconcile(snapshot,evidence){
      const {document}=current(snapshot,true),contentHash=digest(sequenceContentBytes(document));
      if(evidence.documentId!==document.id)throw new Error('SAVED_STATE_MISMATCH: 確認する編集文書が異なります');
      return {documentId:document.id,contentHash,savedState:contentHash===evidence.beforeHash?'input':contentHash===evidence.afterHash?'proposal':'diverged'};
    },
  };
}
