// src/server/sequence/importAgent.ts
import {createHash} from 'node:crypto';
import {basename} from 'node:path';
import {HttpError} from '../http';
import {assertBrowsablePath,browseRoots,type BrowseRoot} from '../browsePaths';
import {resolveProjectDir} from '../projectRoot';
import {createMediaKind} from '../../shared/createMedia';
import {MAIN_SPEED_REFUSAL} from '../../core/sequence/mainAppend';
import {MAX_IMPORT_BATCH_ITEMS,type ImportBatchView} from '../../shared/importBatches';
import {SequenceStore} from './store';
import {importBatches,type ImportBatches} from './importBatches';

export interface EditorImportInput {projectId:string;operationId:string;paths:string[];placement:'append-main';mode?:'link'|'copy'}
export interface EditorImportAdapter {
  find(projectId:string,operationId:string):ImportBatchView|undefined;
  start(input:EditorImportInput):ImportBatchView;
  runs(projectId:string,batchId?:string):ImportBatchView[];
  cancel(projectId:string,batchId:string):ImportBatchView;
}
/** 内部の要求ID: 操作IDのハッシュ（操作IDは任意の文字・256字まで。要求IDの文字の制限と長さに収め、先頭が同じ長いIDも衝突させない）。 */
export const agentRequestId=(operationId:string)=>`agent:${createHash('sha256').update(operationId).digest('hex')}`;
/** 再送の照合の鍵: 受け取った本文から作る（パスを解決し直さない。初回の後にファイルが動いても同じ操作には同じ束を返す）。 */
const requestKey=(input:EditorImportInput)=>createHash('sha256').update(JSON.stringify(['agent',input.projectId,input.operationId,input.placement,input.mode??'link',input.paths])).digest('hex');
/** AI の道具が扱うのは AI が作った束だけ。画面・ホームの束は「見つかりません」と同じに扱う（存在を漏らさない）。 */
const NOT_FOUND='取り込みが見つかりません';
/** 素材の失敗理由は AI へはパスの無い固定文で返す（fs の例外文などは絶対パスを含む。画面には今のまま出す）。 */
const ITEM_FAILED='この素材を読み込めませんでした';
const forAgent=(batch:ImportBatchView):ImportBatchView=>({...batch,items:batch.items.map(item=>item.error===undefined?item:{...item,error:ITEM_FAILED})});
/** 束の並び（作成時刻→ID。ImportBatches.list と同じ）。 */
const order=(a:{createdAt:string;batchId:string},b:{createdAt:string;batchId:string})=>a.createdAt.localeCompare(b.createdAt)||a.batchId.localeCompare(b.batchId);
const CURSOR=/^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{8,16}Z)~(imp-[a-f0-9]{20})$/;
/**
 * 新しい順の頁。続き位置は返した最も古い束の「作成時刻~ID」（添字ではない）。束が増えても、古い束の記録が整理されても、同じ境界の続きを返す。
 * batches は作成順（古い順）で渡す。
 */
export function importRunsPage(batches:ImportBatchView[],cursor:string|undefined,limit=20){
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('INVALID_PAGE: 取得件数は1〜100件で指定してください');
  let older=batches;
  if(cursor!==undefined){
    const match=CURSOR.exec(cursor);if(!match)throw new Error('INVALID_PAGE: 履歴の続き位置が不正です');
    const boundary={createdAt:match[1]!,batchId:match[2]!};older=batches.filter(batch=>order(batch,boundary)<0);
  }
  const page=older.slice(Math.max(0,older.length-limit)),oldest=page[0];
  return {batches:[...page].reverse(),total:batches.length,nextCursor:older.length>page.length&&oldest?`${oldest.createdAt}~${oldest.batchId}`:null};
}
/** HTTP の失敗を AI の道具の規則コードへ（パスは返さない）。 */
function agentError(error:unknown):never{
  if(error instanceof HttpError){
    if(error.reason==='IMPORT_REQUEST_CONFLICT')throw new Error('OPERATION_CONFLICT: 同じ操作IDの内容が変わっています');
    if(error.status===404)throw new Error(`IMPORT_NOT_FOUND: ${error.message}`);
    if(error.status===409)throw new Error(`IMPORT_FINISHED: ${error.message}`);
    if(error.status===400)throw new Error(`IMPORT_INVALID: ${error.message}`);
  }
  throw error;
}
/** AI の取り込み（設計 §1）。パスは今の参照取り込みと同じく実パスへ解決してから許可された場所かを確かめる。 */
export function createEditorImportAdapter(root:string,batches:ImportBatches=importBatches,roots:()=>BrowseRoot[]=()=>browseRoots()):EditorImportAdapter{
  const project=(projectId:string)=>{
    const dir=resolveProjectDir(root,projectId),saved=new SequenceStore(dir).load();
    if(!saved)throw new Error('NATIVE_EDITOR_REQUIRED: 独自編集の案件を開いてください');return {dir,document:saved.document};
  };
  const directory=(projectId:string)=>project(projectId).dir;
  const own=(dir:string,batchId:string)=>{const batch=batches.get(dir,batchId);if(batch.origin.kind!=='agent')throw new HttpError(404,NOT_FOUND);return batch;};
  return {
    // 要求IDで探す時も AI が作った束だけを見る（多重防御）。整理済みの操作は「完了済み」で断る。
    find(projectId,operationId){
      let found:ImportBatchView|undefined;try{found=batches.findByRequest(directory(projectId),agentRequestId(operationId));}catch(error){return agentError(error);}
      return found?.origin.kind==='agent'?forAgent(found):undefined;
    },
    start(input){
      if(!Array.isArray(input.paths)||!input.paths.length||input.paths.length>MAX_IMPORT_BATCH_ITEMS)throw new Error(`IMPORT_INVALID: 動画は1〜${MAX_IMPORT_BATCH_ITEMS}本で指定してください`);
      const {dir,document}=project(input.projectId),key=requestKey(input);
      // 同じ操作 ID の再送は、パスの確認より先に既存の束で答える（中身が違えば衝突）。
      let existing:ImportBatchView|undefined;try{existing=batches.findByRequest(dir,agentRequestId(input.operationId),key);}catch(error){return agentError(error);}
      if(existing){if(existing.origin.kind!=='agent')throw new Error('OPERATION_CONFLICT: 同じ操作IDの内容が変わっています');return forAgent(existing);}
      // 速度登録済みの案件は受け付けない（確定でも断られるため。設計 §1 の文言）。
      if(document.speed)throw new Error(`IMPORT_SPEED_REGISTERED: ${MAIN_SPEED_REFUSAL}`);
      const allowed=roots(),items=input.paths.map((path,index)=>{
        let real:string;try{real=assertBrowsablePath(path,allowed);}catch{throw new Error('IMPORT_PATH_NOT_ALLOWED: 許可されていない場所の素材は取り込めません');}
        if(createMediaKind(basename(real))!=='video')throw new Error('IMPORT_INVALID: 動画以外は取り込めません');
        return {key:String(index),name:basename(real),source:{kind:'path' as const,path:real}};
      });
      try{return forAgent(batches.create(dir,{requestId:agentRequestId(input.operationId),projectId:input.projectId,origin:{kind:'agent',operationId:input.operationId},mode:input.mode??'link',items,requestKey:key}));}
      catch(error){return agentError(error);}
    },
    runs(projectId,batchId){
      try{return (batchId?[own(directory(projectId),batchId)]:batches.list(directory(projectId)).filter(batch=>batch.origin.kind==='agent')).map(forAgent);}catch(error){return agentError(error);}
    },
    cancel(projectId,batchId){try{const dir=directory(projectId);own(dir,batchId);return forAgent(batches.cancel(dir,batchId));}catch(error){return agentError(error);}},
  };
}
