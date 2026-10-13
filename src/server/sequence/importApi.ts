// src/server/sequence/importApi.ts
import type {IncomingMessage,ServerResponse} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HttpError,sendJson} from '../http';
import {readJsonBody} from '../readBody';
import {assertBrowsablePath,browseRoots} from '../browsePaths';
import {assertContentLengthWithin,resolveMaxUploadBytes,streamBodyToTempFile} from '../streamUpload';
import {MAX_IMPORT_BATCH_ITEMS,type ImportBatchOrigin} from '../../shared/importBatches';
import {object,id} from './editRequest';
import {SequenceStore} from './store';
import type {SequenceService} from './service';
import {appendAssetsToMain} from './appendMain';
import {importBatches,type ImportItemSource} from './importBatches';
import {expectedReferenceFingerprint} from './references';
import {copyIo} from './mediaCopy/io';
import {copyJobsRoot} from './mediaCopy/jobs';
import {resolveCopyDestination,type ChosenDestination} from './mediaCopy/destinations';
import {parseDestinationRequest,shownError} from './mediaCopy/api';

const ROUTES=['/main/append','/imports','/imports/upload','/imports/reference','/imports/abandon','/imports/decide','/imports/confirm','/imports/cancel'];
const CHOICES=['copy','keep-once','keep-always'] as const;
const path=(value:unknown):string=>{if(typeof value!=='string'||!value||value.length>4096)throw new HttpError(400,'素材の場所が不正です');return assertBrowsablePath(value,browseRoots());};
/** メインの末尾への追加と取り込みの束の窓口（設計 §2）。パスは必ず実パスへ解決してから許可された場所かを確かめる。 */
export async function handleImportApi(req:IncomingMessage,res:ServerResponse,url:URL,route:string,directory:string,projectId:string,sessions:SequenceService,signal:AbortSignal):Promise<boolean>{
  if(!ROUTES.includes(route))return false;
  const method=req.method??'GET';
  const saved=new SequenceStore(directory).load();if(!saved)throw new HttpError(409,'先に案件を新形式へ移行してください');
  if(route==='/imports'&&method==='GET'){sendJson(res,200,{batches:importBatches.list(directory)});return true;}
  if(method!=='POST')throw new HttpError(405,'この操作は POST のみ対応します');
  if(route==='/imports/upload'){
    const batchId=id(url.searchParams.get('batch')),itemId=id(url.searchParams.get('item')),maximum=resolveMaxUploadBytes();assertContentLengthWithin(req,maximum);
    // 本文を受け取る前に、束と素材が受け付けられるかを確かめる（取り消した束へのアップロードを最後まで受信しない）。
    importBatches.assertDeliverable(directory,batchId,itemId,'copy');
    const temporaryDirectory=await mkdtemp(join(tmpdir(),'harness-native-import-')),cleanup=()=>rm(temporaryDirectory,{recursive:true,force:true});
    let file:string;try{file=await streamBodyToTempFile(req,temporaryDirectory,maximum);}catch(error){await cleanup();throw error;}
    sendJson(res,200,importBatches.deliverFile(directory,batchId,itemId,{path:file,cleanup}));return true;
  }
  const body=object(await readJsonBody(req));
  if(route==='/main/append'){
    const assetIds=Array.isArray(body.assetIds)?body.assetIds.map(value=>id(value)):[];
    if(!assetIds.length||assetIds.length>MAX_IMPORT_BATCH_ITEMS)throw new HttpError(400,`追加する動画を1〜${MAX_IMPORT_BATCH_ITEMS}本で指定してください`);
    sendJson(res,200,await appendAssetsToMain(directory,sessions,{sessionId:id(body.sessionId),executionId:id(body.executionId),assetIds},signal));return true;
  }
  if(route==='/imports'){
    if(!Array.isArray(body.items))throw new HttpError(400,'取り込む動画の一覧が必要です');
    // 数を先に確かめる（パスの解決・許可の確認は数の範囲内でだけ行う）。
    if(!body.items.length||body.items.length>MAX_IMPORT_BATCH_ITEMS)throw new HttpError(400,`動画は1〜${MAX_IMPORT_BATCH_ITEMS}本で指定してください`);
    const mode=body.mode==='copy'?'copy' as const:body.mode==='link'?'link' as const:null;
    if(!mode)throw new HttpError(400,'取り込み方が不正です');
    const items=body.items.map(raw=>{const item=object(raw);
      const source:ImportItemSource=item.path===undefined?{kind:'client'}:{kind:'path',path:path(item.path)};
      return {key:typeof item.key==='string'?item.key:'',name:typeof item.name==='string'?item.name:'',source};});
    const origin:ImportBatchOrigin=body.origin==='home'?{kind:'home'}:{kind:'ui'};
    sendJson(res,200,importBatches.create(directory,{requestId:id(body.requestId),projectId,origin,mode,items}));return true;
  }
  if(route==='/imports/reference'){
    sendJson(res,200,importBatches.deliverPath(directory,id(body.batchId),id(body.itemId),path(body.path),expectedReferenceFingerprint(body.expectedFingerprint)));return true;
  }
  if(route==='/imports/abandon'){
    // 画面が送れなかった（送るのをやめた）素材を失敗にする。理由の文はサーバが決める。
    if(!Array.isArray(body.itemIds)||!body.itemIds.length||body.itemIds.length>MAX_IMPORT_BATCH_ITEMS)throw new HttpError(400,`素材を1〜${MAX_IMPORT_BATCH_ITEMS}件で指定してください`);
    sendJson(res,200,importBatches.abandon(directory,id(body.batchId),body.itemIds.map(value=>id(value))));return true;
  }
  if(route==='/imports/decide'){
    // 判断待ちの扱い（設計 §2）: copy はコピー先を開始時の確認に通してから（案件名・ID は保存済みの文書から。編集のセッションに触れない）。失敗の理由にパス・英文を出さない
    const choice=CHOICES.find(item=>item===body.choice);if(!choice)throw new HttpError(400,'選び方が不正です');
    const batchId=id(body.batchId);
    try{
      let destination:ChosenDestination|undefined;
      if(choice==='copy'){
        const request=parseDestinationRequest(body.destination),root=copyJobsRoot(directory);
        destination=await resolveCopyDestination(copyIo(),{project:{name:saved.document.name,id:saved.document.id,root},...importBatches.copyInput(directory,batchId)},request);
      }else if(body.destination!==undefined)throw new HttpError(400,'コピー先はコピーする時だけ指定してください');
      sendJson(res,200,await importBatches.decide(directory,batchId,{choice,projectId,...(destination?{destination}:{})}));return true;
    }catch(error){throw shownError(error,route);}
  }
  if(route==='/imports/confirm'){
    if(body.skipFailed!==undefined&&typeof body.skipFailed!=='boolean')throw new HttpError(400,'失敗分の扱いが不正です');
    sendJson(res,200,await importBatches.confirm(directory,id(body.batchId),{sessionId:id(body.sessionId),executionId:id(body.executionId),skipFailed:body.skipFailed===true},sessions));return true;
  }
  sendJson(res,200,importBatches.cancel(directory,id(body.batchId)));return true;
}
