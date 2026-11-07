import type {TransferProgress} from '../components/TaskProgress';
import type {FolderDocument} from '../panels/homeFolderDrop';
import {deleteProjectRequest} from '../trashApi';
import {abandonImportItems,cancelImportBatch,createImportBatch,createNativeEmptyProject,fetchImportBatches,referenceImportItem,retryOnce,savedNativeDocument,uploadImportItem,uploadProjectDocument} from './api';
import {desktopFilePath} from './fileReference';
import {createWithDurations,handOverImportSeconds} from './importSeconds';

/** 空の作品の版（作成時の文書は版0。createDocuments の buildEmptyDocument）。 */
const UNTOUCHED_REVISION = 0;
/**
 * 複数の動画からの作成に失敗した時、作ったばかりの空の作品をゴミ箱へ移す（一覧に空の作品だけが残らないように）。
 * クリップ・素材が無く、版が作成時のまま（誰も編集していない）と確かめられた時だけ。確かめられない・移せない時は残す。
 */
async function dropUntouchedProject(id: string): Promise<void> {
  try {
    const document = await savedNativeDocument(id);
    if (document && document.clips.length === 0 && document.assets.length === 0 && document.revision === UNTOUCHED_REVISION) await deleteProjectRequest(id);
  } catch { /* 残す */ }
}

export interface FolderProjectInput {files:readonly File[];documents:readonly FolderDocument[]}
export interface FileResolver {resolve(file:File,onProgress?:(progress:TransferProgress)=>void):Promise<{path:string;expectedFingerprint?:string}>}
export interface FolderProjectResult {
  id:string;batchId:string;
  /** 渡せなかった動画の本数。 */
  undelivered:number;
  /** 保存場所の選択を途中で取り消した（後続のフォルダを止める合図）。 */
  aborted:boolean;
  /** 保管できなかった書類。 */
  documentFailures:{name:string;reason:string}[];
}
const isAbort=(error:unknown)=>(error as {name?:string}|null)?.name==='AbortError';

/**
 * フォルダから 1 プロジェクトを作る。空の作品を作り、素材欄に入れるホームの束（開いた編集画面が準備完了で自動確定する）を作り、書類を保管する。遷移はしない。
 * デスクトップ版のリンクは実パスを渡す。コピーは実パスを渡さず画面から送る（編集画面の「コピーして追加」と同じ。許可された場所の外の動画もコピーできる）。
 * 長さの先読み（デスクトップ版）は束の作成と並行に行い、読めている分を開く作品へ引き継ぐ。
 * 1 本も渡せなければ束を取り消し、作品を片付けて失敗を投げる。
 */
export async function createFolderProject(name:string,folder:FolderProjectInput,preferCopy:boolean,fileReference:FileResolver,onProgress?:(progress:TransferProgress)=>void):Promise<FolderProjectResult>{
  const {id}=await createNativeEmptyProject(name),paths=folder.files.map(desktopFilePath),desktop=paths.every(Boolean),link=desktop&&!preferCopy;
  const {view,stop}=await createWithDurations(desktop?[...folder.files]:null,()=>createImportBatch(id,{requestId:crypto.randomUUID(),mode:preferCopy?'copy':'link',origin:'home',placement:'materials',
    items:folder.files.map((file,index)=>({key:String(index),name:file.name,...(link?{path:paths[index]}:{})}))}))
    .catch(async(error:unknown)=>{await dropUntouchedProject(id);throw error;});
  // デスクトップ版のリンクは、束の作成で実パスを渡し終えている（サーバは応答の後に準備を始めるので、応答の項目は waiting のまま）。
  // もう一度渡すとサーバが「受け付け済み」で断るので、何も渡さない（編集画面の importVideos の `if(link)` と同じ）。
  // ブラウザ版の参照（実パスなし）とコピーは、受付順に1本ずつ渡す。最初に渡せなかった素材で止め、渡せなかった分は束の中で失敗にする。
  const waiting=link?[]:view.items.filter(entry=>entry.phase==='waiting'),undelivered:string[]=[];let delivered=0,failure:unknown;
  for(const item of waiting){
    if(failure!==undefined){undelivered.push(item.itemId);continue;}
    const file=folder.files[Number(item.key)]!;
    try{
      if(preferCopy)await uploadImportItem(id,view.batchId,item.itemId,file,onProgress);
      else{const reference=await fileReference.resolve(file,onProgress);await referenceImportItem(id,{batchId:view.batchId,itemId:item.itemId,...reference});}
      delivered++;
    }catch(error){undelivered.push(item.itemId);failure=error??new Error('動画を取り込めませんでした');}
  }
  if(waiting.length&&!delivered){
    stop();await cancelImportBatch(id,view.batchId).catch(()=>undefined);await dropUntouchedProject(id);throw failure;
  }
  // ページを読み直す遷移（既定の navigateToProject）では要求が途中で切れうる。失敗の印が届いてから先へ進む（届かないと束が準備中のまま残り、自動で並ばない）。
  if(undelivered.length)await retryOnce(()=>abandonImportItems(id,view.batchId,undelivered)).catch(()=>undefined);
  handOverImportSeconds(id,view.batchId);
  const documentFailures:FolderProjectResult['documentFailures']=[];
  for(const document of folder.documents){
    try{await retryOnce(()=>uploadProjectDocument(id,document.path,document.file));}
    catch(error){documentFailures.push({name:document.path,reason:error instanceof Error?error.message:String(error)});}
  }
  return {id,batchId:view.batchId,undelivered:undelivered.length,aborted:isAbort(failure),documentFailures};
}

export interface ImportPrepared {ready:number;failed:number;deciding:number;timedOut:boolean}
const PREPARING=new Set(['waiting','judging','probing','fingerprinting','copying']);

/**
 * 束の準備が終わるまで待つ（複数のフォルダを作ってトップに留まる時）。準備中の項目は再起動で失敗や判断待ちに変わるが、ready は残って開いた時に自動で確定する。
 * 読み直しの失敗は進み具合なしとして扱い、idleMs の間どの項目の段階も変わらなければ待つのをやめる。
 */
export async function waitForImportPrepared(projectId:string,batchId:string,{idleMs=120_000,pollMs=1000}:{idleMs?:number;pollMs?:number}={}):Promise<ImportPrepared>{
  let last='',changedAt=Date.now(),items:readonly {phase:string}[]=[];
  for(;;){
    const batch=await fetchImportBatches(projectId).then(batches=>batches.find(entry=>entry.batchId===batchId)).catch(()=>undefined);
    if(batch){
      items=batch.items;
      const now=items.map(item=>item.phase).join();
      if(now!==last){last=now;changedAt=Date.now();}
      if(!items.some(item=>PREPARING.has(item.phase)))return countPrepared(items,false);
    }
    if(Date.now()-changedAt>=idleMs)return countPrepared(items,true);
    await new Promise(done=>setTimeout(done,pollMs));
  }
}
const countPrepared=(items:readonly {phase:string}[],timedOut:boolean):ImportPrepared=>({ready:items.filter(item=>item.phase==='ready').length,failed:items.filter(item=>item.phase==='failed').length,deciding:items.filter(item=>item.phase==='awaiting-decision').length,timedOut});

/** 作ったフォルダについて、利用者に伝えることを文にする。無ければ空。 */
export function folderProjectNotes(name:string,made:FolderProjectResult,prepared:ImportPrepared|null):string[]{
  const notes:string[]=[];
  if(made.undelivered)notes.push(`「${name}」: 動画 ${made.undelivered} 本を渡せませんでした`);
  if(prepared?.timedOut)notes.push(`「${name}」: 動画の準備に時間がかかっています。開くと続きを確認できます`);
  else if(prepared&&prepared.failed>made.undelivered)notes.push(`「${name}」: 動画 ${prepared.failed-made.undelivered} 本を準備できませんでした。開くと理由が出ます`);
  if(prepared?.deciding)notes.push(`「${name}」: 動画 ${prepared.deciding} 本は確認が必要です。開くと選べます`);
  if(made.documentFailures.length)notes.push(`「${name}」: 書類を保管できませんでした（${made.documentFailures.map(item=>`${item.name}: ${item.reason}`).join('、')}）`);
  return notes;
}
